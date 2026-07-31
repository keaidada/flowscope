//! Governance database management.
//!
//! Standalone SQLite database for governance data, independent of
//! the main flowscope.db. Created on first open with all tables.

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection};

/// Open or create the governance database.
pub fn open_gov_db(path: &Path) -> Result<Mutex<Connection>, rusqlite::Error> {
    let conn = Connection::open(path)?;
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA foreign_keys = ON;",
    )?;
    create_tables(&conn)?;
    migrate_metrics_registry(&conn)?;
    Ok(Mutex::new(conn))
}

/// Add new columns to metrics_registry if they don't exist (for existing databases).
fn migrate_metrics_registry(conn: &Connection) -> Result<(), rusqlite::Error> {
    let cols: Vec<String> = conn
        .prepare("PRAGMA table_info(metrics_registry)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .filter_map(|r| r.ok())
        .collect();
    if !cols.iter().any(|c| c == "metric_type") {
        conn.execute_batch(
            "ALTER TABLE metrics_registry ADD COLUMN metric_type TEXT NOT NULL DEFAULT 'atomic';",
        )?;
    }
    if !cols.iter().any(|c| c == "business_filter") {
        conn.execute_batch(
            "ALTER TABLE metrics_registry ADD COLUMN business_filter TEXT NOT NULL DEFAULT '';",
        )?;
    }
    if !cols.iter().any(|c| c == "period") {
        conn.execute_batch(
            "ALTER TABLE metrics_registry ADD COLUMN period TEXT NOT NULL DEFAULT '';",
        )?;
    }
    Ok(())
}

fn create_tables(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS contract_registry (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id      TEXT    NOT NULL,
            contract_name   TEXT    NOT NULL,
            file_path       TEXT    NOT NULL,
            version         TEXT    NOT NULL DEFAULT '1.0.0',
            status          INTEGER NOT NULL DEFAULT 1,
            contract_hash   TEXT    NOT NULL DEFAULT '',
            last_evaluated  TEXT    NOT NULL DEFAULT '',
            violation_count INTEGER NOT NULL DEFAULT 0,
            created_at      TEXT    NOT NULL DEFAULT '',
            updated_at      TEXT    NOT NULL DEFAULT '',
            UNIQUE(project_id, contract_name)
        );

        CREATE TABLE IF NOT EXISTS governance_reports (
            id                     INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id             TEXT    NOT NULL,
            report_json            TEXT    NOT NULL,
            health_score           INTEGER NOT NULL DEFAULT 0,
            dimension_scores_json  TEXT    NOT NULL DEFAULT '{}',
            file_count             INTEGER NOT NULL DEFAULT 0,
            violation_count        INTEGER NOT NULL DEFAULT 0,
            status                 INTEGER NOT NULL DEFAULT 1,
            created_at             TEXT    NOT NULL DEFAULT '',
            updated_at             TEXT    NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_gov_reports_project ON governance_reports(project_id);

        CREATE TABLE IF NOT EXISTS governance_violations (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id      TEXT    NOT NULL,
            report_id       INTEGER NOT NULL,
            contract_id     TEXT    NOT NULL,
            rule_id         TEXT    NOT NULL,
            rule_section    TEXT    NOT NULL,
            severity        TEXT    NOT NULL,
            title           TEXT    NOT NULL,
            detail_json     TEXT    NOT NULL,
            file_paths      TEXT    NOT NULL DEFAULT '',
            assignee        TEXT    NOT NULL DEFAULT '',
            status          INTEGER NOT NULL DEFAULT 1,
            created_at      TEXT    NOT NULL DEFAULT '',
            updated_at      TEXT    NOT NULL DEFAULT '',
            FOREIGN KEY(report_id) REFERENCES governance_reports(id)
        );
        CREATE INDEX IF NOT EXISTS idx_gov_violations_project ON governance_violations(project_id);
        CREATE INDEX IF NOT EXISTS idx_gov_violations_severity ON governance_violations(project_id, severity);
        CREATE INDEX IF NOT EXISTS idx_gov_violations_assignee ON governance_violations(project_id, assignee);

        CREATE TABLE IF NOT EXISTS violation_comments (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id      TEXT    NOT NULL,
            violation_id    INTEGER NOT NULL,
            author          TEXT    NOT NULL DEFAULT '',
            content         TEXT    NOT NULL,
            status          INTEGER NOT NULL DEFAULT 1,
            created_at      TEXT    NOT NULL DEFAULT '',
            updated_at      TEXT    NOT NULL DEFAULT '',
            FOREIGN KEY(violation_id) REFERENCES governance_violations(id)
        );
        CREATE INDEX IF NOT EXISTS idx_violation_comments_violation ON violation_comments(violation_id);

        CREATE TABLE IF NOT EXISTS violation_suppressions (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id      TEXT    NOT NULL,
            rule_id         TEXT    NOT NULL,
            pattern         TEXT    NOT NULL DEFAULT '',
            file_pattern    TEXT    NOT NULL DEFAULT '',
            reason          TEXT    NOT NULL DEFAULT '',
            expires_at      TEXT    NOT NULL DEFAULT '',
            status          INTEGER NOT NULL DEFAULT 1,
            created_at      TEXT    NOT NULL DEFAULT '',
            updated_at      TEXT    NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_violation_suppressions_project ON violation_suppressions(project_id);

        CREATE TABLE IF NOT EXISTS domain_registry (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id      TEXT    NOT NULL,
            domain_name     TEXT    NOT NULL,
            description     TEXT    NOT NULL DEFAULT '',
            owner           TEXT    NOT NULL DEFAULT '',
            status          INTEGER NOT NULL DEFAULT 1,
            created_at      TEXT    NOT NULL DEFAULT '',
            updated_at      TEXT    NOT NULL DEFAULT '',
            UNIQUE(project_id, domain_name)
        );

        CREATE TABLE IF NOT EXISTS classification_catalog (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id      TEXT    NOT NULL,
            classification  TEXT    NOT NULL,
            severity        TEXT    NOT NULL DEFAULT 'low',
            column_patterns TEXT    NOT NULL DEFAULT '[]',
            description     TEXT    NOT NULL DEFAULT '',
            status          INTEGER NOT NULL DEFAULT 1,
            created_at      TEXT    NOT NULL DEFAULT '',
            updated_at      TEXT    NOT NULL DEFAULT '',
            UNIQUE(project_id, classification)
        );

        CREATE TABLE IF NOT EXISTS governance_settings (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id      TEXT    NOT NULL UNIQUE,
            scan_cron       TEXT    NOT NULL DEFAULT '',
            alert_threshold INTEGER NOT NULL DEFAULT 60,
            webhook_url     TEXT    NOT NULL DEFAULT '',
            notify_emails   TEXT    NOT NULL DEFAULT '[]',
            settings_json   TEXT    NOT NULL DEFAULT '{}',
            status          INTEGER NOT NULL DEFAULT 1,
            created_at      TEXT    NOT NULL DEFAULT '',
            updated_at      TEXT    NOT NULL DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS model_registry (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id      TEXT    NOT NULL,
            table_name      TEXT    NOT NULL,
            model_layer     TEXT    NOT NULL DEFAULT '',
            model_type      TEXT    NOT NULL DEFAULT '',
            business_domain TEXT    NOT NULL DEFAULT '',
            owner           TEXT    NOT NULL DEFAULT '',
            lifecycle       TEXT    NOT NULL DEFAULT 'active',
            description     TEXT    NOT NULL DEFAULT '',
            tags            TEXT    NOT NULL DEFAULT '[]',
            source          TEXT    NOT NULL DEFAULT 'auto',
            contract_id     TEXT    NOT NULL DEFAULT '',
            status          INTEGER NOT NULL DEFAULT 1,
            created_at      TEXT    NOT NULL DEFAULT '',
            updated_at      TEXT    NOT NULL DEFAULT '',
            UNIQUE(project_id, table_name)
        );
        CREATE INDEX IF NOT EXISTS idx_model_registry_layer ON model_registry(project_id, model_layer);
        CREATE INDEX IF NOT EXISTS idx_model_registry_domain ON model_registry(project_id, business_domain);
        CREATE INDEX IF NOT EXISTS idx_model_registry_owner ON model_registry(project_id, owner);

        CREATE TABLE IF NOT EXISTS model_columns (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id      TEXT    NOT NULL,
            model_id        INTEGER NOT NULL,
            column_name     TEXT    NOT NULL,
            data_type       TEXT    NOT NULL DEFAULT '',
            description     TEXT    NOT NULL DEFAULT '',
            sensitivity     TEXT    NOT NULL DEFAULT '',
            category        TEXT    NOT NULL DEFAULT '',
            bound_metric    TEXT    NOT NULL DEFAULT '',
            status          INTEGER NOT NULL DEFAULT 1,
            created_at      TEXT    NOT NULL DEFAULT '',
            updated_at      TEXT    NOT NULL DEFAULT '',
            UNIQUE(project_id, model_id, column_name),
            FOREIGN KEY(model_id) REFERENCES model_registry(id)
        );
        CREATE INDEX IF NOT EXISTS idx_model_columns_model ON model_columns(model_id);

        CREATE TABLE IF NOT EXISTS model_audit_log (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id      TEXT    NOT NULL,
            model_id        INTEGER NOT NULL,
            action          TEXT    NOT NULL,
            field_name      TEXT    NOT NULL DEFAULT '',
            old_value       TEXT    NOT NULL DEFAULT '',
            new_value       TEXT    NOT NULL DEFAULT '',
            operator        TEXT    NOT NULL DEFAULT '',
            status          INTEGER NOT NULL DEFAULT 1,
            created_at      TEXT    NOT NULL DEFAULT '',
            updated_at      TEXT    NOT NULL DEFAULT '',
            FOREIGN KEY(model_id) REFERENCES model_registry(id)
        );
        CREATE INDEX IF NOT EXISTS idx_model_audit_model ON model_audit_log(model_id);

        CREATE TABLE IF NOT EXISTS metrics_registry (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id      TEXT    NOT NULL,
            metric_name     TEXT    NOT NULL,
            metric_type     TEXT    NOT NULL DEFAULT 'atomic',
            definition      TEXT    NOT NULL,
            sql_signature   TEXT    NOT NULL,
            expression      TEXT    NOT NULL DEFAULT '',
            aggregation     TEXT    NOT NULL DEFAULT '',
            business_filter TEXT    NOT NULL DEFAULT '',
            period          TEXT    NOT NULL DEFAULT '',
            source_tables   TEXT    NOT NULL DEFAULT '',
            dimensions      TEXT    NOT NULL DEFAULT '[]',
            owner           TEXT    NOT NULL DEFAULT '',
            layer           TEXT    NOT NULL DEFAULT '',
            lifecycle       TEXT    NOT NULL DEFAULT 'active',
            contract_id     TEXT    NOT NULL DEFAULT '',
            bound_model     TEXT    NOT NULL DEFAULT '',
            bound_column    TEXT    NOT NULL DEFAULT '',
            status          INTEGER NOT NULL DEFAULT 1,
            created_at      TEXT    NOT NULL DEFAULT '',
            updated_at      TEXT    NOT NULL DEFAULT '',
            UNIQUE(project_id, metric_name)
        );
        CREATE INDEX IF NOT EXISTS idx_metrics_registry_layer ON metrics_registry(project_id, layer);
        CREATE INDEX IF NOT EXISTS idx_metrics_registry_owner ON metrics_registry(project_id, owner);

        CREATE TABLE IF NOT EXISTS metric_conflicts (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id      TEXT    NOT NULL,
            conflict_type   TEXT    NOT NULL,
            metric_ids      TEXT    NOT NULL DEFAULT '[]',
            detail_json     TEXT    NOT NULL DEFAULT '{}',
            resolution      TEXT    NOT NULL DEFAULT '',
            resolved        INTEGER NOT NULL DEFAULT 0,
            status          INTEGER NOT NULL DEFAULT 1,
            created_at      TEXT    NOT NULL DEFAULT '',
            updated_at      TEXT    NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_metric_conflicts_project ON metric_conflicts(project_id);

        CREATE TABLE IF NOT EXISTS metric_audit_log (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id      TEXT    NOT NULL,
            metric_id       INTEGER NOT NULL,
            action          TEXT    NOT NULL,
            field_name      TEXT    NOT NULL DEFAULT '',
            old_value       TEXT    NOT NULL DEFAULT '',
            new_value       TEXT    NOT NULL DEFAULT '',
            operator        TEXT    NOT NULL DEFAULT '',
            status          INTEGER NOT NULL DEFAULT 1,
            created_at      TEXT    NOT NULL DEFAULT '',
            updated_at      TEXT    NOT NULL DEFAULT '',
            FOREIGN KEY(metric_id) REFERENCES metrics_registry(id)
        );
        CREATE INDEX IF NOT EXISTS idx_metric_audit_metric ON metric_audit_log(metric_id);

        CREATE TABLE IF NOT EXISTS governance_data_sources (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id      TEXT    NOT NULL,
            source_name     TEXT    NOT NULL,
            source_type     TEXT    NOT NULL,
            connection_json TEXT    NOT NULL DEFAULT '{}',
            description     TEXT    NOT NULL DEFAULT '',
            status          INTEGER NOT NULL DEFAULT 1,
            created_at      TEXT    NOT NULL DEFAULT '',
            updated_at      TEXT    NOT NULL DEFAULT '',
            UNIQUE(project_id, source_name)
        );

        CREATE TABLE IF NOT EXISTS quality_check_results (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id      TEXT    NOT NULL,
            contract_id     TEXT    NOT NULL,
            quality_rule_id TEXT    NOT NULL,
            passed          INTEGER NOT NULL DEFAULT 0,
            actual_value    TEXT    NOT NULL DEFAULT '',
            expected_value  TEXT    NOT NULL DEFAULT '',
            error_message   TEXT    NOT NULL DEFAULT '',
            status          INTEGER NOT NULL DEFAULT 1,
            created_at      TEXT    NOT NULL DEFAULT '',
            updated_at      TEXT    NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_quality_results_contract ON quality_check_results(project_id, contract_id);
        ",
    )?;
    Ok(())
}

/// Save a governance report and its violations.
pub fn save_report(
    conn: &Connection,
    project_id: &str,
    report: &super::GovernanceReport,
) -> Result<i64, rusqlite::Error> {
    let report_json = serde_json::to_string(report).unwrap_or_default();
    let dim_json = serde_json::to_string(&report.dimension_scores).unwrap_or_default();
    let now = now_str();

    conn.execute(
        "INSERT INTO governance_reports
            (project_id, report_json, health_score, dimension_scores_json, file_count, violation_count, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?7)",
        params![
            project_id,
            report_json,
            report.health_score,
            dim_json,
            report.summary.total_files,
            report.summary.total_violations,
            now,
        ],
    )?;

    let report_id = conn.last_insert_rowid();

    // Save violations
    let mut stmt = conn.prepare(
        "INSERT INTO governance_violations
            (project_id, report_id, contract_id, rule_id, rule_section, severity, title, detail_json, file_paths, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 1, ?10, ?10)",
    )?;

    for v in &report.violations {
        let severity_str = format!("{:?}", v.severity);
        let detail_json = serde_json::to_string(&v.detail).unwrap_or_default();
        let file_paths = v.file_paths.join(",");
        stmt.execute(params![
            project_id,
            report_id,
            v.contract_id,
            v.rule_id,
            v.rule_section,
            severity_str,
            v.title,
            detail_json,
            file_paths,
            now,
        ])?;
    }

    Ok(report_id)
}

/// Get recent governance reports for a project.
pub fn get_reports(
    conn: &Connection,
    project_id: &str,
    limit: usize,
) -> Result<Vec<super::GovernanceReport>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT report_json FROM governance_reports
         WHERE project_id = ?1 AND status = 1
         ORDER BY id DESC LIMIT ?2",
    )?;

    let rows = stmt.query_map(params![project_id, limit], |row| {
        let json: String = row.get(0)?;
        Ok(json)
    })?;

    let mut reports = Vec::new();
    for row in rows.flatten() {
        if let Ok(report) = serde_json::from_str::<super::GovernanceReport>(&row) {
            reports.push(report);
        }
    }
    Ok(reports)
}

/// Get health score trend.
pub fn get_health_trend(
    conn: &Connection,
    project_id: &str,
    limit: usize,
) -> Result<Vec<u32>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT health_score FROM governance_reports
         WHERE project_id = ?1 AND status = 1
         ORDER BY id DESC LIMIT ?2",
    )?;

    let rows = stmt.query_map(params![project_id, limit], |row| {
        row.get::<_, i64>(0).map(|v| v as u32)
    })?;

    let mut scores: Vec<u32> = rows.flatten().collect();
    scores.reverse(); // Chronological order
    Ok(scores)
}

/// Upsert a contract registry entry.
pub fn upsert_contract(
    conn: &Connection,
    project_id: &str,
    name: &str,
    file_path: &str,
    hash: &str,
) -> Result<(), rusqlite::Error> {
    let now = now_str();
    conn.execute(
        "INSERT INTO contract_registry (project_id, contract_name, file_path, contract_hash, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)
         ON CONFLICT(project_id, contract_name) DO UPDATE SET
            file_path = excluded.file_path,
            contract_hash = excluded.contract_hash,
            updated_at = excluded.updated_at",
        params![project_id, name, file_path, hash, now],
    )?;
    Ok(())
}

fn now_str() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}
