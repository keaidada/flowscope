//! Metric management: ODCS metric definitions + conflict detection + CRUD.

use std::collections::{HashMap, HashSet};

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::contract::{Contract, MetricDefinition, SchemaDefinition};

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct MetricEntry {
    pub id: i64,
    pub project_id: String,
    pub metric_name: String,
    pub metric_type: String,
    pub definition: String,
    pub sql_signature: String,
    pub expression: String,
    pub aggregation: String,
    pub business_filter: String,
    pub period: String,
    pub source_tables: String,
    pub dimensions: Vec<String>,
    pub owner: String,
    pub layer: String,
    pub lifecycle: String,
    pub contract_id: String,
    pub bound_model: String,
    pub bound_column: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct MetricConflict {
    pub id: i64,
    pub conflict_type: String,
    pub metric_names: Vec<String>,
    pub detail: serde_json::Value,
    pub resolution: String,
    pub resolved: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct MetricStats {
    pub total: usize,
    pub by_layer: HashMap<String, usize>,
    pub by_owner: HashMap<String, usize>,
    pub by_lifecycle: HashMap<String, usize>,
    pub conflict_count: usize,
}

/// Extract metric definitions from ODCS contracts.
pub fn import_from_contracts(
    conn: &Connection,
    project_id: &str,
    contracts: &[Contract],
) -> Result<usize, rusqlite::Error> {
    let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
    let mut imported = 0usize;

    for contract in contracts {
        for schema in &contract.schema {
            for prop in &schema.properties {
                if let Some(ref metric) = prop.metric {
                    let dims_json = serde_json::to_string(&[] as &[String]).unwrap_or_default();
                    let signature = compute_signature(&metric.expression, &schema.name);

                    conn.execute(
                        "INSERT INTO metrics_registry
                            (project_id, metric_name, definition, sql_signature, expression, aggregation,
                             source_tables, dimensions, layer, lifecycle, contract_id, bound_model, bound_column,
                             created_at, updated_at, status)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'active', ?10, ?11, ?12, ?13, ?13, 1)
                         ON CONFLICT(project_id, metric_name) DO UPDATE SET
                            definition = excluded.definition,
                            sql_signature = excluded.sql_signature,
                            expression = excluded.expression,
                            aggregation = excluded.aggregation,
                            contract_id = excluded.contract_id,
                            bound_model = excluded.bound_model,
                            bound_column = excluded.bound_column,
                            updated_at = excluded.updated_at",
                        params![
                            project_id,
                            metric.name,
                            metric.description,
                            signature,
                            metric.expression,
                            metric.aggregation,
                            schema.name,
                            dims_json,
                            super::model::infer_layer(&schema.name),
                            contract.id,
                            schema.name,
                            prop.name,
                            now,
                        ],
                    )?;
                    imported += 1;
                }
            }
        }
    }

    Ok(imported)
}

/// Auto-detect metrics from analysis results.
/// Scans for aggregation columns and registers them as atomic metrics,
/// extracting business filters and time periods where available.
pub fn auto_detect_metrics(
    conn: &Connection,
    project_id: &str,
    file_results: &[(String, capybara_core::AnalyzeResult)],
) -> Result<usize, rusqlite::Error> {
    let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
    let mut detected = 0usize;

    for (_file_path, result) in file_results {
        for stmt in &result.statements {
            // Collect source table names from table nodes
            let source_tables: Vec<String> = stmt
                .nodes
                .iter()
                .filter(|n| n.node_type == capybara_core::NodeType::Table)
                .map(|n| n.label.as_ref().to_string())
                .collect();

            // Collect all grouping dimensions
            let dims: Vec<String> = stmt
                .nodes
                .iter()
                .filter_map(|n| {
                    n.aggregation.as_ref().and_then(|a| {
                        if a.is_grouping_key {
                            Some(n.label.as_ref().to_string())
                        } else {
                            None
                        }
                    })
                })
                .collect();

            // Detect time period from group-by columns
            let period = if dims.iter().any(|d| {
                let dl = d.to_lowercase();
                dl.contains("dt") || dl.contains("date") || dl.contains("time") || dl == "day" || dl == "month"
            }) {
                "daily"
            } else {
                ""
            };

            // Collect filter expressions from node filters
            let filter_texts: Vec<String> = stmt
                .nodes
                .iter()
                .flat_map(|n| &n.filters)
                .map(|f| f.expression.clone())
                .collect();
            let filter_str = filter_texts.join("; ");

            // Process each aggregation column
            for node in &stmt.nodes {
                let agg = match &node.aggregation {
                    Some(a) => {
                        if a.is_grouping_key || a.function.is_none() {
                            continue;
                        }
                        a
                    }
                    None => continue,
                };

                let col_name = node.label.as_ref();
                let mut agg_func = agg.function.as_deref().unwrap_or("UNKNOWN").to_string();
                let is_distinct = agg.distinct.unwrap_or(false);

                // Handle COUNT(DISTINCT ...) as a distinct metric type
                if is_distinct {
                    agg_func = format!("{}_DISTINCT", agg_func);
                }

                // Use qualified_name or first source table as parent model
                let parent_table = source_tables.first().map(|s| s.as_str()).unwrap_or("unknown");
                let metric_name = format!("{}_{}_{}", parent_table, col_name, agg_func).to_lowercase();

                let metric_type = if is_distinct { "distinct" } else { "atomic" };

                let signature = compute_signature(&agg_func, col_name);

                conn.execute(
                    "INSERT INTO metrics_registry
                        (project_id, metric_name, metric_type, definition, sql_signature, expression,
                         aggregation, business_filter, period, source_tables, dimensions, layer,
                         lifecycle, bound_model, bound_column, created_at, updated_at, status)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'active', ?13, ?14, ?15, ?15, 1)
                     ON CONFLICT(project_id, metric_name) DO UPDATE SET
                        aggregation = excluded.aggregation,
                        expression = excluded.expression,
                        business_filter = excluded.business_filter,
                        period = excluded.period,
                        source_tables = excluded.source_tables,
                        dimensions = excluded.dimensions,
                        bound_model = excluded.bound_model,
                        bound_column = excluded.bound_column,
                        updated_at = excluded.updated_at",
                    rusqlite::params![
                        project_id,
                        metric_name,
                        metric_type,
                        &metric_name,
                        signature,
                        agg_func,
                        agg_func,
                        filter_str,
                        period.to_string(),
                        source_tables.join(","),
                        serde_json::to_string(&dims).unwrap_or_default(),
                        super::model::infer_layer(&source_tables.join("_")),
                        parent_table,
                        col_name,
                        now,
                    ],
                )?;
                detected += 1;
            }
        }
    }

    Ok(detected)
}

/// Simple SQL signature: hash the expression for conflict detection.
pub fn compute_signature(expression: &str, table: &str) -> String {
    let combined = format!("{table}:{expression}");
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(combined.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// List metrics with optional filters.
pub fn list_metrics(
    conn: &Connection,
    project_id: &str,
    layer: Option<&str>,
    owner: Option<&str>,
    query: Option<&str>,
    contract_id: Option<&str>,
) -> Result<Vec<MetricEntry>, rusqlite::Error> {
    let mut sql = String::from(
        "SELECT id, project_id, metric_name, metric_type, definition, sql_signature, expression, aggregation,
                business_filter, period, source_tables, dimensions, owner, layer, lifecycle, contract_id, bound_model, bound_column
         FROM metrics_registry WHERE project_id = ?1 AND status = 1",
    );
    let mut idx = 2;
    let mut params_vec: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(project_id.to_string())];

    if let Some(l) = layer {
        sql.push_str(&format!(" AND layer = ?{idx}"));
        params_vec.push(Box::new(l.to_string()));
        idx += 1;
    }
    if let Some(o) = owner {
        sql.push_str(&format!(" AND owner = ?{idx}"));
        params_vec.push(Box::new(o.to_string()));
        idx += 1;
    }
    if let Some(q) = query {
        sql.push_str(&format!(" AND (metric_name LIKE ?{idx} OR definition LIKE ?{idx})"));
        params_vec.push(Box::new(format!("%{q}%")));
        idx += 1;
    }
    if let Some(cid) = contract_id {
        sql.push_str(&format!(" AND contract_id = ?{idx}"));
        params_vec.push(Box::new(cid.to_string()));
    }
    sql.push_str(" ORDER BY metric_name");

    let mut stmt = conn.prepare(&sql)?;
    let param_refs: Vec<&dyn rusqlite::ToSql> = params_vec.iter().map(|p| p.as_ref()).collect();
    let rows = stmt.query_map(param_refs.as_slice(), |row| {
        let dims_json: String = row.get(11)?;
        let dims: Vec<String> = serde_json::from_str(&dims_json).unwrap_or_default();
        Ok(MetricEntry {
            id: row.get(0)?,
            project_id: row.get(1)?,
            metric_name: row.get(2)?,
            metric_type: row.get::<_, String>(3).unwrap_or_default(),
            definition: row.get(4)?,
            sql_signature: row.get(5)?,
            expression: row.get(6)?,
            aggregation: row.get(7)?,
            business_filter: row.get::<_, String>(8).unwrap_or_default(),
            period: row.get::<_, String>(9).unwrap_or_default(),
            source_tables: row.get(10)?,
            dimensions: dims,
            owner: row.get(12)?,
            layer: row.get(13)?,
            lifecycle: row.get(14)?,
            contract_id: row.get(15)?,
            bound_model: row.get(16)?,
            bound_column: row.get(17)?,
        })
    })?;

    rows.collect()
}

/// Detect metric conflicts (same name different signature, or different name same signature).
pub fn detect_conflicts(conn: &Connection, project_id: &str) -> Result<Vec<MetricConflict>, rusqlite::Error> {
    let metrics = list_metrics(conn, project_id, None, None, None, None)?;
    let mut conflicts = Vec::new();

    // Group by signature
    let mut by_sig: HashMap<&str, Vec<&MetricEntry>> = HashMap::new();
    for m in &metrics {
        by_sig.entry(m.sql_signature.as_str()).or_default().push(m);
    }

    for (_sig, group) in &by_sig {
        if group.len() > 1 {
            // Different names, same signature → 异名同义
            let names: Vec<String> = group.iter().map(|m| m.metric_name.clone()).collect();
            let names_unique: Vec<&str> = group.iter().map(|m| m.metric_name.as_str()).collect();
            if names_unique.iter().collect::<std::collections::HashSet<_>>().len() > 1 {
                conflicts.push(MetricConflict {
                    id: 0,
                    conflict_type: "异名同义".to_string(),
                    metric_names: names,
                    detail: serde_json::json!({
                        "signature": _sig,
                        "expression": group[0].expression,
                    }),
                    resolution: String::new(),
                    resolved: false,
                });
            }
        }
    }

    Ok(conflicts)
}

/// Get metric statistics.
pub fn get_metric_stats(conn: &Connection, project_id: &str) -> Result<MetricStats, rusqlite::Error> {
    let metrics = list_metrics(conn, project_id, None, None, None, None)?;
    let conflicts = detect_conflicts(conn, project_id)?;

    let mut stats = MetricStats {
        total: metrics.len(),
        by_layer: HashMap::new(),
        by_owner: HashMap::new(),
        by_lifecycle: HashMap::new(),
        conflict_count: conflicts.len(),
    };

    for m in &metrics {
        *stats.by_layer.entry(m.layer.clone()).or_default() += 1;
        *stats.by_owner.entry(m.owner.clone()).or_default() += 1;
        *stats.by_lifecycle.entry(m.lifecycle.clone()).or_default() += 1;
    }

    Ok(stats)
}

// ============================================================
// Script-level summaries (lightweight, for lazy loading)
// ============================================================

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ScriptSummary {
    pub contract_id: String,
    pub script_name: String,
    pub metric_count: usize,
    pub table_count: usize,
}

/// List all scripts with counts — lightweight, no table/metric details.
pub fn list_script_summaries(
    conn: &Connection,
    project_id: &str,
) -> Result<Vec<ScriptSummary>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT COALESCE(contract_id, '') as cid,
                COUNT(*) as cnt,
                COUNT(DISTINCT bound_model) as tbl_cnt
         FROM metrics_registry
         WHERE project_id = ?1 AND status = 1
         GROUP BY cid
         ORDER BY cnt DESC",
    )?;
    let rows = stmt.query_map(params![project_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)? as usize,
            row.get::<_, i64>(2)? as usize,
        ))
    })?;

    let mut result = Vec::new();
    for row in rows {
        let (cid, cnt, tbl_cnt) = row?;
        let script_name = if cid.is_empty() {
            "(auto)".to_string()
        } else if let Some(path) = cid.strip_prefix("lineage:") {
            path.rsplit('/').next().unwrap_or(path).to_string()
        } else {
            cid.clone()
        };
        result.push(ScriptSummary {
            contract_id: cid,
            script_name,
            metric_count: cnt,
            table_count: tbl_cnt,
        });
    }
    Ok(result)
}
// ============================================================

/// Row extracted from lineage_edges.
struct ExtractedRow {
    expression: String,
    file_path: String,
    output_col: String,
    output_table: String,
    #[allow(dead_code)]
    output_type: String,
    source_col: String,
    source_table: String,
}

/// Parsed expression classification.
enum ParsedExpr {
    Atomic { agg: String, inner: String },
    Derived,
    NotMetric,
}

/// Parse an SQL expression to classify it as an atomic aggregation,
/// a compound/derived expression, or not a metric at all.
fn parse_metric_expression(expr: &str) -> ParsedExpr {
    let trimmed = expr.trim();
    let lower = trimmed.to_lowercase();

    let aggs = ["sum", "count", "avg", "average", "min", "max"];

    for agg in &aggs {
        let prefix = format!("{}(", agg);
        if lower.starts_with(&prefix) {
            // Find matching closing paren for the first '('.
            let open_pos = agg.len();
            let mut depth = 0i32;
            let mut close_pos = None;
            for (i, c) in trimmed[open_pos..].char_indices() {
                match c {
                    '(' => depth += 1,
                    ')' => {
                        depth -= 1;
                        if depth == 0 {
                            close_pos = Some(open_pos + i);
                            break;
                        }
                    }
                    _ => {}
                }
            }

            if let Some(cp) = close_pos {
                let inner = trimmed[open_pos + 1..cp].trim();
                let trailing = trimmed[cp + 1..].trim();

                if trailing.is_empty() {
                    let (clean_inner, is_distinct) =
                        if inner.to_lowercase().strip_prefix("distinct ").is_some() {
                            (inner[9..].trim(), true)
                        } else {
                            (inner, false)
                        };

                    let agg_name = match (*agg, is_distinct) {
                        ("count", true) => "count_distinct",
                        ("average", _) => "avg",
                        (a, _) => a,
                    };

                    return ParsedExpr::Atomic {
                        agg: agg_name.to_string(),
                        inner: strip_table_alias(clean_inner),
                    };
                }
                // trailing content → compound like "sum(a) + sum(b)"
                return ParsedExpr::Derived;
            }
        }
    }

    // Doesn't start with a known aggregation but may contain one → derived.
    if lower.contains("sum(")
        || lower.contains("count(")
        || lower.contains("avg(")
        || lower.contains("average(")
        || lower.contains("max(")
        || lower.contains("min(")
    {
        ParsedExpr::Derived
    } else {
        ParsedExpr::NotMetric
    }
}

/// Strip a simple table alias from a column reference: `tab1.pid` → `pid`.
/// Leaves complex expressions (CASE WHEN, spaces) untouched.
fn strip_table_alias(expr: &str) -> String {
    if expr.contains(' ') || expr.to_lowercase().contains("case") {
        return expr.to_string();
    }
    if let Some(pos) = expr.rfind('.') {
        expr[pos + 1..].to_string()
    } else {
        expr.to_string()
    }
}

/// Extract business filter conditions from CASE WHEN patterns in an expression.
///
/// `SUM(CASE WHEN fee_code = 'F0001' THEN price ELSE 0 END)`
///   → `fee_code = 'F0001'`
///
/// Filters out boilerplate conditions (`is_deleted = 0`, `_sign = 1`, etc.)
/// and limits to the 5 most meaningful conditions to keep the filter readable.
fn extract_business_filter(expr: &str) -> String {
    let lower = expr.to_lowercase();
    if !lower.contains("case when") {
        return String::new();
    }

    // Patterns that are boilerplate, not meaningful business logic.
    const NOISE_PATTERNS: &[&str] = &[
        "is_deleted", "is_delete", "_sign", "is_valid", "is_active",
        "row_rank", "rownum", "rk =", "rn =",
    ];

    let mut conditions: Vec<String> = Vec::new();
    let mut search_from = 0usize;

    while let Some(rel_pos) = lower[search_from..].find("when") {
        let abs_pos = search_from + rel_pos + 4;
        if abs_pos >= expr.len() {
            break;
        }
        let after_when = &expr[abs_pos..];
        let after_lower = after_when.to_lowercase();

        if let Some(then_rel) = after_lower.find("then") {
            let condition = after_when[..then_rel].trim();
            let cleaned = clean_condition(condition);
            // Skip empty / trivially-true / boilerplate conditions.
            let is_noise = cleaned.is_empty()
                || cleaned == "1"
                || cleaned == "true"
                || NOISE_PATTERNS.iter().any(|p| cleaned.to_lowercase().contains(p));
            if !is_noise {
                conditions.push(cleaned);
            }
            search_from = abs_pos + then_rel + 4;
        } else {
            break;
        }
    }

    // Deduplicate while preserving order.
    let mut seen = HashSet::new();
    conditions.retain(|c| seen.insert(c.clone()));

    // Keep at most 5 conditions, truncate total length.
    let result = conditions.iter().take(5).cloned().collect::<Vec<_>>().join("; ");
    if result.chars().count() > 200 {
        let truncated: String = result.chars().take(200).collect();
        format!("{truncated}...")
    } else {
        result
    }
}

/// Clean a CASE WHEN condition: strip backticks, collapse whitespace.
fn clean_condition(cond: &str) -> String {
    cond.replace(['`', '"'], "")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Infer metric owner / business domain from the file path.
///
/// `etl/M01_接口集市库-BI/M01_ACCM_USR.HQL` → `M01_接口集市库-BI`
/// `dqc/DQC_数据质量检查区/DQC_CHK.HQL`       → `DQC_数据质量检查区`
fn infer_owner_from_path(file_path: &str) -> String {
    let normalized = file_path.replace('\\', "/");
    let segments: Vec<&str> = normalized.split('/').filter(|s| !s.is_empty()).collect();
    // Use the parent directory of the file (usually the module/team directory).
    if segments.len() >= 2 {
        return segments[segments.len() - 2].to_string();
    }
    if segments.len() == 1 {
        return segments[0].to_string();
    }
    String::new()
}

/// Build a unique metric name from output table + output column (+ fallback).
fn build_metric_name(output_table: &str, output_col: &str, agg: &str, source_col: &str) -> String {
    let generic = matches!(
        output_col.to_lowercase().as_str(),
        "sum" | "count" | "avg" | "average" | "min" | "max" | "" | "cnt" | "value" | "result"
    );

    let name = if generic {
        let src = if source_col.is_empty() || source_col == "*" {
            "all"
        } else {
            &strip_table_alias(source_col)
        };
        format!("{output_table}_{src}_{agg}")
    } else {
        format!("{output_table}_{output_col}")
    };

    name.to_lowercase().replace([' ', '.', '`', '"'], "_")
}

/// Infer time period from table / column naming conventions.
fn infer_period(table: &str, column: &str) -> String {
    let combined = format!("{table} {column}").to_lowercase();
    if combined.contains("hour") {
        "hourly"
    } else if combined.contains("day") || combined.contains("_dt") || combined.contains("daily") {
        "daily"
    } else if combined.contains("week") {
        "weekly"
    } else if combined.contains("month") || combined.contains("_mon") {
        "monthly"
    } else if combined.contains("quarter") {
        "quarterly"
    } else if combined.contains("year") || combined.contains("annual") {
        "yearly"
    } else {
        ""
    }
    .to_string()
}

/// Extract metrics from column-level lineage data stored in the main DB.
///
/// Uses three lightweight queries (no JOINs) + in-memory HashMap lookups
/// to resolve column/table names, then upserts normalized metrics in a
/// single transaction. This covers **all** analysed files (no 500-file
/// limit) and is far faster than re-parsing SQL.
pub fn extract_metrics_from_lineage(
    main_conn: &Connection,
    gov_conn: &Connection,
    project_id: &str,
) -> Result<usize, rusqlite::Error> {
    let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();

    // --- 1. Load column lookup: column_id → (label, parent_node_id) ---
    let mut col_label: HashMap<String, String> = HashMap::new();
    let mut col_parent: HashMap<String, String> = HashMap::new();
    {
        let mut stmt = main_conn.prepare(
            "SELECT column_id, label, COALESCE(parent_node_id, '')
             FROM lineage_columns WHERE project_id = ?1 AND status = 1",
        )?;
        let rows = stmt.query_map(params![project_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))
        })?;
        for row in rows {
            let (id, label, parent) = row?;
            col_label.insert(id.clone(), label);
            col_parent.insert(id, parent);
        }
    }

    // --- 2. Load node lookup: node_id → (label, node_type) ---
    let mut node_label: HashMap<String, String> = HashMap::new();
    {
        let mut stmt = main_conn.prepare(
            "SELECT node_id, label FROM lineage_nodes WHERE project_id = ?1 AND status = 1",
        )?;
        let rows = stmt.query_map(params![project_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (id, label) = row?;
            node_label.insert(id, label);
        }
    }

    // Helper closures for resolving references.
    let resolve_col = |id: &str| -> String {
        col_label.get(id).cloned().unwrap_or_default()
    };
    let resolve_table_for = |id: &str| -> String {
        // If id is a column, trace to its parent node; if id is itself a node, use directly.
        if let Some(parent) = col_parent.get(id) {
            if !parent.is_empty() {
                return node_label.get(parent).cloned().unwrap_or_default();
            }
        }
        node_label.get(id).cloned().unwrap_or_default()
    };

    // --- 3. Query aggregation edges (no JOINs, fast table scan) ---
    let mut stmt = main_conn.prepare(
        "SELECT DISTINCT expression, COALESCE(to_id, ''), COALESCE(from_id, ''), COALESCE(file_path, '')
         FROM lineage_edges
         WHERE project_id = ?1 AND status = 1
           AND expression IS NOT NULL AND length(expression) > 0
           AND LOWER(edge_type) = 'derivation'
           AND (LOWER(expression) LIKE '%sum(%' OR LOWER(expression) LIKE '%count(%'
             OR LOWER(expression) LIKE '%avg(%' OR LOWER(expression) LIKE '%average(%'
             OR LOWER(expression) LIKE '%max(%' OR LOWER(expression) LIKE '%min(%')",
    )?;
    let rows = stmt.query_map(params![project_id], |row| {
        Ok((
            row.get::<_, String>(0)?,  // expression
            row.get::<_, String>(1)?,  // to_id
            row.get::<_, String>(2)?,  // from_id
            row.get::<_, String>(3)?,  // file_path
        ))
    })?;

    // --- 4. Collect + deduplicate by (output_table, output_col) ---
    let mut seen: HashSet<String> = HashSet::new();
    let mut metrics: Vec<ExtractedRow> = Vec::new();
    for row in rows {
        let (expression, to_id, from_id, file_path) = row?;
        let output_col = resolve_col(&to_id);
        if output_col.is_empty() {
            continue;
        }
        let output_table = resolve_table_for(&to_id);
        let key = format!("{}|{}", output_table, output_col);
        if seen.insert(key) {
            metrics.push(ExtractedRow {
                expression,
                file_path,
                output_col,
                output_table,
                output_type: String::new(),
                source_col: resolve_col(&from_id),
                source_table: resolve_table_for(&from_id),
            });
        }
    }

    // --- 5. Parse + normalize + upsert in a single transaction ---
    gov_conn.execute_batch("BEGIN")?;
    let result = (|| {
        let mut count = 0usize;
        for m in &metrics {
            let parsed = parse_metric_expression(&m.expression);
            let (metric_type, agg, inner_expr) = match parsed {
                ParsedExpr::NotMetric => continue,
                ParsedExpr::Atomic { agg, inner } => ("atomic", agg, inner),
                ParsedExpr::Derived => ("derived", String::new(), String::new()),
            };

            let metric_name =
                build_metric_name(&m.output_table, &m.output_col, &agg, &m.source_col);
            let signature = compute_signature(&m.expression, &m.output_table);
            let layer = super::model::infer_layer(&m.output_table);
            let period = infer_period(&m.output_table, &m.output_col);

            // Extract business filter from CASE WHEN conditions.
            let business_filter = extract_business_filter(&m.expression);

            // Infer owner/domain from file path.
            let owner = infer_owner_from_path(&m.file_path);

            let definition = if metric_type == "atomic" {
                if business_filter.is_empty() {
                    format!("{agg}({inner_expr}) → {}.{}", m.output_table, m.output_col)
                } else {
                    format!("{agg}({inner_expr}) [{business_filter}] → {}.{}", m.output_table, m.output_col)
                }
            } else {
                if business_filter.is_empty() {
                    format!("derived → {}.{}", m.output_table, m.output_col)
                } else {
                    format!("derived [{business_filter}] → {}.{}", m.output_table, m.output_col)
                }
            };
            let definition = if definition.chars().count() > 200 {
                let truncated: String = definition.chars().take(200).collect();
                format!("{truncated}...")
            } else {
                definition
            };

            let contract_id = if m.file_path.is_empty() {
                "lineage".to_string()
            } else {
                format!("lineage:{}", m.file_path)
            };

            gov_conn.execute(
                "INSERT INTO metrics_registry
                    (project_id, metric_name, metric_type, definition, sql_signature, expression,
                     aggregation, business_filter, period, source_tables, dimensions, owner, layer,
                     lifecycle, contract_id, bound_model, bound_column, created_at, updated_at, status)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, '[]', ?11, ?12, 'active', ?13, ?14, ?15, ?16, ?16, 1)
                 ON CONFLICT(project_id, metric_name) DO UPDATE SET
                    metric_type = excluded.metric_type,
                    definition = excluded.definition,
                    sql_signature = excluded.sql_signature,
                    expression = excluded.expression,
                    aggregation = excluded.aggregation,
                    business_filter = excluded.business_filter,
                    period = excluded.period,
                    source_tables = excluded.source_tables,
                    owner = excluded.owner,
                    layer = excluded.layer,
                    contract_id = excluded.contract_id,
                    bound_model = excluded.bound_model,
                    bound_column = excluded.bound_column,
                    updated_at = excluded.updated_at",
                params![
                    project_id,
                    metric_name,
                    metric_type,
                    definition,
                    signature,
                    m.expression,
                    if metric_type == "atomic" { agg.as_str() } else { "" },
                    business_filter,
                    period,
                    m.source_table,
                    owner,
                    layer,
                    contract_id,
                    m.output_table,
                    m.output_col,
                    now,
                ],
            )?;
            count += 1;
        }
        Ok(count)
    })();

    match result {
        Ok(n) => {
            gov_conn.execute_batch("COMMIT")?;
            Ok(n)
        }
        Err(e) => {
            let _ = gov_conn.execute_batch("ROLLBACK");
            Err(e)
        }
    }
}

// ============================================================
// Metric Intelligence: global analysis + problem discovery
// ============================================================

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct MetricAnalysis {
    pub quality: MetricQuality,
    pub duplicates: Vec<DuplicateGroup>,
    pub families: Vec<MetricFamily>,
    pub model_loads: Vec<ModelLoad>,
    pub tips: Vec<OptimizationTip>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct MetricQuality {
    pub total: usize,
    pub filter_pct: f64,
    pub owner_pct: f64,
    pub period_pct: f64,
    pub duplicate_metric_count: usize,
    pub conflict_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct DuplicateGroup {
    pub dup_type: String,
    pub aggregation: String,
    pub normalized_expr: String,
    pub metric_names: Vec<String>,
    pub metric_count: usize,
    pub bound_models: Vec<String>,
    pub suggestion: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct MetricFamily {
    pub bound_model: String,
    pub pattern: String,
    pub count: usize,
    pub columns: Vec<String>,
    pub column_count: usize,
    pub suggestion: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ModelLoad {
    pub table_name: String,
    pub metric_count: usize,
    pub source_count: usize,
    pub agg_types: Vec<String>,
    pub load_level: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct OptimizationTip {
    pub tip_type: String,
    pub severity: String,
    pub title: String,
    pub description: String,
    pub affected_count: usize,
}

/// Normalize an SQL expression for duplicate comparison.
///
/// Strips string/number literals (→ `?`), table aliases (`a.col` → `col`),
/// backticks/quotes, and collapses whitespace. This makes expressions that
/// differ only in literal values or table aliases compare as equal.
///
/// `max(CASE WHEN fee_code = 'F0001' THEN price ELSE 0 END)`
///   → `max(case when fee_code = ? then price else ? end)`
fn normalize_expression(expr: &str) -> String {
    let lower = expr.to_lowercase();

    // Phase 1: Replace string literals with ?
    let mut phase1 = String::with_capacity(lower.len());
    let mut in_str = false;
    for c in lower.chars() {
        if c == '\'' {
            if in_str {
                phase1.push('?');
                in_str = false;
            } else {
                in_str = true;
            }
        } else if !in_str {
            phase1.push(c);
        }
    }

    // Phase 2: strip backticks/quotes, collapse table aliases, replace numbers
    let mut phase2 = String::with_capacity(phase1.len());
    let mut token = String::new();
    for c in phase1.chars() {
        if c.is_alphanumeric() || c == '_' || c == '.' {
            token.push(c);
        } else {
            flush_token(&mut phase2, &mut token);
            if c != '`' && c != '"' {
                phase2.push(c);
            }
        }
    }
    flush_token(&mut phase2, &mut token);

    // Phase 3: collapse whitespace + remove spaces around punctuation
    let collapsed = phase2.split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed
        .replace("( ", "(")
        .replace(" )", ")")
        .replace(" ,", ",")
        .replace(" ;", ";")
}

/// Write a token to the output buffer, applying alias-stripping and
/// numeric-literal replacement.
fn flush_token(out: &mut String, token: &mut String) {
    if token.is_empty() {
        return;
    }
    // Strip table alias: keep only the part after the last dot.
    let cleaned = match token.rfind('.') {
        Some(pos) => &token[pos + 1..],
        None => token.as_str(),
    };
    // Replace pure-numeric tokens with ?
    if !cleaned.is_empty() && cleaned.chars().all(|c| c.is_ascii_digit()) {
        out.push('?');
    } else {
        out.push_str(cleaned);
    }
    token.clear();
}

/// Run full metric intelligence analysis for a project.
pub fn analyze_metrics(
    gov_conn: &Connection,
    project_id: &str,
) -> Result<MetricAnalysis, rusqlite::Error> {
    let metrics = list_metrics(gov_conn, project_id, None, None, None, None)?;
    let conflicts = detect_conflicts(gov_conn, project_id)?;

    // --- Quality scorecard ---
    let total = metrics.len();
    let has_filter = metrics.iter().filter(|m| !m.business_filter.is_empty()).count();
    let has_owner = metrics.iter().filter(|m| !m.owner.is_empty()).count();
    let has_period = metrics.iter().filter(|m| !m.period.is_empty()).count();

    let quality = MetricQuality {
        total,
        filter_pct: pct(has_filter, total),
        owner_pct: pct(has_owner, total),
        period_pct: pct(has_period, total),
        duplicate_metric_count: 0, // filled below
        conflict_count: conflicts.len(),
    };

    // --- Duplicate detection ---
    // Group by (aggregation, normalized_expression)
    let mut groups: HashMap<(String, String), Vec<&MetricEntry>> = HashMap::new();
    for m in &metrics {
        if m.expression.is_empty() {
            continue;
        }
        let norm = normalize_expression(&m.expression);
        let agg = m.aggregation.to_lowercase();
        groups.entry((agg, norm)).or_default().push(m);
    }

    let mut duplicates = Vec::new();
    let mut families = Vec::new();
    let mut dup_metric_count = 0usize;

    for ((agg, norm), group) in &groups {
        if group.len() < 2 {
            continue;
        }

        let models: Vec<String> = group
            .iter()
            .map(|m| m.bound_model.clone())
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();

        let metric_names: Vec<String> = group.iter().map(|m| m.metric_name.clone()).collect();
        let metric_total = metric_names.len();
        dup_metric_count += metric_total;

        if models.len() > 1 {
            // Cross-model duplicate: same logic in different models
            duplicates.push(DuplicateGroup {
                dup_type: "cross_model".into(),
                aggregation: agg.clone(),
                normalized_expr: norm.clone(),
                metric_names: metric_names.clone(),
                metric_count: metric_total,
                bound_models: models.clone(),
                suggestion: format!(
                    "相同逻辑在 {} 个模型中重复计算，建议统一为单一指标",
                    models.len()
                ),
            });
        } else if group.len() >= 3 {
            // Metric family: ≥3 metrics with same pattern on same model
            let model = &models[0];
            let columns: Vec<String> = group.iter().map(|m| m.bound_column.clone()).collect();
            let col_total = columns.len();
            families.push(MetricFamily {
                bound_model: model.clone(),
                pattern: norm.clone(),
                count: group.len(),
                columns: columns.clone(),
                column_count: col_total,
                suggestion: format!(
                    "{} 个指标使用相同模式，建议参数化为单一指标+维度",
                    group.len()
                ),
            });
        } else {
            // Same-model duplicate (2 metrics)
            duplicates.push(DuplicateGroup {
                dup_type: "same_model".into(),
                aggregation: agg.clone(),
                normalized_expr: norm.clone(),
                metric_names,
                metric_count: metric_total,
                bound_models: models,
                suggestion: "相同模型内有重复指标逻辑".into(),
            });
        }
    }

    // --- Model load analysis ---
    let mut model_map: HashMap<&str, Vec<&MetricEntry>> = HashMap::new();
    for m in &metrics {
        if !m.bound_model.is_empty() {
            model_map.entry(m.bound_model.as_str()).or_default().push(m);
        }
    }

    let mut model_loads: Vec<ModelLoad> = model_map
        .iter()
        .map(|(table, ms)| {
            let source_count = ms
                .iter()
                .flat_map(|m| m.source_tables.split(','))
                .map(|s| s.trim().to_lowercase())
                .filter(|s| !s.is_empty())
                .collect::<HashSet<_>>()
                .len();
            let agg_types: Vec<String> = ms
                .iter()
                .map(|m| m.aggregation.clone())
                .filter(|a| !a.is_empty())
                .collect::<HashSet<_>>()
                .into_iter()
                .collect();
            let load_level = if ms.len() > 10 || source_count > 10 {
                "heavy"
            } else if ms.len() > 5 || source_count > 5 {
                "moderate"
            } else {
                "light"
            };
            ModelLoad {
                table_name: table.to_string(),
                metric_count: ms.len(),
                source_count,
                agg_types,
                load_level: load_level.into(),
            }
        })
        .filter(|ml| ml.load_level != "light")
        .collect();

    model_loads.sort_by(|a, b| b.metric_count.cmp(&a.metric_count));

    // --- Truncate BEFORE generating tips (so tips reference limited data) ---
    duplicates.sort_by(|a, b| b.metric_count.cmp(&a.metric_count));
    for d in &mut duplicates {
        d.metric_names.truncate(10);
        if d.normalized_expr.len() > 200 {
            d.normalized_expr.truncate(200);
            d.normalized_expr.push_str("...");
        }
    }
    duplicates.truncate(30);

    families.sort_by(|a, b| b.count.cmp(&a.count));
    for f in &mut families {
        f.columns.truncate(15);
        if f.pattern.len() > 200 {
            f.pattern.truncate(200);
            f.pattern.push_str("...");
        }
    }
    families.truncate(15);

    model_loads.truncate(30);

    // --- Optimization tips (built from already-truncated data) ---
    let mut tips = Vec::new();

    // Cross-model dedup tips
    let cross_dups: Vec<&DuplicateGroup> = duplicates.iter().filter(|d| d.dup_type == "cross_model").collect();
    if !cross_dups.is_empty() {
        let affected_count: usize = cross_dups.iter().map(|d| d.metric_count).sum();
        tips.push(OptimizationTip {
            tip_type: "dedup".into(),
            severity: "high".into(),
            title: "跨模型重复计算".into(),
            description: format!(
                "发现 {} 组跨模型重复指标，相同逻辑在多个模型中重复计算，浪费计算资源",
                cross_dups.len()
            ),
            affected_count,
        });
    }

    // Metric family merge tips
    for f in &families {
        if f.count >= 5 {
            tips.push(OptimizationTip {
                tip_type: "merge".into(),
                severity: "medium".into(),
                title: format!("指标族可参数化: {}", f.bound_model),
                description: f.suggestion.clone(),
                affected_count: f.column_count,
            });
        }
    }

    // Model split tips
    for ml in &model_loads {
        if ml.load_level == "heavy" && ml.source_count > 15 {
            tips.push(OptimizationTip {
                tip_type: "split".into(),
                severity: if ml.source_count > 20 { "high" } else { "medium" }.into(),
                title: format!("模型过载: {} ({} 张源表)", ml.table_name, ml.source_count),
                description: format!(
                    "该模型依赖 {} 张源表，产出 {} 个指标，建议拆分为多个子模型",
                    ml.source_count, ml.metric_count
                ),
                affected_count: ml.metric_count,
            });
        }
    }

    // Owner assignment tip
    if quality.owner_pct < 100.0 {
        let missing = total - has_owner;
        tips.push(OptimizationTip {
            tip_type: "assign_owner".into(),
            severity: "low".into(),
            title: "缺少负责人".into(),
            description: format!("{} 个指标未分配负责人/域", missing),
            affected_count: missing,
        });
    }

    tips.truncate(15);

    Ok(MetricAnalysis {
        quality: MetricQuality {
            duplicate_metric_count: dup_metric_count,
            ..quality
        },
        duplicates,
        families,
        model_loads,
        tips,
    })
}

fn pct(n: usize, total: usize) -> f64 {
    if total == 0 {
        0.0
    } else {
         (n as f64 / total as f64 * 100.0 * 10.0).round() / 10.0
     }
  }

// ============================================================
// Script metric extraction (real, from AnalyzeResult)
// ============================================================

/// A metric extracted from a script's analysis result.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ScriptMetric {
    pub name: String,
    pub expression: String,
    pub agg_func: String,
    pub distinct: bool,
    pub source_table: String,
    pub column: String,
    pub business_filter: String,
    pub period: String,
}

/// Extract metrics for a single script by querying persisted lineage tables
/// (`lineage_edges` derivation edges + `lineage_columns` + `lineage_nodes`).
///
/// All queries are scoped by (project_id, file_path) and use indexed columns
/// (idx_lineage_edges_path / idx_lineage_columns_parent / idx_lineage_nodes_node)
/// — no full-table scans.
///
/// A derivation edge whose expression is an aggregation (SUM/COUNT/AVG/MIN/MAX,
/// possibly wrapped in IF()/CASE WHEN) represents a real metric. The edge's
/// `from_id` resolves to a source column whose parent node is the source table.
pub fn extract_script_metrics_from_lineage(
    conn: &Connection,
    project_id: &str,
    file_path: &str,
) -> Vec<ScriptMetric> {
    let mut metrics: Vec<ScriptMetric> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    // Load column metadata for THIS file: id → (label, parent_node_id).
    let mut col_label: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut col_parent: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    if let Ok(mut stmt) = conn.prepare(
        "SELECT column_id, label, COALESCE(parent_node_id,'') FROM lineage_columns \
         WHERE project_id = ?1 AND file_path = ?2",
    ) {
        if let Ok(rows) = stmt.query_map(params![project_id, file_path], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        }) {
            for (cid, lbl, par) in rows.flatten() {
                col_label.insert(cid.clone(), lbl);
                col_parent.insert(cid, par);
            }
        }
    }

    // Load node metadata for THIS file: id → (label, qualified_name, node_type).
    let mut node_qn: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut node_type: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    if let Ok(mut stmt) = conn.prepare(
        "SELECT node_id, label, node_type, COALESCE(qualified_name,'') FROM lineage_nodes \
         WHERE project_id = ?1 AND file_path = ?2",
    ) {
        if let Ok(rows) = stmt.query_map(params![project_id, file_path], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        }) {
            for (nid, _lbl, typ, qn) in rows.flatten() {
                node_type.insert(nid.clone(), typ);
                node_qn.insert(nid, qn);
            }
        }
    }

    // Load data_flow incoming edges for CTE nodes in THIS file:
    // derived_<id> → predecessor (CTE or source table). Multi-hop CTE chains
    // are resolved via BFS below so every CTE column maps to a real source
    // table (aggregations happen on CTE output).
    let mut cte_to_source: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut cte_adj: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
    if let Ok(mut stmt) = conn.prepare(
        "SELECT to_id, from_id FROM lineage_edges \
         INDEXED BY idx_lineage_edges_path \
         WHERE project_id = ?1 AND file_path = ?2 \
         AND REPLACE(LOWER(edge_type),'_','') = 'dataflow'",
    ) {
        if let Ok(rows) = stmt.query_map(params![project_id, file_path], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        }) {
            for (to_id, from_id) in rows.flatten() {
                // Only edges into CTE nodes.
                if to_id.starts_with("derived_") {
                    cte_adj.entry(to_id.clone()).or_default().push(from_id.clone());
                    // If predecessor is directly a table, record immediately.
                    if let Some(t) = node_type.get(&from_id) {
                        if t == "table" || t == "view" {
                            cte_to_source
                                .entry(to_id.clone())
                                .or_insert_with(|| node_qn.get(&from_id).cloned().unwrap_or_default());
                        }
                    }
                }
            }
        }
    }
    // BFS multi-hop CTE chains: CTE → data_flow → CTE → ... → source table.
    let cte_ids: Vec<String> = cte_adj.keys().cloned().collect();
    for cte in &cte_ids {
        if cte_to_source.contains_key(cte) {
            continue;
        }
        let mut visited = std::collections::HashSet::new();
        let mut queue = vec![cte.clone()];
        while let Some(cur) = queue.pop() {
            if !visited.insert(cur.clone()) {
                continue;
            }
            if let Some(src) = cte_to_source.get(&cur) {
                cte_to_source.insert(cte.clone(), src.clone());
                break;
            }
            if let Some(preds) = cte_adj.get(&cur) {
                for p in preds {
                    queue.push(p.clone());
                }
            }
        }
    }

    // 1. Query aggregation derivation edges for this file (indexed by path).
    let sql_edges = "SELECT to_id, expression, from_id FROM lineage_edges \
                     INDEXED BY idx_lineage_edges_path \
                     WHERE project_id = ?1 AND file_path = ?2 \
                     AND REPLACE(LOWER(edge_type),'_','') = 'derivation' \
                     AND expression IS NOT NULL \
                     AND (LOWER(expression) LIKE '%count(%' \
                          OR LOWER(expression) LIKE '%sum(%' \
                          OR LOWER(expression) LIKE '%avg(%' \
                          OR LOWER(expression) LIKE '%min(%' \
                          OR LOWER(expression) LIKE '%max(%')";
    if let Ok(mut stmt) = conn.prepare(sql_edges) {
        if let Ok(rows) = stmt.query_map(params![project_id, file_path], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        }) {
            for (to_id, expr, from_id) in rows.flatten() {
                // Metric name = the destination column's label.
                let name = col_label.get(&to_id).cloned().unwrap_or_else(|| to_id.clone());

                // Aggregate function + distinct from the expression.
                let (agg_func, distinct) = parse_agg_from_expr(&expr);

                // Resolve source table: from_id → column → parent node.
                let source_table = resolve_source_table(
                    &from_id, &col_parent, &node_type, &node_qn, &cte_to_source,
                );

                // Business filter from IF()/CASE WHEN conditions inside the expr.
                let business_filter = extract_filter_from_expression(&expr);

                // Key for dedup: agg(column)|filter|source.
                let key = format!("{agg_func}({name})|{business_filter}|{source_table}");
                if !seen.insert(key.clone()) {
                    continue;
                }

                metrics.push(ScriptMetric {
                    name: format!("{}_{}", agg_func, to_snake(&name)),
                    expression: expr,
                    agg_func,
                    distinct,
                    source_table,
                    column: name.clone(),
                    business_filter,
                    period: String::new(),
                });
            }
        }
    }

    metrics.sort_by(|a, b| a.name.cmp(&b.name));
    metrics
}

/// Parse "COUNT(DISTINCT ...)" / "SUM(...)" from an expression.
fn parse_agg_from_expr(expr: &str) -> (String, bool) {
    let lower = expr.to_lowercase();
    for agg in ["count_distinct", "count", "sum", "avg", "min", "max", "median"] {
        let prefix = format!("{agg}(");
        if lower.starts_with(&prefix) {
            // count(distinct X) → count_distinct
            if agg == "count" {
                let rest = &lower[prefix.len()..];
                if rest.starts_with("distinct") {
                    return ("count_distinct".to_string(), true);
                }
            }
            return (agg.to_string(), false);
        }
    }
    // fallback: find any agg( anywhere
    for agg in ["count", "sum", "avg", "min", "max"] {
        if lower.contains(&format!("{agg}(")) {
            let distinct = agg == "count" && lower.contains("distinct");
            return (if distinct { "count_distinct".to_string() } else { agg.to_string() }, distinct);
        }
    }
    ("agg".to_string(), false)
}

/// Resolve a source table from a column id: column → parent node → node qn.
/// If the parent is a CTE (aggregation on CTE output), fall back to the CTE's
/// incoming data_flow source table.
fn resolve_source_table(
    from_id: &str,
    col_parent: &std::collections::HashMap<String, String>,
    node_type: &std::collections::HashMap<String, String>,
    node_qn: &std::collections::HashMap<String, String>,
    cte_to_source: &std::collections::HashMap<String, String>,
) -> String {
    if let Some(parent) = col_parent.get(from_id) {
        if !parent.is_empty() {
            if let Some(t) = node_type.get(parent) {
                if t == "table" || t == "view" {
                    return node_qn
                        .get(parent)
                        .cloned()
                        .unwrap_or_default();
                }
                if t == "cte" {
                    if let Some(src) = cte_to_source.get(parent) {
                        return src.clone();
                    }
                }
            }
        }
    }
    String::new()
}

/// Extract a business filter from IF(cond, then, else) or CASE WHEN cond THEN.
fn extract_filter_from_expression(expr: &str) -> String {
    let lower = expr.to_lowercase();
    // IF(cond, then, else)
    if let Some(pos) = lower.find("if(") {
        // find first comma after '('
        let after = &expr[pos + 3..];
        let after_lower = after.to_lowercase();
        if let Some(comma) = after_lower.find(',') {
            return after[..comma].trim().to_string();
        }
    }
    // CASE WHEN cond THEN
    if let Some(pos) = lower.find("case when") {
        let after = &expr[pos + 9..];
        let after_lower = after.to_lowercase();
        if let Some(then) = after_lower.find("then") {
            return after[..then].trim().to_string();
        }
    }
    String::new()
}

/// Convert a label to snake_case for metric naming.
fn to_snake(s: &str) -> String {
    let mut out = String::new();
    for (i, ch) in s.chars().enumerate() {
        if ch.is_uppercase() && i > 0 {
            out.push('_');
        }
        out.push(ch.to_ascii_lowercase());
    }
    out.replace([' ', '-'], "_")
}



/// Decomposition statistics returned by decompose_metrics.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct DecomposeStats {
    pub total: usize,
    pub atomic_count: usize,
    pub qualifier_count: usize,
    pub derived_count: usize,
    pub compound_count: usize,
    pub skipped_count: usize,
}

/// An atomic metric entry.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AtomicMetricEntry {
    pub id: i64,
    pub metric_name: String,
    pub expression: String,
    pub agg_func: String,
    pub source_column: String,
    pub source_table: String,
    pub description: String,
    pub status: String,
}

/// A business qualifier entry.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct QualifierEntry {
    pub id: i64,
    pub qualifier_name: String,
    pub qualifier_expr: String,
    pub field_name: String,
    pub ref_count: usize,
}

/// A derived metric entry.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct DerivedMetricEntry {
    pub id: i64,
    pub metric_name: String,
    pub atomic_metric_name: String,
    pub qualifier_names: Vec<String>,
    pub time_period: String,
    pub stat_granularity: Vec<String>,
    pub full_expression: String,
    pub full_sql: String,
}

/// Parsed decomposition result for a single metric expression.
struct ParsedDecomposition {
    metric_type: String, // "atomic" | "derived" | "compound"
    agg_func: String,
    atomic_expr: String, // e.g. "sum(vv)"
    source_column: String,
    qualifiers: Vec<(String, String)>, // (field, condition_expr)
}

/// Decompose all metrics in metrics_registry into atomic/qualifier/derived tables.
pub fn decompose_metrics(
    conn: &Connection,
    project_id: &str,
) -> Result<DecomposeStats, rusqlite::Error> {
    let now = chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string();

    // Load all metrics.
    let metrics = list_metrics(conn, project_id, None, None, None, None)?;

    // Clear old decomposition data.
    conn.execute_batch(
        "DELETE FROM atomic_metric_registry WHERE project_id = ?1;
         DELETE FROM business_qualifier_registry WHERE project_id = ?1;
         DELETE FROM derived_metric_registry WHERE project_id = ?1;",
    )?;
    // Use a workaround for project_id param.
    conn.execute(
        "DELETE FROM atomic_metric_registry WHERE project_id = ?1",
        params![project_id],
    )?;
    conn.execute(
        "DELETE FROM business_qualifier_registry WHERE project_id = ?1",
        params![project_id],
    )?;
    conn.execute(
        "DELETE FROM derived_metric_registry WHERE project_id = ?1",
        params![project_id],
    )?;

    let mut atomic_map: HashMap<String, i64> = HashMap::new(); // atomic_expr → id
    let mut qualifier_map: HashMap<String, i64> = HashMap::new(); // qualifier_expr → id
    let mut stats = DecomposeStats {
        total: 0,
        atomic_count: 0,
        qualifier_count: 0,
        derived_count: 0,
        compound_count: 0,
        skipped_count: 0,
    };

    for m in &metrics {
        if m.expression.is_empty() {
            stats.skipped_count += 1;
            continue;
        }
        stats.total += 1;

        let parsed = parse_expression_decomposition(&m.expression);
        match parsed.metric_type.as_str() {
            "atomic" => {
                // Upsert atomic metric.
                let atomic_name =
                    build_atomic_name(&parsed.agg_func, &parsed.source_column);
                let id = upsert_atomic_metric(
                    conn,
                    project_id,
                    &atomic_name,
                    &parsed.atomic_expr,
                    &parsed.agg_func,
                    &parsed.source_column,
                    &m.source_tables,
                    &now,
                )?;
                atomic_map.insert(parsed.atomic_expr.clone(), id);
                stats.atomic_count += 1;
            }
            "derived" => {
                // Upsert atomic metric for the inner expression.
                let atomic_name =
                    build_atomic_name(&parsed.agg_func, &parsed.source_column);
                let atomic_id = upsert_atomic_metric(
                    conn,
                    project_id,
                    &atomic_name,
                    &parsed.atomic_expr,
                    &parsed.agg_func,
                    &parsed.source_column,
                    &m.source_tables,
                    &now,
                )?;
                atomic_map.insert(parsed.atomic_expr.clone(), atomic_id);
                stats.atomic_count += 1;

                // Upsert qualifiers.
                let mut qual_ids = Vec::new();
                let mut qual_names = Vec::new();
                for (field, cond) in &parsed.qualifiers {
                    let q_name = build_qualifier_name(field, &cond);
                    let q_id = upsert_qualifier(
                        conn,
                        project_id,
                        &q_name,
                        &cond,
                        field,
                        &now,
                    )?;
                    qualifier_map.insert(cond.clone(), q_id);
                    qual_ids.push(q_id);
                    qual_names.push(q_name);
                }
                stats.qualifier_count += qual_ids.len();

                // Build granularity from qualifier fields.
                let granularity: Vec<String> = parsed
                    .qualifiers
                    .iter()
                    .map(|(f, _)| f.clone())
                    .collect::<HashSet<_>>()
                    .into_iter()
                    .collect();

                // Insert derived metric.
                let qual_ids_json = serde_json::to_string(&qual_ids).unwrap_or_default();
                let qual_names_json = serde_json::to_string(&qual_names).unwrap_or_default();
                let gran_json = serde_json::to_string(&granularity).unwrap_or_default();
                let full_sql = build_derived_sql(&parsed.agg_func, &parsed.source_column, &m.source_tables, &granularity);

                conn.execute(
                    "INSERT OR REPLACE INTO derived_metric_registry
                        (project_id, metric_name, atomic_metric_id, atomic_metric_name,
                         qualifier_ids, qualifier_names, time_period, stat_granularity,
                         full_expression, full_sql, source_metric_id, status, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'confirmed', ?12, ?12)",
                    params![
                        project_id,
                        m.metric_name,
                        atomic_id,
                        atomic_name,
                        qual_ids_json,
                        qual_names_json,
                        m.period,
                        gran_json,
                        m.expression,
                        full_sql,
                        m.id,
                        now,
                    ],
                )?;
                stats.derived_count += 1;
            }
            "compound" => {
                stats.compound_count += 1;
            }
            _ => {
                stats.skipped_count += 1;
            }
        }
    }

    Ok(stats)
}

/// Parse a metric expression and decompose into atomic + qualifiers.
fn parse_expression_decomposition(expr: &str) -> ParsedDecomposition {
    let trimmed = expr.trim();
    let lower = trimmed.to_lowercase();

    // Pattern 1: AGG(CASE WHEN <cond> THEN <val> ELSE <else> END)
    // Extract aggregation + CASE WHEN condition + inner value.
    let case_re = regex_lite(
        r"(?i)^(sum|count|avg|average|max|min|median)\s*\(\s*case\s+when\s+(.+?)\s+then\s+(.+?)\s+else\s+(.+?)\s+end\s*\)$",
    );
    if let Some(caps) = case_re.captures(trimmed) {
        let agg = caps.get(1).unwrap().to_lowercase();
        let condition = caps.get(2).unwrap().trim().to_string();
        let then_val = caps.get(3).unwrap().trim().to_string();

        // Extract qualifier fields from the condition.
        let qualifiers = extract_qualifier_fields(&condition);

        // Atomic metric = agg(then_val) if then_val != "1", else count(*).
        let (atomic_agg, source_col) = if then_val == "1" || then_val == "1" {
            ("count".to_string(), "*".to_string())
        } else {
            let col = strip_alias(&then_val);
            (agg.clone(), col)
        };
        let atomic_expr = format!("{}({})", atomic_agg, source_col);

        return ParsedDecomposition {
            metric_type: "derived".into(),
            agg_func: atomic_agg,
            atomic_expr,
            source_column: source_col,
            qualifiers,
        };
    }

    // Pattern 2: AGG(DISTINCT? column) — simple atomic.
    let simple_re = regex_lite(r"(?i)^(sum|count|avg|average|max|min|median)\s*\(\s*(distinct\s+)?(.+?)\s*\)$");
    if let Some(caps) = simple_re.captures(trimmed) {
        let agg_raw = caps.get(1).unwrap().to_lowercase();
        let distinct = caps.get(2).map(|m| m.trim()).unwrap_or("");
        let col = caps.get(3).unwrap().trim();

        let agg_name = match (agg_raw.as_str(), !distinct.is_empty()) {
            ("count", true) => "count_distinct".to_string(),
            ("average", _) => "avg".to_string(),
            _ => agg_raw,
        };
        let source_col = strip_alias(col);
        let atomic_expr = format!("{}({})", agg_name, source_col);

        return ParsedDecomposition {
            metric_type: "atomic".into(),
            agg_func: agg_name,
            atomic_expr,
            source_column: source_col,
            qualifiers: vec![],
        };
    }

    // Pattern 3: compound (contains +, /, *)
    if trimmed.contains('+') || trimmed.contains('/') || trimmed.contains('*') {
        return ParsedDecomposition {
            metric_type: "compound".into(),
            agg_func: String::new(),
            atomic_expr: trimmed.to_string(),
            source_column: String::new(),
            qualifiers: vec![],
        };
    }

    ParsedDecomposition {
        metric_type: "unknown".into(),
        agg_func: String::new(),
        atomic_expr: trimmed.to_string(),
        source_column: String::new(),
        qualifiers: vec![],
    }
}

/// Extract qualifier fields from a CASE WHEN condition string.
/// "video_side = 'APP'" → [("video_side", "video_side = 'APP'")]
/// "video_ctgy IN ('OLYL','VIDE') AND video_side = 'APP'" → [("video_ctgy", "..."), ("video_side", "...")]
fn extract_qualifier_fields(condition: &str) -> Vec<(String, String)> {
    let mut result = Vec::new();
    for clause in condition.split(" AND ") {
        let c = clause.trim();
        if c.is_empty() {
            continue;
        }
        // Extract field name (first identifier).
        let field = c
            .split(|c: char| !c.is_alphanumeric() && c != '_')
            .next()
            .unwrap_or("")
            .trim()
            .to_string();
        if !field.is_empty() {
            result.push((field, c.to_string()));
        }
    }
    if result.is_empty() {
        result.push((String::new(), condition.to_string()));
    }
    result
}

/// Strip table alias from a column reference: "a.pid" → "pid".
fn strip_alias(expr: &str) -> String {
    if expr.contains(' ') {
        return expr.to_string();
    }
    if let Some(pos) = expr.rfind('.') {
        expr[pos + 1..].to_string()
    } else {
        expr.to_string()
    }
}

/// Build a standardized atomic metric name.
fn build_atomic_name(agg: &str, col: &str) -> String {
    let clean_col = col.replace('.', "_").replace(' ', "_").to_lowercase();
    format!("{}_{}", agg, clean_col)
}

/// Build a qualifier name from field + condition.
fn build_qualifier_name(field: &str, cond: &str) -> String {
    // Try to extract the value from conditions like field = 'value' or field IN (...)
    let lower = cond.to_lowercase();
    if let Some(pos) = lower.find('=') {
        let val = cond[pos + 1..].trim().trim_matches(|c| c == '\'' || c == '"' || c == ' ');
        if !val.is_empty() {
            return format!("{}_{}", field, val.to_lowercase());
        }
    }
    field.to_string()
}

/// Build a derived metric SQL.
fn build_derived_sql(agg: &str, col: &str, source_table: &str, granularity: &[String]) -> String {
    let from = if source_table.is_empty() {
        "unknown_table"
    } else {
        source_table.split(',').next().unwrap_or(source_table)
    };
    let group_by = if granularity.is_empty() {
        String::new()
    } else {
        format!("\nGROUP BY {}", granularity.join(", "))
    };
    format!(
        "SELECT {}({}) AS derived_metric{}\nFROM {}{}",
        agg, col,
        if granularity.is_empty() {
            String::new()
        } else {
            format!(", {}", granularity.join(", "))
        },
        from,
        group_by
    )
}

/// Upsert an atomic metric, returning its id.
fn upsert_atomic_metric(
    conn: &Connection,
    project_id: &str,
    name: &str,
    expr: &str,
    agg: &str,
    source_col: &str,
    source_table: &str,
    now: &str,
) -> Result<i64, rusqlite::Error> {
    conn.execute(
        "INSERT INTO atomic_metric_registry
            (project_id, metric_name, expression, agg_func, source_column, source_table, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'confirmed', ?7, ?7)
         ON CONFLICT(project_id, metric_name) DO UPDATE SET
            expression = excluded.expression,
            agg_func = excluded.agg_func,
            source_column = excluded.source_column,
            source_table = excluded.source_table,
            updated_at = excluded.updated_at",
        params![project_id, name, expr, agg, source_col, source_table.split(',').next().unwrap_or(""), now],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Upsert a business qualifier, returning its id.
fn upsert_qualifier(
    conn: &Connection,
    project_id: &str,
    name: &str,
    expr: &str,
    field: &str,
    now: &str,
) -> Result<i64, rusqlite::Error> {
    conn.execute(
        "INSERT INTO business_qualifier_registry
            (project_id, qualifier_name, qualifier_expr, field_name, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'confirmed', ?5, ?5)
         ON CONFLICT(project_id, qualifier_name) DO UPDATE SET
            qualifier_expr = excluded.qualifier_expr,
            field_name = excluded.field_name,
            ref_count = ref_count + 1,
            updated_at = excluded.updated_at",
        params![project_id, name, expr, field, now],
    )?;
    Ok(conn.last_insert_rowid())
}

/// List atomic metrics.
pub fn list_atomic_metrics(
    conn: &Connection,
    project_id: &str,
) -> Result<Vec<AtomicMetricEntry>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, metric_name, expression, agg_func, source_column, source_table, description, status
         FROM atomic_metric_registry WHERE project_id = ?1 AND status = 'confirmed'
         ORDER BY source_column, agg_func",
    )?;
    let rows = stmt.query_map(params![project_id], |row| {
        Ok(AtomicMetricEntry {
            id: row.get(0)?,
            metric_name: row.get(1)?,
            expression: row.get(2)?,
            agg_func: row.get(3)?,
            source_column: row.get(4)?,
            source_table: row.get(5)?,
            description: row.get::<_, String>(6).unwrap_or_default(),
            status: row.get(7)?,
        })
    })?;
    rows.collect()
}

/// List business qualifiers.
pub fn list_qualifiers(
    conn: &Connection,
    project_id: &str,
) -> Result<Vec<QualifierEntry>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, qualifier_name, qualifier_expr, field_name, ref_count
         FROM business_qualifier_registry WHERE project_id = ?1
         ORDER BY ref_count DESC",
    )?;
    let rows = stmt.query_map(params![project_id], |row| {
        Ok(QualifierEntry {
            id: row.get(0)?,
            qualifier_name: row.get(1)?,
            qualifier_expr: row.get(2)?,
            field_name: row.get(3)?,
            ref_count: row.get::<_, i64>(4).unwrap_or(0) as usize,
        })
    })?;
    rows.collect()
}

/// List derived metrics.
pub fn list_derived_metrics(
    conn: &Connection,
    project_id: &str,
) -> Result<Vec<DerivedMetricEntry>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, metric_name, atomic_metric_name, qualifier_names, time_period,
                stat_granularity, full_expression, full_sql
         FROM derived_metric_registry WHERE project_id = ?1
         ORDER BY atomic_metric_name, metric_name",
    )?;
    let rows = stmt.query_map(params![project_id], |row| {
        let qn_json: String = row.get::<_, String>(3).unwrap_or_default();
        let qn: Vec<String> = serde_json::from_str(&qn_json).unwrap_or_default();
        let gran_json: String = row.get::<_, String>(5).unwrap_or_default();
        let gran: Vec<String> = serde_json::from_str(&gran_json).unwrap_or_default();
        Ok(DerivedMetricEntry {
            id: row.get(0)?,
            metric_name: row.get(1)?,
            atomic_metric_name: row.get::<_, String>(2).unwrap_or_default(),
            qualifier_names: qn,
            time_period: row.get::<_, String>(4).unwrap_or_default(),
            stat_granularity: gran,
            full_expression: row.get::<_, String>(6).unwrap_or_default(),
            full_sql: row.get::<_, String>(7).unwrap_or_default(),
        })
    })?;
    rows.collect()
}

// ============================================================
// Summary Table Recommendations
// ============================================================

/// A summary table recommendation entry.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct SummaryRecommendation {
    pub id: i64,
    pub recommended_table_name: String,
    pub recommended_layer: String,
    pub stat_granularity: Vec<String>,
    pub time_period: String,
    pub source_table: String,
    pub metric_count: usize,
    pub metric_names: Vec<String>,
    pub suggested_sql: String,
    pub source_scripts: Vec<String>,
    pub potential_savings: String,
    pub status: String,
}

/// Generate summary table recommendations from metric analysis families.
pub fn generate_summary_recommendations(
    conn: &Connection,
    project_id: &str,
) -> Result<usize, rusqlite::Error> {
    let now = chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string();

    // Get metric analysis families (same model, same pattern, count ≥ 3).
    let analysis = analyze_metrics(conn, project_id)?;

    // Clear old recommendations.
    conn.execute(
        "DELETE FROM summary_table_recommendation WHERE project_id = ?1",
        params![project_id],
    )?;

    let mut count = 0usize;
    for family in &analysis.families {
        if family.count < 3 {
            continue;
        }

        // Infer stat granularity from the pattern (CASE WHEN fields).
        let granularity = extract_granularity_from_pattern(&family.pattern);

        // Infer source table from the model.
        let source_table = &family.bound_model;

        // Generate recommended table name.
        let rec_name = generate_summary_table_name(source_table, &granularity);

        // Build suggested SQL.
        let suggested_sql = build_summary_sql(source_table, &family.columns, &granularity);

        let savings = format!("合并 {} 个同模式指标为 1 个汇总表", family.count);

        let cols_json = serde_json::to_string(&family.columns).unwrap_or_default();
        let gran_json = serde_json::to_string(&granularity).unwrap_or_default();

        conn.execute(
            "INSERT INTO summary_table_recommendation
                (project_id, recommended_table_name, recommended_layer, stat_granularity,
                 time_period, source_table, metric_count, metric_names, suggested_sql,
                 source_scripts, potential_savings, status, created_at, updated_at)
             VALUES (?1, ?2, 'DWS', ?3, 'daily', ?4, ?5, ?6, ?7, '[]', ?8, 'pending', ?9, ?9)",
            params![
                project_id,
                rec_name,
                gran_json,
                source_table,
                family.count,
                cols_json,
                suggested_sql,
                savings,
                now,
            ],
        )?;
        count += 1;
    }

    // Also generate from cross-model duplicates with high count.
    for dup in &analysis.duplicates {
        if dup.metric_count < 5 {
            continue;
        }
        let granularity = extract_granularity_from_pattern(&dup.normalized_expr);
        let rec_name = format!("dws_{}_{}", dup.aggregation, "consolidated");
        let cols_json = serde_json::to_string(&dup.metric_names).unwrap_or_default();
        let gran_json = serde_json::to_string(&granularity).unwrap_or_default();
        let savings = format!("跨 {} 个模型合并 {} 个重复指标", dup.bound_models.len(), dup.metric_count);

        conn.execute(
            "INSERT INTO summary_table_recommendation
                (project_id, recommended_table_name, recommended_layer, stat_granularity,
                 time_period, source_table, metric_count, metric_names, suggested_sql,
                 source_scripts, potential_savings, status, created_at, updated_at)
             VALUES (?1, ?2, 'DWS', ?3, 'daily', '', ?4, ?5, '', '[]', ?6, 'pending', ?7, ?7)",
            params![
                project_id,
                rec_name,
                gran_json,
                dup.metric_count,
                cols_json,
                savings,
                now,
            ],
        )?;
        count += 1;
    }

    Ok(count)
}

/// List summary table recommendations.
pub fn list_summary_recommendations(
    conn: &Connection,
    project_id: &str,
) -> Result<Vec<SummaryRecommendation>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, recommended_table_name, recommended_layer, stat_granularity,
                time_period, source_table, metric_count, metric_names, suggested_sql,
                source_scripts, potential_savings, status
         FROM summary_table_recommendation WHERE project_id = ?1
         ORDER BY metric_count DESC",
    )?;
    let rows = stmt.query_map(params![project_id], |row| {
        let gran_json: String = row.get::<_, String>(3).unwrap_or_default();
        let gran: Vec<String> = serde_json::from_str(&gran_json).unwrap_or_default();
        let mn_json: String = row.get::<_, String>(7).unwrap_or_default();
        let mn: Vec<String> = serde_json::from_str(&mn_json).unwrap_or_default();
        let ss_json: String = row.get::<_, String>(9).unwrap_or_default();
        let ss: Vec<String> = serde_json::from_str(&ss_json).unwrap_or_default();
        Ok(SummaryRecommendation {
            id: row.get(0)?,
            recommended_table_name: row.get(1)?,
            recommended_layer: row.get::<_, String>(2).unwrap_or_default(),
            stat_granularity: gran,
            time_period: row.get::<_, String>(4).unwrap_or_default(),
            source_table: row.get::<_, String>(5).unwrap_or_default(),
            metric_count: row.get::<_, i64>(6).unwrap_or(0) as usize,
            metric_names: mn,
            suggested_sql: row.get::<_, String>(8).unwrap_or_default(),
            source_scripts: ss,
            potential_savings: row.get::<_, String>(10).unwrap_or_default(),
            status: row.get(11)?,
        })
    })?;
    rows.collect()
}

/// Extract granularity dimensions from a normalized expression pattern.
/// "sum(case when video_ctgy = ? ...)" → ["video_ctgy"]
fn extract_granularity_from_pattern(pattern: &str) -> Vec<String> {
    let lower = pattern.to_lowercase();
    if !lower.contains("when") {
        return vec![];
    }
    // Find identifiers between WHEN and THEN.
    let mut fields = Vec::new();
    let keywords = [
        "case", "when", "then", "else", "end", "and", "or", "not",
        "in", "is", "null", "like", "between",
    ];
    for token in lower.split(|c: char| !c.is_alphanumeric() && c != '_') {
        let t = token.trim();
        if t.is_empty() || keywords.contains(&t) || t == "?" {
            continue;
        }
        // This is likely a field name.
        fields.push(t.to_string());
    }
    // Deduplicate preserving order.
    let mut seen = HashSet::new();
    fields.retain(|f| seen.insert(f.clone()));
    fields
}

/// Generate a recommended summary table name.
fn generate_summary_table_name(source: &str, granularity: &[String]) -> String {
    let gran_part = if granularity.is_empty() {
        "statt".to_string()
    } else {
        granularity
            .iter()
            .map(|g| g.split('_').next().unwrap_or(g))
            .collect::<Vec<_>>()
            .join("_")
    };
    // Extract meaningful part from source table name.
    let src_clean = source
        .split('.')
        .last()
        .unwrap_or(source)
        .trim_start_matches("s20_")
        .trim_start_matches("s02_")
        .trim_start_matches("s03_")
        .trim_start_matches("s99_");
    format!("dws_{}_{}_statt", src_clean, gran_part)
}

/// Build a suggested summary SQL.
fn build_summary_sql(source: &str, columns: &[String], granularity: &[String]) -> String {
    let group_cols = if granularity.is_empty() {
        "dt".to_string()
    } else {
        granularity.join(", ")
    };
    let mut sql = format!("SELECT\n  {},\n", group_cols);
    for (i, col) in columns.iter().enumerate() {
        if i < columns.len() - 1 {
            sql.push_str(&format!("  -- {} (from CASE WHEN)\n", col));
        }
    }
    sql.push_str(&format!("\nFROM {}\nGROUP BY {}", source, group_cols));
    sql
}

/// A lightweight regex helper (avoids pulling in the regex crate if not available).
fn regex_lite(_pat: &'static str) -> RegexLite {
    RegexLite
}

struct RegexLite;

impl RegexLite {
    fn captures<'a>(&self, text: &'a str) -> Option<RegexCaps> {
        // Simple sequential matching for our patterns.
        // We do case-insensitive matching.
        let lower_text = text.to_lowercase();
        let lower_pat = String::new(); // unused

        // Find AGG( prefix.
        let aggs = ["sum", "count", "avg", "average", "max", "min", "median"];
        let mut matched_agg = None;
        let mut after_agg = 0;
        for agg in &aggs {
            if lower_text.starts_with(agg) {
                let after = &text[agg.len()..];
                let after_trimmed = after.trim_start();
                if after_trimmed.starts_with('(') {
                    matched_agg = Some(*agg);
                    after_agg = text.len() - after_trimmed.len();
                    break;
                }
            }
        }

        // Only handle the two patterns we care about.
        let trimmed = text.trim();

        // Pattern 1: CASE WHEN inside
        let lower_t = trimmed.to_lowercase();
        if lower_t.contains("case when") && lower_t.contains("then") && lower_t.contains("else") {
            // Try to match: AGG(CASE WHEN <cond> THEN <val> ELSE <else> END)
            let agg = matched_agg?;
            // Find the content inside AGG(...).
            let open = trimmed.find('(')?;
            let close = trimmed.rfind(')')?;
            if close <= open {
                return None;
            }
            let inner = &trimmed[open + 1..close];
            let lower_inner = inner.to_lowercase();
            let when_pos = lower_inner.find("case when")?;
            let then_pos = lower_inner.find("then")?;
            let else_pos = lower_inner.find("else")?;
            let end_pos = lower_inner.find("end")?;

            if !(when_pos < then_pos && then_pos < else_pos && else_pos < end_pos) {
                return None;
            }

            let cond = inner[when_pos + 9..then_pos].trim().to_string();
            let then_val = inner[then_pos + 4..else_pos].trim().to_string();
            let else_val = inner[else_pos + 4..end_pos].trim().to_string();

            return Some(RegexCaps {
                groups: vec![
                    agg.to_string(),
                    cond,
                    then_val,
                    else_val,
                ],
            });
        }

        // Pattern 2: simple AGG(DISTINCT? col)
        if let Some(agg) = matched_agg {
            let open = trimmed.find('(')?;
            let close = trimmed.rfind(')')?;
            if close <= open {
                return None;
            }
            let inner = trimmed[open + 1..close].trim();
            let distinct = if inner.to_lowercase().starts_with("distinct ") {
                "distinct ".to_string()
            } else {
                String::new()
            };
            let col = if !distinct.is_empty() {
                inner[9..].trim()
            } else {
                inner
            };

            // Reject if contains spaces (compound) or operators.
            if col.contains('+') || col.contains('/') || col.contains('*') {
                return None;
            }

            return Some(RegexCaps {
                groups: vec![
                    agg.to_string(),
                    distinct,
                    col.to_string(),
                ],
            });
        }

        let _ = self; // RegexLite is unit struct
        None
    }
}

struct RegexCaps {
    groups: Vec<String>,
}

impl RegexCaps {
    fn get(&self, i: usize) -> Option<&str> {
        // Index 0 = full match (not stored), 1+ = capture groups.
        if i == 0 {
            return None;
        }
        self.groups.get(i - 1).map(|s| s.as_str())
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_compute_signature() {
        let sig1 = compute_signature("SUM(amount)", "dws_gmv");
        let sig2 = compute_signature("SUM(amount)", "dws_gmv");
        let sig3 = compute_signature("COUNT(*)", "dws_gmv");
        assert_eq!(sig1, sig2, "Same input should produce same signature");
        assert_ne!(sig1, sig3, "Different input should produce different signature");
    }

    #[test]
    fn test_parse_simple_sum() {
        match parse_metric_expression("sum(lvtm)") {
            ParsedExpr::Atomic { agg, inner } => {
                assert_eq!(agg, "sum");
                assert_eq!(inner, "lvtm");
            }
            _ => panic!("expected atomic"),
        }
    }

    #[test]
    fn test_parse_count_distinct() {
        match parse_metric_expression("count(DISTINCT usr_id)") {
            ParsedExpr::Atomic { agg, inner } => {
                assert_eq!(agg, "count_distinct");
                assert_eq!(inner, "usr_id");
            }
            _ => panic!("expected atomic"),
        }
    }

    #[test]
    fn test_parse_count_star() {
        match parse_metric_expression("count(*)") {
            ParsedExpr::Atomic { agg, inner } => {
                assert_eq!(agg, "count");
                assert_eq!(inner, "*");
            }
            _ => panic!("expected atomic"),
        }
    }

    #[test]
    fn test_parse_compound_derived() {
        match parse_metric_expression("sum(a) + sum(b)") {
            ParsedExpr::Derived => {}
            _ => panic!("expected derived"),
        }
    }

    #[test]
    fn test_parse_round_division() {
        match parse_metric_expression("round(sum(a) / sum(b), 2)") {
            ParsedExpr::Derived => {}
            _ => panic!("expected derived"),
        }
    }

    #[test]
    fn test_parse_nested_case_when() {
        match parse_metric_expression(
            "SUM(CASE WHEN x > 0 THEN y ELSE 0 END)",
        ) {
            ParsedExpr::Atomic { agg, .. } => {
                assert_eq!(agg, "sum");
            }
            _ => panic!("expected atomic for SUM(CASE WHEN ...)"),
        }
    }

    #[test]
    fn test_parse_not_metric() {
        assert!(matches!(parse_metric_expression("a + b"), ParsedExpr::NotMetric));
        assert!(matches!(parse_metric_expression("CAST(x AS INT)"), ParsedExpr::NotMetric));
    }

    #[test]
    fn test_strip_table_alias() {
        assert_eq!(strip_table_alias("tab1.pid"), "pid");
        assert_eq!(strip_table_alias("t.col_name"), "col_name");
        assert_eq!(strip_table_alias("plain_col"), "plain_col");
        // Complex expressions left untouched
        assert_eq!(strip_table_alias("CASE WHEN x THEN y"), "CASE WHEN x THEN y");
    }

    #[test]
    fn test_build_metric_name() {
        // Meaningful output column
        assert_eq!(
            build_metric_name("M01_ACCM_USR", "accm_rgst_usr_cnt", "count_distinct", "usr_id"),
            "m01_accm_usr_accm_rgst_usr_cnt"
        );
        // Generic output column → fallback to source+agg
        assert_eq!(
            build_metric_name("app_appout_lvtm", "sum", "sum", "lvtm"),
            "app_appout_lvtm_lvtm_sum"
        );
        // count(*) with no source col
        assert_eq!(
            build_metric_name("dws_daily", "count", "count", ""),
            "dws_daily_all_count"
        );
    }

    #[test]
    fn test_infer_period() {
        assert_eq!(infer_period("dws_daily_sales", ""), "daily");
        assert_eq!(infer_period("dws_monthly_report", ""), "monthly");
        assert_eq!(infer_period("dws_weekly_stats", ""), "weekly");
        assert_eq!(infer_period("ods_raw", "total_amt"), "");
        assert_eq!(infer_period("dws_hourly_log", ""), "hourly");
    }

    #[test]
    fn test_extract_business_filter_simple() {
        let filter = extract_business_filter(
            "max(CASE WHEN `fee_code` = 'F0001' THEN `price` ELSE 0 END)",
        );
        assert_eq!(filter, "fee_code = 'F0001'");
    }

    #[test]
    fn test_extract_business_filter_multi_when() {
        let filter = extract_business_filter(
            "SUM(CASE WHEN status = 1 THEN amount WHEN status = 2 THEN 0 ELSE 0 END)",
        );
        assert_eq!(filter, "status = 1; status = 2");
    }

    #[test]
    fn test_extract_business_filter_and_condition() {
        let filter = extract_business_filter(
            "SUM(CASE WHEN a.system_id = '1' AND group_id = 1 THEN amount ELSE 0 END)",
        );
        assert_eq!(filter, "a.system_id = '1' AND group_id = 1");
    }

    #[test]
    fn test_extract_business_filter_none() {
        assert_eq!(extract_business_filter("sum(lvtm)"), "");
        assert_eq!(extract_business_filter("count(*)"), "");
    }

    #[test]
    fn test_infer_owner_from_path() {
        assert_eq!(
            infer_owner_from_path("etl/M01_接口集市库-BI/M01_ACCM_USR.HQL"),
            "M01_接口集市库-BI",
        );
        assert_eq!(
            infer_owner_from_path("dqc/DQC_数据质量检查区/DQC_CHK.HQL"),
            "DQC_数据质量检查区",
        );
        assert_eq!(infer_owner_from_path("single_file.sql"), "single_file.sql");
    }

    #[test]
    fn test_normalize_expression() {
        // String literal → ?
        assert_eq!(
            normalize_expression("max(CASE WHEN fee_code = 'F0001' THEN price ELSE 0 END)"),
            "max(case when fee_code = ? then price else ? end)",
        );
        // Different literal → same normalized form
        assert_eq!(
            normalize_expression("max(CASE WHEN fee_code = 'F0002' THEN price ELSE 0 END)"),
            "max(case when fee_code = ? then price else ? end)",
        );
        // Table alias stripped
        assert_eq!(
            normalize_expression("sum(tab1.amount)"),
            "sum(amount)",
        );
        // Backticks removed
        assert_eq!(
            normalize_expression("max(`fee_code` = 'X')"),
            "max(fee_code = ?)",
        );
        // Whitespace collapsed
        assert_eq!(
            normalize_expression("sum(  a  +  b  )"),
            "sum(a + b)",
        );
    }

    #[test]
    fn test_normalize_family_detection() {
        // Three fee metrics should normalize to the same expression
        let exprs = [
            "max(CASE WHEN `fee_code` = 'F0001' THEN `price` ELSE 0 END)",
            "max(CASE WHEN `fee_code` = 'F0002' THEN `price` ELSE 0 END)",
            "max(CASE WHEN `fee_code` = 'F0003' THEN `price` ELSE 0 END)",
        ];
        let norms: Vec<String> = exprs.iter().map(|e| normalize_expression(e)).collect();
        assert_eq!(norms[0], norms[1], "F0001 and F0002 should match");
        assert_eq!(norms[1], norms[2], "F0002 and F0003 should match");
    }

    #[test]
    fn test_pct() {
        assert_eq!(pct(3, 4), 75.0);
        assert_eq!(pct(0, 0), 0.0);
        assert_eq!(pct(1, 3), 33.3);
    }
}
