//! Metric management: ODCS metric definitions + conflict detection + CRUD.

use std::collections::HashMap;

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
                let agg_func = agg.function.as_deref().unwrap_or("UNKNOWN");

                // Use qualified_name or label as metric name
                let parent_table = node
                    .qualified_name
                    .as_deref()
                    .or_else(|| source_tables.first().map(|s| s.as_str()))
                    .unwrap_or(col_name);
                let metric_name = format!("{}_{}_{}", parent_table, col_name, agg_func).to_lowercase();

                let signature = compute_signature(agg_func, col_name);

                conn.execute(
                    "INSERT INTO metrics_registry
                        (project_id, metric_name, metric_type, definition, sql_signature, expression,
                         aggregation, business_filter, period, source_tables, dimensions, layer,
                         lifecycle, bound_model, bound_column, created_at, updated_at, status)
                     VALUES (?1, ?2, 'atomic', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'active', ?12, ?13, ?14, ?14, 1)
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
fn compute_signature(expression: &str, table: &str) -> String {
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
    let metrics = list_metrics(conn, project_id, None, None, None)?;
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
    let metrics = list_metrics(conn, project_id, None, None, None)?;
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
}
