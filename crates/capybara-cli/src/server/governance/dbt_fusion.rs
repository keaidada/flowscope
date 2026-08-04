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

    // CTE / subquery aliases that must NOT be rewritten to ref()/source().
    let cte_names = extract_cte_names(sql);

    // Preprocess: merge lines where FROM/JOIN/INTO/OVERWRITE is at the end of
    // a line and the table name is on the next line. This ensures
    // replace_table_refs (which works line-by-line) can see the table name.
    let sql = merge_trailing_keywords(sql);

    for line in sql.lines() {
        let trimmed = line.trim();

        // Skip empty lines at the start
        if output.is_empty() && trimmed.is_empty() {
            continue;
        }

        // Handle CREATE TABLE ... (DDL definition).
        // CREATE TEMPORARY/TEMP TABLE is NOT treated as DDL — it's a CTE-like
        // construct whose body should be processed normally (table refs inside
        // still need to be rewritten).
        let tu = trimmed.to_uppercase();
        let is_create_table = tu.starts_with("CREATE") && tu.contains("TABLE");
        let is_temp = tu.starts_with("CREATE")
            && (tu.contains("TEMPORARY") || tu.contains(" TEMP "));
        if is_create_table && !is_temp {
            in_create_table = true;
            has_config = true;
            // Avoid duplicate materialized entries when a script has multiple
            // CREATE TABLE statements (only the first occurrence is kept).
            if !config_parts.iter().any(|c| c.starts_with("materialized")) {
                config_parts.push("materialized='table'".to_string());
            }

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
                    let entry = format!("engine='{engine}'");
                    if !config_parts.iter().any(|c| c.starts_with("engine=")) {
                        config_parts.push(entry);
                    }
                }
                continue;
            }
            if upper.starts_with("PARTITION BY") {
                let expr = trimmed.trim_start_matches(|c: char| c.is_ascii_alphabetic() || c == ' ' || c == '\t');
                let expr = expr.trim().trim_matches(|c: char| c == '(' || c == ')' || c == ' ' || c == '\'');
                if !expr.is_empty() {
                    let entry = format!("partition_by=\"{}\"", expr);
                    if !config_parts.iter().any(|c| c.starts_with("partition_by=")) {
                        config_parts.push(entry);
                    }
                }
                continue;
            }
            if upper.starts_with("ORDER BY") && !upper.contains("JOIN") {
                let expr = trimmed[8..].trim().trim_matches(|c: char| c == '(' || c == ')' || c == ' ');
                if !expr.is_empty() {
                    let entry = format!("order_by=\"{}\"", expr);
                    if !config_parts.iter().any(|c| c.starts_with("order_by=")) {
                        config_parts.push(entry);
                    }
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

        // Replace table references in FROM/JOIN/INTO clauses. INSERT INTO,
        // partition, and column-list lines are kept as-is (only table names
        // are rewritten to ref()/source()).
        let converted_line = replace_table_refs(&trimmed, &model_tables, &cte_names, &mut source_count, &mut warnings);
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

/// Merge lines where a keyword (FROM/JOIN/INTO/OVERWRITE TABLE) is the last
/// token on a line and the table name follows on the next line.
///
/// Example:
///   `from\nm01_rep_db.xxx` → `from m01_rep_db.xxx`
///
/// This lets `replace_table_refs` (line-by-line) see the table name.
fn merge_trailing_keywords(sql: &str) -> String {
    let lines: Vec<&str> = sql.lines().collect();
    let mut result: Vec<String> = Vec::with_capacity(lines.len());
    let mut i = 0;
    while i < lines.len() {
        let trimmed = lines[i].trim_end();
        let upper = trimmed.to_uppercase();
        // Check if the line ends with a keyword that expects a table name next.
        let last_token = upper.split_whitespace().last().unwrap_or("");
        let needs_merge = matches!(last_token, "FROM" | "JOIN" | "INTO" | "TABLE")
            || upper.ends_with("LEFT JOIN")
            || upper.ends_with("RIGHT JOIN")
            || upper.ends_with("INNER JOIN")
            || upper.ends_with("FULL JOIN")
            || upper.ends_with("CROSS JOIN")
            || upper.ends_with("JOIN");

        if needs_merge && i + 1 < lines.len() {
            // Merge this line with the next non-empty line.
            let next = lines[i + 1].trim();
            if !next.is_empty() && !next.starts_with("--") {
                result.push(format!("{trimmed} {next}"));
                i += 2;
                continue;
            }
        }
        result.push(lines[i].to_string());
        i += 1;
    }
    result.join("\n")
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
    // Skip comment lines — table names inside comments (-- ...) should not
    // be rewritten. This prevents '--from old_table' from becoming
    // '--from {{ source(...) }}'.
    if line.trim_start().starts_with("--") {
        return line.to_string();
    }

    let mut result = line.to_string();

    // Find table references after FROM / JOIN / INTO keywords. INSERT INTO /
    // INSERT OVERWRITE target tables are rewritten to ref()/source() (dbt
    // format). The OVERWRITE keyword is only matched on INSERT lines to avoid
    // rewriting column/comment text elsewhere.
    let upper = line.to_uppercase();
    let is_insert_line = upper.trim_start().starts_with("INSERT")
        || upper.trim_start().starts_with("INTO");

    let keywords: &[&str] = if is_insert_line {
        &["FROM ", "JOIN ", "INTO ", "OVERWRITE "]
    } else {
        &["FROM ", "JOIN ", "INTO "]
    };

    for keyword in keywords {
        let mut search_start = 0;
        while let Some(pos) = upper[search_start..].find(keyword) {
            let abs_pos = search_start + pos + keyword.len();
            if abs_pos >= line.len() {
                break;
            }

            // Skip any whitespace between the keyword and the table name
            // (handles `FROM  table` with multiple spaces/tabs).
            let rest_raw = &line[abs_pos..];
            let leading_ws = rest_raw.len() - rest_raw.trim_start().len();
            let rest = &rest_raw[leading_ws..];

            // Extract the table name (until space, comma, paren, or end).
            // ')' is included so that `from b1) temp` yields `b1` not `b1)`.
            let end = rest
                .find(|c: char| c == ' ' || c == ',' || c == '(' || c == ')' || c == '\n' || c == ';')
                .unwrap_or(rest.len());
            let table_ref = rest[..end].trim().trim_matches(|c: char| c == '`' || c == '"');

            if table_ref.is_empty() || table_ref.starts_with('(') || table_ref.starts_with("{{") {
                search_start = abs_pos + leading_ws + 1;
                continue;
            }

            // `INSERT INTO TABLE db.tbl` / `INSERT OVERWRITE TABLE db.tbl` —
            // skip the TABLE keyword and use the actual table name.
            let mut actual_ref = table_ref;
            let mut actual_end = end;
            let mut actual_start = 0usize; // offset of the table name in `rest`
            if (*keyword == "INTO " || *keyword == "OVERWRITE ")
                && (table_ref.eq_ignore_ascii_case("table")
                    || table_ref.eq_ignore_ascii_case("overwrite"))
            {
                let mut pos = table_ref.len();
                let mut after = rest[pos..].trim_start();
                pos = rest.len() - after.len();
                if after.eq_ignore_ascii_case("table") {
                    after = after[5..].trim_start();
                    pos = rest.len() - after.len();
                }
                let end2 = after
                    .find(|c: char| c == ' ' || c == ',' || c == '(' || c == ')' || c == '\n' || c == ';')
                    .unwrap_or(after.len());
                actual_ref = after[..end2].trim().trim_matches(|c: char| c == '`' || c == '"');
                actual_start = pos;
                actual_end = pos + end2;
            }

            let normalized = normalize_table_name(actual_ref);

            // Skip CTE / subquery aliases — they are not physical tables.
            if cte_names.contains(&normalized) || cte_names.contains(actual_ref) {
                search_start = abs_pos + leading_ws + actual_end;
                continue;
            }

            // Decide ref() vs source()
            let replacement = if model_tables.contains(&normalized) || model_tables.contains(actual_ref) {
                format!("{{{{ ref('{}') }}}}", normalized)
            } else {
                // Extract schema from the table ref
                let (schema, table) = if let Some(pos) = actual_ref.rfind('.') {
                    (&actual_ref[..pos], &actual_ref[pos + 1..])
                } else {
                    ("raw", actual_ref)
                };
                *source_count += 1;
                format!("{{{{ source('{}', '{}') }}}}", schema, table)
            };

            // Replace in the result string — only the table name is replaced,
            // so `INSERT INTO TABLE` keeps its `TABLE` keyword. The leading
            // whitespace skipped after the keyword must be added back so the
            // slice offsets align with the original `line`.
            let off = abs_pos + leading_ws;
            let full_ref = &line[off + actual_start..off + actual_end];
            result = result.replacen(full_ref, &replacement, 1);

            search_start = off + actual_end;
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

    // 1. CTE names: `<name> AS (` or `<name> AS(` (case-insensitive).
    //    Scan over char_indices so every byte index is a UTF-8 char boundary.
    let mut i = 0usize;
    let chars: Vec<(usize, char)> = sql.char_indices().collect();
    while i + 1 < chars.len() {
        if chars[i].1.eq_ignore_ascii_case(&'A') && chars[i + 1].1.eq_ignore_ascii_case(&'S') {
            // "AS" must be followed (after whitespace) by '('
            let mut k = i + 2;
            while k < chars.len() && chars[k].1.is_whitespace() {
                k += 1;
            }
            if k < chars.len() && chars[k].1 == '(' {
                // Walk backwards from before "AS" to find the identifier
                // (ASCII letters/digits/_). Skip whitespace right before "AS".
                let mut id_end_idx = i; // char index of the char right after the identifier
                while id_end_idx > 0 {
                    let ch = chars[id_end_idx - 1].1;
                    if ch.is_whitespace() || ch == '(' || ch == ')' || ch == ',' {
                        id_end_idx -= 1;
                    } else {
                        break;
                    }
                }
                // Now walk back over identifier chars to find the start.
                let mut id_start = id_end_idx;
                while id_start > 0 {
                    let ch = chars[id_start - 1].1;
                    if ch.is_ascii_alphanumeric() || ch == '_' {
                        id_start -= 1;
                    } else {
                        break;
                    }
                }
                if id_start < id_end_idx {
                    let start_byte = chars[id_start].0;
                    let end_byte = chars[id_end_idx].0;
                    if end_byte <= sql.len() {
                        let name = &sql[start_byte..end_byte];
                        names.insert(name.to_string());
                    }
                }
                i = k;
                continue;
            }
        }
        i += 1;
    }

    // 2. Subquery aliases: `) <alias>` followed by join/on/etc.
    //    char-safe scanning: find each ')' byte offset, then inspect what
    //    follows it.
    let mut scan = 0usize;
    while let Some(pos) = sql[scan..].find(')') {
        let after_paren = scan + pos + 1; // byte offset of the char after ')'
        if after_paren >= sql.len() {
            break;
        }
        // after_paren is a char boundary because ')' is ASCII and +1 lands on
        // the next char's first byte.
        let after = &sql[after_paren..];
        let trimmed = after.trim_start();
        let trimmed_byte_off = after.len() - trimmed.len();
        let mut consumed = trimmed.len();
        if !trimmed.is_empty() {
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
                // Only advance past the alias token so later ')' chars are
                // still scanned (e.g. nested subqueries).
                consumed = alias.len();
            }
        }
        // Resume scanning after the alias token (or after the whole region if
        // no alias matched).
        scan = after_paren + trimmed_byte_off + consumed;
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
            // Find the closing quote (handle escaped quotes '') using byte
            // offsets via char_indices so slicing is always char-boundary safe.
            let mut end = 1usize; // byte offset after the opening quote
            let mut iter = rest_trimmed.char_indices().skip(1).peekable();
            while let Some((off, ch)) = iter.next() {
                if ch == '\'' {
                    if let Some(&(_, next_ch)) = iter.peek() {
                        if next_ch == '\'' {
                            // escaped quote '' — skip both
                            iter.next();
                            continue;
                        }
                    }
                    end = off;
                    break;
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
    fn test_convert_skips_insert_header_multiline() {
        // INSERT INTO ... partition (...) column-list SELECT — the INSERT
        // statement is preserved; only the table name is rewritten.
        let sql = "INSERT INTO TABLE mat_db.a01_cctv_acct_contt_send_msg_form
partition (data_dt='${data_dt}')
(col1, col2, col3)
SELECT col1, col2, col3
FROM src_table
WHERE data_dt = '${data_dt}'";
        let empty_models: HashSet<String> = HashSet::new();
        let result = convert_sql_to_dbt_with_tables(&empty_models, sql);
        let content = &result.dbt_content;
        // INSERT INTO target table rewritten to source() — `TABLE` kept.
        assert!(content.contains("INSERT INTO TABLE {{ source('mat_db', 'a01_cctv_acct_contt_send_msg_form') }}"), "INSERT INTO not rewritten: {content}");
        assert!(content.contains("partition (data_dt"), "PARTITION missing: {content}");
        assert!(content.contains("(col1, col2, col3)"), "column list missing: {content}");
        // Query body preserved
        assert!(content.contains("SELECT col1, col2, col3"), "SELECT body missing: {content}");
        assert!(content.contains("src_table"), "FROM missing: {content}");
        assert!(content.contains("WHERE data_dt"), "WHERE missing: {content}");
    }

    #[test]
    fn test_convert_insert_select_single_line() {
        // INSERT + SELECT on one line → INSERT target preserved verbatim,
        // only FROM table names rewritten.
        let sql = "INSERT INTO TABLE mat_db.t PARTITION (dt='1') SELECT a FROM src";
        let empty_models: HashSet<String> = HashSet::new();
        let result = convert_sql_to_dbt_with_tables(&empty_models, sql);
        let content = &result.dbt_content;
        assert!(content.contains("INSERT INTO TABLE {{ source('mat_db', 't') }}"), "INSERT/target missing: {content}");
        assert!(content.contains("PARTITION (dt='1')"), "PARTITION missing: {content}");
        assert!(content.contains("SELECT a FROM {{ source('raw', 'src') }}"), "SELECT body missing: {content}");
    }

    #[test]
    fn test_convert_with_query_body_then_insert() {
        // WITH defs + INSERT INTO referencing CTEs. All CTEs (incl. last a6)
        // must be preserved; INSERT INTO header + column list preserved; only
        // table names are rewritten.
        let sql = "with a1 as (select 1 x),
a2 as (select 2 x),
a3 as (select 3 x),
a4 as (select 4 x),
a5 as (select 5 x),
a6 as (select a1.x, a2.y from a1 left join a2 on a1.x = a2.x)
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
        // CTE definitions preserved (a1..a6)
        for name in ["a1", "a2", "a3", "a4", "a5", "a6"] {
            assert!(content.contains(&format!("{name} as (")), "CTE {name} missing: {content}");
        }
        // INSERT INTO / partition preserved, target rewritten to source()
        assert!(content.contains("insert into table {{ source('mat_db', 't') }}"), "INSERT INTO missing: {content}");
        assert!(content.contains("partition (data_dt"), "PARTITION missing: {content}");
        assert!(content.contains("statt_tm"), "column list missing: {content}");
        // INSERT's actual SELECT body preserved (references CTEs)
        assert!(content.contains("select current_date"), "INSERT SELECT missing: {content}");
        assert!(content.contains("from a1"), "INSERT FROM missing: {content}");
    }
}
