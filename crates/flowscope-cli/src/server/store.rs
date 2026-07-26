//! SQLite storage layer for serve-mode persistence.
//!
//! Stores projects, lineage data, and analysis cache in a local SQLite file.
//! Each table uses an auto-increment INTEGER primary key.

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{Connection, params};
use serde::{Serialize, Deserialize};
use utoipa::ToSchema;

/// Current schema version.
///
/// v0: original — time fields (`created_at`, `updated_at`, `last_accessed_at`)
///     stored as `INTEGER` Unix millisecond timestamps.
/// v1: time fields stored as `TEXT` RFC3339 / ISO 8601 strings (human-readable).
const SCHEMA_VERSION: i32 = 5;

/// Open (or create) the database file at the given path.
pub fn open_db(path: &Path) -> Result<Mutex<Connection>, rusqlite::Error> {
    let conn = Connection::open(path)?;
    conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA cache_size = -200000; PRAGMA temp_store = MEMORY; PRAGMA wal_autocheckpoint = 1000;")?;
    migrate(&conn)?;
    create_tables(&conn)?;
    Ok(Mutex::new(conn))
}

/// Run any pending schema migrations based on `PRAGMA user_version`.
///
/// Each migration step is responsible for upgrading from version N to N+1.
/// After all steps complete, `PRAGMA user_version = SCHEMA_VERSION` is set.
///
/// v0 → v1: convert time fields from INTEGER (Unix ms) to TEXT (RFC3339).
/// SQLite cannot ALTER COLUMN type, so each affected table is rebuilt via
/// `CREATE TABLE _new` + `INSERT ... SELECT` (non-time columns preserved,
/// time columns reset to `''`) + `DROP` + `RENAME`. Old time values are
/// discarded per design decision.
fn migrate(conn: &Connection) -> Result<(), rusqlite::Error> {
    let current: i32 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;

    if current < 1 {
        migrate_v0_to_v1(conn)?;
    }

    if current < 2 {
        migrate_v1_to_v2(conn)?;
    }

    if current < 3 {
        migrate_v2_to_v3(conn)?;
    }

    if current < 4 {
        migrate_v3_to_v4(conn)?;
    }

    if current < 5 {
        migrate_v4_to_v5(conn)?;
    }

    if current != SCHEMA_VERSION {
        conn.execute_batch(&format!("PRAGMA user_version = {SCHEMA_VERSION};"))?;
    }
    Ok(())
}

/// v0 → v1: rebuild every table that has time fields so the columns become
/// TEXT. Non-time data is preserved; existing time values are discarded
/// (reset to empty string).
///
/// For each table we use the SQLite-recommended 12-step pattern:
///   1. BEGIN
///   2. CREATE TABLE __tmp AS SELECT (non-time cols, '' AS <time col>) FROM old
///   3. DROP TABLE old
///   4. CREATE TABLE old (... new schema with TEXT time cols ...)
///   5. INSERT INTO old SELECT * FROM __tmp
///   6. DROP TABLE __tmp
///   7. recreate indexes
///   8. COMMIT
///
/// We skip tables that don't exist yet (fresh DBs) so this is idempotent.
fn migrate_v0_to_v1(conn: &Connection) -> Result<(), rusqlite::Error> {
    // (table_name, all_columns_in_order, time_columns_set)
    // For each table, we re-create preserving all columns except time ones,
    // which are replaced with ''.
    let rebuilds: &[(&str, &[&str], &[&str])] = &[
        // project_files
        (
            "project_files",
            &[
                "id", "project_id", "name", "path", "content", "language",
                "size", "created_at", "updated_at", "status",
            ],
            &["created_at", "updated_at"],
        ),
        // schema_files
        (
            "schema_files",
            &[
                "id", "project_id", "name", "path", "content", "size",
                "created_at", "updated_at", "status",
            ],
            &["created_at", "updated_at"],
        ),
        // analysis_cache
        (
            "analysis_cache",
            &[
                "id", "cache_key", "result_json", "size_bytes",
                "created_at", "updated_at", "last_accessed_at", "status",
            ],
            &["created_at", "updated_at", "last_accessed_at"],
        ),
        // project_file_results
        (
            "project_file_results",
            &[
                "id", "project_id", "file_path", "result_json",
                "content_hash", "size_bytes", "created_at", "updated_at", "status",
            ],
            &["created_at", "updated_at"],
        ),
        // lineage_nodes
        (
            "lineage_nodes",
            &[
                "id", "project_id", "file_path", "node_id", "node_type",
                "label", "qualified_name", "statement_index",
                "resolution_source", "created_at", "updated_at", "status",
            ],
            &["created_at", "updated_at"],
        ),
        // lineage_columns
        (
            "lineage_columns",
            &[
                "id", "project_id", "file_path", "column_id", "label",
                "qualified_name", "parent_node_id", "expression",
                "statement_index", "created_at", "updated_at", "status",
            ],
            &["created_at", "updated_at"],
        ),
        // lineage_edges
        (
            "lineage_edges",
            &[
                "id", "project_id", "file_path", "edge_id", "from_id",
                "to_id", "edge_type", "expression", "statement_index",
                "created_at", "updated_at", "status",
            ],
            &["created_at", "updated_at"],
        ),
        // table_metadata
        (
            "table_metadata",
            &[
                "id", "project_id", "catalog", "schema_name", "table_name",
                "table_type", "origin", "temporary", "partition_keys",
                "cluster_keys", "file_format", "location", "properties_json",
                "owner", "comment", "row_count", "size_bytes",
                "created_at", "updated_at", "status",
            ],
            &["created_at", "updated_at"],
        ),
        // column_metadata
        (
            "column_metadata",
            &[
                "id", "project_id", "table_id", "column_name", "ordinal",
                "data_type", "is_nullable", "is_primary_key", "is_partition",
                "default_value", "comment", "created_at", "updated_at", "status",
            ],
            &["created_at", "updated_at"],
        ),
        // projects
        (
            "projects",
            &[
                "id", "name", "dialect", "run_mode", "template_mode",
                "schema_sql", "selected_file_ids", "active_file_id",
                "created_at", "updated_at",
            ],
            &["created_at", "updated_at"],
        ),
        // view_states
        (
            "view_states",
            &["id", "project_id", "state_json", "created_at", "updated_at"],
            &["created_at", "updated_at"],
        ),
        // table_level_edges
        (
            "table_level_edges",
            &["id", "project_id", "from_table", "to_table", "script", "created_at"],
            &["created_at"],
        ),
    ];

    for (table, all_cols, time_cols) in rebuilds {
        // Skip if the table doesn't exist (fresh DB — create_tables will make it).
        let exists: i64 = conn.query_row(
            &format!("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='{table}'"),
            [],
            |row| row.get(0),
        )?;
        if exists == 0 {
            continue;
        }

        // Check whether any time column is still INTEGER (needs rebuild).
        // If all time columns are already TEXT, the table was already migrated
        // (e.g. by a partial run) and we skip it.
        let mut needs_rebuild = false;
        let col_types: Vec<(String, String)> = conn
            .prepare(&format!("PRAGMA table_info({table})"))?
            .query_map([], |row| {
                Ok((row.get::<_, String>(1)?, row.get::<_, String>(2)?))
            })?
            .filter_map(Result::ok)
            .collect();
        for (name, ty) in &col_types {
            if time_cols.contains(&name.as_str()) && ty.eq_ignore_ascii_case("integer") {
                needs_rebuild = true;
                break;
            }
        }
        if !needs_rebuild {
            continue;
        }

        eprintln!("[migrate] rebuilding table '{table}' for TEXT time columns...");

        // Build SELECT list with time cols replaced by ''.
        let select_cols: Vec<String> = all_cols
            .iter()
            .map(|c| {
                if time_cols.contains(c) {
                    format!("'' AS {c}")
                } else {
                    (*c).to_string()
                }
            })
            .collect();
        let col_list = all_cols.join(", ");

        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(&format!(
            "CREATE TABLE __tmp_{table} AS SELECT {select} FROM {table};\n\
             DROP TABLE {table};",
            select = select_cols.join(", "),
        ))?;

        // Recreate the table with the new (TEXT time) schema.
        let create_sql = create_table_sql_for(table);
        tx.execute_batch(create_sql)?;

        // Copy data back.
        tx.execute_batch(&format!(
            "INSERT INTO {table} ({col_list}) SELECT {col_list} FROM __tmp_{table};\n\
             DROP TABLE __tmp_{table};",
        ))?;

        // Recreate indexes for this table.
        for idx_sql in indexes_for(table) {
            tx.execute_batch(idx_sql)?;
        }

        tx.commit()?;
        eprintln!("[migrate] table '{table}' rebuilt successfully.");
    }

    Ok(())
}

/// v1 → v2: add `file_name` and `dir_path` columns to all tables that have
/// `file_path`. Existing rows are backfilled from `file_path`.
fn migrate_v1_to_v2(conn: &Connection) -> Result<(), rusqlite::Error> {
    let tables = ["lineage_nodes", "lineage_columns", "lineage_edges", "project_file_results"];

    for table in &tables {
        // Check if the table exists
        let exists: i64 = conn.query_row(
            &format!("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='{table}'"),
            [],
            |row| row.get(0),
        )?;
        if exists == 0 {
            continue;
        }

        // Check columns
        let cols: Vec<String> = conn
            .prepare(&format!("PRAGMA table_info({table})"))?
            .query_map([], |row| row.get::<_, String>(1))?
            .filter_map(Result::ok)
            .collect();

        if !cols.iter().any(|c| c == "file_path") {
            continue;
        }

        // Add columns if missing
        if !cols.iter().any(|c| c == "file_name") {
            eprintln!("[migrate v1→v2] adding file_name, dir_path to '{table}'...");
            conn.execute_batch(&format!(
                "ALTER TABLE {table} ADD COLUMN file_name TEXT NOT NULL DEFAULT '';\n\
                 ALTER TABLE {table} ADD COLUMN dir_path TEXT NOT NULL DEFAULT '';"
            ))?;
        }

        // Always backfill rows where file_name is empty
        let empty_count: i64 = conn.query_row(
            &format!("SELECT COUNT(*) FROM {table} WHERE file_name = ''"),
            [],
            |row| row.get(0),
        )?;

        if empty_count > 0 {
            eprintln!("[migrate v1→v2] backfilling {empty_count} rows in '{table}'...");
            let rows: Vec<(i64, String)> = conn
                .prepare(&format!("SELECT rowid, file_path FROM {table} WHERE file_name = ''"))?
                .query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)))?
                .filter_map(Result::ok)
                .collect();

            let tx = conn.unchecked_transaction()?;
            {
                let mut stmt = tx.prepare(
                    &format!("UPDATE {table} SET file_name = ?1, dir_path = ?2 WHERE rowid = ?3")
                )?;
                for (rowid, fp) in &rows {
                    let (fn_, dp) = split_file_path(fp);
                    stmt.execute(params![fn_, dp, rowid])?;
                }
            }
            tx.commit()?;
            eprintln!("[migrate v1→v2] '{table}' done.");
        }
    }

    Ok(())
}

/// v2 → v3: add `script_name` and `dir_path` columns to `table_level_edges`.
fn migrate_v2_to_v3(conn: &Connection) -> Result<(), rusqlite::Error> {
    let table = "table_level_edges";
    let exists: i64 = conn.query_row(
        &format!("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='{table}'"),
        [], |row| row.get(0),
    )?;
    if exists == 0 { return Ok(()); }

    let cols: Vec<String> = conn
        .prepare(&format!("PRAGMA table_info({table})"))?
        .query_map([], |row| row.get::<_, String>(1))?
        .filter_map(Result::ok)
        .collect();

    if !cols.iter().any(|c| c == "script_name") {
        eprintln!("[migrate v2→v3] adding script_name, dir_path to '{table}'...");
        conn.execute_batch(&format!(
            "ALTER TABLE {table} ADD COLUMN script_name TEXT NOT NULL DEFAULT '';\n\
             ALTER TABLE {table} ADD COLUMN dir_path TEXT NOT NULL DEFAULT '';"
        ))?;
    }

    let empty_count: i64 = conn.query_row(
        &format!("SELECT COUNT(*) FROM {table} WHERE script_name = ''"),
        [], |row| row.get(0),
    )?;

    if empty_count > 0 {
        eprintln!("[migrate v2→v3] backfilling {empty_count} rows in '{table}'...");
        let rows: Vec<(i64, String)> = conn
            .prepare(&format!("SELECT rowid, script FROM {table} WHERE script_name = ''"))?
            .query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)))?
            .filter_map(Result::ok)
            .collect();

        let tx = conn.unchecked_transaction()?;
        {
            let mut stmt = tx.prepare(
                &format!("UPDATE {table} SET script_name = ?1, dir_path = ?2 WHERE rowid = ?3")
            )?;
            for (rowid, script) in &rows {
                let (sn, dp) = split_file_path(script);
                stmt.execute(params![sn, dp, rowid])?;
            }
        }
        tx.commit()?;
        eprintln!("[migrate v2→v3] '{table}' done.");
    }
    Ok(())
}

/// v3 → v4: Add `project_directories` table and `dir_id` column to `project_files`.
/// Backfills dir_id and directory rows from existing file paths.
fn migrate_v3_to_v4(conn: &Connection) -> Result<(), rusqlite::Error> {
    // 1. Create project_directories table
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS project_directories (
            id           TEXT    NOT NULL,
            project_id   TEXT    NOT NULL,
            parent_id    TEXT    NOT NULL DEFAULT '',
            name         TEXT    NOT NULL,
            path         TEXT    NOT NULL,
            level        INTEGER NOT NULL DEFAULT 0,
            file_count   INTEGER NOT NULL DEFAULT 0,
            child_count  INTEGER NOT NULL DEFAULT 0,
            status       INTEGER NOT NULL DEFAULT 1,
            created_at   TEXT    NOT NULL DEFAULT '',
            updated_at   TEXT    NOT NULL DEFAULT '',
            PRIMARY KEY (project_id, id)
        );
        CREATE INDEX IF NOT EXISTS idx_pd_parent ON project_directories(project_id, parent_id);",
    )?;
    eprintln!("[migrate v3→v4] created project_directories table");

    // 2. Add dir_id column to project_files if not exists
    let pf_cols: Vec<String> = conn
        .prepare("PRAGMA table_info(project_files)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .filter_map(Result::ok)
        .collect();

    if !pf_cols.iter().any(|c| c == "dir_id") {
        conn.execute_batch("ALTER TABLE project_files ADD COLUMN dir_id TEXT NOT NULL DEFAULT '';")?;
        eprintln!("[migrate v3→v4] added dir_id column to project_files");
    }

    // 3. Backfill dir_id in project_files
    let empty_dir_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM project_files WHERE dir_id = ''",
        [], |row| row.get(0),
    )?;
    if empty_dir_count > 0 {
        eprintln!("[migrate v3→v4] backfilling dir_id for {empty_dir_count} files...");
        let rows: Vec<(i64, String)> = conn
            .prepare("SELECT rowid, path FROM project_files WHERE dir_id = ''")?
            .query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)))?
            .filter_map(Result::ok)
            .collect();
        let tx = conn.unchecked_transaction()?;
        {
            let mut stmt = tx.prepare("UPDATE project_files SET dir_id = ?1 WHERE rowid = ?2")?;
            for (rowid, path) in &rows {
                let (_, dir) = split_file_path(path);
                stmt.execute(params![dir, rowid])?;
            }
        }
        tx.commit()?;
    }

    // 4. Rebuild project_directories from file paths
    let project_ids: Vec<String> = conn
        .prepare("SELECT DISTINCT project_id FROM project_files")?
        .query_map([], |row| row.get::<_, String>(0))?
        .filter_map(Result::ok)
        .collect();
    for pid in &project_ids {
        rebuild_directories_for_project(conn, pid)?;
    }

    eprintln!("[migrate v3→v4] done.");
    Ok(())
}

/// Split a file_path into (file_name, dir_path).
/// Handles both `/` and `\` separators.
/// Example: "etl/SUM_公共汇总库/B10.HQL" → ("B10.HQL", "etl/SUM_公共汇总库")
fn split_file_path(file_path: &str) -> (String, String) {
    let pos = file_path.rfind(|c| c == '/' || c == '\\');
    match pos {
        Some(i) => (file_path[i + 1..].to_string(), file_path[..i].to_string()),
        None => (file_path.to_string(), String::new()),
    }
}

/// v4→v5: add dialect, is_procedure, transformed_content columns to project_files
fn migrate_v4_to_v5(conn: &Connection) -> Result<(), rusqlite::Error> {
    let pf_cols: Vec<String> = conn
        .prepare("PRAGMA table_info(project_files)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .filter_map(Result::ok)
        .collect();

    if !pf_cols.iter().any(|c| c == "dialect") {
        conn.execute_batch("ALTER TABLE project_files ADD COLUMN dialect TEXT NOT NULL DEFAULT '';")?;
    }
    if !pf_cols.iter().any(|c| c == "is_procedure") {
        conn.execute_batch("ALTER TABLE project_files ADD COLUMN is_procedure INTEGER NOT NULL DEFAULT 0;")?;
    }
    if !pf_cols.iter().any(|c| c == "transformed_content") {
        conn.execute_batch("ALTER TABLE project_files ADD COLUMN transformed_content TEXT NOT NULL DEFAULT '';")?;
    }
    Ok(())
}

/// Returns the `CREATE TABLE` statement for the given table with the current
/// (v1) schema — time columns as `TEXT`.
fn create_table_sql_for(table: &str) -> &'static str {
    match table {
        "project_files" => "
            CREATE TABLE project_files (
                id                  INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id          TEXT    NOT NULL,
                name                TEXT    NOT NULL,
                path                TEXT    NOT NULL,
                content             TEXT    NOT NULL DEFAULT '',
                language            TEXT    NOT NULL DEFAULT 'sql',
                size                INTEGER NOT NULL DEFAULT 0,
                dialect             TEXT    NOT NULL DEFAULT '',
                is_procedure        INTEGER NOT NULL DEFAULT 0,
                transformed_content TEXT    NOT NULL DEFAULT '',
                created_at          TEXT    NOT NULL DEFAULT '',
                updated_at          TEXT    NOT NULL DEFAULT '',
                status              INTEGER NOT NULL DEFAULT 1,
                UNIQUE(project_id, path)
            );",
        "schema_files" => "
            CREATE TABLE schema_files (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id TEXT    NOT NULL,
                name       TEXT    NOT NULL,
                path       TEXT    NOT NULL,
                content    TEXT    NOT NULL DEFAULT '',
                size       INTEGER NOT NULL DEFAULT 0,
                created_at TEXT    NOT NULL DEFAULT '',
                updated_at TEXT    NOT NULL DEFAULT '',
                status     INTEGER NOT NULL DEFAULT 1,
                UNIQUE(project_id, path)
            );",
        "analysis_cache" => "
            CREATE TABLE analysis_cache (
                id               INTEGER PRIMARY KEY AUTOINCREMENT,
                cache_key        TEXT    NOT NULL UNIQUE,
                result_json      TEXT    NOT NULL,
                size_bytes       INTEGER NOT NULL,
                created_at       TEXT    NOT NULL DEFAULT '',
                updated_at       TEXT    NOT NULL DEFAULT '',
                last_accessed_at TEXT    NOT NULL DEFAULT '',
                status           INTEGER NOT NULL DEFAULT 1
            );",
        "project_file_results" => "
            CREATE TABLE project_file_results (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id   TEXT    NOT NULL,
                file_path    TEXT    NOT NULL,
                file_name    TEXT    NOT NULL DEFAULT '',
                dir_path     TEXT    NOT NULL DEFAULT '',
                result_json  TEXT    NOT NULL,
                content_hash TEXT    NOT NULL,
                size_bytes   INTEGER NOT NULL DEFAULT 0,
                created_at   TEXT    NOT NULL DEFAULT '',
                updated_at   TEXT    NOT NULL DEFAULT '',
                status       INTEGER NOT NULL DEFAULT 1,
                UNIQUE(project_id, file_path)
            );",
        "lineage_anomalies" => "
            CREATE TABLE lineage_anomalies (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id    TEXT    NOT NULL,
                file_path     TEXT    NOT NULL DEFAULT '',
                script_name   TEXT    NOT NULL DEFAULT '',
                script_content TEXT    NOT NULL DEFAULT '',
                severity      TEXT    NOT NULL DEFAULT 'warning',
                anomaly_type  TEXT    NOT NULL DEFAULT 'unknown',
                message       TEXT    NOT NULL DEFAULT '',
                detail        TEXT    NOT NULL DEFAULT '',
                is_test       INTEGER NOT NULL DEFAULT 0,
                created_at    TEXT    NOT NULL DEFAULT '',
                updated_at    TEXT    NOT NULL DEFAULT '',
                status        INTEGER NOT NULL DEFAULT 1
            );",
        "lineage_nodes" => "
            CREATE TABLE lineage_nodes (
                id                INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id        TEXT    NOT NULL,
                file_path         TEXT    NOT NULL,
                file_name         TEXT    NOT NULL DEFAULT '',
                dir_path          TEXT    NOT NULL DEFAULT '',
                node_id           TEXT    NOT NULL,
                node_type         TEXT    NOT NULL,
                label             TEXT    NOT NULL,
                qualified_name    TEXT,
                statement_index   INTEGER NOT NULL,
                resolution_source TEXT,
                created_at        TEXT    NOT NULL DEFAULT '',
                updated_at        TEXT    NOT NULL DEFAULT '',
                status            INTEGER NOT NULL DEFAULT 1,
                UNIQUE(project_id, file_path, node_id)
            );",
        "lineage_columns" => "
            CREATE TABLE lineage_columns (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id      TEXT    NOT NULL,
                file_path       TEXT    NOT NULL,
                file_name       TEXT    NOT NULL DEFAULT '',
                dir_path        TEXT    NOT NULL DEFAULT '',
                column_id       TEXT    NOT NULL,
                label           TEXT    NOT NULL,
                qualified_name  TEXT,
                parent_node_id  TEXT,
                expression      TEXT,
                statement_index INTEGER NOT NULL,
                created_at      TEXT    NOT NULL DEFAULT '',
                updated_at      TEXT    NOT NULL DEFAULT '',
                status          INTEGER NOT NULL DEFAULT 1,
                UNIQUE(project_id, file_path, column_id)
            );",
        "lineage_edges" => "
            CREATE TABLE lineage_edges (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id      TEXT    NOT NULL,
                file_path       TEXT    NOT NULL,
                file_name       TEXT    NOT NULL DEFAULT '',
                dir_path        TEXT    NOT NULL DEFAULT '',
                edge_id         TEXT    NOT NULL,
                from_id         TEXT    NOT NULL,
                to_id           TEXT    NOT NULL,
                edge_type       TEXT    NOT NULL,
                expression      TEXT,
                statement_index INTEGER,
                created_at      TEXT    NOT NULL DEFAULT '',
                updated_at      TEXT    NOT NULL DEFAULT '',
                status          INTEGER NOT NULL DEFAULT 1,
                UNIQUE(project_id, file_path, edge_id)
            );",
        "table_metadata" => "
            CREATE TABLE table_metadata (
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
                created_at      TEXT    NOT NULL DEFAULT '',
                updated_at      TEXT    NOT NULL DEFAULT '',
                status          INTEGER NOT NULL DEFAULT 1,
                UNIQUE(project_id, catalog, schema_name, table_name)
            );",
        "column_metadata" => "
            CREATE TABLE column_metadata (
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
                created_at      TEXT    NOT NULL DEFAULT '',
                updated_at      TEXT    NOT NULL DEFAULT '',
                status          INTEGER NOT NULL DEFAULT 1,
                UNIQUE(project_id, table_id, column_name),
                FOREIGN KEY(table_id) REFERENCES table_metadata(id) ON DELETE CASCADE
            );",
        "projects" => "
            CREATE TABLE projects (
                id                TEXT PRIMARY KEY,
                name              TEXT    NOT NULL,
                dialect           TEXT    NOT NULL DEFAULT 'generic',
                run_mode          TEXT    NOT NULL DEFAULT 'current',
                template_mode     TEXT    NOT NULL DEFAULT 'raw',
                schema_sql        TEXT    NOT NULL DEFAULT '',
                selected_file_ids TEXT    NOT NULL DEFAULT '[]',
                active_file_id    TEXT,
                created_at        TEXT    NOT NULL DEFAULT '',
                updated_at        TEXT    NOT NULL DEFAULT ''
            );",
        "view_states" => "
            CREATE TABLE view_states (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id  TEXT    NOT NULL UNIQUE,
                state_json  TEXT    NOT NULL,
                created_at  TEXT    NOT NULL DEFAULT '',
                updated_at  TEXT    NOT NULL DEFAULT ''
            );",
        "table_level_edges" => "
            CREATE TABLE table_level_edges (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id  TEXT    NOT NULL,
                from_table  TEXT    NOT NULL,
                to_table    TEXT    NOT NULL,
                script      TEXT    NOT NULL DEFAULT '',
                script_name TEXT    NOT NULL DEFAULT '',
                dir_path    TEXT    NOT NULL DEFAULT '',
                created_at  TEXT    NOT NULL DEFAULT '',
                UNIQUE(project_id, from_table, to_table, script)
            );",
        _ => panic!("create_table_sql_for: unknown table '{table}'"),
    }
}

/// Returns the `CREATE INDEX` statements that belong to a given table.
/// Used to recreate indexes after a table rebuild during migration.
fn indexes_for(table: &str) -> &'static [&'static str] {
    match table {
        "lineage_nodes" => &[
            "CREATE INDEX IF NOT EXISTS idx_lineage_nodes_project ON lineage_nodes(project_id);",
            "CREATE INDEX IF NOT EXISTS idx_lineage_nodes_node ON lineage_nodes(project_id, node_id);",
            "CREATE INDEX IF NOT EXISTS idx_lineage_nodes_type ON lineage_nodes(project_id, node_type);",
        ],
        "lineage_columns" => &[
            "CREATE INDEX IF NOT EXISTS idx_lineage_columns_project ON lineage_columns(project_id);",
        ],
        "lineage_edges" => &[
            "CREATE INDEX IF NOT EXISTS idx_lineage_edges_project ON lineage_edges(project_id);",
            "CREATE INDEX IF NOT EXISTS idx_lineage_edges_from ON lineage_edges(project_id, from_id);",
            "CREATE INDEX IF NOT EXISTS idx_lineage_edges_to ON lineage_edges(project_id, to_id);",
        ],
        "project_file_results" => &[
            "CREATE INDEX IF NOT EXISTS idx_project_file_results_project ON project_file_results(project_id);",
        ],
        "lineage_anomalies" => &[
            "CREATE INDEX IF NOT EXISTS idx_anomalies_project ON lineage_anomalies(project_id);",
            "CREATE INDEX IF NOT EXISTS idx_anomalies_created ON lineage_anomalies(created_at);",
            "CREATE INDEX IF NOT EXISTS idx_anomalies_type ON lineage_anomalies(anomaly_type);",
        ],
        "table_metadata" => &[
            "CREATE INDEX IF NOT EXISTS idx_table_metadata_project ON table_metadata(project_id);",
        ],
        "column_metadata" => &[
            "CREATE INDEX IF NOT EXISTS idx_column_metadata_table ON column_metadata(table_id);",
        ],
        "table_level_edges" => &[
            "CREATE INDEX IF NOT EXISTS idx_table_level_edges_project ON table_level_edges(project_id);",
        ],
        _ => &[],
    }
}

fn create_tables(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS project_files (
            id                  INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id          TEXT    NOT NULL,
            name                TEXT    NOT NULL,
            path                TEXT    NOT NULL,
            content             TEXT    NOT NULL DEFAULT '',
            language            TEXT    NOT NULL DEFAULT 'sql',
            size                INTEGER NOT NULL DEFAULT 0,
            dialect             TEXT    NOT NULL DEFAULT '',
            is_procedure        INTEGER NOT NULL DEFAULT 0,
            transformed_content TEXT    NOT NULL DEFAULT '',
            created_at          TEXT    NOT NULL DEFAULT '',
            updated_at          TEXT    NOT NULL DEFAULT '',
            status              INTEGER NOT NULL DEFAULT 1,
            dir_id              TEXT    NOT NULL DEFAULT '',
            UNIQUE(project_id, path)
        );

        CREATE TABLE IF NOT EXISTS project_directories (
            id           TEXT    NOT NULL,
            project_id   TEXT    NOT NULL,
            parent_id    TEXT    NOT NULL DEFAULT '',
            name         TEXT    NOT NULL,
            path         TEXT    NOT NULL,
            level        INTEGER NOT NULL DEFAULT 0,
            file_count   INTEGER NOT NULL DEFAULT 0,
            child_count  INTEGER NOT NULL DEFAULT 0,
            status       INTEGER NOT NULL DEFAULT 1,
            created_at   TEXT    NOT NULL DEFAULT '',
            updated_at   TEXT    NOT NULL DEFAULT '',
            PRIMARY KEY (project_id, id)
        );

        CREATE TABLE IF NOT EXISTS schema_files (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id TEXT    NOT NULL,
            name       TEXT    NOT NULL,
            path       TEXT    NOT NULL,
            content    TEXT    NOT NULL DEFAULT '',
            size       INTEGER NOT NULL DEFAULT 0,
            created_at TEXT    NOT NULL DEFAULT '',
            updated_at TEXT    NOT NULL DEFAULT '',
            status     INTEGER NOT NULL DEFAULT 1,
            UNIQUE(project_id, path)
        );

        CREATE TABLE IF NOT EXISTS analysis_cache (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            cache_key        TEXT    NOT NULL UNIQUE,
            result_json      TEXT    NOT NULL,
            size_bytes       INTEGER NOT NULL,
            created_at       TEXT    NOT NULL DEFAULT '',
            updated_at       TEXT    NOT NULL DEFAULT '',
            last_accessed_at TEXT    NOT NULL DEFAULT '',
            status           INTEGER NOT NULL DEFAULT 1
        );

        CREATE TABLE IF NOT EXISTS project_file_results (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id   TEXT    NOT NULL,
            file_path    TEXT    NOT NULL,
            file_name    TEXT    NOT NULL DEFAULT '',
            dir_path     TEXT    NOT NULL DEFAULT '',
            result_json  TEXT    NOT NULL,
            content_hash TEXT    NOT NULL,
            size_bytes   INTEGER NOT NULL DEFAULT 0,
            created_at   TEXT    NOT NULL DEFAULT '',
            updated_at   TEXT    NOT NULL DEFAULT '',
            status       INTEGER NOT NULL DEFAULT 1,
            UNIQUE(project_id, file_path)
        );

        CREATE TABLE IF NOT EXISTS lineage_nodes (
            id                INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id        TEXT    NOT NULL,
            file_path         TEXT    NOT NULL,
            file_name         TEXT    NOT NULL DEFAULT '',
            dir_path          TEXT    NOT NULL DEFAULT '',
            node_id           TEXT    NOT NULL,
            node_type         TEXT    NOT NULL,
            label             TEXT    NOT NULL,
            qualified_name    TEXT,
            statement_index   INTEGER NOT NULL,
            resolution_source TEXT,
            created_at        TEXT    NOT NULL DEFAULT '',
            updated_at        TEXT    NOT NULL DEFAULT '',
            status            INTEGER NOT NULL DEFAULT 1,
            UNIQUE(project_id, file_path, node_id)
        );

        CREATE TABLE IF NOT EXISTS lineage_columns (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id      TEXT    NOT NULL,
            file_path       TEXT    NOT NULL,
            file_name       TEXT    NOT NULL DEFAULT '',
            dir_path        TEXT    NOT NULL DEFAULT '',
            column_id       TEXT    NOT NULL,
            label           TEXT    NOT NULL,
            qualified_name  TEXT,
            parent_node_id  TEXT,
            expression      TEXT,
            statement_index INTEGER NOT NULL,
            created_at      TEXT    NOT NULL DEFAULT '',
            updated_at      TEXT    NOT NULL DEFAULT '',
            status          INTEGER NOT NULL DEFAULT 1,
            UNIQUE(project_id, file_path, column_id)
        );

        CREATE TABLE IF NOT EXISTS lineage_edges (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id      TEXT    NOT NULL,
            file_path       TEXT    NOT NULL,
            file_name       TEXT    NOT NULL DEFAULT '',
            dir_path        TEXT    NOT NULL DEFAULT '',
            edge_id         TEXT    NOT NULL,
            from_id         TEXT    NOT NULL,
            to_id           TEXT    NOT NULL,
            edge_type       TEXT    NOT NULL,
            expression      TEXT,
            statement_index INTEGER,
            created_at      TEXT    NOT NULL DEFAULT '',
            updated_at      TEXT    NOT NULL DEFAULT '',
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
            created_at      TEXT    NOT NULL DEFAULT '',
            updated_at      TEXT    NOT NULL DEFAULT '',
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
            created_at      TEXT    NOT NULL DEFAULT '',
            updated_at      TEXT    NOT NULL DEFAULT '',
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
            created_at        TEXT    NOT NULL DEFAULT '',
            updated_at        TEXT    NOT NULL DEFAULT '',
            status            INTEGER NOT NULL DEFAULT 1
        );

        CREATE TABLE IF NOT EXISTS view_states (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id  TEXT    NOT NULL UNIQUE,
            state_json  TEXT    NOT NULL,
            created_at  TEXT    NOT NULL DEFAULT '',
            updated_at  TEXT    NOT NULL DEFAULT '',
            status      INTEGER NOT NULL DEFAULT 1
        );

        CREATE TABLE IF NOT EXISTS table_level_edges (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id  TEXT    NOT NULL,
            from_table  TEXT    NOT NULL,
            to_table    TEXT    NOT NULL,
            script      TEXT    NOT NULL DEFAULT '',
            script_name TEXT    NOT NULL DEFAULT '',
            dir_path    TEXT    NOT NULL DEFAULT '',
            created_at  TEXT    NOT NULL DEFAULT '',
            updated_at  TEXT    NOT NULL DEFAULT '',
            status      INTEGER NOT NULL DEFAULT 1,
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
        CREATE INDEX IF NOT EXISTS idx_pd_parent ON project_directories(project_id, parent_id);
        CREATE INDEX IF NOT EXISTS idx_pf_dir ON project_files(project_id, dir_id);
        "
    )
}

// ── project_files ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ProjectFileRow {
    pub name: String,
    pub path: String,
    pub content: String,
    pub language: String,
    pub size: i64,
    #[serde(default)]
    pub dialect: String,
    #[serde(default)]
    pub is_procedure: i64,
    #[serde(default)]
    pub transformed_content: String,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
}

// ── project_files (internal) ────────────────────────────────────────────

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
    let now = chrono::Local::now().to_rfc3339();
    {
        let mut stmt = tx.prepare(
            "INSERT OR REPLACE INTO project_files (project_id, name, path, content, language, size, dialect, is_procedure, transformed_content, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, COALESCE(NULLIF(?10, ''), ?12), COALESCE(NULLIF(?11, ''), ?12))"
        )?;
        for f in files {
            stmt.execute(params![project_id, f.name, f.path, f.content, f.language, f.size, f.dialect, f.is_procedure, f.transformed_content, f.created_at, f.updated_at, now])?;
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
        "SELECT name, path, content, language, size, COALESCE(dialect,'') as dialect, COALESCE(is_procedure,0) as is_procedure, COALESCE(transformed_content,'') as transformed_content, created_at, updated_at FROM project_files WHERE project_id = ?1 ORDER BY path"
    )?;
    let rows = stmt.query_map(params![project_id], |row| {
        Ok(ProjectFileRow {
            name: row.get(0)?,
            path: row.get(1)?,
            content: row.get(2)?,
            language: row.get(3)?,
            size: row.get(4)?,
            dialect: row.get(5)?,
            is_procedure: row.get(6)?,
            transformed_content: row.get(7)?,
            created_at: row.get(8)?,
            updated_at: row.get(9)?,
        })
    })?;
    rows.collect()
}

// ── file metadata (no content) ────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ProjectFileMetaRow {
    pub name: String,
    pub path: String,
    pub dir_id: String,
    pub language: String,
    pub size: i64,
    pub is_procedure: i64,
    pub has_transformed_content: i64,
    pub created_at: String,
    pub updated_at: String,
}

pub fn load_file_metadata(
    conn: &Connection,
    project_id: &str,
) -> Result<Vec<ProjectFileMetaRow>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT name, path, COALESCE(dir_id, ''), language, size, COALESCE(is_procedure, 0), CASE WHEN transformed_content <> '' THEN 1 ELSE 0 END, created_at, updated_at
         FROM project_files WHERE project_id = ?1 ORDER BY path"
    )?;
    let rows = stmt.query_map(params![project_id], |row| {
        Ok(ProjectFileMetaRow {
            name: row.get(0)?,
            path: row.get(1)?,
            dir_id: row.get(2)?,
            language: row.get(3)?,
            size: row.get(4)?,
            is_procedure: row.get(5)?,
            has_transformed_content: row.get(6)?,
            created_at: row.get(7)?,
            updated_at: row.get(8)?,
        })
    })?;
    rows.collect()
}

// ── single / batch file content ───────────────────────────────────────

pub fn load_file_content(
    conn: &Connection,
    project_id: &str,
    file_path: &str,
) -> Result<Option<String>, rusqlite::Error> {
    let result: Result<String, _> = conn.query_row(
        "SELECT content FROM project_files WHERE project_id = ?1 AND path = ?2",
        params![project_id, file_path],
        |row| row.get(0),
    );
    match result {
        Ok(content) => Ok(Some(content)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileFullRow {
    pub content: Option<String>,
    pub is_procedure: i64,
    pub transformed_content: Option<String>,
}

pub fn load_file_full(
    conn: &Connection,
    project_id: &str,
    file_path: &str,
) -> Result<Option<FileFullRow>, rusqlite::Error> {
    let result = conn.query_row(
        "SELECT content, COALESCE(is_procedure, 0), COALESCE(transformed_content, '')
         FROM project_files WHERE project_id = ?1 AND path = ?2",
        params![project_id, file_path],
        |row| {
            Ok(FileFullRow {
                content: row.get(0)?,
                is_procedure: row.get(1)?,
                transformed_content: {
                    let tc: String = row.get(2)?;
                    if tc.is_empty() { None } else { Some(tc) }
                },
            })
        },
    );
    match result {
        Ok(row) => Ok(Some(row)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileContentRow {
    pub path: String,
    pub content: String,
}

pub fn load_file_contents_batch(
    conn: &Connection,
    project_id: &str,
    paths: &[String],
) -> Result<Vec<FileContentRow>, rusqlite::Error> {
    if paths.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders: Vec<String> = (0..paths.len()).map(|i| format!("?{}", i + 2)).collect();
    let sql = format!(
        "SELECT path, content FROM project_files WHERE project_id = ?1 AND path IN ({})",
        placeholders.join(", ")
    );
    let mut stmt = conn.prepare(&sql)?;
    let params_iter: Vec<&dyn rusqlite::ToSql> = std::iter::once(&project_id as &dyn rusqlite::ToSql)
        .chain(paths.iter().map(|p| p as &dyn rusqlite::ToSql))
        .collect();
    let rows = stmt.query_map(params_iter.as_slice(), |row| {
        Ok(FileContentRow {
            path: row.get(0)?,
            content: row.get(1)?,
        })
    })?;
    rows.collect()
}

// ── incremental upsert (no DELETE) ────────────────────────────────────

pub fn upsert_project_files(
    conn: &Connection,
    project_id: &str,
    files: &[ProjectFileRow],
) -> Result<(), rusqlite::Error> {
    if files.is_empty() {
        return Ok(());
    }
    let now = chrono::Local::now().to_rfc3339();
    let tx = conn.unchecked_transaction()?;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO project_files (project_id, name, path, content, language, size, dialect, is_procedure, transformed_content, created_at, updated_at, dir_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, COALESCE(NULLIF(?10, ''), ?13), COALESCE(NULLIF(?11, ''), ?13), ?12)
             ON CONFLICT(project_id, path) DO UPDATE SET
             name = excluded.name,
             content = excluded.content,
             language = excluded.language,
             size = excluded.size,
             dialect = excluded.dialect,
             is_procedure = excluded.is_procedure,
             transformed_content = excluded.transformed_content,
             updated_at = COALESCE(NULLIF(excluded.updated_at, ''), ?13),
             dir_id = excluded.dir_id"
        )?;
        for f in files {
            let (_, dir) = split_file_path(&f.path);
            stmt.execute(params![project_id, f.name, f.path, f.content, f.language, f.size, f.dialect, f.is_procedure, f.transformed_content, f.created_at, f.updated_at, dir, now])?;
        }
    }
    tx.commit()?;
    // Sync directories after upsert
    rebuild_directories_for_project(conn, project_id)?;
    Ok(())
}

// ── delete by paths ───────────────────────────────────────────────────

pub fn delete_project_files_by_paths(
    conn: &Connection,
    project_id: &str,
    paths: &[String],
) -> Result<(), rusqlite::Error> {
    if paths.is_empty() {
        return Ok(());
    }
    let tx = conn.unchecked_transaction()?;
    {
        let mut stmt = tx.prepare("DELETE FROM project_files WHERE project_id = ?1 AND path = ?2")?;
        for path in paths {
            stmt.execute(params![project_id, path])?;
        }
    }
    tx.commit()?;
    rebuild_directories_for_project(conn, project_id)?;
    Ok(())
}

// ── rename (metadata-only, no content needed) ─────────────────────────

pub fn rename_project_file(
    conn: &Connection,
    project_id: &str,
    old_path: &str,
    new_path: &str,
    new_name: &str,
) -> Result<(), rusqlite::Error> {
    let (_, dir) = split_file_path(new_path);
    let now = chrono::Local::now().to_rfc3339();
    conn.execute(
        "UPDATE project_files SET path = ?1, name = ?2, dir_id = ?3, updated_at = ?4
         WHERE project_id = ?5 AND path = ?6",
        params![new_path, new_name, dir, now, project_id, old_path],
    )?;
    rebuild_directories_for_project(conn, project_id)?;
    Ok(())
}

pub fn rename_project_folder(
    conn: &Connection,
    project_id: &str,
    old_folder_path: &str,
    new_folder_path: &str,
) -> Result<(), rusqlite::Error> {
    let now = chrono::Local::now().to_rfc3339();
    let prefix = format!("{old_folder_path}/");
    // Update all files under the old folder
    let files_to_update: Vec<(String, String)> = conn
        .prepare(
            "SELECT path FROM project_files WHERE project_id = ?1 AND (path = ?2 OR path LIKE ?3)"
        )?
        .query_map(params![project_id, old_folder_path, format!("{prefix}%")], |row| {
            row.get::<_, String>(0)
        })?
        .filter_map(|r| r.ok())
        .map(|old_path| {
            let new_path = if old_path == old_folder_path {
                new_folder_path.to_string()
            } else {
                format!("{new_folder_path}{}", &old_path[old_folder_path.len()..])
            };
            (old_path, new_path)
        })
        .collect();

    let tx = conn.unchecked_transaction()?;
    {
        let mut stmt = tx.prepare(
            "UPDATE project_files SET path = ?1, dir_id = ?2, updated_at = ?3
             WHERE project_id = ?4 AND path = ?5"
        )?;
        for (old_path, new_path) in &files_to_update {
            let (_, dir) = split_file_path(new_path);
            stmt.execute(params![new_path, dir, now, project_id, old_path])?;
        }
    }
    tx.commit()?;
    rebuild_directories_for_project(conn, project_id)?;
    Ok(())
}

// ── directories ───────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectDirectoryRow {
    pub id: String,
    pub project_id: String,
    pub parent_id: String,
    pub name: String,
    pub path: String,
    pub level: i64,
    pub file_count: i64,
    pub child_count: i64,
}

pub fn load_directories(
    conn: &Connection,
    project_id: &str,
) -> Result<Vec<ProjectDirectoryRow>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, project_id, parent_id, name, path, level, file_count, child_count
         FROM project_directories WHERE project_id = ?1 AND status = 1 ORDER BY path"
    )?;
    let rows = stmt.query_map(params![project_id], |row| {
        Ok(ProjectDirectoryRow {
            id: row.get(0)?,
            project_id: row.get(1)?,
            parent_id: row.get(2)?,
            name: row.get(3)?,
            path: row.get(4)?,
            level: row.get(5)?,
            file_count: row.get(6)?,
            child_count: row.get(7)?,
        })
    })?;
    rows.collect()
}

/// Rebuild directories for a single project (called after file changes).
fn rebuild_directories_for_project(conn: &Connection, project_id: &str) -> Result<(), rusqlite::Error> {
    let now = chrono::Local::now().to_rfc3339();

    conn.execute("DELETE FROM project_directories WHERE project_id = ?1", params![project_id])?;

    let paths: Vec<String> = conn
        .prepare("SELECT path FROM project_files WHERE project_id = ?1")?
        .query_map(params![project_id], |row| row.get::<_, String>(0))?
        .filter_map(Result::ok)
        .collect();

    let mut dir_map: std::collections::BTreeMap<String, (String, usize)> = std::collections::BTreeMap::new();
    // dir_path → (parent_path, file_count)

    for path in &paths {
        let (_, dir) = split_file_path(path);
        let segments: Vec<&str> = if dir.is_empty() { vec![] } else { dir.split('/').collect() };
        let mut current_path = String::new();
        let mut parent_path = String::new();
        for (i, seg) in segments.iter().enumerate() {
            if i > 0 {
                parent_path = current_path.clone();
                current_path.push('/');
            }
            current_path.push_str(seg);
            dir_map.entry(current_path.clone()).or_insert_with(|| (parent_path.clone(), 0));
        }
        if !dir.is_empty() {
            if let Some(entry) = dir_map.get_mut(&dir) {
                entry.1 += 1;
            }
        }
    }

    let mut child_counts: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for (_dir_path, (parent_path, _)) in &dir_map {
        if !parent_path.is_empty() {
            *child_counts.entry(parent_path.clone()).or_insert(0usize) += 1;
        }
    }

    let tx = conn.unchecked_transaction()?;
    {
        let mut stmt = tx.prepare(
            "INSERT OR REPLACE INTO project_directories
             (id, project_id, parent_id, name, path, level, file_count, child_count, status, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, ?9, ?9)"
        )?;
        for (dir_path, (parent_path, file_count)) in &dir_map {
            let name = dir_path.rsplit('/').next().unwrap_or(dir_path);
            let level = if dir_path.is_empty() { 0 } else { dir_path.matches('/').count() + 1 } as i64;
            let cc = *child_counts.get(dir_path).unwrap_or(&0) as i64;
            stmt.execute(params![dir_path, project_id, parent_path, name, dir_path, level, *file_count as i64, cc, now])?;
        }
    }
    tx.commit()?;
    Ok(())
}

// ── projects ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ProjectRow {
    pub id: String,
    pub name: String,
    pub dialect: String,
    pub run_mode: String,
    pub template_mode: String,
    pub schema_sql: String,
    pub selected_file_ids: String,
    pub active_file_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default = "default_status")]
    pub status: i32,
}

fn default_status() -> i32 { 1 }

pub fn save_project(conn: &Connection, p: &ProjectRow) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT OR REPLACE INTO projects (id, name, dialect, run_mode, template_mode, schema_sql, selected_file_ids, active_file_id, created_at, updated_at, status) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![p.id, p.name, p.dialect, p.run_mode, p.template_mode, p.schema_sql, p.selected_file_ids, p.active_file_id, p.created_at, p.updated_at, p.status],
    )?;
    Ok(())
}

pub fn load_projects(conn: &Connection) -> Result<Vec<ProjectRow>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, name, dialect, run_mode, template_mode, schema_sql, selected_file_ids, active_file_id, created_at, updated_at, status FROM projects"
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
            status: row.get(10)?,
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
    let now = chrono::Local::now().to_rfc3339();
    conn.execute(
        "INSERT OR REPLACE INTO view_states (project_id, state_json, created_at, updated_at, status) VALUES (?1, ?2, ?3, ?4, 1)",
        params![project_id, state_json, now, now],
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
    // Only delete edges for the scripts we're updating, not the whole project
    let scripts: std::collections::HashSet<&str> = edges.iter().map(|(_, _, s)| s.as_str()).collect();
    if !scripts.is_empty() {
        let placeholders: Vec<String> = (0..scripts.len()).map(|_| "?".to_string()).collect();
        let sql = format!("DELETE FROM table_level_edges WHERE project_id = ?1 AND script IN ({})", placeholders.join(","));
        let mut params: Vec<&dyn ToSql> = vec![&project_id];
        for s in &scripts { params.push(s); }
        tx.execute(&sql, params_from_iter(params))?;
    }
    let now = chrono::Local::now().to_rfc3339();
    const CHUNK: usize = 500;
    let row_ph = "(?,?,?,?,?,?,?,?,?)";
    for chunk in edges.chunks(CHUNK) {
        let sql = format!(
            "INSERT OR REPLACE INTO table_level_edges (project_id, from_table, to_table, script, script_name, dir_path, created_at, updated_at, status) VALUES {}",
            (0..chunk.len()).map(|_| row_ph).collect::<Vec<_>>().join(",")
        );
        let mut p: Vec<std::boxed::Box<dyn ToSql>> = Vec::with_capacity(chunk.len() * 9);
        for (from, to, script) in chunk {
            let (sn, dp) = split_file_path(script);
            p.push(Box::new(project_id.to_string()));
            p.push(Box::new(from.clone()));
            p.push(Box::new(to.clone()));
            p.push(Box::new(script.clone()));
            p.push(Box::new(sn));
            p.push(Box::new(dp));
            p.push(Box::new(now.clone()));
            p.push(Box::new(now.clone()));
            p.push(Box::new(1));
        }
        let p_refs: Vec<&dyn ToSql> = p.iter().map(|b| b.as_ref()).collect();
        tx.execute(&sql, params_from_iter(p_refs))?;
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

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct SchemaFileRow {
    pub name: String,
    pub path: String,
    pub content: String,
    pub size: i64,
    pub created_at: String,
    pub updated_at: String,
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
            params![chrono::Local::now().to_rfc3339(), cache_key],
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
    let now = chrono::Local::now().to_rfc3339();
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
    let now = chrono::Local::now().to_rfc3339();
    let (file_name, dir_path) = split_file_path(file_path);
    conn.execute(
        "INSERT OR REPLACE INTO project_file_results (project_id, file_path, file_name, dir_path, result_json, content_hash, size_bytes, created_at, updated_at, status) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 1)",
        params![project_id, file_path, file_name, dir_path, result_json, content_hash, result_json.len() as i64, now, now],
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
) -> Result<Vec<(String, String, String, String, String)>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT file_path, result_json, content_hash, file_name, dir_path FROM project_file_results WHERE project_id = ?1"
    )?;
    let rows = stmt.query_map(params![project_id], |row| {
        Ok((
            row.get::<_, String>(0)?,  // file_path
            row.get::<_, String>(1)?,  // result_json
            row.get::<_, String>(2)?,  // content_hash
            row.get::<_, String>(3)?,  // file_name
            row.get::<_, String>(4)?,  // dir_path
        ))
    })?;
    rows.collect()
}

/// 轻量查询：只返回 file_path + file_name，用于搜索匹配，不返回大字段 result_json
pub fn get_file_results_light(
    conn: &Connection,
    project_id: &str,
) -> Result<Vec<(String, String)>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT file_path, file_name FROM project_file_results WHERE project_id = ?1"
    )?;
    let rows = stmt.query_map(params![project_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
        ))
    })?;
    rows.collect()
}

pub fn delete_file_result(
    conn: &Connection,
    project_id: &str,
    file_path: &str,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "DELETE FROM project_file_results WHERE project_id = ?1 AND file_path = ?2",
        params![project_id, file_path],
    )?;
    Ok(())
}

// ── lineage_anomalies ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct LineageAnomalyRow {
    #[serde(default)]
    pub id: i64,
    pub project_id: String,
    pub file_path: String,
    pub script_name: String,
    pub script_content: String,
    pub severity: String,
    pub anomaly_type: String,
    pub message: String,
    pub detail: String,
    pub is_test: i64,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default = "default_status")]
    pub status: i32,
}

pub fn insert_anomaly(
    conn: &Connection,
    row: &LineageAnomalyRow,
) -> Result<i64, rusqlite::Error> {
    let now = chrono::Local::now().to_rfc3339();
    conn.execute(
        "INSERT INTO lineage_anomalies (project_id, file_path, script_name, script_content, severity, anomaly_type, message, detail, is_test, created_at, updated_at, status) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![row.project_id, row.file_path, row.script_name, row.script_content, row.severity, row.anomaly_type, row.message, row.detail, row.is_test, now, now, 1],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn get_anomalies(
    conn: &Connection,
    project_id: &str,
    limit: i64,
    offset: i64,
) -> Result<Vec<LineageAnomalyRow>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, project_id, file_path, script_name, script_content, severity, anomaly_type, message, detail, is_test, created_at, updated_at, status FROM lineage_anomalies WHERE project_id = ?1 ORDER BY created_at DESC LIMIT ?2 OFFSET ?3"
    )?;
    let rows = stmt.query_map(params![project_id, limit, offset], |row| {
        Ok(LineageAnomalyRow {
            id: row.get(0)?,
            project_id: row.get(1)?,
            file_path: row.get(2)?,
            script_name: row.get(3)?,
            script_content: row.get(4)?,
            severity: row.get(5)?,
            anomaly_type: row.get(6)?,
            message: row.get(7)?,
            detail: row.get(8)?,
            is_test: row.get(9)?,
            created_at: row.get(10)?,
            updated_at: row.get(11)?,
            status: row.get(12)?,
        })
    })?;
    rows.collect()
}

// ── lineage ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct LineageNodeRow {
    pub node_id: String,
    pub node_type: String,
    pub label: String,
    pub qualified_name: Option<String>,
    pub statement_index: i64,
    pub resolution_source: Option<String>,
    pub file_path: String,
    #[serde(default)]
    pub file_name: String,
    #[serde(default)]
    pub dir_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct LineageColumnRow {
    pub column_id: String,
    pub label: String,
    pub qualified_name: Option<String>,
    pub parent_node_id: Option<String>,
    pub expression: Option<String>,
    pub statement_index: i64,
    pub file_path: String,
    #[serde(default)]
    pub file_name: String,
    #[serde(default)]
    pub dir_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct LineageEdgeRow {
    pub edge_id: String,
    pub from_id: String,
    pub to_id: String,
    pub edge_type: String,
    pub expression: Option<String>,
    pub statement_index: Option<i64>,
    pub file_path: String,
    #[serde(default)]
    pub file_name: String,
    #[serde(default)]
    pub dir_path: String,
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

    let now = chrono::Local::now().to_rfc3339();
    const CHUNK: usize = 500;
    let row12 = "(?,?,?,?,?,?,?,?,?,?,?,?)";

    // nodes (12 cols: +file_name, +dir_path)
    for chunk in nodes.chunks(CHUNK) {
        let sql = format!(
            "INSERT OR REPLACE INTO lineage_nodes (project_id, file_path, file_name, dir_path, node_id, node_type, label, qualified_name, statement_index, resolution_source, created_at, updated_at) VALUES {}",
            (0..chunk.len()).map(|_| row12).collect::<Vec<_>>().join(",")
        );
        let mut p: Vec<Box<dyn ToSql>> = Vec::with_capacity(chunk.len() * 12);
        for n in chunk {
            let (fn_, dp) = split_file_path(&n.file_path);
            p.push(Box::new(project_id.to_string()));
            p.push(Box::new(n.file_path.clone()));
            p.push(Box::new(fn_));
            p.push(Box::new(dp));
            p.push(Box::new(n.node_id.clone()));
            p.push(Box::new(n.node_type.clone()));
            p.push(Box::new(n.label.clone()));
            p.push(Box::new(n.qualified_name.clone()));
            p.push(Box::new(n.statement_index));
            p.push(Box::new(n.resolution_source.clone()));
            p.push(Box::new(now.clone()));
            p.push(Box::new(now.clone()));
        }
        let p_refs: Vec<&dyn ToSql> = p.iter().map(|b| b.as_ref()).collect();
        tx.execute(&sql, params_from_iter(p_refs))?;
    }

    // columns (12 cols: +file_name, +dir_path)
    for chunk in columns.chunks(CHUNK) {
        let sql = format!(
            "INSERT OR REPLACE INTO lineage_columns (project_id, file_path, file_name, dir_path, column_id, label, qualified_name, parent_node_id, expression, statement_index, created_at, updated_at) VALUES {}",
            (0..chunk.len()).map(|_| row12).collect::<Vec<_>>().join(",")
        );
        let mut p: Vec<Box<dyn ToSql>> = Vec::with_capacity(chunk.len() * 12);
        for c in chunk {
            let (fn_, dp) = split_file_path(&c.file_path);
            p.push(Box::new(project_id.to_string()));
            p.push(Box::new(c.file_path.clone()));
            p.push(Box::new(fn_));
            p.push(Box::new(dp));
            p.push(Box::new(c.column_id.clone()));
            p.push(Box::new(c.label.clone()));
            p.push(Box::new(c.qualified_name.clone()));
            p.push(Box::new(c.parent_node_id.clone()));
            p.push(Box::new(c.expression.clone()));
            p.push(Box::new(c.statement_index));
            p.push(Box::new(now.clone()));
            p.push(Box::new(now.clone()));
        }
        let p_refs: Vec<&dyn ToSql> = p.iter().map(|b| b.as_ref()).collect();
        tx.execute(&sql, params_from_iter(p_refs))?;
    }

    // edges (12 cols: +file_name, +dir_path)
    for chunk in edges.chunks(CHUNK) {
        let sql = format!(
            "INSERT OR REPLACE INTO lineage_edges (project_id, file_path, file_name, dir_path, edge_id, from_id, to_id, edge_type, expression, statement_index, created_at, updated_at) VALUES {}",
            (0..chunk.len()).map(|_| row12).collect::<Vec<_>>().join(",")
        );
        let mut p: Vec<Box<dyn ToSql>> = Vec::with_capacity(chunk.len() * 12);
        for e in chunk {
            let (fn_, dp) = split_file_path(&e.file_path);
            p.push(Box::new(project_id.to_string()));
            p.push(Box::new(e.file_path.clone()));
            p.push(Box::new(fn_));
            p.push(Box::new(dp));
            p.push(Box::new(e.edge_id.clone()));
            p.push(Box::new(e.from_id.clone()));
            p.push(Box::new(e.to_id.clone()));
            p.push(Box::new(e.edge_type.clone()));
            p.push(Box::new(e.expression.clone()));
            p.push(Box::new(e.statement_index));
            p.push(Box::new(now.clone()));
            p.push(Box::new(now.clone()));
        }
        let p_refs: Vec<&dyn ToSql> = p.iter().map(|b| b.as_ref()).collect();
        tx.execute(&sql, params_from_iter(p_refs))?;
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
            "SELECT node_id, node_type, label, qualified_name, statement_index, resolution_source, file_path, file_name, dir_path FROM lineage_nodes WHERE project_id = ?1 AND file_path = ?2",
            vec![project_id.to_string(), fp.to_string()],
        )
    } else {
        (
            "SELECT node_id, node_type, label, qualified_name, statement_index, resolution_source, file_path, file_name, dir_path FROM lineage_nodes WHERE project_id = ?1",
            vec![project_id.to_string()],
        )
    };
    let params: Vec<&dyn rusqlite::types::ToSql> = params_vec.iter().map(|s| s as &dyn rusqlite::types::ToSql).collect();
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params.as_slice(), |row| {
        Ok(LineageNodeRow {
            node_id: row.get(0)?,
            node_type: row.get(1)?,
            label: row.get(2)?,
            qualified_name: row.get(3)?,
            statement_index: row.get(4)?,
            resolution_source: row.get(5)?,
            file_path: row.get(6)?,
            file_name: row.get(7)?,
            dir_path: row.get(8)?,
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
            "SELECT column_id, label, qualified_name, parent_node_id, expression, statement_index, file_path, file_name, dir_path FROM lineage_columns WHERE project_id = ?1 AND file_path = ?2",
            vec![project_id.to_string(), fp.to_string()],
        )
    } else {
        (
            "SELECT column_id, label, qualified_name, parent_node_id, expression, statement_index, file_path, file_name, dir_path FROM lineage_columns WHERE project_id = ?1",
            vec![project_id.to_string()],
        )
    };
    let params: Vec<&dyn rusqlite::types::ToSql> = params_vec.iter().map(|s| s as &dyn rusqlite::types::ToSql).collect();
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params.as_slice(), |row| {
        Ok(LineageColumnRow {
            column_id: row.get(0)?,
            label: row.get(1)?,
            qualified_name: row.get(2)?,
            parent_node_id: row.get(3)?,
            expression: row.get(4)?,
            statement_index: row.get(5)?,
            file_path: row.get(6)?,
            file_name: row.get(7)?,
            dir_path: row.get(8)?,
        })
    })?;
    rows.collect()
}

pub fn load_lineage_edges(
    conn: &Connection,
    project_id: &str,
    file_path: Option<&str>,
    edge_type: Option<&str>,
) -> Result<Vec<LineageEdgeRow>, rusqlite::Error> {
    let sql = match (file_path, edge_type) {
        (Some(_), Some(_)) => format!(
            "SELECT edge_id, from_id, to_id, edge_type, expression, statement_index, file_path, file_name, dir_path FROM lineage_edges WHERE project_id = ?1 AND file_path = ?2 AND edge_type = ?3"
        ),
        (Some(_), None) => format!(
            "SELECT edge_id, from_id, to_id, edge_type, expression, statement_index, file_path, file_name, dir_path FROM lineage_edges WHERE project_id = ?1 AND file_path = ?2"
        ),
        (None, Some(_)) => format!(
            "SELECT edge_id, from_id, to_id, edge_type, expression, statement_index, file_path, file_name, dir_path FROM lineage_edges WHERE project_id = ?1 AND edge_type = ?2"
        ),
        (None, None) => format!(
            "SELECT edge_id, from_id, to_id, edge_type, expression, statement_index, file_path, file_name, dir_path FROM lineage_edges WHERE project_id = ?1"
        ),
    };
    let mut params_vec: Vec<String> = vec![project_id.to_string()];
    if let Some(fp) = file_path { params_vec.push(fp.to_string()); }
    if let Some(et) = edge_type { params_vec.push(et.to_string()); }
    let params: Vec<&dyn rusqlite::types::ToSql> = params_vec.iter().map(|s| s as &dyn rusqlite::types::ToSql).collect();
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params.as_slice(), |row| {
        Ok(LineageEdgeRow {
            edge_id: row.get(0)?,
            from_id: row.get(1)?,
            to_id: row.get(2)?,
            edge_type: row.get(3)?,
            expression: row.get(4)?,
            statement_index: row.get(5)?,
            file_path: row.get(6)?,
            file_name: row.get(7)?,
            dir_path: row.get(8)?,
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

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
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
    pub created_at: String,
    pub updated_at: String,
    pub status: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
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
    pub created_at: String,
    pub updated_at: String,
    pub status: i32,
}

pub fn save_table_metadata(
    conn: &Connection,
    project_id: &str,
    tables: &[TableMetadataRow],
    columns: &[ColumnMetadataRow],
) -> Result<(), rusqlite::Error> {
    let tx = conn.unchecked_transaction()?;

    // Replace semantics: clear this project's existing metadata before writing
    // the fresh set. The frontend `writeTableMetadata` now filters out
    // temporary tables, so re-analysis must be able to physically evict stale
    // rows (e.g. previously-captured `a/b/c/d` temp-table metadata) rather
    // than leave them behind as orphans. Doing DELETE+INSERT per project_id
    // is safe because callers always pass the full resolved schema for one
    // project at a time.
    tx.execute(
        "DELETE FROM column_metadata WHERE project_id = ?1",
        params![project_id],
    )?;
    tx.execute(
        "DELETE FROM table_metadata WHERE project_id = ?1",
        params![project_id],
    )?;

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
