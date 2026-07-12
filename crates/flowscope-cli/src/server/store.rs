//! SQLite storage layer for serve-mode persistence.
//!
//! Stores projects, lineage data, and analysis cache in a local SQLite file.
//! Each table uses an auto-increment INTEGER primary key.

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{Connection, params};
use serde::{Serialize, Deserialize};

/// Open (or create) the database file at the given path.
pub fn open_db(path: &Path) -> Result<Mutex<Connection>, rusqlite::Error> {
    let conn = Connection::open(path)?;
    conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA cache_size = -200000; PRAGMA temp_store = MEMORY; PRAGMA wal_autocheckpoint = 1000;")?;
    create_tables(&conn)?;
    Ok(Mutex::new(conn))
}

fn create_tables(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS project_files (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id TEXT    NOT NULL,
            name       TEXT    NOT NULL,
            path       TEXT    NOT NULL,
            content    TEXT    NOT NULL DEFAULT '',
            language   TEXT    NOT NULL DEFAULT 'sql',
            size       INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL DEFAULT 0,
            status     INTEGER NOT NULL DEFAULT 1,
            UNIQUE(project_id, path)
        );

        CREATE TABLE IF NOT EXISTS schema_files (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id TEXT    NOT NULL,
            name       TEXT    NOT NULL,
            path       TEXT    NOT NULL,
            content    TEXT    NOT NULL DEFAULT '',
            size       INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL DEFAULT 0,
            status     INTEGER NOT NULL DEFAULT 1,
            UNIQUE(project_id, path)
        );

        CREATE TABLE IF NOT EXISTS analysis_cache (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            cache_key        TEXT    NOT NULL UNIQUE,
            result_json      TEXT    NOT NULL,
            size_bytes       INTEGER NOT NULL,
            created_at       INTEGER NOT NULL DEFAULT 0,
            updated_at       INTEGER NOT NULL DEFAULT 0,
            last_accessed_at INTEGER NOT NULL DEFAULT 0,
            status           INTEGER NOT NULL DEFAULT 1
        );

        CREATE TABLE IF NOT EXISTS project_file_results (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id   TEXT    NOT NULL,
            file_path    TEXT    NOT NULL,
            result_json  TEXT    NOT NULL,
            content_hash TEXT    NOT NULL,
            size_bytes   INTEGER NOT NULL DEFAULT 0,
            created_at   INTEGER NOT NULL DEFAULT 0,
            updated_at   INTEGER NOT NULL DEFAULT 0,
            status       INTEGER NOT NULL DEFAULT 1,
            UNIQUE(project_id, file_path)
        );

        CREATE TABLE IF NOT EXISTS lineage_nodes (
            id                INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id        TEXT    NOT NULL,
            file_path         TEXT    NOT NULL,
            node_id           TEXT    NOT NULL,
            node_type         TEXT    NOT NULL,
            label             TEXT    NOT NULL,
            qualified_name    TEXT,
            statement_index   INTEGER NOT NULL,
            resolution_source TEXT,
            created_at        INTEGER NOT NULL DEFAULT 0,
            updated_at        INTEGER NOT NULL DEFAULT 0,
            status            INTEGER NOT NULL DEFAULT 1,
            UNIQUE(project_id, file_path, node_id)
        );

        CREATE TABLE IF NOT EXISTS lineage_columns (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id      TEXT    NOT NULL,
            file_path       TEXT    NOT NULL,
            column_id       TEXT    NOT NULL,
            label           TEXT    NOT NULL,
            qualified_name  TEXT,
            parent_node_id  TEXT,
            expression      TEXT,
            statement_index INTEGER NOT NULL,
            created_at      INTEGER NOT NULL DEFAULT 0,
            updated_at      INTEGER NOT NULL DEFAULT 0,
            status          INTEGER NOT NULL DEFAULT 1,
            UNIQUE(project_id, file_path, column_id)
        );

        CREATE TABLE IF NOT EXISTS lineage_edges (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id      TEXT    NOT NULL,
            file_path       TEXT    NOT NULL,
            edge_id         TEXT    NOT NULL,
            from_id         TEXT    NOT NULL,
            to_id           TEXT    NOT NULL,
            edge_type       TEXT    NOT NULL,
            expression      TEXT,
            statement_index INTEGER,
            created_at      INTEGER NOT NULL DEFAULT 0,
            updated_at      INTEGER NOT NULL DEFAULT 0,
            status          INTEGER NOT NULL DEFAULT 1,
            UNIQUE(project_id, file_path, edge_id)
        );

        CREATE TABLE IF NOT EXISTS table_metadata (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id      TEXT    NOT NULL,
            catalog         TEXT    NOT NULL DEFAULT '',
            schema_name     TEXT    NOT NULL DEFAULT '',
            table_name      TEXT    NOT NULL,
            table_type      TEXT    NOT NULL DEFAULT 'table',
            origin          TEXT    NOT NULL DEFAULT 'unknown',
            temporary       INTEGER NOT NULL DEFAULT 0,
            partition_keys  TEXT    NOT NULL DEFAULT '',
            cluster_keys    TEXT    NOT NULL DEFAULT '',
            file_format     TEXT    NOT NULL DEFAULT '',
            location        TEXT    NOT NULL DEFAULT '',
            properties_json TEXT    NOT NULL DEFAULT '{}',
            owner           TEXT    NOT NULL DEFAULT '',
            comment         TEXT    NOT NULL DEFAULT '',
            row_count       INTEGER NOT NULL DEFAULT -1,
            size_bytes      INTEGER NOT NULL DEFAULT -1,
            created_at      INTEGER NOT NULL DEFAULT 0,
            updated_at      INTEGER NOT NULL DEFAULT 0,
            status          INTEGER NOT NULL DEFAULT 1,
            UNIQUE(project_id, catalog, schema_name, table_name)
        );

        CREATE TABLE IF NOT EXISTS column_metadata (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id      TEXT    NOT NULL,
            table_id        INTEGER NOT NULL,
            column_name     TEXT    NOT NULL,
            ordinal         INTEGER NOT NULL DEFAULT 0,
            data_type       TEXT    NOT NULL DEFAULT '',
            is_nullable     INTEGER NOT NULL DEFAULT 1,
            is_primary_key  INTEGER NOT NULL DEFAULT 0,
            is_partition    INTEGER NOT NULL DEFAULT 0,
            default_value   TEXT,
            comment         TEXT    NOT NULL DEFAULT '',
            created_at      INTEGER NOT NULL DEFAULT 0,
            updated_at      INTEGER NOT NULL DEFAULT 0,
            status          INTEGER NOT NULL DEFAULT 1,
            UNIQUE(project_id, table_id, column_name),
            FOREIGN KEY(table_id) REFERENCES table_metadata(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS projects (
            id                TEXT PRIMARY KEY,
            name              TEXT    NOT NULL,
            dialect           TEXT    NOT NULL DEFAULT 'generic',
            run_mode          TEXT    NOT NULL DEFAULT 'current',
            template_mode     TEXT    NOT NULL DEFAULT 'raw',
            schema_sql        TEXT    NOT NULL DEFAULT '',
            selected_file_ids TEXT    NOT NULL DEFAULT '[]',
            active_file_id    TEXT,
            created_at        INTEGER NOT NULL DEFAULT 0,
            updated_at        INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS view_states (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id  TEXT    NOT NULL UNIQUE,
            state_json  TEXT    NOT NULL,
            created_at  INTEGER NOT NULL DEFAULT 0,
            updated_at  INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS table_level_edges (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id  TEXT    NOT NULL,
            from_table  TEXT    NOT NULL,
            to_table    TEXT    NOT NULL,
            script      TEXT    NOT NULL DEFAULT '',
            created_at  INTEGER NOT NULL DEFAULT 0,
            UNIQUE(project_id, from_table, to_table, script)
        );
        CREATE INDEX IF NOT EXISTS idx_table_level_edges_project ON table_level_edges(project_id);

        CREATE INDEX IF NOT EXISTS idx_lineage_nodes_project ON lineage_nodes(project_id);
        CREATE INDEX IF NOT EXISTS idx_lineage_nodes_node ON lineage_nodes(project_id, node_id);
        CREATE INDEX IF NOT EXISTS idx_lineage_edges_from ON lineage_edges(project_id, from_id);
        CREATE INDEX IF NOT EXISTS idx_lineage_edges_to ON lineage_edges(project_id, to_id);
        CREATE INDEX IF NOT EXISTS idx_lineage_columns_project ON lineage_columns(project_id);
        CREATE INDEX IF NOT EXISTS idx_lineage_edges_project ON lineage_edges(project_id);
        CREATE INDEX IF NOT EXISTS idx_lineage_nodes_type ON lineage_nodes(project_id, node_type);
        CREATE INDEX IF NOT EXISTS idx_project_file_results_project ON project_file_results(project_id);
        CREATE INDEX IF NOT EXISTS idx_table_metadata_project ON table_metadata(project_id);
        CREATE INDEX IF NOT EXISTS idx_column_metadata_table ON column_metadata(table_id);
        "
    )
}

// ── project_files ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectFileRow {
    pub name: String,
    pub path: String,
    pub content: String,
    pub language: String,
    pub size: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

pub fn save_project_files(
    conn: &Connection,
    project_id: &str,
    files: &[ProjectFileRow],
) -> Result<(), rusqlite::Error> {
    save_project_files_batch(conn, project_id, files, true)
}

pub fn save_project_files_batch(
    conn: &Connection,
    project_id: &str,
    files: &[ProjectFileRow],
    is_first: bool,
) -> Result<(), rusqlite::Error> {
    let tx = conn.unchecked_transaction()?;
    if is_first {
        tx.execute("DELETE FROM project_files WHERE project_id = ?1", params![project_id])?;
    }
    {
        let mut stmt = tx.prepare(
            "INSERT OR REPLACE INTO project_files (project_id, name, path, content, language, size, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)"
        )?;
        for f in files {
            stmt.execute(params![project_id, f.name, f.path, f.content, f.language, f.size, f.created_at, f.updated_at])?;
        }
    }
    tx.commit()?;
    Ok(())
}

pub fn load_project_files(
    conn: &Connection,
    project_id: &str,
) -> Result<Vec<ProjectFileRow>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT name, path, content, language, size, created_at, updated_at FROM project_files WHERE project_id = ?1 ORDER BY path"
    )?;
    let rows = stmt.query_map(params![project_id], |row| {
        Ok(ProjectFileRow {
            name: row.get(0)?,
            path: row.get(1)?,
            content: row.get(2)?,
            language: row.get(3)?,
            size: row.get(4)?,
            created_at: row.get(5)?,
            updated_at: row.get(6)?,
        })
    })?;
    rows.collect()
}

// ── projects ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectRow {
    pub id: String,
    pub name: String,
    pub dialect: String,
    pub run_mode: String,
    pub template_mode: String,
    pub schema_sql: String,
    pub selected_file_ids: String,
    pub active_file_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

pub fn save_project(conn: &Connection, p: &ProjectRow) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT OR REPLACE INTO projects (id, name, dialect, run_mode, template_mode, schema_sql, selected_file_ids, active_file_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![p.id, p.name, p.dialect, p.run_mode, p.template_mode, p.schema_sql, p.selected_file_ids, p.active_file_id, p.created_at, p.updated_at],
    )?;
    Ok(())
}

pub fn load_projects(conn: &Connection) -> Result<Vec<ProjectRow>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, name, dialect, run_mode, template_mode, schema_sql, selected_file_ids, active_file_id, created_at, updated_at FROM projects"
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(ProjectRow {
            id: row.get(0)?,
            name: row.get(1)?,
            dialect: row.get(2)?,
            run_mode: row.get(3)?,
            template_mode: row.get(4)?,
            schema_sql: row.get(5)?,
            selected_file_ids: row.get(6)?,
            active_file_id: row.get(7)?,
            created_at: row.get(8)?,
            updated_at: row.get(9)?,
        })
    })?;
    rows.collect()
}

pub fn delete_project(conn: &Connection, project_id: &str) -> Result<(), rusqlite::Error> {
    conn.execute("DELETE FROM projects WHERE id = ?1", params![project_id])?;
    Ok(())
}

// ── view_states ─────────────────────────────────────────────────────────

pub fn save_view_state(
    conn: &Connection,
    project_id: &str,
    state_json: &str,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT OR REPLACE INTO view_states (project_id, state_json, created_at, updated_at) VALUES (?1, ?2, ?3, ?4)",
        params![project_id, state_json, 0, 0],
    )?;
    Ok(())
}

pub fn load_view_state(conn: &Connection, project_id: &str) -> Result<Option<String>, rusqlite::Error> {
    let mut stmt = conn.prepare("SELECT state_json FROM view_states WHERE project_id = ?1")?;
    let mut rows = stmt.query(params![project_id])?;
    if let Some(row) = rows.next()? {
        Ok(Some(row.get(0)?))
    } else {
        Ok(None)
    }
}

pub fn load_all_view_states(conn: &Connection) -> Result<Vec<(String, String)>, rusqlite::Error> {
    let mut stmt = conn.prepare("SELECT project_id, state_json FROM view_states")?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    rows.collect()
}

// ── table-level lineage ────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableLevelEdge {
    pub from_table: String,
    pub to_table: String,
    pub file_path: String,
}

/// Physical table→table lineage for a project.
/// Joins lineage_edges to lineage_nodes on both endpoints, keeping only edges
/// where BOTH endpoints are physical tables/views (node_type table|view),
/// excluding CTE/temp/self-loops. This is what "table-level lineage" exports need.
pub fn load_table_lineage(conn: &Connection, project_id: &str) -> Result<Vec<TableLevelEdge>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT DISTINCT
            COALESCE(NULLIF(nf.qualified_name, ''), nf.label) AS from_table,
            COALESCE(NULLIF(nt.qualified_name, ''), nt.label) AS to_table,
            e.file_path
         FROM lineage_edges e
         JOIN lineage_nodes nf ON nf.node_id = e.from_id AND nf.project_id = e.project_id
         JOIN lineage_nodes nt ON nt.node_id = e.to_id AND nt.project_id = e.project_id
         WHERE e.project_id = ?1
           AND nf.node_type IN ('table', 'view')
           AND nt.node_type IN ('table', 'view')
           AND nf.node_id <> nt.node_id"
    )?;
    let rows = stmt.query_map(params![project_id], |row| {
        Ok(TableLevelEdge {
            from_table: row.get(0)?,
            to_table: row.get(1)?,
            file_path: row.get(2)?,
        })
    })?;
    rows.collect()
}

// ── table_level_edges (物化预计算,前端 buildTableLevelLineage 算好后写入) ──

pub fn save_table_level_edges(
    conn: &Connection,
    project_id: &str,
    edges: &[(String, String, String)],
) -> Result<(), rusqlite::Error> {
    use rusqlite::{params_from_iter, ToSql};
    let tx = conn.unchecked_transaction()?;
    tx.execute("DELETE FROM table_level_edges WHERE project_id = ?1", params![project_id])?;
    let now = chrono::Utc::now().timestamp_millis();
    const CHUNK: usize = 500;
    let row_ph = "(?,?,?,?,?)";
    for chunk in edges.chunks(CHUNK) {
        let sql = format!(
            "INSERT OR REPLACE INTO table_level_edges (project_id, from_table, to_table, script, created_at) VALUES {}",
            (0..chunk.len()).map(|_| row_ph).collect::<Vec<_>>().join(",")
        );
        let mut p: Vec<&dyn ToSql> = Vec::with_capacity(chunk.len() * 5);
        for (from, to, script) in chunk {
            p.push(&project_id);
            p.push(from);
            p.push(to);
            p.push(script);
            p.push(&now);
        }
        tx.execute(&sql, params_from_iter(p))?;
    }
    tx.commit()?;
    Ok(())
}

pub fn load_table_level_edges(conn: &Connection, project_id: &str) -> Result<Vec<(String, String, String)>, rusqlite::Error> {
    let mut stmt = conn.prepare("SELECT from_table, to_table, script FROM table_level_edges WHERE project_id = ?1")?;
    let rows = stmt.query_map(params![project_id], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))
    })?;
    rows.collect()
}

// ── schema_files ───────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchemaFileRow {
    pub name: String,
    pub path: String,
    pub content: String,
    pub size: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

pub fn save_schema_files(
    conn: &Connection,
    project_id: &str,
    files: &[SchemaFileRow],
) -> Result<(), rusqlite::Error> {
    let tx = conn.unchecked_transaction()?;
    tx.execute("DELETE FROM schema_files WHERE project_id = ?1", params![project_id])?;
    {
        let mut stmt = tx.prepare(
            "INSERT OR REPLACE INTO schema_files (project_id, name, path, content, size, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)"
        )?;
        for f in files {
            stmt.execute(params![project_id, f.name, f.path, f.content, f.size, f.created_at, f.updated_at])?;
        }
    }
    tx.commit()?;
    Ok(())
}

pub fn load_schema_files(
    conn: &Connection,
    project_id: &str,
) -> Result<Vec<SchemaFileRow>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT name, path, content, size, created_at, updated_at FROM schema_files WHERE project_id = ?1 ORDER BY path"
    )?;
    let rows = stmt.query_map(params![project_id], |row| {
        Ok(SchemaFileRow {
            name: row.get(0)?,
            path: row.get(1)?,
            content: row.get(2)?,
            size: row.get(3)?,
            created_at: row.get(4)?,
            updated_at: row.get(5)?,
        })
    })?;
    rows.collect()
}

// ── analysis_cache ─────────────────────────────────────────────────────

pub fn get_cache(
    conn: &Connection,
    cache_key: &str,
) -> Result<Option<String>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT result_json FROM analysis_cache WHERE cache_key = ?1"
    )?;
    let mut rows = stmt.query_map(params![cache_key], |row| row.get::<_, String>(0))?;
    if let Some(row) = rows.next() {
        conn.execute(
            "UPDATE analysis_cache SET last_accessed_at = ?1 WHERE cache_key = ?2",
            params![chrono::Utc::now().timestamp_millis(), cache_key],
        )?;
        Ok(Some(row?))
    } else {
        Ok(None)
    }
}

pub fn set_cache(
    conn: &Connection,
    cache_key: &str,
    result_json: &str,
) -> Result<(), rusqlite::Error> {
    let now = chrono::Utc::now().timestamp_millis();
    conn.execute(
        "INSERT OR REPLACE INTO analysis_cache (cache_key, result_json, size_bytes, created_at, updated_at, last_accessed_at, status) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1)",
        params![cache_key, result_json, result_json.len() as i64, now, now, now],
    )?;
    Ok(())
}

pub fn clear_all_cache(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.execute("DELETE FROM analysis_cache", [])?;
    Ok(())
}

pub fn delete_cache(conn: &Connection, key: &str) -> Result<(), rusqlite::Error> {
    conn.execute("DELETE FROM analysis_cache WHERE cache_key = ?1", params![key])?;
    Ok(())
}

// ── project_file_results ───────────────────────────────────────────────

pub fn set_file_result(
    conn: &Connection,
    project_id: &str,
    file_path: &str,
    result_json: &str,
    content_hash: &str,
) -> Result<(), rusqlite::Error> {
    let now = chrono::Utc::now().timestamp_millis();
    conn.execute(
        "INSERT OR REPLACE INTO project_file_results (project_id, file_path, result_json, content_hash, size_bytes, created_at, updated_at, status) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1)",
        params![project_id, file_path, result_json, content_hash, result_json.len() as i64, now, now],
    )?;
    Ok(())
}

pub fn get_file_result(
    conn: &Connection,
    project_id: &str,
    file_path: &str,
) -> Result<Option<(String, String)>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT result_json, content_hash FROM project_file_results WHERE project_id = ?1 AND file_path = ?2"
    )?;
    let mut rows = stmt.query_map(params![project_id, file_path], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    if let Some(row) = rows.next() {
        Ok(Some(row?))
    } else {
        Ok(None)
    }
}

pub fn get_file_results(
    conn: &Connection,
    project_id: &str,
) -> Result<Vec<(String, String, String)>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT file_path, result_json, content_hash FROM project_file_results WHERE project_id = ?1"
    )?;
    let rows = stmt.query_map(params![project_id], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))
    })?;
    rows.collect()
}

// ── lineage ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LineageNodeRow {
    pub node_id: String,
    pub node_type: String,
    pub label: String,
    pub qualified_name: Option<String>,
    pub statement_index: i64,
    pub resolution_source: Option<String>,
    pub file_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LineageColumnRow {
    pub column_id: String,
    pub label: String,
    pub qualified_name: Option<String>,
    pub parent_node_id: Option<String>,
    pub expression: Option<String>,
    pub statement_index: i64,
    pub file_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LineageEdgeRow {
    pub edge_id: String,
    pub from_id: String,
    pub to_id: String,
    pub edge_type: String,
    pub expression: Option<String>,
    pub statement_index: Option<i64>,
    pub file_path: String,
}

pub fn save_lineage_batch(
    conn: &Connection,
    project_id: &str,
    nodes: &[LineageNodeRow],
    columns: &[LineageColumnRow],
    edges: &[LineageEdgeRow],
) -> Result<(), rusqlite::Error> {
    use rusqlite::{params_from_iter, ToSql};
    let tx = conn.unchecked_transaction()?;

    // 只删除本次涉及的 file_path 的旧 lineage(支持 merged 跨文件),
    // 避免单文件分析时删全项目千万行导致卡死
    use std::collections::HashSet;
    let fp_set: HashSet<&str> = nodes.iter().map(|n| n.file_path.as_str())
        .chain(columns.iter().map(|c| c.file_path.as_str()))
        .chain(edges.iter().map(|e| e.file_path.as_str()))
        .collect();
    let fps: Vec<&str> = fp_set.into_iter().collect();
    if !fps.is_empty() {
        let placeholders = (0..fps.len()).map(|_| "?").collect::<Vec<_>>().join(",");
        for table in &["lineage_nodes", "lineage_columns", "lineage_edges"] {
            let mut p: Vec<&dyn ToSql> = Vec::with_capacity(fps.len() + 1);
            p.push(&project_id);
            for fp in &fps {
                p.push(&*fp);
            }
            tx.execute(
                &format!("DELETE FROM {} WHERE project_id = ? AND file_path IN ({})", table, placeholders),
                params_from_iter(p),
            )?;
        }
    }

    let now = chrono::Utc::now().timestamp_millis();
    const CHUNK: usize = 500; // 500 行 × 10 params = 5000,SQLite 3.32+ MAX_VARIABLE=32766 安全
    let row10 = "(?,?,?,?,?,?,?,?,?,?)";

    // nodes (10 cols)
    for chunk in nodes.chunks(CHUNK) {
        let sql = format!(
            "INSERT OR REPLACE INTO lineage_nodes (project_id, file_path, node_id, node_type, label, qualified_name, statement_index, resolution_source, created_at, updated_at) VALUES {}",
            (0..chunk.len()).map(|_| row10).collect::<Vec<_>>().join(",")
        );
        let mut p: Vec<&dyn ToSql> = Vec::with_capacity(chunk.len() * 10);
        for n in chunk {
            p.push(&project_id);
            p.push(&n.file_path);
            p.push(&n.node_id);
            p.push(&n.node_type);
            p.push(&n.label);
            p.push(&n.qualified_name);
            p.push(&n.statement_index);
            p.push(&n.resolution_source);
            p.push(&now);
            p.push(&now);
        }
        tx.execute(&sql, params_from_iter(p))?;
    }

    // columns (10 cols)
    for chunk in columns.chunks(CHUNK) {
        let sql = format!(
            "INSERT OR REPLACE INTO lineage_columns (project_id, file_path, column_id, label, qualified_name, parent_node_id, expression, statement_index, created_at, updated_at) VALUES {}",
            (0..chunk.len()).map(|_| row10).collect::<Vec<_>>().join(",")
        );
        let mut p: Vec<&dyn ToSql> = Vec::with_capacity(chunk.len() * 10);
        for c in chunk {
            p.push(&project_id);
            p.push(&c.file_path);
            p.push(&c.column_id);
            p.push(&c.label);
            p.push(&c.qualified_name);
            p.push(&c.parent_node_id);
            p.push(&c.expression);
            p.push(&c.statement_index);
            p.push(&now);
            p.push(&now);
        }
        tx.execute(&sql, params_from_iter(p))?;
    }

    // edges (10 cols)
    for chunk in edges.chunks(CHUNK) {
        let sql = format!(
            "INSERT OR REPLACE INTO lineage_edges (project_id, file_path, edge_id, from_id, to_id, edge_type, expression, statement_index, created_at, updated_at) VALUES {}",
            (0..chunk.len()).map(|_| row10).collect::<Vec<_>>().join(",")
        );
        let mut p: Vec<&dyn ToSql> = Vec::with_capacity(chunk.len() * 10);
        for e in chunk {
            p.push(&project_id);
            p.push(&e.file_path);
            p.push(&e.edge_id);
            p.push(&e.from_id);
            p.push(&e.to_id);
            p.push(&e.edge_type);
            p.push(&e.expression);
            p.push(&e.statement_index);
            p.push(&now);
            p.push(&now);
        }
        tx.execute(&sql, params_from_iter(p))?;
    }

    tx.commit()?;
    Ok(())
}

pub fn load_lineage_nodes(
    conn: &Connection,
    project_id: &str,
    file_path: Option<&str>,
) -> Result<Vec<LineageNodeRow>, rusqlite::Error> {
    let (sql, params_vec) = if let Some(fp) = file_path {
        (
            "SELECT node_id, node_type, label, qualified_name, statement_index, resolution_source, file_path FROM lineage_nodes WHERE project_id = ?1 AND file_path = ?2",
            vec![project_id.to_string(), fp.to_string()],
        )
    } else {
        (
            "SELECT node_id, node_type, label, qualified_name, statement_index, resolution_source, file_path FROM lineage_nodes WHERE project_id = ?1",
            vec![project_id.to_string()],
        )
    };
    let params: Vec<&dyn rusqlite::types::ToSql> = params_vec.iter().map(|s| s as &dyn rusqlite::types::ToSql).collect();
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map(params.as_slice(), |row| {
        Ok(LineageNodeRow {
            node_id: row.get(0)?,
            node_type: row.get(1)?,
            label: row.get(2)?,
            qualified_name: row.get(3)?,
            statement_index: row.get(4)?,
            resolution_source: row.get(5)?,
            file_path: row.get(6)?,
        })
    })?;
    rows.collect()
}

pub fn load_lineage_columns(
    conn: &Connection,
    project_id: &str,
    file_path: Option<&str>,
) -> Result<Vec<LineageColumnRow>, rusqlite::Error> {
    let (sql, params_vec) = if let Some(fp) = file_path {
        (
            "SELECT column_id, label, qualified_name, parent_node_id, expression, statement_index, file_path FROM lineage_columns WHERE project_id = ?1 AND file_path = ?2",
            vec![project_id.to_string(), fp.to_string()],
        )
    } else {
        (
            "SELECT column_id, label, qualified_name, parent_node_id, expression, statement_index, file_path FROM lineage_columns WHERE project_id = ?1",
            vec![project_id.to_string()],
        )
    };
    let params: Vec<&dyn rusqlite::types::ToSql> = params_vec.iter().map(|s| s as &dyn rusqlite::types::ToSql).collect();
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map(params.as_slice(), |row| {
        Ok(LineageColumnRow {
            column_id: row.get(0)?,
            label: row.get(1)?,
            qualified_name: row.get(2)?,
            parent_node_id: row.get(3)?,
            expression: row.get(4)?,
            statement_index: row.get(5)?,
            file_path: row.get(6)?,
        })
    })?;
    rows.collect()
}

pub fn load_lineage_edges(
    conn: &Connection,
    project_id: &str,
    file_path: Option<&str>,
) -> Result<Vec<LineageEdgeRow>, rusqlite::Error> {
    let (sql, params_vec) = if let Some(fp) = file_path {
        (
            "SELECT edge_id, from_id, to_id, edge_type, expression, statement_index, file_path FROM lineage_edges WHERE project_id = ?1 AND file_path = ?2",
            vec![project_id.to_string(), fp.to_string()],
        )
    } else {
        (
            "SELECT edge_id, from_id, to_id, edge_type, expression, statement_index, file_path FROM lineage_edges WHERE project_id = ?1",
            vec![project_id.to_string()],
        )
    };
    let params: Vec<&dyn rusqlite::types::ToSql> = params_vec.iter().map(|s| s as &dyn rusqlite::types::ToSql).collect();
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map(params.as_slice(), |row| {
        Ok(LineageEdgeRow {
            edge_id: row.get(0)?,
            from_id: row.get(1)?,
            to_id: row.get(2)?,
            edge_type: row.get(3)?,
            expression: row.get(4)?,
            statement_index: row.get(5)?,
            file_path: row.get(6)?,
        })
    })?;
    rows.collect()
}

pub fn clear_lineage_for_file(
    conn: &Connection,
    project_id: &str,
    file_path: &str,
) -> Result<(), rusqlite::Error> {
    for table in &["lineage_nodes", "lineage_columns", "lineage_edges"] {
        conn.execute(
            &format!("DELETE FROM {} WHERE project_id = ?1 AND file_path = ?2", table),
            params![project_id, file_path],
        )?;
    }
    Ok(())
}

// ── table_metadata / column_metadata ───────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableMetadataRow {
    pub id: i64,
    pub project_id: String,
    pub catalog: String,
    pub schema_name: String,
    pub table_name: String,
    pub table_type: String,
    pub origin: String,
    pub temporary: bool,
    pub partition_keys: String,
    pub cluster_keys: String,
    pub file_format: String,
    pub location: String,
    pub properties_json: String,
    pub owner: String,
    pub comment: String,
    pub row_count: i64,
    pub size_bytes: i64,
    pub created_at: i64,
    pub updated_at: i64,
    pub status: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColumnMetadataRow {
    pub id: i64,
    pub project_id: String,
    pub table_id: i64,
    pub column_name: String,
    pub ordinal: i32,
    pub data_type: String,
    pub is_nullable: bool,
    pub is_primary_key: bool,
    pub is_partition: bool,
    pub default_value: Option<String>,
    pub comment: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub status: i32,
}

pub fn save_table_metadata(
    conn: &Connection,
    project_id: &str,
    tables: &[TableMetadataRow],
    columns: &[ColumnMetadataRow],
) -> Result<(), rusqlite::Error> {
    let tx = conn.unchecked_transaction()?;

    // Upsert each table by (project_id, catalog, schema_name, table_name)
    let mut insert_table = tx.prepare(
        "INSERT INTO table_metadata (project_id, catalog, schema_name, table_name, table_type, origin, temporary, partition_keys, cluster_keys, file_format, location, properties_json, owner, comment, row_count, size_bytes, created_at, updated_at, status) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19) ON CONFLICT(project_id, catalog, schema_name, table_name) DO UPDATE SET table_type=excluded.table_type, origin=excluded.origin, temporary=excluded.temporary, partition_keys=excluded.partition_keys, cluster_keys=excluded.cluster_keys, file_format=excluded.file_format, location=excluded.location, properties_json=excluded.properties_json, owner=excluded.owner, comment=excluded.comment, row_count=excluded.row_count, size_bytes=excluded.size_bytes, updated_at=excluded.updated_at, status=excluded.status"
    )?;

    let mut get_table_id = tx.prepare(
        "SELECT id FROM table_metadata WHERE project_id = ?1 AND catalog = ?2 AND schema_name = ?3 AND table_name = ?4"
    )?;

    // Map of (catalog, schema, table_name) -> table_id for column insertion
    let mut table_id_map: std::collections::HashMap<(String, String, String), i64> = std::collections::HashMap::new();

    for t in tables {
        insert_table.execute(params![
            project_id,
            t.catalog, t.schema_name, t.table_name, t.table_type,
            t.origin, t.temporary as i32,
            t.partition_keys, t.cluster_keys, t.file_format, t.location,
            t.properties_json, t.owner, t.comment,
            t.row_count, t.size_bytes,
            t.created_at, t.updated_at, t.status,
        ])?;
    }
    // Drop insert_table so get_table_id can borrow the connection
    drop(insert_table);

    // Resolve real table_ids after upsert
    for t in tables {
        let table_id: i64 = get_table_id.query_row(
            params![project_id, t.catalog, t.schema_name, t.table_name],
            |row| row.get(0),
        )?;
        table_id_map.insert((t.catalog.clone(), t.schema_name.clone(), t.table_name.clone()), table_id);
    }
    drop(get_table_id);

    // Upsert columns by (project_id, table_id, column_name)
    if !columns.is_empty() {
        // Remap sequential table_id from the caller to real DB table_id.
        // Both callers (extract_and_save_ddl_metadata and writeTableMetadata) assign
        // table_id = 1,2,3... in the same order as the `tables` slice.
        let input_order_to_real: Vec<i64> = (0..tables.len())
            .map(|i| {
                let t = &tables[i];
                *table_id_map.get(&(t.catalog.clone(), t.schema_name.clone(), t.table_name.clone()))
                    .unwrap_or(&0)
            })
            .collect();

        let mut insert_col = tx.prepare(
            "INSERT INTO column_metadata (project_id, table_id, column_name, ordinal, data_type, is_nullable, is_primary_key, is_partition, default_value, comment, created_at, updated_at, status) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13) ON CONFLICT(project_id, table_id, column_name) DO UPDATE SET ordinal=excluded.ordinal, data_type=excluded.data_type, is_nullable=excluded.is_nullable, is_primary_key=excluded.is_primary_key, is_partition=excluded.is_partition, default_value=excluded.default_value, comment=excluded.comment, updated_at=excluded.updated_at, status=excluded.status"
        )?;

        for c in columns {
            // Remap table_id: input uses 1-indexed sequential IDs
            let real_table_id = if c.table_id > 0 && (c.table_id as usize) <= input_order_to_real.len() {
                input_order_to_real[(c.table_id - 1) as usize]
            } else {
                c.table_id // fallback
            };

            insert_col.execute(params![
                project_id,
                real_table_id, c.column_name, c.ordinal, c.data_type,
                c.is_nullable as i32, c.is_primary_key as i32, c.is_partition as i32,
                c.default_value, c.comment,
                c.created_at, c.updated_at, c.status,
            ])?;
        }
    }
    tx.commit()?;
    Ok(())
}

pub fn save_column_metadata(
    conn: &Connection,
    project_id: &str,
    columns: &[ColumnMetadataRow],
) -> Result<(), rusqlite::Error> {
    let tx = conn.unchecked_transaction()?;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO column_metadata (project_id, table_id, column_name, ordinal, data_type, is_nullable, is_primary_key, is_partition, default_value, comment, created_at, updated_at, status) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)"
        )?;
        for c in columns {
            stmt.execute(params![
                project_id,
                c.table_id, c.column_name, c.ordinal, c.data_type,
                c.is_nullable as i32, c.is_primary_key as i32, c.is_partition as i32,
                c.default_value, c.comment,
                c.created_at, c.updated_at, c.status,
            ])?;
        }
    }
    tx.commit()?;
    Ok(())
}

pub fn load_table_metadata(
    conn: &Connection,
    project_id: &str,
) -> Result<Vec<TableMetadataRow>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, project_id, catalog, schema_name, table_name, table_type, origin, temporary, partition_keys, cluster_keys, file_format, location, properties_json, owner, comment, row_count, size_bytes, created_at, updated_at, status FROM table_metadata WHERE project_id = ?1 ORDER BY catalog, schema_name, table_name"
    )?;
    let rows = stmt.query_map(params![project_id], |row| {
        Ok(TableMetadataRow {
            id: row.get(0)?,
            project_id: row.get(1)?,
            catalog: row.get(2)?,
            schema_name: row.get(3)?,
            table_name: row.get(4)?,
            table_type: row.get(5)?,
            origin: row.get(6)?,
            temporary: row.get::<_, i32>(7)? != 0,
            partition_keys: row.get(8)?,
            cluster_keys: row.get(9)?,
            file_format: row.get(10)?,
            location: row.get(11)?,
            properties_json: row.get(12)?,
            owner: row.get(13)?,
            comment: row.get(14)?,
            row_count: row.get(15)?,
            size_bytes: row.get(16)?,
            created_at: row.get(17)?,
            updated_at: row.get(18)?,
            status: row.get(19)?,
        })
    })?;
    rows.collect()
}

pub fn load_column_metadata(
    conn: &Connection,
    project_id: &str,
) -> Result<Vec<ColumnMetadataRow>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, project_id, table_id, column_name, ordinal, data_type, is_nullable, is_primary_key, is_partition, default_value, comment, created_at, updated_at, status FROM column_metadata WHERE project_id = ?1 ORDER BY table_id, ordinal"
    )?;
    let rows = stmt.query_map(params![project_id], |row| {
        Ok(ColumnMetadataRow {
            id: row.get(0)?,
            project_id: row.get(1)?,
            table_id: row.get(2)?,
            column_name: row.get(3)?,
            ordinal: row.get(4)?,
            data_type: row.get(5)?,
            is_nullable: row.get::<_, i32>(6)? != 0,
            is_primary_key: row.get::<_, i32>(7)? != 0,
            is_partition: row.get::<_, i32>(8)? != 0,
            default_value: row.get(9)?,
            comment: row.get(10)?,
            created_at: row.get(11)?,
            updated_at: row.get(12)?,
            status: row.get(13)?,
        })
    })?;
    rows.collect()
}
