//! dbt MetricFlow metric import.
//!
//! Parses dbt Semantic Layer definitions (`semantic_models.yml` / `metrics.yml`)
//! and maps them into the FlowScope `metrics_registry`. This provides a
//! structured alternative to `auto_detect_metrics` (which reverse-engineers
//! metrics from SQL text).
//!
//! Scope: MetricFlow (the recommended dbt metric system) only. Legacy
//! `dbt_metrics` (`schema.yml` `metrics:` property) is not covered.

use std::collections::HashMap;
use std::path::PathBuf;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use super::metric::compute_signature;
use super::model::infer_layer;

// ============================================================
// dbt MetricFlow YAML structures
// ============================================================

#[derive(Debug, Clone, Default, Deserialize)]
struct DbtFile {
    #[serde(default)]
    semantic_models: Vec<DbtSemanticModel>,
    #[serde(default)]
    metrics: Vec<DbtMetric>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct DbtSemanticModel {
    name: String,
    #[serde(default)]
    model: String,
    #[serde(default)]
    measures: Vec<DbtMeasure>,
    #[serde(default)]
    dimensions: Vec<DbtDimension>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct DbtMeasure {
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    agg: String,
    #[serde(default)]
    expr: String,
    #[serde(default, rename = "agg_time_dimension")]
    agg_time_dimension: String,
    #[serde(default, rename = "create_metric")]
    create_metric: Option<bool>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct DbtDimension {
    name: String,
    #[serde(default)]
    #[allow(dead_code)]
    description: String,
    #[serde(default)]
    #[allow(dead_code)]
    r#type: String,
    #[serde(default)]
    type_params: DbtDimensionTypeParams,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct DbtDimensionTypeParams {
    #[serde(default, rename = "time_granularity")]
    time_granularity: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct DbtMetric {
    name: String,
    #[serde(default)]
    label: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    r#type: String,
    #[serde(default)]
    filter: String,
    #[serde(default)]
    type_params: DbtTypeParams,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct DbtTypeParams {
    #[serde(default)]
    measure: DbtMeasureRef,
    #[serde(default)]
    numerator: DbtMeasureRef,
    #[serde(default)]
    denominator: DbtMeasureRef,
    #[serde(default)]
    input_metric: DbtMeasureRef,
    #[serde(default)]
    expr: String,
    #[serde(default)]
    metrics: Vec<DbtMetricRef>,
    #[serde(default, rename = "cumulative_type_params")]
    cumulative_type_params: DbtCumulativeTypeParams,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct DbtMeasureRef {
    name: String,
    #[serde(default)]
    expr: String,
    #[serde(default)]
    filter: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct DbtMetricRef {
    name: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct DbtCumulativeTypeParams {
    #[serde(default)]
    window: String,
    #[serde(default, rename = "grain_to_date")]
    grain_to_date: String,
}

// ============================================================
// Import result
// ============================================================

#[derive(Debug, Clone, Serialize)]
pub struct DbtImportResult {
    pub imported: usize,
    pub metrics: Vec<serde_json::Value>,
    pub skipped: Vec<String>,
}

// ============================================================
// Discovery
// ============================================================

/// Scan watch directories for dbt YAML files that define semantic models
/// or metrics (top-level `semantic_models:` / `metrics:` keys).
pub fn discover_dbt_files(dirs: &[PathBuf]) -> Vec<(PathBuf, String)> {
    let mut found = Vec::new();
    for dir in dirs {
        if !dir.is_dir() {
            continue;
        }
        for entry in walkdir::WalkDir::new(dir)
            .follow_links(false)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let ext = match path.extension() {
                Some(e) => e.to_string_lossy().to_lowercase(),
                None => continue,
            };
            if ext != "yaml" && ext != "yml" {
                continue;
            }
            let content = match std::fs::read_to_string(path) {
                Ok(c) => c,
                Err(_) => continue,
            };
            if is_dbt_metric_file(&content) {
                found.push((path.to_path_buf(), content));
            }
        }
    }
    found
}

/// Cheap heuristic: check for top-level dbt metric keys.
fn is_dbt_metric_file(content: &str) -> bool {
    for line in content.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("semantic_models:") || trimmed.starts_with("metrics:") {
            return true;
        }
        // Only inspect top-level (no indentation) keys.
        if trimmed != line {
            continue;
        }
    }
    false
}

// ============================================================
// Parsing + mapping
// ============================================================

/// Parse a dbt YAML file and map every metric/measure into registry rows.
fn parse_dbt_file(
    content: &str,
    source_path: &str,
    model_name_map: &mut HashMap<String, String>,
    rows: &mut Vec<RegistryRow>,
    skipped: &mut Vec<String>,
) {
    let parsed: DbtFile = match serde_yaml::from_str(content) {
        Ok(p) => p,
        Err(e) => {
            skipped.push(format!("{source_path}: parse error ({e})"));
            return;
        }
    };

    // Register measure metadata keyed by (semantic model name, measure name).
    let mut measure_meta: HashMap<(String, String), DbtMeasure> = HashMap::new();
    for sm in &parsed.semantic_models {
        // Extract physical model name from ref('name') / ref('pkg','name').
        let resolved = resolve_ref(&sm.model);
        if !resolved.is_empty() {
            model_name_map.insert(sm.name.clone(), resolved.clone());
        }
        for m in &sm.measures {
            measure_meta.insert((sm.name.clone(), m.name.clone()), m.clone());
        }
    }

    // Simple metrics from measures with `create_metric: true`.
    for sm in &parsed.semantic_models {
        for m in &sm.measures {
            if m.create_metric.unwrap_or(false) {
                let metric_name = m.name.clone();
                rows.push(map_metric_to_row(
                    &metric_name,
                    &DbtMetric {
                        name: metric_name.clone(),
                        label: metric_name.clone(),
                        description: m.description.clone(),
                        r#type: "simple".to_string(),
                        filter: String::new(),
                        type_params: DbtTypeParams {
                            measure: DbtMeasureRef { name: m.name.clone(), expr: m.expr.clone(), filter: String::new() },
                            ..Default::default()
                        },
                    },
                    Some(sm),
                    Some(m),
                    model_name_map,
                ));
            }
        }
    }

    // Explicit metrics.
    for metric in &parsed.metrics {
        let (sm, measure) = resolve_measure(metric, &measure_meta);
        rows.push(map_metric_to_row(
            &metric.name,
            metric,
            sm.as_ref(),
            measure.as_ref(),
            model_name_map,
        ));
    }
}

/// Extract the physical model name from `ref('name')` / `ref('pkg','name')`.
fn resolve_ref(model_expr: &str) -> String {
    let trimmed = model_expr.trim();
    // Strip `ref(...)` / `source(...)` wrappers.
    if let Some(inner) = trimmed
        .strip_prefix("ref(")
        .and_then(|s| s.strip_suffix(')'))
        .or_else(|| trimmed.strip_prefix("source(").and_then(|s| s.strip_suffix(')')))
    {
        // ref('pkg','name') → last quoted segment.
        let quoted: Vec<&str> = inner.split(',').map(|s| s.trim().trim_matches('\'').trim_matches('"')).collect();
        return quoted.last().map(|s| s.to_string()).unwrap_or_default();
    }
    trimmed
        .trim_matches('\'')
        .trim_matches('"')
        .to_string()
}

/// Locate the semantic model + measure backing a metric.
fn resolve_measure(
    metric: &DbtMetric,
    measure_meta: &HashMap<(String, String), DbtMeasure>,
) -> (Option<DbtSemanticModel>, Option<DbtMeasure>) {
    let tp = &metric.type_params;
    let measure_name = if !tp.measure.name.is_empty() {
        Some(tp.measure.name.as_str())
    } else if !tp.numerator.name.is_empty() {
        Some(tp.numerator.name.as_str())
    } else if !tp.input_metric.name.is_empty() {
        Some(tp.input_metric.name.as_str())
    } else {
        None
    };
    let Some(mname) = measure_name else {
        return (None, None);
    };
    for (key, m) in measure_meta {
        if key.1 == mname {
            return (Some(DbtSemanticModel { name: key.0.clone(), ..Default::default() }), Some(m.clone()));
        }
    }
    (None, None)
}

// ============================================================
// Row mapping
// ============================================================

/// One row to upsert into metrics_registry.
struct RegistryRow {
    project_id: String,
    metric_name: String,
    metric_type: String,
    definition: String,
    expression: String,
    aggregation: String,
    business_filter: String,
    period: String,
    source_tables: String,
    dimensions: String,
    layer: String,
    contract_id: String,
    bound_model: String,
    bound_column: String,
}

fn map_metric_to_row(
    metric_name: &str,
    metric: &DbtMetric,
    sm: Option<&DbtSemanticModel>,
    measure: Option<&DbtMeasure>,
    model_name_map: &HashMap<String, String>,
) -> RegistryRow {
    let tp = &metric.type_params;

    // Aggregation: from the backing measure (default sum).
    let aggregation = measure
        .map(|m| normalize_agg(&m.agg))
        .filter(|a| !a.is_empty())
        .unwrap_or_else(|| "sum".to_string());

    // Expression: derived metrics carry their own expr; others use measure.expr.
    let expression = if metric.r#type == "derived" && !tp.expr.is_empty() {
        tp.expr.clone()
    } else {
        measure
            .and_then(|m| {
                if m.expr.is_empty() { None } else { Some(m.expr.clone()) }
            })
            .unwrap_or_else(|| tp.measure.expr.clone())
    };

    // Period from agg_time_dimension / time granularity, with cumulative
    // grain_to_date taking precedence for cumulative metrics.
    let period = if metric.r#type == "cumulative" && !tp.cumulative_type_params.grain_to_date.is_empty() {
        map_granularity(&tp.cumulative_type_params.grain_to_date)
    } else {
        measure
            .and_then(|m| {
                let base = if m.agg_time_dimension.is_empty() {
                    sm.and_then(|s| {
                        s.dimensions
                            .iter()
                            .find(|d| !d.type_params.time_granularity.is_empty())
                            .map(|d| d.type_params.time_granularity.clone())
                    })
                } else {
                    Some(m.agg_time_dimension.clone())
                };
                base.map(|g| map_granularity(&g))
            })
            .unwrap_or_default()
    };

    // Bound model: resolved physical model from the semantic model name.
    let sm_name = sm.map(|s| s.name.clone()).unwrap_or_default();
    let bound_model = if sm_name.is_empty() {
        String::new()
    } else {
        model_name_map
            .get(&sm_name)
            .cloned()
            .unwrap_or_else(|| sm_name.clone())
    };
    let bound_column = measure
        .map(|m| {
            if m.expr.is_empty() { m.name.clone() } else { m.expr.clone() }
        })
        .unwrap_or_default();

    // Business filter: translate dbt Jinja filter references to readable text,
    // combining metric-level and measure-level filters.
    let metric_filter = translate_filter(&metric.filter);
    let measure_filter = translate_filter(&tp.measure.filter);
    let business_filter = if metric_filter.is_empty() {
        measure_filter
    } else if measure_filter.is_empty() {
        metric_filter
    } else {
        format!("{metric_filter}; {measure_filter}")
    };

    // Metric type.
    let metric_type = match metric.r#type.as_str() {
        "simple" => "atomic",
        _ => "derived",
    };

    // Definition: description with label as fallback, enriched with
    // type-specific inputs (derived inputs / ratio denominator / window).
    let base_definition = if metric.description.is_empty() {
        if metric.label.is_empty() { metric_name.to_string() } else { metric.label.clone() }
    } else {
        metric.description.clone()
    };
    let mut definition = base_definition.clone();
    if metric.r#type == "derived" && !tp.metrics.is_empty() {
        let inputs: Vec<String> = tp.metrics.iter().map(|m| m.name.clone()).collect();
        definition = format!("{base_definition} (inputs: {})", inputs.join(", "));
    } else if metric.r#type == "ratio" && !tp.denominator.name.is_empty() {
        definition = format!("{base_definition} (numerator: {}, denominator: {})", tp.numerator.name, tp.denominator.name);
    } else if metric.r#type == "cumulative" && !tp.cumulative_type_params.window.is_empty() {
        definition = format!("{base_definition} (window: {})", tp.cumulative_type_params.window);
    }

    // Dimensions: categorical + time dimension names from the semantic model.
    let dimensions: Vec<String> = sm
        .map(|s| s.dimensions.iter().map(|d| d.name.clone()).collect())
        .unwrap_or_default();
    let dimensions_json = serde_json::to_string(&dimensions).unwrap_or_else(|_| "[]".to_string());

    let layer = infer_layer(&bound_model);

    RegistryRow {
        project_id: String::new(),
        metric_name: metric_name.to_string(),
        metric_type: metric_type.to_string(),
        definition,
        expression,
        aggregation,
        business_filter,
        period,
        source_tables: bound_model.clone(),
        dimensions: dimensions_json,
        layer: layer.to_string(),
        contract_id: format!("dbt:{bound_model}"),
        bound_model,
        bound_column,
    }
}

/// Normalize dbt aggregation names to FlowScope conventions.
fn normalize_agg(agg: &str) -> String {
    match agg.to_lowercase().as_str() {
        "count" => "count".to_string(),
        "count_distinct" => "count_distinct".to_string(),
        "sum" => "sum".to_string(),
        "avg" | "average" => "avg".to_string(),
        "min" => "min".to_string(),
        "max" => "max".to_string(),
        "median" => "median".to_string(),
        "percentile" => "percentile".to_string(),
        "stddev" => "stddev".to_string(),
        other => other.to_string(),
    }
}

/// Map dbt time granularity to FlowScope period.
fn map_granularity(grain: &str) -> String {
    match grain.to_lowercase().as_str() {
        "day" | "daily" => "daily",
        "week" | "weekly" => "weekly",
        "month" | "monthly" => "monthly",
        "hour" | "hourly" => "hourly",
        "quarter" => "quarterly",
        "year" | "yearly" => "yearly",
        other => other,
    }
    .to_string()
}

/// Translate dbt Jinja filter syntax into human-readable text.
/// e.g. `{{ Dimension('is_food_item') }}` → `is_food_item`
///      `{{ TimeDimension('order_date', 'month') }}` → `order_date @ month`
fn translate_filter(filter: &str) -> String {
    let mut out = String::new();
    let mut rest = filter;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let end = match rest[start..].find("}}") {
            Some(e) => start + e + 2,
            None => break,
        };
        let expr = rest[start + 2..end - 2].trim();
        if let Some(args) = expr.strip_prefix("Dimension(") {
            if let Some(clean) = args.strip_suffix(')') {
                out.push_str(clean.trim().trim_matches('\''));
            }
        } else if let Some(args) = expr.strip_prefix("TimeDimension(") {
            let parts: Vec<&str> = args
                .strip_suffix(')')
                .unwrap_or(args)
                .split(',')
                .map(|s| s.trim().trim_matches('\''))
                .collect();
            if !parts.is_empty() {
                let grain = parts.get(1).copied().unwrap_or("");
                if grain.is_empty() {
                    out.push_str(parts[0]);
                } else {
                    out.push_str(&format!("{} @ {}", parts[0], grain));
                }
            }
        } else if let Some(args) = expr.strip_prefix("Entity(") {
            if let Some(clean) = args.strip_suffix(')') {
                out.push_str(clean.trim().trim_matches('\''));
            }
        } else {
            out.push_str(expr);
        }
        rest = &rest[end..];
    }
    out.push_str(rest);
    let cleaned = out.trim().trim_matches(|c| c == ';' || c == ' ' || c == '\n');
    cleaned.to_string()
}

// ============================================================
// Public entry point
// ============================================================

/// Import all dbt MetricFlow definitions found under the given directories
/// into the metrics registry. Returns the number of rows upserted.
pub fn import_dbt_metrics(
    conn: &Connection,
    project_id: &str,
    watch_dirs: &[PathBuf],
) -> Result<DbtImportResult, rusqlite::Error> {
    let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
    let files = discover_dbt_files(watch_dirs);

    let mut model_name_map: HashMap<String, String> = HashMap::new();
    let mut rows: Vec<RegistryRow> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();

    for (path, content) in &files {
        parse_dbt_file(content, &path.display().to_string(), &mut model_name_map, &mut rows, &mut skipped);
    }

    let mut imported = 0usize;
    let mut imported_rows = Vec::new();
    for mut row in rows {
        row.project_id = project_id.to_string();
        let signature = compute_signature(&row.expression, &row.bound_model);
        let dims_json = row.dimensions.clone();
        let upserted = upsert_metric(conn, &row, &signature, &dims_json, &now)?;
        imported += upserted;
        imported_rows.push(serde_json::json!({
            "metric_name": row.metric_name,
            "metric_type": row.metric_type,
            "aggregation": row.aggregation,
            "expression": row.expression,
            "business_filter": row.business_filter,
            "period": row.period,
            "bound_model": row.bound_model,
            "bound_column": row.bound_column,
        }));
    }

    Ok(DbtImportResult {
        imported,
        metrics: imported_rows,
        skipped,
    })
}

/// Insert or update one metric row (idempotent upsert by project_id+metric_name).
fn upsert_metric(
    conn: &Connection,
    row: &RegistryRow,
    signature: &str,
    dims_json: &str,
    now: &str,
) -> Result<usize, rusqlite::Error> {
    let changed = 1usize;
    conn.execute(
        "INSERT INTO metrics_registry
            (project_id, metric_name, metric_type, definition, sql_signature, expression,
             aggregation, business_filter, period, source_tables, dimensions, layer,
             lifecycle, contract_id, bound_model, bound_column, created_at, updated_at, status)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'active', ?13, ?14, ?15, ?16, ?16, 1)
         ON CONFLICT(project_id, metric_name) DO UPDATE SET
            metric_type = excluded.metric_type,
            definition = excluded.definition,
            sql_signature = excluded.sql_signature,
            expression = excluded.expression,
            aggregation = excluded.aggregation,
            business_filter = excluded.business_filter,
            period = excluded.period,
            source_tables = excluded.source_tables,
            dimensions = excluded.dimensions,
            layer = excluded.layer,
            contract_id = excluded.contract_id,
            bound_model = excluded.bound_model,
            bound_column = excluded.bound_column,
            updated_at = excluded.updated_at",
        params![
            row.project_id,
            row.metric_name,
            row.metric_type,
            row.definition,
            signature,
            row.expression,
            row.aggregation,
            row.business_filter,
            row.period,
            row.source_tables,
            dims_json,
            row.layer,
            row.contract_id,
            row.bound_model,
            row.bound_column,
            now,
        ],
    )?;
    Ok(changed)
}

// ============================================================
// Tests
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_semantic_models() -> &'static str {
        r#"
semantic_models:
  - name: orders
    model: ref('fct_orders')
    entities:
      - name: order_id
        type: primary
      - name: customer
        expr: customer_id
        type: foreign
    dimensions:
      - name: order_date
        type: time
        type_params:
          time_granularity: day
      - name: is_food_item
        type: categorical
    measures:
      - name: order_total
        description: The total amount for each order.
        agg: sum
        expr: amount
      - name: order_count
        agg: sum
        expr: "1"
      - name: customers_with_orders
        agg: count_distinct
        expr: customer_id
"#
    }

    fn sample_metrics() -> &'static str {
        r#"
metrics:
  - name: order_total
    description: Sum of orders value
    type: simple
    label: Order Total
    type_params:
      measure:
        name: order_total
  - name: avg_order_value
    label: Avg Order Value
    type: ratio
    type_params:
      numerator:
        name: order_total
      denominator:
        name: order_count
  - name: cumulative_mtd
    type: cumulative
    type_params:
      measure:
        name: order_total
      cumulative_type_params:
        grain_to_date: month
  - name: gross_profit
    type: derived
    type_params:
      expr: order_total - cost
      metrics:
        - name: order_total
  - name: large_orders
    type: simple
    filter: |
      {{ Metric('order_total', group_by=['order_id']) }} >= 20
    type_params:
      measure:
        name: order_count
"#
    }

    #[test]
    fn test_resolve_ref() {
        assert_eq!(resolve_ref("ref('fct_orders')"), "fct_orders");
        assert_eq!(resolve_ref("ref('pkg', 'fct_orders')"), "fct_orders");
        assert_eq!(resolve_ref("source('raw', 'events')"), "events");
        assert_eq!(resolve_ref("fct_orders"), "fct_orders");
    }

    #[test]
    fn test_normalize_agg_and_granularity() {
        assert_eq!(normalize_agg("count_distinct"), "count_distinct");
        assert_eq!(normalize_agg("AVG"), "avg");
        assert_eq!(normalize_agg("median"), "median");
        assert_eq!(map_granularity("day"), "daily");
        assert_eq!(map_granularity("month"), "monthly");
        assert_eq!(map_granularity("week"), "weekly");
    }

    #[test]
    fn test_translate_filter() {
        assert_eq!(translate_filter("{{ Dimension('is_food_item') }}"), "is_food_item");
        assert_eq!(
            translate_filter("{{ TimeDimension('order_date', 'month') }}"),
            "order_date @ month"
        );
        assert_eq!(translate_filter("{{ Entity('customer') }} = 'x'"), "customer = 'x'");
        assert_eq!(translate_filter("{{ Metric('order_total', group_by=['order_id']) }} >= 20"),
            "Metric('order_total', group_by=['order_id']) >= 20");
    }

    #[test]
    fn test_parse_dbt_metrics() {
        let sm: DbtFile = serde_yaml::from_str(sample_semantic_models()).unwrap();
        assert_eq!(sm.semantic_models.len(), 1);
        let orders = &sm.semantic_models[0];
        assert_eq!(orders.model, "ref('fct_orders')");
        assert_eq!(orders.measures.len(), 3);

        let m: DbtFile = serde_yaml::from_str(sample_metrics()).unwrap();
        assert_eq!(m.metrics.len(), 5);
        assert_eq!(m.metrics[0].r#type, "simple");
        assert_eq!(m.metrics[1].r#type, "ratio");
        assert_eq!(m.metrics[3].type_params.expr, "order_total - cost");
    }

    #[test]
    fn test_map_metric_to_row_simple() {
        let sm: DbtFile = serde_yaml::from_str(sample_semantic_models()).unwrap();
        let m: DbtFile = serde_yaml::from_str(sample_metrics()).unwrap();
        let mut model_map = HashMap::new();
        model_map.insert("orders".to_string(), "fct_orders".to_string());

        let sm_orders = &sm.semantic_models[0];
        let measure = &sm_orders.measures[0]; // order_total
        let row = map_metric_to_row(
            &m.metrics[0].name,
            &m.metrics[0],
            Some(sm_orders),
            Some(measure),
            &model_map,
        );

        assert_eq!(row.metric_name, "order_total");
        assert_eq!(row.metric_type, "atomic");
        assert_eq!(row.aggregation, "sum");
        assert_eq!(row.expression, "amount");
        assert_eq!(row.bound_model, "fct_orders");
        assert_eq!(row.bound_column, "amount");
        assert_eq!(row.period, "daily");
        assert_eq!(row.layer, "unknown");
        assert_eq!(row.contract_id, "dbt:fct_orders");
    }

    #[test]
    fn test_map_metric_to_row_ratio_and_count_distinct() {
        let sm: DbtFile = serde_yaml::from_str(sample_semantic_models()).unwrap();
        let m: DbtFile = serde_yaml::from_str(sample_metrics()).unwrap();
        let mut model_map = HashMap::new();
        model_map.insert("orders".to_string(), "fct_orders".to_string());

        let sm_orders = &sm.semantic_models[0];

        // ratio → derived
        let row = map_metric_to_row(
            &m.metrics[1].name,
            &m.metrics[1],
            Some(sm_orders),
            Some(&sm_orders.measures[0]),
            &model_map,
        );
        assert_eq!(row.metric_name, "avg_order_value");
        assert_eq!(row.metric_type, "derived");

        // count_distinct measure
        let row = map_metric_to_row(
            "customers_with_orders",
            &DbtMetric {
                name: "customers_with_orders".into(),
                r#type: "simple".into(),
                type_params: DbtTypeParams { measure: DbtMeasureRef { name: "customers_with_orders".into(), ..Default::default() }, ..Default::default() },
                ..Default::default()
            },
            Some(sm_orders),
            Some(&sm_orders.measures[2]),
            &model_map,
        );
        assert_eq!(row.aggregation, "count_distinct");
        assert_eq!(row.expression, "customer_id");
    }

    #[test]
    fn test_upsert_is_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        super::super::db::init_gov_db(&conn).unwrap();

        let row = RegistryRow {
            project_id: "p1".into(),
            metric_name: "order_total".into(),
            metric_type: "atomic".into(),
            definition: "Sum of orders value".into(),
            expression: "amount".into(),
            aggregation: "sum".into(),
            business_filter: "".into(),
            period: "daily".into(),
            source_tables: "fct_orders".into(),
            dimensions: "[]".into(),
            layer: "unknown".into(),
            contract_id: "dbt:fct_orders".into(),
            bound_model: "fct_orders".into(),
            bound_column: "amount".into(),
        };
        let sig = compute_signature("amount", "fct_orders");
        let n1 = upsert_metric(&conn, &row, &sig, "[]", "2026-01-01T00:00:00Z").unwrap();
        let n2 = upsert_metric(&conn, &row, &sig, "[]", "2026-01-01T00:00:00Z").unwrap();
        assert_eq!(n1, 1);
        assert_eq!(n2, 1);

        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM metrics_registry", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }
}
