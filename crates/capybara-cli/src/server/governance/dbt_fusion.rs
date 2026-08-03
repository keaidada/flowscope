//! SQL → dbt model conversion engine.
//!
//! Converts raw SQL scripts into dbt-compatible format by:
//! 1. Replacing table references with `{{ ref('model') }}` or `{{ source('schema', 'table') }}`
//! 2. Extracting DDL (CREATE TABLE) into `{{ config(...) }}` headers
//! 3. Stripping INSERT INTO wrappers (keeping only the SELECT body)
//! 4. Cleaning dialect-specific syntax (ClickHouse ENGINE, etc.)

use std::collections::HashSet;

use rusqlite::{params, Connection};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct ConvertResult {
    pub dbt_content: String,
    pub model_count: usize,
    pub source_count: usize,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DmlExtractResult {
    pub statements: Vec<String>,
    pub count: usize,
}

/// Convert a SQL file to dbt format.
///
/// Uses `table_level_edges` to classify tables as models (produced by scripts)
/// vs sources (only read). Replaces table references accordingly.
pub fn convert_sql_to_dbt(
    main_conn: &Connection,
    project_id: &str,
    sql: &str,
) -> ConvertResult {
    let mut warnings = Vec::new();
    let mut model_count = 0usize;
    let mut source_count = 0usize;

    // 1. Build the set of "model" tables (tables that appear as to_table in table_level_edges)
    let model_tables = load_model_tables(main_conn, project_id);

    // 2. Process the SQL line by line
    let mut output = String::with_capacity(sql.len());
    let mut in_create_table = false;
    let mut config_parts: Vec<String> = Vec::new();
    let mut has_config = false;

    for line in sql.lines() {
        let trimmed = line.trim();

        // Skip empty lines at the start
        if output.is_empty() && trimmed.is_empty() {
            continue;
        }

        // Handle CREATE TABLE ... (DDL definition)
        if trimmed.to_uppercase().starts_with("CREATE") && trimmed.to_uppercase().contains("TABLE") {
            in_create_table = true;
            has_config = true;
            config_parts.push("materialized='table'".to_string());

            // Extract table name
            if let Some(table_name) = extract_table_name_from_ddl(trimmed) {
                model_count += 1;
            }
            continue; // Skip the CREATE TABLE line — dbt generates it
        }

        // Handle ClickHouse ENGINE / PARTITION BY / ORDER BY → config
        if in_create_table {
            let upper = trimmed.to_uppercase();
            if upper.starts_with("ENGINE") {
                if let Some(engine) = extract_engine(trimmed) {
                    config_parts.push(format!("engine='{engine}'"));
                }
                continue;
            }
            if upper.starts_with("PARTITION BY") {
                let expr = trimmed.trim_start_matches(|c: char| c.is_ascii_alphabetic() || c == ' ' || c == '\t');
                let expr = expr.trim().trim_matches(|c: char| c == '(' || c == ')' || c == ' ' || c == '\'');
                if !expr.is_empty() {
                    config_parts.push(format!("partition_by=\"{}\"", expr));
                }
                continue;
            }
            if upper.starts_with("ORDER BY") && !upper.contains("JOIN") {
                let expr = trimmed[8..].trim().trim_matches(|c: char| c == '(' || c == ')' || c == ' ');
                if !expr.is_empty() {
                    config_parts.push(format!("order_by=\"{}\"", expr));
                }
                continue;
            }
            // Inside CREATE TABLE column definitions — skip (dbt infers from SELECT)
            // Detect end of DDL: closing paren on its own line or a semicolon
            if trimmed == ");" || trimmed == ")" || trimmed.ends_with(';') {
                in_create_table = false;
            }
            continue;
        }

        // Handle INSERT INTO ... — strip the INSERT wrapper, keep SELECT
        if trimmed.to_uppercase().starts_with("INSERT INTO") {
            continue; // Skip — dbt materializes automatically
        }

        // Replace table references in FROM/JOIN clauses
        let converted_line = replace_table_refs(&trimmed, &model_tables, &mut source_count, &mut warnings);
        output.push_str(&converted_line);
        output.push('\n');
    }

    // 3. Prepend config header
    let mut result = String::new();
    if has_config && !config_parts.is_empty() {
        result.push_str(&format!("{{{{ config({}) }}}}\n\n", config_parts.join(", ")));
    }
    result.push_str(&output);

    ConvertResult {
        dbt_content: result,
        model_count,
        source_count,
        warnings,
    }
}

/// Load all tables that are produced by scripts (appear as `to_table` in table_level_edges).
fn load_model_tables(conn: &Connection, project_id: &str) -> HashSet<String> {
    let mut tables = HashSet::new();
    if let Ok(mut stmt) = conn.prepare(
        "SELECT DISTINCT to_table FROM table_level_edges WHERE project_id = ?1 AND status = 1",
    ) {
        if let Ok(rows) = stmt.query_map(params![project_id], |row| row.get::<_, String>(0)) {
            for row in rows.flatten() {
                // Normalize: strip schema prefix (syncdb.table → table)
                let normalized = normalize_table_name(&row);
                tables.insert(normalized);
                tables.insert(row); // also keep the full name
            }
        }
    }
    tables
}

/// Normalize a table name: strip schema prefix and database prefix.
/// `syncdb.dwd_orders` → `dwd_orders`
/// `db_mp_order.order_info` → `order_info`
fn normalize_table_name(name: &str) -> String {
    if let Some(pos) = name.rfind('.') {
        name[pos + 1..].to_string()
    } else {
        name.to_string()
    }
}

/// Extract the table name from a CREATE TABLE DDL statement.
fn extract_table_name_from_ddl(line: &str) -> Option<String> {
    let upper = line.to_uppercase();
    let after_table = upper.find("TABLE")?;
    let rest = &line[after_table + 5..].trim_start();
    // Skip OR REPLACE, IF NOT EXISTS
    let rest = rest.trim_start_matches(|c: char| c.is_ascii_alphabetic() || c == '_')
        .trim_start();
    // Read until space, paren, or end
    let end = rest.find(|c: char| c == ' ' || c == '(' || c == '\n').unwrap_or(rest.len());
    let table_name = rest[..end].trim();
    if table_name.is_empty() {
        None
    } else {
        Some(normalize_table_name(table_name))
    }
}

/// Extract ClickHouse engine type from ENGINE = xxx line.
fn extract_engine(line: &str) -> Option<String> {
    let after_eq = line.find('=')?;
    let engine = line[after_eq + 1..].trim();
    // Take just the engine name (before parenthesis)
    let end = engine.find('(').unwrap_or(engine.len());
    Some(engine[..end].trim().to_string())
}

/// Replace table references in a line with {{ ref() }} or {{ source() }}.
fn replace_table_refs(
    line: &str,
    model_tables: &HashSet<String>,
    source_count: &mut usize,
    warnings: &mut Vec<String>,
) -> String {
    let mut result = line.to_string();

    // Find table references after FROM and JOIN keywords
    // Pattern: FROM table_name or JOIN table_name
    let upper = line.to_uppercase();

    for keyword in &["FROM ", "JOIN ", "INTO "] {
        let mut search_start = 0;
        while let Some(pos) = upper[search_start..].find(keyword) {
            let abs_pos = search_start + pos + keyword.len();
            if abs_pos >= line.len() {
                break;
            }

            // Extract the table name (until space, comma, paren, or end)
            let rest = &line[abs_pos..];
            let end = rest
                .find(|c: char| c == ' ' || c == ',' || c == '(' || c == '\n' || c == ';')
                .unwrap_or(rest.len());
            let table_ref = rest[..end].trim().trim_matches(|c: char| c == '`' || c == '"');

            if table_ref.is_empty() || table_ref.starts_with('(') || table_ref.starts_with("{{") {
                search_start = abs_pos;
                continue;
            }

            let normalized = normalize_table_name(table_ref);

            // Decide ref() vs source()
            let replacement = if model_tables.contains(&normalized) || model_tables.contains(table_ref) {
                format!("{{{{ ref('{}') }}}}", normalized)
            } else {
                // Extract schema from the table ref
                let (schema, table) = if let Some(pos) = table_ref.rfind('.') {
                    (&table_ref[..pos], &table_ref[pos + 1..])
                } else {
                    ("raw", table_ref)
                };
                *source_count += 1;
                format!("{{{{ source('{}', '{}') }}}}", schema, table)
            };

            // Replace in the result string
            let full_ref = &line[abs_pos..abs_pos + end];
            result = result.replacen(full_ref, &replacement, 1);

            search_start = abs_pos + end;
        }
    }

    result
}

/// Extract DML statements (INSERT/UPDATE/DELETE/MERGE) from a SQL script.
///
/// For stored procedures, also extracts statements from within
/// BEGIN/END blocks and EXECUTE IMMEDIATE.
pub fn extract_dml(sql: &str) -> DmlExtractResult {
    let mut statements = Vec::new();

    // Split by semicolons (naive but effective for most cases)
    let mut current = String::new();
    let mut in_string = false;
    let mut string_char = '\0';

    for c in sql.chars() {
        if !in_string && (c == '\'' || c == '"') {
            in_string = true;
            string_char = c;
        } else if in_string && c == string_char {
            in_string = false;
        }

        current.push(c);

        if c == ';' && !in_string {
            let stmt = current.trim();
            if !stmt.is_empty() {
                let upper = stmt.to_uppercase();
                if upper.starts_with("INSERT")
                    || upper.starts_with("UPDATE")
                    || upper.starts_with("DELETE")
                    || upper.starts_with("MERGE")
                    || upper.starts_with("CREATE TABLE AS")
                    || upper.starts_with("CREATE OR REPLACE TABLE")
                {
                    // Skip pure DDL (CREATE TABLE without AS)
                    if upper.starts_with("CREATE") && !upper.contains(" AS ") && !upper.contains(" AS\n") && !upper.contains(" AS\t") {
                        // Pure CREATE TABLE (definition only) — skip
                    } else {
                        statements.push(stmt.to_string());
                    }
                }
            }
            current.clear();
        }
    }

    // Handle last statement without semicolon
    let last = current.trim();
    if !last.is_empty() {
        let upper = last.to_uppercase();
        if upper.starts_with("INSERT")
            || upper.starts_with("UPDATE")
            || upper.starts_with("DELETE")
            || upper.starts_with("MERGE")
        {
            statements.push(last.to_string());
        }
    }

    // Also extract from EXECUTE IMMEDIATE blocks
    extract_execute_immediate(sql, &mut statements);

    DmlExtractResult {
        count: statements.len(),
        statements,
    }
}

/// Extract SQL from `EXECUTE IMMEDIATE '...'` blocks (BigQuery stored procedures).
fn extract_execute_immediate(sql: &str, out: &mut Vec<String>) {
    let upper = sql.to_uppercase();
    let mut search_from = 0;

    while let Some(pos) = upper[search_from..].find("EXECUTE IMMEDIATE") {
        let abs_pos = search_from + pos + "EXECUTE IMMEDIATE".len();
        if abs_pos >= sql.len() {
            break;
        }
        let rest = &sql[abs_pos..];
        // Find the string literal
        let rest_trimmed = rest.trim_start();
        if rest_trimmed.starts_with('\'') {
            // Find the closing quote (handle escaped quotes '')
            let mut end = 1;
            let chars: Vec<char> = rest_trimmed.chars().collect();
            while end < chars.len() {
                if chars[end] == '\'' {
                    if end + 1 < chars.len() && chars[end + 1] == '\'' {
                        end += 2; // escaped quote
                    } else {
                        break;
                    }
                } else {
                    end += 1;
                }
            }
            let inner = &rest_trimmed[1..end];
            // Unescape SQL quotes
            let unescaped = inner.replace("''", "'");
            let trimmed = unescaped.trim();
            if !trimmed.is_empty() {
                out.push(trimmed.to_string());
            }
            search_from = abs_pos + end + 1;
        } else {
            search_from = abs_pos;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_table_name() {
        assert_eq!(normalize_table_name("syncdb.dwd_orders"), "dwd_orders");
        assert_eq!(normalize_table_name("db_mp_order.order_info"), "order_info");
        assert_eq!(normalize_table_name("plain_table"), "plain_table");
    }

    #[test]
    fn test_extract_dml_basic() {
        let sql = "SELECT 1;\nINSERT INTO target SELECT * FROM source;\nUPDATE t SET x=1;";
        let result = extract_dml(sql);
        assert_eq!(result.count, 2);
        assert!(result.statements[0].to_uppercase().contains("INSERT"));
        assert!(result.statements[1].to_uppercase().contains("UPDATE"));
    }

    #[test]
    fn test_extract_dml_skip_ddl() {
        let sql = "CREATE TABLE foo (id INT);\nINSERT INTO foo VALUES (1);";
        let result = extract_dml(sql);
        assert_eq!(result.count, 1);
        assert!(result.statements[0].to_uppercase().contains("INSERT"));
    }

    #[test]
    fn test_replace_table_refs() {
        let mut models = HashSet::new();
        models.insert("dwd_orders".to_string());

        let mut source_count = 0;
        let mut warnings = Vec::new();

        let result = replace_table_refs(
            "FROM dwd_orders o",
            &models,
            &mut source_count,
            &mut warnings,
        );
        assert!(result.contains("{{ ref('dwd_orders') }}"));

        let result2 = replace_table_refs(
            "LEFT JOIN db_mp_order.order_info ON",
            &models,
            &mut source_count,
            &mut warnings,
        );
        assert!(result2.contains("{{ source('db_mp_order', 'order_info') }}"));
    }

    #[test]
    fn test_extract_execute_immediate() {
        let sql = "BEGIN\nEXECUTE IMMEDIATE 'INSERT INTO t SELECT 1';\nEND;";
        let mut out = Vec::new();
        extract_execute_immediate(sql, &mut out);
        assert_eq!(out.len(), 1);
        assert!(out[0].to_uppercase().contains("INSERT"));
    }
}
