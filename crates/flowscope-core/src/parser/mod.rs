use crate::error::ParseError;
use crate::types::Dialect;
use sqlparser::ast::Statement;
use sqlparser::dialect::PostgreSqlDialect;
use sqlparser::parser::Parser;

/// Result of parsing SQL with fallback metadata.
pub struct ParseSqlOutput {
    pub statements: Vec<Statement>,
    pub parser_fallback_used: bool,
}

/// Parse SQL using the specified dialect
pub fn parse_sql_with_dialect(sql: &str, dialect: Dialect) -> Result<Vec<Statement>, ParseError> {
    parse_sql_with_dialect_output(sql, dialect).map(|output| output.statements)
}

/// Parse SQL using the specified dialect and report whether parser fallback was used.
pub fn parse_sql_with_dialect_output(
    sql: &str,
    dialect: Dialect,
) -> Result<ParseSqlOutput, ParseError> {
    let sqlparser_dialect = dialect.to_sqlparser_dialect();
    match Parser::parse_sql(sqlparser_dialect.as_ref(), sql) {
        Ok(statements) => Ok(ParseSqlOutput {
            statements,
            parser_fallback_used: false,
        }),
        Err(primary_err) => {
            if let Some(sanitized_sql) = sanitize_escaped_identifiers_for_dialect(sql, dialect) {
                if let Ok(statements) =
                    Parser::parse_sql(sqlparser_dialect.as_ref(), &sanitized_sql)
                {
                    return Ok(ParseSqlOutput {
                        statements,
                        parser_fallback_used: true,
                    });
                }
            }

            if let Some(sanitized_sql) = sanitize_trailing_comma_before_from(sql) {
                if let Ok(statements) =
                    Parser::parse_sql(sqlparser_dialect.as_ref(), &sanitized_sql)
                {
                    return Ok(ParseSqlOutput {
                        statements,
                        parser_fallback_used: true,
                    });
                }
            }

            if matches!(dialect, Dialect::Ansi) {
                if let Some(sanitized_sql) = sanitize_ansi_national_literal_spacing(sql) {
                    if let Ok(statements) =
                        Parser::parse_sql(sqlparser_dialect.as_ref(), &sanitized_sql)
                    {
                        return Ok(ParseSqlOutput {
                            statements,
                            parser_fallback_used: true,
                        });
                    }
                }
            }

            if matches!(dialect, Dialect::Bigquery) || (matches!(dialect, Dialect::Generic) && looks_like_bigquery_procedure(sql)) {
                if let Some(sanitized_sql) = sanitize_bigquery_raw_double_quoted_literals(sql) {
                    if let Ok(statements) =
                        Parser::parse_sql(sqlparser_dialect.as_ref(), &sanitized_sql)
                    {
                        return Ok(ParseSqlOutput {
                            statements,
                            parser_fallback_used: true,
                        });
                    }
                }
            }

            // Hive/Spark sanitize: always try this fallback when the SQL contains
            // Spark-specific patterns (CACHE TABLE, UNCACHE TABLE, LEFT ANTI JOIN etc.)
            // regardless of the declared dialect, since users often leave dialect at
            // 'generic' for Spark SQL files.
            if matches!(dialect, Dialect::Hive) || looks_like_hive_spark_syntax(sql) {
                if let Some(sanitized_sql) = sanitize_hive_spark_sql(sql) {
                    if let Ok(statements) =
                        Parser::parse_sql(sqlparser_dialect.as_ref(), &sanitized_sql)
                    {
                        return Ok(ParseSqlOutput {
                            statements,
                            parser_fallback_used: true,
                        });
                    }
                }
            }

            // Parity fallback: Generic dialect frequently fails on Postgres-specific
            // operators (`?`, `->>`, `::`) commonly used in warehouse SQL.
            if matches!(dialect, Dialect::Generic) && looks_like_postgres_syntax(sql) {
                let postgres = PostgreSqlDialect {};
                if let Ok(statements) = Parser::parse_sql(&postgres, sql) {
                    return Ok(ParseSqlOutput {
                        statements,
                        parser_fallback_used: true,
                    });
                }
            }
            Err(primary_err.into())
        }
    }
}

fn looks_like_hive_spark_syntax(sql: &str) -> bool {
    let upper = sql.to_uppercase();
    upper.contains("CACHE TABLE")
        || upper.contains("UNCACHE TABLE")
        || upper.contains("ANTI JOIN")
        || upper.contains("SEMI JOIN")
        || upper.contains("OPTIONS (") // Spark OPTIONS on CACHE TABLE / CREATE TABLE
        || sql.contains('#') // Hive-style comments
}

fn looks_like_bigquery_procedure(sql: &str) -> bool {
    let upper = sql.to_uppercase();
    if let Some(pos) = upper.find("PROCEDURE") {
        upper[..pos].trim_end().ends_with("CREATE")
            || upper[..pos].trim_end().ends_with("REPLACE")
    } else {
        false
    }
}

fn looks_like_postgres_syntax(sql: &str) -> bool {
    sql.contains("::")
        || sql.contains("->")
        || sql.contains("?|")
        || sql.contains("?&")
        || sql.contains(" ? ")
        || sql.contains(" ?\n")
        || sql.contains("? '")
        || sql.contains("?\t")
}

fn sanitize_escaped_identifiers_for_dialect(sql: &str, dialect: Dialect) -> Option<String> {
    let delimiters: &[u8] = match dialect {
        Dialect::Bigquery => b"`",
        Dialect::Clickhouse => b"`\"",
        _ => return None,
    };

    if !sql.as_bytes().contains(&b'\\') {
        return None;
    }

    let mut rewritten = rewrite_escaped_quoted_identifiers(sql, delimiters);

    if matches!(dialect, Dialect::Clickhouse) {
        rewritten = remove_trailing_comma_before_from(&rewritten);
    }

    (rewritten != sql).then_some(rewritten)
}

fn sanitize_trailing_comma_before_from(sql: &str) -> Option<String> {
    let rewritten = remove_trailing_comma_before_from(sql);
    (rewritten != sql).then_some(rewritten)
}

fn push_current_char(sql: &str, i: &mut usize, out: &mut String) {
    if let Some(ch) = sql[*i..].chars().next() {
        out.push(ch);
        *i += ch.len_utf8();
    }
}

fn sanitize_ansi_national_literal_spacing(sql: &str) -> Option<String> {
    #[derive(Clone, Copy, PartialEq, Eq)]
    enum ScanMode {
        Outside,
        SingleQuote,
        DoubleQuote,
        BacktickQuote,
        BracketQuote,
        LineComment,
        BlockComment,
    }

    fn identifier_tail(byte: u8) -> bool {
        byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'$')
    }

    let bytes = sql.as_bytes();
    let mut out = String::with_capacity(sql.len());
    let mut mode = ScanMode::Outside;
    let mut i = 0usize;
    let mut changed = false;

    while i < bytes.len() {
        let b = bytes[i];
        let next = bytes.get(i + 1).copied();

        match mode {
            ScanMode::Outside => {
                if b == b'\'' {
                    mode = ScanMode::SingleQuote;
                    out.push('\'');
                    i += 1;
                    continue;
                }
                if b == b'"' {
                    mode = ScanMode::DoubleQuote;
                    out.push('"');
                    i += 1;
                    continue;
                }
                if b == b'`' {
                    mode = ScanMode::BacktickQuote;
                    out.push('`');
                    i += 1;
                    continue;
                }
                if b == b'[' {
                    mode = ScanMode::BracketQuote;
                    out.push('[');
                    i += 1;
                    continue;
                }
                if b == b'-' && next == Some(b'-') {
                    mode = ScanMode::LineComment;
                    out.push('-');
                    out.push('-');
                    i += 2;
                    continue;
                }
                if b == b'/' && next == Some(b'*') {
                    mode = ScanMode::BlockComment;
                    out.push('/');
                    out.push('*');
                    i += 2;
                    continue;
                }

                if matches!(b, b'N' | b'n') {
                    let prev = i.checked_sub(1).and_then(|idx| bytes.get(idx).copied());
                    if !prev.is_some_and(identifier_tail) {
                        let mut j = i + 1;
                        while j < bytes.len() && bytes[j].is_ascii_whitespace() {
                            j += 1;
                        }
                        if j > i + 1 && bytes.get(j).copied() == Some(b'\'') {
                            out.push(b as char);
                            i += 1;
                            while i < j {
                                changed = true;
                                i += 1;
                            }
                            continue;
                        }
                    }
                }

                push_current_char(sql, &mut i, &mut out);
            }
            ScanMode::SingleQuote => {
                push_current_char(sql, &mut i, &mut out);
                if b == b'\'' {
                    if next == Some(b'\'') {
                        out.push('\'');
                        i += 1;
                    } else {
                        mode = ScanMode::Outside;
                    }
                }
            }
            ScanMode::DoubleQuote => {
                push_current_char(sql, &mut i, &mut out);
                if b == b'"' {
                    mode = ScanMode::Outside;
                }
            }
            ScanMode::BacktickQuote => {
                push_current_char(sql, &mut i, &mut out);
                if b == b'`' {
                    mode = ScanMode::Outside;
                }
            }
            ScanMode::BracketQuote => {
                push_current_char(sql, &mut i, &mut out);
                if b == b']' {
                    mode = ScanMode::Outside;
                }
            }
            ScanMode::LineComment => {
                push_current_char(sql, &mut i, &mut out);
                if b == b'\n' || b == b'\r' {
                    mode = ScanMode::Outside;
                }
            }
            ScanMode::BlockComment => {
                push_current_char(sql, &mut i, &mut out);
                if b == b'*' && next == Some(b'/') {
                    out.push('/');
                    i += 1;
                    mode = ScanMode::Outside;
                }
            }
        }
    }

    changed.then_some(out)
}

/// Sanitize BigQuery stored procedures: extract DML/SELECT from BEGIN...END body.
fn sanitize_bigquery_procedure(sql: &str) -> Option<String> {
    let upper = sql.to_uppercase();
    let proc_pos = upper.find("PROCEDURE")?;
    let before_proc = upper[..proc_pos].trim_end();
    if !before_proc.ends_with("CREATE") && !before_proc.ends_with("REPLACE") { return None; }
    let begin_idx = upper[proc_pos..].find("BEGIN").map(|i| proc_pos + i)?;

    let bytes = sql.as_bytes();
    let mut depth = 0;
    let body_start = begin_idx + 5;
    let mut body_end = body_start;
    let mut in_string = false;
    let mut in_line_comment = false;
    let mut in_block_comment = false;
    let mut string_char: u8 = 0;
    let mut i = body_start;

    while i < bytes.len() {
        let c = bytes[i];
        if !in_string && !in_line_comment && !in_block_comment {
            if c == b'-' && i + 1 < bytes.len() && bytes[i + 1] == b'-' { in_line_comment = true; i += 2; continue; }
            if c == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'*' { in_block_comment = true; i += 2; continue; }
            if c == b'\'' || c == b'"' || c == b'`' { in_string = true; string_char = c; }
        } else if in_string {
            if c == b'\\' && i + 1 < bytes.len() && string_char != b'`' { i += 2; continue; }
            if c == string_char { in_string = false; }
        } else if in_line_comment { if c == b'\n' { in_line_comment = false; } i += 1; continue; }
        else if in_block_comment { if c == b'*' && i+1 < bytes.len() && bytes[i+1] == b'/' { in_block_comment = false; i+=2; continue; } i+=1; continue; }
        if !in_string && !in_line_comment && !in_block_comment {
            if i+5 <= bytes.len() && upper[i..].starts_with("BEGIN") && is_word_boundary(bytes,i,5) { depth += 1; }
            if i+3 <= bytes.len() && upper[i..].starts_with("END") && is_word_boundary(bytes,i,3) { if depth == 0 { body_end = i; break; } depth -= 1; }
        }
        i += 1;
    }
    if body_end <= body_start { body_end = sql.len(); }
    let body = &sql[body_start..body_end];
    if body.trim().is_empty() { return None; }

    let statements = split_sql_statements(body);
    let mut out = String::with_capacity(body.len());
    let mut has_any = false;
    for stmt in &statements {
        let trimmed = stmt.trim();
        if trimmed.is_empty() { continue; }
        let upper_stmt = trimmed.to_uppercase();
        let first_word = upper_stmt.split_whitespace().next().unwrap_or("");
        match first_word {
            "DECLARE" | "SET" | "IF" | "ELSE" | "ELSEIF" | "WHILE" | "LOOP" | "FOR"
            | "BREAK" | "CONTINUE" | "RETURN" | "RAISE" | "BEGIN" | "END"
            | "CALL" | "EXECUTE" | "EXEC" | "DROP" | "ALTER" | "GRANT" | "REVOKE" => {}
            "CREATE" => { if upper_stmt.contains("AS SELECT") || upper_stmt.contains("AS\nSELECT") { out.push_str(trimmed); if !trimmed.ends_with(';') { out.push(';'); } out.push('\n'); has_any = true; } }
            "SELECT" | "INSERT" | "UPDATE" | "DELETE" | "MERGE" | "TRUNCATE" | "WITH" => { out.push_str(trimmed); if !trimmed.ends_with(';') { out.push(';'); } out.push('\n'); has_any = true; }
            _ => {}
        }
    }
    has_any.then_some(out)
}

fn is_word_boundary(bytes: &[u8], i: usize, word_len: usize) -> bool {
    let next = i + word_len;
    if next >= bytes.len() { return true; }
    matches!(bytes[next], b' ' | b'\t' | b'\n' | b'\r' | b';' | b'(' | b')' | b',' | b'.')
}

fn split_sql_statements(body: &str) -> Vec<String> {
    let mut result = Vec::new();
    let mut current = String::new();
    let mut in_s = false; let mut in_d = false; let mut in_b = false;
    let mut in_lc = false; let mut in_bc = false;
    let bytes = body.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        if !in_s && !in_d && !in_b && !in_lc && !in_bc {
            if c == b'-' && i+1 < bytes.len() && bytes[i+1] == b'-' { in_lc = true; current.push_str("--"); i+=2; continue; }
            if c == b'/' && i+1 < bytes.len() && bytes[i+1] == b'*' { in_bc = true; current.push_str("/*"); i+=2; continue; }
            if c == b'\'' { in_s = true; } else if c == b'"' { in_d = true; } else if c == b'`' { in_b = true; }
            else if c == b';' { result.push(current); current = String::new(); i+=1; continue; }
        } else if in_s { if c == b'\\' && i+1 < bytes.len() { current.push(bytes[i] as char); current.push(bytes[i+1] as char); i+=2; continue; } if c == b'\'' { in_s = false; } }
        else if in_d { if c == b'\\' && i+1 < bytes.len() { current.push(bytes[i] as char); current.push(bytes[i+1] as char); i+=2; continue; } if c == b'"' { in_d = false; } }
        else if in_b { if c == b'`' { in_b = false; } }
        else if in_lc { if c == b'\n' { in_lc = false; } }
        else if in_bc { if c == b'*' && i+1 < bytes.len() && bytes[i+1] == b'/' { in_bc = false; current.push_str("*/"); i+=2; continue; } }
        current.push(c as char); i += 1;
    }
    let trimmed = current.trim().to_string();
    if !trimmed.is_empty() { result.push(trimmed); }
    result
}

fn sanitize_bigquery_raw_double_quoted_literals(sql: &str) -> Option<String> {
    // Try procedure sanitizer first for BigQuery stored procedures
    if let Some(inner) = sanitize_bigquery_procedure(sql) {
        return Some(inner);
    }

    let bytes = sql.as_bytes();
    let mut out = String::with_capacity(sql.len());
    let mut i = 0usize;
    let mut changed = false;

    while i < bytes.len() {
        let start = i;
        while i < bytes.len() && bytes[i].is_ascii_alphabetic() {
            i += 1;
        }

        let prefix = &sql[start..i];
        let is_raw_prefix = prefix.eq_ignore_ascii_case("r")
            || prefix.eq_ignore_ascii_case("br")
            || prefix.eq_ignore_ascii_case("rb");

        if !is_raw_prefix || i >= bytes.len() || bytes[i] != b'"' {
            if start < i {
                out.push_str(prefix);
            } else if i < bytes.len() {
                push_current_char(sql, &mut i, &mut out);
            }
            continue;
        }

        let quote_start = i;
        i += 1;
        let mut body = String::new();
        let mut closed = false;
        while i < bytes.len() {
            if bytes[i] == b'\\' && i + 1 < bytes.len() && bytes[i + 1] == b'"' {
                body.push('\\');
                body.push('"');
                i += 2;
                continue;
            }
            if bytes[i] == b'"' {
                closed = true;
                i += 1;
                break;
            }
            push_current_char(sql, &mut i, &mut body);
        }

        if !closed {
            out.push_str(&sql[start..quote_start]);
            out.push('"');
            out.push_str(&body);
            break;
        }

        changed = true;
        out.push_str(prefix);
        out.push('\'');
        for ch in body.chars() {
            if ch == '\'' {
                out.push('\'');
            }
            out.push(ch);
        }
        out.push('\'');
    }

    changed.then_some(out)
}

fn rewrite_escaped_quoted_identifiers(sql: &str, delimiters: &[u8]) -> String {
    let bytes = sql.as_bytes();
    let mut out = String::with_capacity(sql.len());
    let mut i = 0usize;
    let len = bytes.len();

    while i < len {
        if bytes[i] == b'\'' {
            let start = i;
            i += 1;
            while i < len {
                if bytes[i] == b'\'' {
                    if i + 1 < len && bytes[i + 1] == b'\'' {
                        i += 2;
                    } else {
                        i += 1;
                        break;
                    }
                } else {
                    i += 1;
                }
            }
            out.push_str(&sql[start..i]);
            continue;
        }

        if bytes[i] == b'-' && i + 1 < len && bytes[i + 1] == b'-' {
            let start = i;
            i += 2;
            while i < len && bytes[i] != b'\n' && bytes[i] != b'\r' {
                i += 1;
            }
            out.push_str(&sql[start..i]);
            continue;
        }

        if bytes[i] == b'/' && i + 1 < len && bytes[i + 1] == b'*' {
            let start = i;
            i += 2;
            while i + 1 < len {
                if bytes[i] == b'*' && bytes[i + 1] == b'/' {
                    i += 2;
                    break;
                }
                i += 1;
            }
            out.push_str(&sql[start..i.min(len)]);
            continue;
        }

        if delimiters.contains(&bytes[i]) {
            let delimiter = bytes[i];
            let start = i;
            i += 1;
            let mut content = String::new();
            let mut had_escape = false;
            let mut closed = false;

            while i < len {
                if bytes[i] == b'\\' && i + 1 < len && bytes[i + 1] == delimiter {
                    had_escape = true;
                    content.push('_');
                    i += 2;
                    continue;
                }

                if bytes[i] == delimiter {
                    if i + 1 < len && bytes[i + 1] == delimiter {
                        had_escape = true;
                        content.push('_');
                        i += 2;
                        continue;
                    }
                    i += 1;
                    closed = true;
                    break;
                }

                push_current_char(sql, &mut i, &mut content);
            }

            if !closed {
                out.push_str(&sql[start..len]);
                break;
            }

            if had_escape {
                let normalized = normalize_identifier_content(&content);
                out.push(delimiter as char);
                out.push_str(&normalized);
                out.push(delimiter as char);
            } else {
                out.push_str(&sql[start..i]);
            }
            continue;
        }

        push_current_char(sql, &mut i, &mut out);
    }

    out
}

fn normalize_identifier_content(content: &str) -> String {
    let mut normalized = String::with_capacity(content.len());
    for ch in content.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' {
            normalized.push(ch.to_ascii_lowercase());
        } else {
            normalized.push('_');
        }
    }

    if normalized.is_empty() || normalized.chars().all(|ch| ch == '_') {
        "escaped_identifier".to_string()
    } else {
        normalized
    }
}

fn remove_trailing_comma_before_from(sql: &str) -> String {
    let bytes = sql.as_bytes();
    let mut out = String::with_capacity(sql.len());
    let mut i = 0usize;
    let len = bytes.len();

    while i < len {
        if bytes[i] == b',' {
            let mut j = i + 1;
            while j < len && matches!(bytes[j], b' ' | b'\t' | b'\n' | b'\r') {
                j += 1;
            }

            if j + 4 <= len
                && bytes[j..j + 4].eq_ignore_ascii_case(b"FROM")
                && (j + 4 == len || !bytes[j + 4].is_ascii_alphanumeric())
            {
                i += 1;
                continue;
            }
        }

        push_current_char(sql, &mut i, &mut out);
    }

    out
}

/// Parse SQL using the generic dialect (legacy compatibility)
pub fn parse_sql(sql: &str) -> Result<Vec<Statement>, ParseError> {
    parse_sql_with_dialect(sql, Dialect::Generic)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_valid_select() {
        let sql = "SELECT * FROM users";
        let result = parse_sql(sql);
        assert!(result.is_ok());
        let statements = result.unwrap();
        assert_eq!(statements.len(), 1);
    }

    #[test]
    fn test_parse_invalid_sql() {
        let sql = "SELECT * FROM";
        let result = parse_sql(sql);
        assert!(result.is_err());
    }

    #[test]
    fn test_parse_multiple_statements() {
        let sql = "SELECT * FROM users; SELECT * FROM orders;";
        let result = parse_sql(sql);
        assert!(result.is_ok());
        let statements = result.unwrap();
        assert_eq!(statements.len(), 2);
    }

    #[test]
    fn test_parse_with_postgres_dialect() {
        let sql = "SELECT * FROM users WHERE name ILIKE '%test%'";
        let result = parse_sql_with_dialect(sql, Dialect::Postgres);
        assert!(result.is_ok());
    }

    #[test]
    fn test_parse_with_snowflake_dialect() {
        let sql = "SELECT * FROM db.schema.table";
        let result = parse_sql_with_dialect(sql, Dialect::Snowflake);
        assert!(result.is_ok());
    }

    #[test]
    fn test_parse_with_bigquery_dialect() {
        let sql = "SELECT * FROM `project.dataset.table`";
        let result = parse_sql_with_dialect(sql, Dialect::Bigquery);
        assert!(result.is_ok());
    }

    #[test]
    fn test_parse_cte() {
        let sql = r#"
            WITH active_users AS (
                SELECT * FROM users WHERE active = true
            )
            SELECT * FROM active_users
        "#;
        let result = parse_sql(sql);
        assert!(result.is_ok());
    }

    #[test]
    fn test_parse_insert_select() {
        let sql = "INSERT INTO archive SELECT * FROM users WHERE deleted = true";
        let result = parse_sql(sql);
        assert!(result.is_ok());
    }

    #[test]
    fn test_parse_create_table_as() {
        let sql = "CREATE TABLE users_backup AS SELECT * FROM users";
        let result = parse_sql(sql);
        assert!(result.is_ok());
    }

    #[test]
    fn test_parse_union() {
        let sql = "SELECT id FROM users UNION ALL SELECT id FROM admins";
        let result = parse_sql(sql);
        assert!(result.is_ok());
    }

    #[test]
    fn test_parse_generic_falls_back_for_postgres_json_operator() {
        let sql = "SELECT usage_metadata ? 'pipeline_id' FROM ledger.usage_line_item";
        let result = parse_sql(sql);
        assert!(result.is_ok());
    }

    #[test]
    fn test_parse_generic_falls_back_for_postgres_cast_operator() {
        let sql = "SELECT workspace_id::text FROM ledger.usage_line_item";
        let result = parse_sql(sql);
        assert!(result.is_ok());
    }

    #[test]
    fn test_parse_output_marks_parser_fallback_usage() {
        let generic = sqlparser::dialect::GenericDialect {};
        let sql = [
            "SELECT usage_metadata ? 'pipeline_id' FROM ledger.usage_line_item",
            "SELECT workspace_id::text FROM ledger.usage_line_item",
            "SELECT payload->>'id' FROM ledger.usage_line_item",
        ]
        .into_iter()
        .find(|candidate| Parser::parse_sql(&generic, candidate).is_err())
        .expect("expected at least one postgres-only candidate to fail in generic parser");

        let output = parse_sql_with_dialect_output(sql, Dialect::Generic).expect("parse");
        assert!(output.parser_fallback_used);
        assert_eq!(output.statements.len(), 1);
    }

    #[test]
    fn test_parse_output_bigquery_escaped_identifier_fallback_usage() {
        let sql = "SELECT `\\`a`.col1 FROM tab1 as `\\`A`";
        let output = parse_sql_with_dialect_output(sql, Dialect::Bigquery).expect("parse");
        assert!(output.parser_fallback_used);
        assert_eq!(output.statements.len(), 1);
    }

    #[test]
    fn test_parse_output_clickhouse_escaped_identifier_fallback_usage() {
        let sql = "SELECT \"\\\"`a`\"\"\".col1,\nFROM tab1 as `\"\\`a``\"`";
        let output = parse_sql_with_dialect_output(sql, Dialect::Clickhouse).expect("parse");
        assert!(output.parser_fallback_used);
        assert_eq!(output.statements.len(), 1);
    }

    #[test]
    fn test_parse_output_trailing_comma_before_from_fallback_usage() {
        let sql = "SELECT widget.id,\nwidget.name,\nFROM widget";
        let output = parse_sql_with_dialect_output(sql, Dialect::Ansi).expect("parse");
        assert!(output.parser_fallback_used);
        assert_eq!(output.statements.len(), 1);
    }

    #[test]
    fn test_remove_trailing_comma_before_from_preserves_utf8() {
        let sql = "SELECT café,\nFROM résumé";
        let rewritten = remove_trailing_comma_before_from(sql);
        assert_eq!(rewritten, "SELECT café\nFROM résumé");
    }

    #[test]
    fn test_sanitize_escaped_identifiers_preserves_utf8() {
        let sql = "SELECT naïve, `\\`id` FROM café";
        let rewritten =
            sanitize_escaped_identifiers_for_dialect(sql, Dialect::Bigquery).expect("rewrite");
        assert_eq!(rewritten, "SELECT naïve, `_id` FROM café");
    }

    #[test]
    fn test_parse_output_ansi_national_literal_spacing_fallback_usage() {
        let sql = "SELECT a + N 'b' + N 'c' FROM tbl;";
        let output = parse_sql_with_dialect_output(sql, Dialect::Ansi).expect("parse");
        assert!(output.parser_fallback_used);
        assert_eq!(output.statements.len(), 1);
    }

    #[test]
    fn test_parse_output_bigquery_raw_double_quoted_literal_fallback_usage() {
        let sql = r#"SELECT r'Tricky "quote', r"Not-so-tricky \"quote""#;
        let output = parse_sql_with_dialect_output(sql, Dialect::Bigquery).expect("parse");
        assert!(output.parser_fallback_used);
        assert_eq!(output.statements.len(), 1);
    }

    #[test]
    fn test_hive_spark_sanitize_left_anti_join() {
        // LEFT ANTI JOIN is not supported by sqlparser-rs; sanitize rewrites to LEFT JOIN
        let sql = "SELECT a.id FROM t1 a LEFT ANTI JOIN t2 b ON a.id = b.id";
        let output = parse_sql_with_dialect_output(sql, Dialect::Generic);
        // Should parse (either directly or via fallback)
        assert!(output.is_ok(), "Failed to parse LEFT ANTI JOIN SQL");
    }

    #[test]
    fn test_hive_spark_sanitize_cache_table() {
        let sql = "CACHE TABLE Temp_X OPTIONS ('storageLevel' 'DISK_ONLY');\nSELECT * FROM users;";
        let output = parse_sql_with_dialect_output(sql, Dialect::Generic);
        assert!(output.is_ok(), "Failed to parse CACHE TABLE SQL");
    }

    #[test]
    fn test_hive_spark_sanitize_hash_comments() {
        let sql = "# this is a comment\nSELECT 1;";
        let output = parse_sql_with_dialect_output(sql, Dialect::Generic);
        assert!(output.is_ok(), "Failed to parse # comment SQL");
    }

    #[test]
    fn test_hive_spark_sanitize_uncache() {
        let sql = "UNCACHE TABLE IF EXISTS Temp_X;\nSELECT 1;";
        let output = parse_sql_with_dialect_output(sql, Dialect::Generic);
        assert!(output.is_ok(), "Failed to parse UNCACHE TABLE SQL");
    }

    #[test]
    fn test_hive_spark_sanitize_left_anti_join_combined() {
        // Multiple Spark patterns in one SQL - must not fail
        let sql = "\
# comment block
CACHE TABLE Temp_X OPTIONS ('storageLevel' 'DISK_ONLY');
SELECT a.id FROM t1 a LEFT ANTI JOIN t2 b ON a.id = b.id;
UNCACHE TABLE IF EXISTS Temp_X;
SELECT * FROM t1;";
        let output = parse_sql_with_dialect_output(sql, Dialect::Generic);
        assert!(output.is_ok(), "Failed to parse combined Spark SQL: {:?}", output.err());
    }

    #[test]
    fn test_parse_output_without_fallback() {
        let sql = "SELECT 1";
        let output = parse_sql_with_dialect_output(sql, Dialect::Generic).expect("parse");
        assert!(!output.parser_fallback_used);
        assert_eq!(output.statements.len(), 1);
    }

    #[test]
    fn test_spark_sql_mixed_patterns_databricks() {
        // Simulate the user's real Spark SQL: CACHE TABLE, UNCACHE TABLE, LEFT ANTI JOIN,
        // temp table references, INSERT INTO physical table.
        let sql = "\
UNCACHE TABLE IF EXISTS Temp_All_Subs_Existed;
CACHE TABLE Temp_All_Subs_Existed OPTIONS ('storageLevel' 'DISK_ONLY');
SELECT a.subs_id, a.acc_nbr
FROM Temp_All_Subs_Existed a
LEFT ANTI JOIN smartfren_analytic_prd.dwh_cc.f_subs_order_movement b
    ON b.subs_id = a.subs_id;
INSERT INTO smartfren_analytic_prd.stg_cc.f_smartfren_active_master_l3_fu_traffic
SELECT subs_id, acc_nbr FROM Temp_All_Subs_Existed;
# this is a hash comment
SELECT * FROM smartfren_analytic_prd.dwh_cc.f_usage_cdr;
";

        // Test with Databricks dialect (should work via sanitize)
        let output = parse_sql_with_dialect_output(sql, Dialect::Databricks);
        assert!(output.is_ok(), "Databricks parse failed: {:?}", output.err());

        // Test with Generic dialect (should also work via sanitize)
        let output = parse_sql_with_dialect_output(sql, Dialect::Generic);
        assert!(output.is_ok(), "Generic parse failed: {:?}", output.err());
    }

    #[test]
    fn test_bigquery_procedure_sanitize_simple() {
        let sql = "\
CREATE OR REPLACE PROCEDURE my_dataset.my_proc(x INT64)
BEGIN
  DECLARE v INT64;
  SET v = x + 1;
  INSERT INTO dst_table SELECT * FROM src_table WHERE id = v;
END;";
        let output = parse_sql_with_dialect_output(sql, Dialect::Bigquery);
        assert!(output.is_ok(), "BigQuery procedure parse failed: {:?}", output.err());
        assert!(output.unwrap().parser_fallback_used);
    }

    #[test]
    fn test_bigquery_procedure_sanitize_multiple_dml() {
        let sql = "\
CREATE PROCEDURE dataset.proc()
BEGIN
  INSERT INTO t1 SELECT a, b FROM s1;
  DELETE FROM t2 WHERE id IN (SELECT id FROM t1);
  UPDATE t3 SET x = 1 WHERE y = 2;
END;";
        let output = parse_sql_with_dialect_output(sql, Dialect::Bigquery);
        assert!(output.is_ok(), "BigQuery multi-DML parse failed: {:?}", output.err());
    }

    #[test]
    fn test_bigquery_procedure_generic_dialect() {
        let sql = "\
CREATE PROCEDURE ds.foo()
BEGIN
  DECLARE x INT64 DEFAULT 0;
  SELECT a, b FROM my_table WHERE a > x;
END;";
        let output = parse_sql_with_dialect_output(sql, Dialect::Generic);
        assert!(output.is_ok(), "Generic dialect procedure parse failed: {:?}", output.err());
    }

    #[test]
    fn test_bigquery_procedure_nested_begin_end() {
        let sql = "\
CREATE PROCEDURE ds.nested()
BEGIN
  DECLARE i INT64;
  SET i = 0;
  BEGIN
    SELECT * FROM inner_table;
  END;
  INSERT INTO outer_table SELECT * FROM inner_table;
END;";
        let output = parse_sql_with_dialect_output(sql, Dialect::Bigquery);
        assert!(output.is_ok(), "Nested BEGIN..END parse failed: {:?}", output.err());
    }
}

/// Sanitize Hive/Spark SQL: remove CACHE TABLE / UNCACHE TABLE statements,
/// convert `#` comments to `--` comments, and rewrite LEFT ANTI/SEMI JOIN to
/// LEFT JOIN so the parser can handle the input.
fn sanitize_hive_spark_sql(sql: &str) -> Option<String> {
    let mut changed = false;

    // Rewrite LEFT ANTI JOIN / LEFT SEMI JOIN / RIGHT ANTI JOIN / RIGHT SEMI JOIN
    // to LEFT JOIN / RIGHT JOIN (schema-level analysis doesn't depend on join type).
    let mut result = String::new();
    for line in sql.split('\n') {
        let rewritten = rewrite_spark_joins(line);
        if rewritten.as_deref() != Some(line) {
            changed = true;
        }
        result.push_str(rewritten.as_deref().unwrap_or(line));
        result.push('\n');
    }
    // Remove trailing newline added in loop
    result.pop();

    let lines: Vec<&str> = result.split('\n').collect();
    let mut out_lines: Vec<String> = Vec::with_capacity(lines.len());

    for line in &lines {
        let trimmed = line.trim();

        // Convert # comments to -- comments
        if trimmed.starts_with('#') || trimmed.starts_with("---") {
            out_lines.push(format!("-- {}", &trimmed[1..].trim()));
            changed = true;
            continue;
        }

        // Skip CACHE TABLE / UNCACHE TABLE statements
        let upper = trimmed.to_uppercase();
        if upper.starts_with("CACHE TABLE") || upper.starts_with("UNCACHE TABLE") {
            // Comment out the line so it doesn't cause parse errors
            out_lines.push(format!("-- spark: {}", line));
            changed = true;
            continue;
        }

        out_lines.push(line.to_string());
    }

    if changed {
        Some(out_lines.join("\n"))
    } else {
        None
    }
}

/// Rewrite Spark-specific join types to standard SQL join types.
/// LEFT ANTI JOIN → LEFT JOIN, LEFT SEMI JOIN → LEFT JOIN,
/// RIGHT ANTI JOIN → RIGHT JOIN, RIGHT SEMI JOIN → RIGHT JOIN.
fn rewrite_spark_joins(line: &str) -> Option<String> {
    // Quick check to avoid regex overhead for most lines
    let upper = line.to_uppercase();
    if !upper.contains("ANTI JOIN") && !upper.contains("SEMI JOIN") {
        return None;
    }

    use std::sync::LazyLock;
    use regex::Regex;
    static SPARK_JOIN_RE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?i)(LEFT|RIGHT)\s+(ANTI|SEMI)\s+(JOIN)").unwrap()
    });
    Some(SPARK_JOIN_RE.replace_all(line, "$1 JOIN").into_owned())
}
