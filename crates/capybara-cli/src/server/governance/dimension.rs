//! Dimension registry: auto-discover dimensions from lineage ownership edges,
//! manage dimension candidates → confirmed lifecycle.

use std::collections::{HashMap, HashSet};

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

/// A dimension entry in the registry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DimensionEntry {
    pub id: i64,
    pub project_id: String,
    pub dim_name: String,
    pub dim_name_cn: String,
    pub dim_column: String,
    pub master_table: String,
    pub attributes: Vec<String>,
    pub ref_count: usize,
    pub ref_tables: Vec<String>,
    pub status: String,
    pub owner: String,
    pub description: String,
}

/// Noise columns to exclude from dimension discovery.
const NOISE_COLUMNS: &[&str] = &[
    "id", "dt", "data_dt", "created_at", "updated_at", "status",
    "is_deleted", "is_delete", "_sign", "is_valid",
    "col_1", "col_2", "col_3", "col_4", "col_5",
    "rownum", "row_id", "rn", "rk",
];

/// Time-like columns to exclude (they are time dimensions, handled separately).
const TIME_COLUMNS: &[&str] = &[
    "from_unixtime", "statt_tm", "imp_date", "etl_dt",
    "current_date", "now", "today",
];

/// Auto-discover dimension candidates from lineage ownership edges.
///
/// Algorithm:
/// 1. Find all table/view nodes.
/// 2. For each table, find its columns via ownership edges.
/// 3. Aggregate by column label: a column referenced by ≥3 distinct tables
///    is a dimension candidate.
/// 4. For each candidate, find the "master table" (the table with the most
/// A dimension candidate discovered from lineage (read phase output).
pub struct DimensionCandidate {
    pub dim_name: String,
    pub dim_column: String,
    pub master_table: String,
    pub attributes: Vec<String>,
    pub ref_count: usize,
    pub ref_tables: Vec<String>,
}

/// Phase 1 (read from main DB): Scan lineage to discover dimension candidates.
/// Does NOT touch gov_db. Returns candidates for phase 2 to persist.
pub fn discover_read(
    main_conn: &Connection,
    project_id: &str,
) -> Result<Vec<DimensionCandidate>, String> {
    // Step 1: Collect table node IDs → table label.
    let mut table_labels: HashMap<String, String> = HashMap::new();
    let sql_tables =
        "SELECT node_id, label FROM lineage_nodes \
         WHERE project_id = ?1 AND node_type IN ('table', 'view')";
    if let Ok(mut stmt) = main_conn.prepare(sql_tables) {
        let rows = stmt.query_map(params![project_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        });
        if let Ok(rows) = rows {
            for (nid, label) in rows.flatten() {
                table_labels.insert(nid, label);
            }
        }
    }

    if table_labels.is_empty() {
        return Err("No table nodes found in lineage".into());
    }

    // Step 2: Query ALL columns once — used for both col→tables map AND table→cols map.
    let mut col_to_tables: HashMap<String, HashSet<String>> = HashMap::new();
    let mut table_to_cols: HashMap<String, Vec<String>> = HashMap::new();
    let sql_cols =
        "SELECT label, parent_node_id FROM lineage_columns \
         WHERE project_id = ?1 AND parent_node_id IS NOT NULL";
    if let Ok(mut stmt) = main_conn.prepare(sql_cols) {
        let rows = stmt.query_map(params![project_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        });
        if let Ok(rows) = rows {
            for (label, parent) in rows.flatten() {
                if let Some(tbl) = table_labels.get(&parent) {
                    col_to_tables.entry(label.clone()).or_default().insert(tbl.clone());
                    table_to_cols.entry(tbl.clone()).or_default().push(label);
                }
            }
        }
    }

    // Step 3: Filter candidates (≥3 tables, not noise/time).
    let noise_set: HashSet<&str> = NOISE_COLUMNS.iter().copied().collect();
    let time_set: HashSet<&str> = TIME_COLUMNS.iter().copied().collect();

    let mut candidates_raw: Vec<(String, Vec<String>)> = col_to_tables
        .into_iter()
        .filter(|(col, tables)| {
            let lower = col.to_lowercase();
            tables.len() >= 3
                && !noise_set.contains(lower.as_str())
                && !time_set.contains(lower.as_str())
                && col.len() > 1
        })
        .map(|(col, tables)| {
            let mut tbls: Vec<String> = tables.into_iter().collect();
            tbls.sort();
            (col, tbls)
        })
        .collect();
    candidates_raw.sort_by(|a, b| b.1.len().cmp(&a.1.len()));

    // Step 4: Build DimensionCandidate with master table + attributes.
    let candidates: Vec<DimensionCandidate> = candidates_raw
        .into_iter()
        .map(|(col, ref_tables)| {
            let master_table = ref_tables
                .iter()
                .max_by_key(|t| table_to_cols.get(*t).map(|c| c.len()).unwrap_or(0))
                .cloned()
                .unwrap_or_default();

            let attributes: Vec<String> = table_to_cols
                .get(&master_table)
                .map(|cols| {
                    cols.iter()
                        .filter(|c| {
                            **c != col
                                && !noise_set.contains(&c.to_lowercase().as_str())
                                && c.len() > 1
                        })
                        .take(20)
                        .cloned()
                        .collect()
                })
                .unwrap_or_default();

            let dim_name = generate_dim_name(&col);
            let ref_count = ref_tables.len();
            DimensionCandidate {
                dim_name,
                dim_column: col,
                master_table,
                attributes,
                ref_count,
                ref_tables,
            }
        })
        .collect();

    Ok(candidates)
}

/// Phase 2 (write to gov DB): Persist dimension candidates.
pub fn discover_write(
    gov_conn: &Connection,
    project_id: &str,
    candidates: &[DimensionCandidate],
) -> Result<usize, String> {
    let now = chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string();
    let noise_set: HashSet<&str> = NOISE_COLUMNS.iter().copied().collect();

    let mut upserted = 0usize;
    for c in candidates {
        // Truncate ref_tables for storage.
        let ref_tables_json = serde_json::to_string(
            &c.ref_tables.iter().take(10).cloned().collect::<Vec<_>>(),
        )
        .unwrap_or_default();
        let attrs_json = serde_json::to_string(&c.attributes).unwrap_or_default();

        let result = gov_conn.execute(
            "INSERT INTO dimension_registry
                (project_id, dim_name, dim_column, master_table, attributes, ref_count,
                 ref_tables, status, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'candidate', ?8, ?8)
             ON CONFLICT(project_id, dim_name) DO UPDATE SET
                dim_column = excluded.dim_column,
                master_table = excluded.master_table,
                attributes = excluded.attributes,
                ref_count = excluded.ref_count,
                ref_tables = excluded.ref_tables,
                updated_at = excluded.updated_at",
            params![
                project_id,
                c.dim_name,
                c.dim_column,
                c.master_table,
                attrs_json,
                c.ref_count,
                ref_tables_json,
                now,
            ],
        );

        if result.is_ok() {
            upserted += 1;
        }
    }

    let _ = noise_set; // suppress unused
    Ok(upserted)
}

/// Generate a dimension name from a column name.
/// `vid` → `video`, `usr_id` → `user`, otherwise use the column name itself.
fn generate_dim_name(col: &str) -> String {
    let lower = col.to_lowercase();
    // Common dimension name mappings.
    match lower.as_str() {
        "vid" => "video".into(),
        "usr_id" | "uid" | "user_id" => "user".into(),
        "cid" => "content".into(),
        "termn_id" | "terminal_id" => "terminal".into(),
        "appver_id" | "app_version" => "app_version".into(),
        "loc_id" | "location_id" => "location".into(),
        "yangid" => "yang_id".into(),
        "video_ctgy" | "video_category" => "video_category".into(),
        "video_side" => "video_channel".into(),
        _ => lower.replace(' ', "_"),
    }
}

/// List dimensions with optional status filter and pagination.
pub fn list_dimensions(
    conn: &Connection,
    project_id: &str,
    status: Option<&str>,
    limit: usize,
    offset: usize,
) -> Result<(Vec<DimensionEntry>, usize), rusqlite::Error> {
    // Count total first.
    let count_sql = match status {
        Some(_) => "SELECT COUNT(*) FROM dimension_registry WHERE project_id = ?1 AND status = ?2",
        None => "SELECT COUNT(*) FROM dimension_registry WHERE project_id = ?1",
    };
    let total: usize = if let Some(s) = status {
        conn.query_row(count_sql, params![project_id, s], |row| row.get::<_, i64>(0).map(|v| v as usize))?
    } else {
        conn.query_row(count_sql, params![project_id], |row| row.get::<_, i64>(0).map(|v| v as usize))?
    };

    let mut sql = String::from(
        "SELECT id, project_id, dim_name, dim_name_cn, dim_column, master_table,
                attributes, ref_count, ref_tables, status, owner, description
         FROM dimension_registry WHERE project_id = ?1",
    );
    let mut params_vec: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(project_id.to_string())];
    let mut idx = 2;
    if let Some(s) = status {
        sql.push_str(&format!(" AND status = ?{idx}"));
        params_vec.push(Box::new(s.to_string()));
        idx += 1;
    }
    sql.push_str(&format!(" ORDER BY ref_count DESC LIMIT ?{idx} OFFSET ?{}", idx + 1));
    params_vec.push(Box::new(limit as i64));
    params_vec.push(Box::new(offset as i64));

    let mut stmt = conn.prepare(&sql)?;
    let param_refs: Vec<&dyn rusqlite::ToSql> = params_vec.iter().map(|p| p.as_ref()).collect();
    let rows = stmt.query_map(param_refs.as_slice(), |row| {
        let attrs_json: String = row.get(6)?;
        let attrs: Vec<String> = serde_json::from_str(&attrs_json).unwrap_or_default();
        let ref_tables_json: String = row.get(8)?;
        let mut ref_tables: Vec<String> = serde_json::from_str(&ref_tables_json).unwrap_or_default();
        // Truncate ref_tables to keep payload small (max 10).
        ref_tables.truncate(10);
        Ok(DimensionEntry {
            id: row.get(0)?,
            project_id: row.get(1)?,
            dim_name: row.get(2)?,
            dim_name_cn: row.get::<_, String>(3).unwrap_or_default(),
            dim_column: row.get(4)?,
            master_table: row.get::<_, String>(5).unwrap_or_default(),
            attributes: attrs,
            ref_count: row.get::<_, i64>(7).unwrap_or(0) as usize,
            ref_tables,
            status: row.get(9)?,
            owner: row.get::<_, String>(10).unwrap_or_default(),
            description: row.get::<_, String>(11).unwrap_or_default(),
        })
    })?;

    let dims: Vec<DimensionEntry> = rows.collect::<Result<Vec<_>, _>>()?;
    Ok((dims, total))
}

/// Update a dimension (confirm / edit / dismiss).
pub fn update_dimension(
    conn: &Connection,
    project_id: &str,
    dim_id: i64,
    status: Option<&str>,
    dim_name: Option<&str>,
    dim_name_cn: Option<&str>,
    description: Option<&str>,
) -> Result<(), rusqlite::Error> {
    let now = chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string();

    let mut sets = vec!["updated_at = ?1".to_string()];
    let mut idx = 2;
    let mut params_vec: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(now.clone())];

    if let Some(s) = status {
        sets.push(format!("status = ?{idx}"));
        params_vec.push(Box::new(s.to_string()));
        idx += 1;
    }
    if let Some(n) = dim_name {
        sets.push(format!("dim_name = ?{idx}"));
        params_vec.push(Box::new(n.to_string()));
        idx += 1;
    }
    if let Some(n) = dim_name_cn {
        sets.push(format!("dim_name_cn = ?{idx}"));
        params_vec.push(Box::new(n.to_string()));
        idx += 1;
    }
    if let Some(d) = description {
        sets.push(format!("description = ?{idx}"));
        params_vec.push(Box::new(d.to_string()));
        idx += 1;
    }

    params_vec.push(Box::new(project_id.to_string()));
    params_vec.push(Box::new(dim_id));

    let sql = format!(
        "UPDATE dimension_registry SET {} WHERE project_id = ?{} AND id = ?{}",
        sets.join(", "),
        idx,
        idx + 1
    );

    conn.execute(
        &sql,
        params_vec
            .iter()
            .map(|p| p.as_ref())
            .collect::<Vec<_>>()
            .as_slice(),
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_dim_name() {
        assert_eq!(generate_dim_name("vid"), "video");
        assert_eq!(generate_dim_name("usr_id"), "user");
        assert_eq!(generate_dim_name("video_ctgy"), "video_category");
        assert_eq!(generate_dim_name("CustomField"), "customfield");
    }
}
