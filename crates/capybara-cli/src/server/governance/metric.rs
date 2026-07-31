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
    pub definition: String,
    pub sql_signature: String,
    pub expression: String,
    pub aggregation: String,
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
        "SELECT id, project_id, metric_name, definition, sql_signature, expression, aggregation,
                source_tables, dimensions, owner, layer, lifecycle, contract_id, bound_model, bound_column
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
        let dims_json: String = row.get(8)?;
        let dims: Vec<String> = serde_json::from_str(&dims_json).unwrap_or_default();
        Ok(MetricEntry {
            id: row.get(0)?,
            project_id: row.get(1)?,
            metric_name: row.get(2)?,
            definition: row.get(3)?,
            sql_signature: row.get(4)?,
            expression: row.get(5)?,
            aggregation: row.get(6)?,
            source_tables: row.get(7)?,
            dimensions: dims,
            owner: row.get(9)?,
            layer: row.get(10)?,
            lifecycle: row.get(11)?,
            contract_id: row.get(12)?,
            bound_model: row.get(13)?,
            bound_column: row.get(14)?,
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
