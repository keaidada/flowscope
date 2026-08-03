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
    let model_tables = load_model_tables(main_conn, project_id);
    convert_sql_to_dbt_with_tables(&model_tables, sql)
}

/// Same as [`convert_sql_to_dbt`] but accepts a preloaded model-table set.
/// Use in batch loops to avoid re-querying the DB per file.
pub fn convert_sql_to_dbt_with_tables(
    model_tables: &std::collections::HashSet<String>,
    sql: &str,
) -> ConvertResult {
    let mut warnings = Vec::new();
    let mut model_count = 0usize;
    let mut source_count = 0usize;

    // 2. Process the SQL line by line
    let mut output = String::with_capacity(sql.len());
    let mut in_create_table = false;
    let mut config_parts: Vec<String> = Vec::new();
    let mut has_config = false;

    // State for INSERT INTO ... header (table / partition / column list).
    // We skip everything from `INSERT` up to the query body (SELECT/VALUES or `(`).
    let mut in_insert_header = false;

    // CTE / subquery aliases that must NOT be rewritten to ref()/source().
    let cte_names = extract_cte_names(sql);

    // Byte offset in `output` right after the last CTE definition (`),`).
    // When we hit INSERT INTO, we truncate output back to this point,
    // discarding the WITH main query body (dbt only needs CTE definitions +
    // the INSERT's own SELECT).
    let mut last_cte_end: Option<usize> = None;

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

        let upper = trimmed.to_uppercase();

        // Handle INSERT INTO ... — skip the whole header (table, partition,
        // column list) until the query body begins. dbt materializes via config.
        if upper.starts_with("INSERT") || upper.starts_with("INTO") {
            // Discard the WITH main query body — keep only CTE definitions.
            if let Some(off) = last_cte_end {
                output.truncate(off);
                last_cte_end = None;
            }
            // If SELECT/VALUES/WITH is on the same line as INSERT, strip the
            // INSERT prefix and keep only the query body.
            if let Some(body) = strip_insert_prefix(trimmed) {
                let converted_line = replace_table_refs(&body, &model_tables, &cte_names, &mut source_count, &mut warnings);
                output.push_str(&converted_line);
                output.push('\n');
                continue;
            }
            in_insert_header = true;
            continue;
        }
        if in_insert_header {
            // Skip partition (...) lines, column lists, trailing commas, etc.
            // Stop when we reach the actual query body: SELECT/VALUES/WITH.
            if upper.starts_with("SELECT")
                || upper.starts_with("VALUES")
                || upper.starts_with("WITH")
                || upper.starts_with("(SELECT")
            {
                in_insert_header = false;
                // fall through to process this line
            } else {
                continue;
            }
        }

        // Replace table references in FROM/JOIN clauses
        let converted_line = replace_table_refs(&trimmed, &model_tables, &cte_names, &mut source_count, &mut warnings);
        // Track CTE definition end: a line ending with `),` closes a CTE def
        // (e.g. `from a4 group by Ctgy_Desc),`). The latest offset is the end
        // of the WITH definitions block; the main query body follows it.
        if trimmed.ends_with("),") && !upper.contains("LEFT JOIN") && !upper.contains("RIGHT JOIN") && !upper.contains("INNER JOIN") {
            last_cte_end = Some(output.len() + converted_line.len() + 1);
        }
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
pub fn load_model_tables_pub(conn: &Connection, project_id: &str) -> HashSet<String> {
    load_model_tables(conn, project_id)
}

/// Load all tables that are produced by scripts (appear as `to_table` in table_level_edges).
fn load_model_tables(conn: &Connection, project_id: &str) -> HashSet<String> {    let mut tables = HashSet::new();
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

/// If a line starts with `INSERT ...` and contains the query body on the same
/// line (`SELECT`/`VALUES`/`WITH`), return the query body with the INSERT
/// prefix stripped. Otherwise return `None` (means the INSERT header spans
/// multiple lines and should be handled by the state machine).
fn strip_insert_prefix(line: &str) -> Option<String> {
    let upper = line.to_uppercase();
    if !(upper.starts_with("INSERT") || upper.starts_with("INTO")) {
        return None;
    }
    // Find the earliest body marker: SELECT, VALUES, WITH
    let select_pos = upper.find("SELECT");
    let values_pos = upper.find(" VALUES ");
    let with_pos = upper.find(" WITH ");
    let body_pos = [select_pos, values_pos, with_pos]
        .into_iter()
        .flatten()
        .min()?;
    Some(line[body_pos..].to_string())
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
///
/// `cte_names` contains CTE aliases / subquery aliases that must NOT be
/// treated as physical tables (they are defined within the same SQL).
fn replace_table_refs(
    line: &str,
    model_tables: &HashSet<String>,
    cte_names: &HashSet<String>,
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

            // Skip CTE / subquery aliases — they are not physical tables.
            if cte_names.contains(&normalized) || cte_names.contains(table_ref) {
                search_start = abs_pos + end;
                continue;
            }

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

/// Extract CTE aliases and subquery aliases from a SQL script.
///
/// Returns a set of identifiers that appear as:
/// - `WITH <name> AS (...)`
/// - `) <alias>` (subquery aliases, e.g. `) k1`, `) tt2 on ...`)
///
/// These should not be treated as physical tables during ref()/source()
/// replacement.
fn extract_cte_names(sql: &str) -> HashSet<String> {
    let mut names = HashSet::new();
    let upper = sql.to_uppercase();

    // 1. CTE names: `<name> AS (`, `<name> AS(`, matching both spacing variants.
    let mut search_from = 0usize;
    while let Some(rel) = upper[search_from..].find(" AS") {
        let as_pos = search_from + rel;
        if as_pos < 2 {
            search_from = as_pos + 3;
            continue;
        }
        // Ensure next non-space char is '('
        let after = &upper[as_pos + 3..];
        let after_trimmed = after.trim_start();
        if !after_trimmed.starts_with('(') {
            search_from = as_pos + 3;
            continue;
        }
        // Walk backwards from ' AS' to find the identifier before it.
        let before = &sql[..as_pos];
        let mut end = before.len();
        // Skip whitespace and delimiters
        while end > 0 {
            let ch = before[..end].chars().last().unwrap();
            if ch == '(' || ch == ')' || ch == ',' || ch == ' ' {
                end -= 1;
            } else {
                break;
            }
        }
        // Read identifier chars backwards
        let id_end = end;
        while end > 0 && (before[..end].chars().last().unwrap().is_ascii_alphanumeric() || before[..end].chars().last().unwrap() == '_') {
            end -= 1;
        }
        let id_start = end;
        if id_start < id_end {
            let name = &sql[id_start..id_end];
            names.insert(name.to_string());
        }
        search_from = as_pos + 3;
    }

    // 2. Subquery aliases: `) <alias>` followed by join/on/etc.
    let mut search = 0usize;
    while let Some(pos) = sql[search..].find(')') {
        let after_paren = search + pos + 1;
        if after_paren >= sql.len() {
            break;
        }
        let after = &sql[after_paren..];
        let after_upper = after.to_uppercase();
        let trimmed = after.trim_start();
        if trimmed.is_empty() {
            search = after_paren + 1;
            continue;
        }
        let id_len = trimmed
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
            .count();
        if id_len > 0 {
            let alias = &trimmed[..id_len];
            let rest_after_alias = trimmed[id_len..].trim_start();
            let is_alias = rest_after_alias.is_empty()
                || rest_after_alias.starts_with("left")
                || rest_after_alias.starts_with("right")
                || rest_after_alias.starts_with("inner")
                || rest_after_alias.starts_with("full")
                || rest_after_alias.starts_with("cross")
                || rest_after_alias.starts_with("on")
                || rest_after_alias.starts_with("where")
                || rest_after_alias.starts_with("group")
                || rest_after_alias.starts_with("order")
                || rest_after_alias.starts_with("having")
                || rest_after_alias.starts_with("limit")
                || rest_after_alias.starts_with(",")
                || rest_after_alias.starts_with(")")
                || rest_after_alias.starts_with("union")
                || rest_after_alias.starts_with("select");
            if is_alias && !rest_after_alias.starts_with('(') {
                names.insert(alias.to_string());
            }
        }
        search = after_paren + 1;
    }

    names
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
        let empty_cte = HashSet::new();

        let mut source_count = 0;
        let mut warnings = Vec::new();

        let result = replace_table_refs(
            "FROM dwd_orders o",
            &models,
            &empty_cte,
            &mut source_count,
            &mut warnings,
        );
        assert!(result.contains("{{ ref('dwd_orders') }}"));

        let result2 = replace_table_refs(
            "LEFT JOIN db_mp_order.order_info ON",
            &models,
            &empty_cte,
            &mut source_count,
            &mut warnings,
        );
        assert!(result2.contains("{{ source('db_mp_order', 'order_info') }}"));
    }

    #[test]
    fn test_replace_table_refs_skips_cte() {
        let mut models = HashSet::new();
        let mut cte = HashSet::new();
        cte.insert("a2".to_string());
        cte.insert("i5".to_string());

        let mut source_count = 0;
        let mut warnings = Vec::new();

        let result = replace_table_refs(
            "left join a2 on x = y",
            &models,
            &cte,
            &mut source_count,
            &mut warnings,
        );
        // CTE alias must NOT be replaced
        assert!(result.contains("join a2"), "CTE was replaced: {result}");
        assert!(!result.contains("source"), "CTE became source: {result}");
    }

    #[test]
    fn test_extract_cte_names() {
        let sql = "with a1 as (select 1), b2 as (select 2)\nselect * from a1 left join b2";
        let ctes = extract_cte_names(sql);
        assert!(ctes.contains("a1"), "missing a1: {ctes:?}");
        assert!(ctes.contains("b2"), "missing b2: {ctes:?}");
    }

    #[test]
    fn test_extract_subquery_alias() {
        let sql = "(select vid from t1 where dt=1) k1\nleft join (select x from t2) tt2 on a=b";
        let ctes = extract_cte_names(sql);
        assert!(ctes.contains("k1"), "missing k1: {ctes:?}");
        assert!(ctes.contains("tt2"), "missing tt2: {ctes:?}");
    }

    #[test]
    fn test_extract_execute_immediate() {
        let sql = "BEGIN\nEXECUTE IMMEDIATE 'INSERT INTO t SELECT 1';\nEND;";
        let mut out = Vec::new();
        extract_execute_immediate(sql, &mut out);
        assert_eq!(out.len(), 1);
        assert!(out[0].to_uppercase().contains("INSERT"));
    }

    #[test]
    fn test_strip_insert_prefix_single_line() {
        // INSERT + SELECT on same line → keep only SELECT
        let body = strip_insert_prefix("INSERT INTO t SELECT * FROM s");
        assert!(body.is_some());
        let body = body.unwrap();
        assert!(body.to_uppercase().starts_with("SELECT"));
        assert!(!body.to_uppercase().contains("INSERT INTO t"));
    }

    #[test]
    fn test_convert_skips_insert_header_multiline() {
        // Multi-line INSERT: table, partition, column list, then SELECT.
        let sql = "INSERT INTO TABLE mat_db.a01_cctv_acct_contt_send_msg_form
partition (data_dt='${data_dt}')
(col1, col2, col3)
SELECT col1, col2, col3
FROM src_table
WHERE data_dt = '${data_dt}'";
        let empty_models: HashSet<String> = HashSet::new();
        let result = convert_sql_to_dbt_with_tables(&empty_models, sql);
        // partition line must NOT appear; SELECT body must appear.
        assert!(!result.dbt_content.contains("partition"), "partition leaked: {}", result.dbt_content);
        assert!(!result.dbt_content.contains("INSERT"), "INSERT leaked: {}", result.dbt_content);
        assert!(!result.dbt_content.contains("(col1, col2, col3)"), "column list leaked: {}", result.dbt_content);
        assert!(result.dbt_content.contains("SELECT col1, col2, col3"), "SELECT body missing: {}", result.dbt_content);
        assert!(result.dbt_content.contains("src_table"), "FROM missing: {}", result.dbt_content);
        assert!(result.dbt_content.contains("WHERE data_dt"), "WHERE missing: {}", result.dbt_content);
    }

    #[test]
    fn test_convert_insert_select_single_line() {
        // INSERT + SELECT on one line → SELECT body kept, INSERT prefix dropped.
        let sql = "INSERT INTO TABLE mat_db.t PARTITION (dt='1') SELECT a FROM src";
        let empty_models: HashSet<String> = HashSet::new();
        let result = convert_sql_to_dbt_with_tables(&empty_models, sql);
        assert!(!result.dbt_content.contains("INSERT"), "INSERT leaked: {}", result.dbt_content);
        assert!(!result.dbt_content.contains("PARTITION"), "PARTITION leaked: {}", result.dbt_content);
        assert!(result.dbt_content.contains("SELECT a"), "SELECT body missing: {}", result.dbt_content);
        assert!(result.dbt_content.contains("src"), "src missing: {}", result.dbt_content);
    }

    #[test]
    fn test_convert_with_query_body_then_insert() {
        // WITH defs (each ends `),`), a leftover main query body, then INSERT.
        // The main query body (a6's SELECT with Exp_UV) is discarded; only
        // CTE defs (a1..a5) + INSERT's own SELECT remain.
        let sql = "with a1 as (select 1 x),
a2 as (select 2 x),
a3 as (select 3 x),
a4 as (select 4 x),
a5 as (select 5 x),
a6 as (select a3.Exp_UV, a1.x
from a1 left join a2 on a1.x = a2.x
left join a3 on a1.x = a3.x
)
insert into table mat_db.t
partition (data_dt='${data_dt}')
(
statt_tm,
acct_num_desc
)
select current_date statt_tm, a1.x acct_num_desc
from a1;";
        let empty_models: HashSet<String> = HashSet::new();
        let result = convert_sql_to_dbt_with_tables(&empty_models, sql);
        let content = &result.dbt_content;
        // The leftover main query body (a6's SELECT with Exp_UV) must be gone
        assert!(!content.contains("Exp_UV"), "WITH main query body leaked: {content}");
        assert!(!content.contains("insert into"), "INSERT leaked: {content}");
        assert!(!content.contains("partition (data_dt"), "PARTITION leaked: {content}");
        // CTE definitions a1..a5 preserved (a6 was the leftover body)
        for name in ["a1", "a2", "a3", "a4", "a5"] {
            assert!(content.contains(&format!("{name} as (")), "CTE {name} missing: {content}");
        }
        // INSERT's actual SELECT body preserved (references CTEs)
        assert!(content.contains("select current_date"), "INSERT SELECT missing: {content}");
        assert!(content.contains("from a1"), "INSERT FROM missing: {content}");
    }
}
