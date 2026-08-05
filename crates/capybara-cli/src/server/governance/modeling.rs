//! Dataphin-style modeling: domain discovery + modeling overview.
//!
//! Domain (主题域) is inferred from the project's file-path directory
//! structure (e.g. `etl/M01_接口集市库-BI/...` → domain "M01_接口集市库-BI").
//! The modeling overview aggregates counts across all governance registries
//! so the frontend can render a Dataphin-like modeling workspace.

use std::collections::HashMap;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

/// A discovered domain entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DomainEntry {
    pub id: i64,
    pub project_id: String,
    pub domain_name: String,
    pub description: String,
    pub model_count: usize,
}

/// Modeling overview for the workspace header.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelingOverview {
    pub total_models: usize,
    pub total_dimensions: usize,
    pub total_atomic_metrics: usize,
    pub total_derived_metrics: usize,
    pub total_qualifiers: usize,
    pub total_summary_tables: usize,
    pub layers: std::collections::BTreeMap<String, usize>,
    pub domains: Vec<ModelingDomain>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelingDomain {
    pub domain_name: String,
    pub model_count: usize,
    pub description: String,
}

/// Discover domains from the main DB's file-path directory structure.
/// `etl/M01_接口集市库-BI/foo.HQL` → domain "M01_接口集市库-BI".
pub fn discover_domains(
    main_conn: &Connection,
    gov_conn: &Connection,
    project_id: &str,
) -> Result<usize, String> {
    let now = chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string();

    // Collect all distinct parent-directory segments from lineage file paths.
    let mut domain_map: HashMap<String, usize> = HashMap::new();
    let sql = "SELECT DISTINCT file_path FROM lineage_nodes WHERE project_id = ?1 AND file_path != ''";
    if let Ok(mut stmt) = main_conn.prepare(sql) {
        let rows = stmt.query_map(params![project_id], |row| row.get::<_, String>(0));
        if let Ok(rows) = rows {
            for fp in rows.flatten() {
                if let Some(d) = infer_domain(&fp) {
                    *domain_map.entry(d).or_insert(0) += 1;
                }
            }
        }
    }

    // Upsert domains.
    let mut upserted = 0usize;
    for (name, count) in &domain_map {
        let desc = format!("{count} 个模型");
        let result = gov_conn.execute(
            "INSERT INTO domain_registry (project_id, domain_name, description, status, created_at, updated_at)
             VALUES (?1, ?2, ?3, 1, ?4, ?4)
             ON CONFLICT(project_id, domain_name) DO UPDATE SET
                description = excluded.description,
                updated_at = excluded.updated_at",
            params![project_id, name, desc, now],
        );
        if result.is_ok() {
            upserted += 1;
        }
    }

    Ok(upserted)
}

/// Infer the domain (business area) from a file path.
/// `etl/M01_接口集市库-BI/xxx.HQL` → `M01_接口集市库-BI`
/// `bigquery/proj/db/tbl.sql` → `db`
fn infer_domain(file_path: &str) -> Option<String> {
    let normalized = file_path.replace('\\', "/");
    let segments: Vec<&str> = normalized.split('/').filter(|s| !s.is_empty()).collect();
    if segments.len() < 2 {
        return None;
    }
    // Skip generic first segment (etl/, bigquery/, etc.) → use second segment.
    let second = segments[1];
    if second.is_empty() || second.len() < 2 {
        return None;
    }
    // Skip noise dirs.
    if matches!(second, "ALL" | "TMP" | "tmp" | "temp") {
        return None;
    }
    Some(second.to_string())
}

/// Compute the modeling overview by aggregating across governance registries.
pub fn modeling_overview(
    gov_conn: &Connection,
    project_id: &str,
) -> Result<ModelingOverview, rusqlite::Error> {
    let total_models = count_rows(gov_conn, project_id, "model_registry")?;
    let total_dimensions = count_rows(gov_conn, project_id, "dimension_registry")?;
    let total_atomic_metrics = count_rows(gov_conn, project_id, "atomic_metric_registry")?;
    let total_derived_metrics = count_rows(gov_conn, project_id, "derived_metric_registry")?;
    let total_qualifiers = count_rows(gov_conn, project_id, "business_qualifier_registry")?;
    let total_summary_tables = count_rows(gov_conn, project_id, "summary_table_recommendation")?;

    // Layer distribution from model_registry.
    let mut layers = std::collections::BTreeMap::new();
    if let Ok(mut stmt) = gov_conn.prepare(
        "SELECT model_layer, COUNT(*) FROM model_registry WHERE project_id = ?1 GROUP BY model_layer",
    ) {
        let rows = stmt.query_map(params![project_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        });
        if let Ok(rows) = rows {
            for (layer, cnt) in rows.flatten() {
                layers.insert(layer, cnt as usize);
            }
        }
    }

    // Domains with model counts.
    let mut domains = Vec::new();
    if let Ok(mut stmt) = gov_conn.prepare(
        "SELECT d.domain_name, d.description,
                (SELECT COUNT(*) FROM model_registry m WHERE m.project_id = d.project_id AND m.business_domain = d.domain_name)
         FROM domain_registry d WHERE d.project_id = ?1 ORDER BY d.domain_name",
    ) {
        let rows = stmt.query_map(params![project_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        });
        if let Ok(rows) = rows {
            for (name, desc, cnt) in rows.flatten() {
                domains.push(ModelingDomain {
                    domain_name: name,
                    model_count: cnt as usize,
                    description: desc,
                });
            }
        }
    }

    Ok(ModelingOverview {
        total_models,
        total_dimensions,
        total_atomic_metrics,
        total_derived_metrics,
        total_qualifiers,
        total_summary_tables,
        layers,
        domains,
    })
}

fn count_rows(conn: &Connection, project_id: &str, table: &str) -> Result<usize, rusqlite::Error> {
    let sql = format!("SELECT COUNT(*) FROM {table} WHERE project_id = ?1");
    conn.query_row(&sql, params![project_id], |row| row.get::<_, i64>(0).map(|v| v as usize))
}

/// List domains.
pub fn list_domains(
    conn: &Connection,
    project_id: &str,
) -> Result<Vec<DomainEntry>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, project_id, domain_name, description,
                (SELECT COUNT(*) FROM model_registry m WHERE m.project_id = domain_registry.project_id AND m.business_domain = domain_registry.domain_name)
         FROM domain_registry WHERE project_id = ?1 ORDER BY domain_name",
    )?;
    let rows = stmt.query_map(params![project_id], |row| {
        Ok(DomainEntry {
            id: row.get(0)?,
            project_id: row.get(1)?,
            domain_name: row.get(2)?,
            description: row.get::<_, String>(3).unwrap_or_default(),
            model_count: row.get::<_, i64>(4).unwrap_or(0) as usize,
        })
    })?;
    rows.collect()
}
