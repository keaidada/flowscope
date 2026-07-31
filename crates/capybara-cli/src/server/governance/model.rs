//! Model management: ODCS schema import + lineage auto-discovery + CRUD.

use std::collections::HashMap;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::contract::{Contract, SchemaDefinition};

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ModelEntry {
    pub id: i64,
    pub project_id: String,
    pub table_name: String,
    pub model_layer: String,
    pub model_type: String,
    pub business_domain: String,
    pub owner: String,
    pub lifecycle: String,
    pub description: String,
    pub tags: Vec<String>,
    pub source: String,
    pub contract_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ModelColumn {
    pub id: i64,
    pub model_id: i64,
    pub column_name: String,
    pub data_type: String,
    pub description: String,
    pub sensitivity: String,
    pub category: String,
    pub bound_metric: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ModelStats {
    pub total: usize,
    pub by_layer: HashMap<String, usize>,
    pub by_type: HashMap<String, usize>,
    pub by_domain: HashMap<String, usize>,
    pub by_lifecycle: HashMap<String, usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ModelRelation {
    pub upstream: Vec<String>,
    pub downstream: Vec<String>,
    pub bound_metrics: Vec<String>,
    pub related_scripts: Vec<String>,
    pub related_contracts: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ModelAuditEntry {
    pub id: i64,
    pub model_id: i64,
    pub action: String,
    pub field_name: String,
    pub old_value: String,
    pub new_value: String,
    pub operator: String,
    pub created_at: String,
}

/// Infer model layer from table name prefix.
pub fn infer_layer(table_name: &str) -> &'static str {
    let lower = table_name.to_lowercase();
    if lower.starts_with("ods_") {
        "ODS"
    } else if lower.starts_with("dwd_") {
        "DWD"
    } else if lower.starts_with("dws_") {
        "DWS"
    } else if lower.starts_with("ads_") || lower.starts_with("app_") {
        "ADS"
    } else if lower.starts_with("dim_") {
        "DIM"
    } else {
        "unknown"
    }
}

/// Infer model type from lineage position.
pub fn infer_model_type(
    table_name: &str,
    table_edges: &[(String, String, String)],
) -> &'static str {
    let is_written = table_edges.iter().any(|(_, to, _)| to == table_name);
    let is_read = table_edges.iter().any(|(from, _, _)| from == table_name);
    let has_downstream = table_edges.iter().any(|(_, to, _)| to == table_name);

    if is_written && has_downstream {
        "aggregate"
    } else if is_written && !has_downstream {
        "fact"
    } else if is_read && !is_written {
        "source"
    } else {
        "unknown"
    }
}

/// Auto-discover models from table_level_edges and ODCS contracts.
pub fn auto_discover_models(
    conn: &Connection,
    project_id: &str,
    table_edges: &[(String, String, String)],
    contracts: &[Contract],
) -> Result<(usize, usize), rusqlite::Error> {
    // Collect all table names from edges
    let mut all_tables: std::collections::HashSet<String> = std::collections::HashSet::new();
    for (from, to, _) in table_edges {
        all_tables.insert(from.clone());
        all_tables.insert(to.clone());
    }

    // Collect schema definitions from contracts
    let mut contract_schemas: HashMap<String, (&str, &SchemaDefinition)> = HashMap::new();
    for contract in contracts {
        for schema in &contract.schema {
            contract_schemas.insert(schema.name.clone(), (contract.id.as_str(), schema));
        }
    }

    let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
    let mut created = 0usize;
    let mut updated = 0usize;

    for table in &all_tables {
        let layer = infer_layer(table);
        let model_type = infer_model_type(table, table_edges);
        let source = if contract_schemas.contains_key(table) {
            "contract"
        } else {
            "auto"
        };
        let contract_id = contract_schemas
            .get(table)
            .map(|(cid, _)| *cid)
            .unwrap_or("");

        // Upsert
        let result = conn.execute(
            "INSERT INTO model_registry
                (project_id, table_name, model_layer, model_type, source, contract_id, created_at, updated_at, status)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, 1)
             ON CONFLICT(project_id, table_name) DO UPDATE SET
                model_layer = CASE WHEN model_registry.model_layer = '' THEN excluded.model_layer ELSE model_registry.model_layer END,
                model_type = CASE WHEN model_registry.model_type = '' THEN excluded.model_type ELSE model_registry.model_type END,
                updated_at = excluded.updated_at",
            params![project_id, table, layer, model_type, source, contract_id, now],
        )?;

        if result == 1 {
            created += 1;
        } else {
            updated += 1;
        }
    }

    Ok((created, updated))
}

/// List models with optional filters.
pub fn list_models(
    conn: &Connection,
    project_id: &str,
    layer: Option<&str>,
    domain: Option<&str>,
    owner: Option<&str>,
    query: Option<&str>,
) -> Result<Vec<ModelEntry>, rusqlite::Error> {
    let mut sql = String::from(
        "SELECT id, project_id, table_name, model_layer, model_type, business_domain, owner, lifecycle, description, tags, source, contract_id FROM model_registry WHERE project_id = ?1 AND status = 1",
    );
    let mut param_idx = 2;
    let mut param_values: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(project_id.to_string())];

    if let Some(l) = layer {
        sql.push_str(&format!(" AND model_layer = ?{param_idx}"));
        param_values.push(Box::new(l.to_string()));
        param_idx += 1;
    }
    if let Some(d) = domain {
        sql.push_str(&format!(" AND business_domain = ?{param_idx}"));
        param_values.push(Box::new(d.to_string()));
        param_idx += 1;
    }
    if let Some(o) = owner {
        sql.push_str(&format!(" AND owner = ?{param_idx}"));
        param_values.push(Box::new(o.to_string()));
        param_idx += 1;
    }
    if let Some(q) = query {
        sql.push_str(&format!(" AND (table_name LIKE ?{param_idx} OR description LIKE ?{param_idx})"));
        param_values.push(Box::new(format!("%{q}%")));
        param_idx += 1;
    }
    sql.push_str(" ORDER BY table_name");

    let mut stmt = conn.prepare(&sql)?;
    let param_refs: Vec<&dyn rusqlite::ToSql> = param_values.iter().map(|p| p.as_ref()).collect();
    let rows = stmt.query_map(param_refs.as_slice(), |row| {
        let tags_json: String = row.get(9)?;
        let tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_default();
        Ok(ModelEntry {
            id: row.get(0)?,
            project_id: row.get(1)?,
            table_name: row.get(2)?,
            model_layer: row.get(3)?,
            model_type: row.get(4)?,
            business_domain: row.get(5)?,
            owner: row.get(6)?,
            lifecycle: row.get(7)?,
            description: row.get(8)?,
            tags,
            source: row.get(10)?,
            contract_id: row.get(11)?,
        })
    })?;

    rows.collect()
}

/// Get a single model by table name.
pub fn get_model(conn: &Connection, project_id: &str, table_name: &str) -> Result<Option<ModelEntry>, rusqlite::Error> {
    let models = list_models(conn, project_id, None, None, None, Some(table_name))?;
    Ok(models.into_iter().find(|m| m.table_name == table_name))
}

/// Update model fields.
pub fn update_model(
    conn: &Connection,
    project_id: &str,
    table_name: &str,
    layer: Option<&str>,
    domain: Option<&str>,
    owner: Option<&str>,
    description: Option<&str>,
    lifecycle: Option<&str>,
) -> Result<(), rusqlite::Error> {
    let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
    let mut sets = vec!["updated_at = ?1".to_string()];
    let mut idx = 2;
    let mut params_vec: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(now.clone())];

    if let Some(v) = layer {
        sets.push(format!("model_layer = ?{idx}"));
        params_vec.push(Box::new(v.to_string()));
        idx += 1;
    }
    if let Some(v) = domain {
        sets.push(format!("business_domain = ?{idx}"));
        params_vec.push(Box::new(v.to_string()));
        idx += 1;
    }
    if let Some(v) = owner {
        sets.push(format!("owner = ?{idx}"));
        params_vec.push(Box::new(v.to_string()));
        idx += 1;
    }
    if let Some(v) = description {
        sets.push(format!("description = ?{idx}"));
        params_vec.push(Box::new(v.to_string()));
        idx += 1;
    }
    if let Some(v) = lifecycle {
        sets.push(format!("lifecycle = ?{idx}"));
        params_vec.push(Box::new(v.to_string()));
        idx += 1;
    }

    params_vec.push(Box::new(project_id.to_string()));
    params_vec.push(Box::new(table_name.to_string()));

    let sql = format!(
        "UPDATE model_registry SET {} WHERE project_id = ?{idx} AND table_name = ?{}",
        sets.join(", "),
        idx + 1
    );

    let param_refs: Vec<&dyn rusqlite::ToSql> = params_vec.iter().map(|p| p.as_ref()).collect();
    conn.execute(&sql, param_refs.as_slice())?;
    Ok(())
}

/// Get model statistics.
pub fn get_model_stats(conn: &Connection, project_id: &str) -> Result<ModelStats, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT model_layer, model_type, business_domain, lifecycle, COUNT(*) FROM model_registry WHERE project_id = ?1 AND status = 1 GROUP BY model_layer, model_type, business_domain, lifecycle",
    )?;

    let mut stats = ModelStats {
        total: 0,
        by_layer: HashMap::new(),
        by_type: HashMap::new(),
        by_domain: HashMap::new(),
        by_lifecycle: HashMap::new(),
    };

    let rows = stmt.query_map(params![project_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, usize>(4)?,
        ))
    })?;

    for row in rows.flatten() {
        let (layer, mtype, domain, lifecycle, count) = row;
        stats.total += count;
        *stats.by_layer.entry(layer).or_default() += count;
        *stats.by_type.entry(mtype).or_default() += count;
        *stats.by_domain.entry(domain).or_default() += count;
        *stats.by_lifecycle.entry(lifecycle).or_default() += count;
    }

    Ok(stats)
}

/// Get model relations (upstream/downstream from table_level_edges).
pub fn get_model_relations(
    table_name: &str,
    table_edges: &[(String, String, String)],
) -> ModelRelation {
    let mut upstream = Vec::new();
    let mut downstream = Vec::new();
    let mut scripts = Vec::new();

    for (from, to, script) in table_edges {
        if to == table_name {
            upstream.push(from.clone());
        }
        if from == table_name {
            downstream.push(to.clone());
        }
        if from == table_name || to == table_name {
            if !script.is_empty() && !scripts.contains(script) {
                scripts.push(script.clone());
            }
        }
    }

    upstream.sort();
    upstream.dedup();
    downstream.sort();
    downstream.dedup();

    ModelRelation {
        upstream,
        downstream,
        bound_metrics: vec![],
        related_scripts: scripts,
        related_contracts: vec![],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_infer_layer() {
        assert_eq!(infer_layer("ods_orders"), "ODS");
        assert_eq!(infer_layer("dwd_order_detail"), "DWD");
        assert_eq!(infer_layer("dws_gmv_daily"), "DWS");
        assert_eq!(infer_layer("ads_report"), "ADS");
        assert_eq!(infer_layer("dim_date"), "DIM");
        assert_eq!(infer_layer("random_table"), "unknown");
    }

    #[test]
    fn test_infer_model_type() {
        let edges = vec![
            ("ods_raw".to_string(), "dws_agg".to_string(), "etl.sql".to_string()),
        ];
        assert_eq!(infer_model_type("dws_agg", &edges), "aggregate");
        assert_eq!(infer_model_type("ods_raw", &edges), "source");
        assert_eq!(infer_model_type("unknown_table", &edges), "unknown");
    }

    #[test]
    fn test_model_relations() {
        let edges = vec![
            ("ods_raw".to_string(), "dwd_clean".to_string(), "etl1.sql".to_string()),
            ("dwd_clean".to_string(), "dws_agg".to_string(), "etl2.sql".to_string()),
            ("dws_agg".to_string(), "ads_report".to_string(), "etl3.sql".to_string()),
        ];
        let rel = get_model_relations("dwd_clean", &edges);
        assert_eq!(rel.upstream, vec!["ods_raw"]);
        assert_eq!(rel.downstream, vec!["dws_agg"]);
        assert_eq!(rel.related_scripts.len(), 2);
    }
}
