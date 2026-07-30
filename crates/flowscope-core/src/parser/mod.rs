use crate::error::ParseError;
use crate::types::Dialect;
use sqlparser::ast::Statement;
use sqlparser::dialect::{GenericDialect, PostgreSqlDialect};
use sqlparser::parser::Parser;

/// Result of parsing SQL with fallback metadata.
pub struct ParseSqlOutput {
    pub statements: Vec<Statement>,
    pub parser_fallback_used: bool,
    /// When parser fallback was used (e.g., BigQuery procedure sanitizer),
    /// this contains the sanitized SQL text that was actually parsed.
    /// Callers should use this instead of the original SQL for range computation.
    pub source_sql: Option<String>,
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
        Ok(statements) => {
            // For BigQuery procedures, the parser produces DECLARE/SET statements but
            // often drops INSERT/SELECT DML inside IF blocks. Always use the sanitizer
            // to extract the actual DML/SELECT from the procedure body.
            let is_bq_procedure = (matches!(dialect, Dialect::Bigquery)
                || matches!(dialect, Dialect::Generic))
                && looks_like_bigquery_procedure(sql);

            if is_bq_procedure {
                match sanitize_bigquery_raw_double_quoted_literals(sql) {
                    Some(sanitized_sql) => {
                        match Parser::parse_sql(sqlparser_dialect.as_ref(), &sanitized_sql) {
                            Ok(parsed) => {
                                if !parsed.is_empty() {
                                    return Ok(ParseSqlOutput {
                                        statements: parsed,
                                        parser_fallback_used: true,
                                        source_sql: Some(sanitized_sql),
                                    });
                                }
                            }
                            Err(_) => {}
                        }
                    }
                    None => {}
                }
                // If sanitizer failed, return original statements (at least they have DELETEs)
            }
            Ok(ParseSqlOutput {
                statements,
                parser_fallback_used: false,
                source_sql: None,
            })
        }
        Err(primary_err) => {
            if let Some(sanitized_sql) = sanitize_escaped_identifiers_for_dialect(sql, dialect) {
                if let Ok(statements) =
                    Parser::parse_sql(sqlparser_dialect.as_ref(), &sanitized_sql)
                {
                    return Ok(ParseSqlOutput {
                        statements,
                        parser_fallback_used: true,
                        source_sql: None,
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
                        source_sql: None,
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
                            source_sql: None,
                        });
                    }
                }
            }

            if matches!(dialect, Dialect::Bigquery)
                || (matches!(dialect, Dialect::Generic) && looks_like_bigquery_procedure(sql))
            {
                match sanitize_bigquery_raw_double_quoted_literals(sql) {
                    Some(sanitized_sql) => {
                        // Try Generic dialect first — the sanitized output contains standard
                        // DML (DELETE, INSERT…SELECT) and the BigQuery dialect may choke on
                        // CASE WHEN or other expressions.
                        let generic = GenericDialect {};
                        let parsed = Parser::parse_sql(&generic, &sanitized_sql).or_else(|_| {
                            Parser::parse_sql(sqlparser_dialect.as_ref(), &sanitized_sql)
                        });
                        if let Ok(statements) = parsed {
                            if !statements.is_empty() {
                                return Ok(ParseSqlOutput {
                                    statements,
                                    parser_fallback_used: true,
                                    source_sql: Some(sanitized_sql),
                                });
                            }
                        }
                    }
                    None => {}
                }
            }

            // ClickHouse sanitizer: strip FINAL keyword + CREATE TABLE engine clauses
            if matches!(dialect, Dialect::Clickhouse) || matches!(dialect, Dialect::Generic) {
                if let Some(sanitized_sql) = sanitize_clickhouse_sql(sql) {
                    if let Ok(statements) =
                        Parser::parse_sql(sqlparser_dialect.as_ref(), &sanitized_sql)
                    {
                        return Ok(ParseSqlOutput {
                            statements,
                            parser_fallback_used: true,
                            source_sql: Some(sanitized_sql),
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
                            source_sql: None,
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
                        source_sql: None,
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

/// Detects whether SQL text is a stored procedure (CREATE PROCEDURE / CREATE PROC).
/// Works across dialects (BigQuery, TSQL, MySQL, Oracle, etc.).
pub fn looks_like_stored_procedure(sql: &str) -> bool {
    let upper = sql.to_uppercase();
    if let Some(pos) = upper.find("PROCEDURE") {
        if upper[..pos].trim_end().ends_with("CREATE")
            || upper[..pos].trim_end().ends_with("REPLACE")
        {
            return true;
        }
    }
    // TSQL: CREATE PROC / CREATE OR ALTER PROC
    if let Some(pos) = upper.find("PROC ") {
        if upper[..pos].trim_end().ends_with("CREATE")
            || upper[..pos].trim_end().ends_with("REPLACE")
            || upper[..pos].trim_end().ends_with("ALTER")
        {
            return true;
        }
    }
    false
}

fn looks_like_bigquery_procedure(sql: &str) -> bool {
    // Case 1: Generic CREATE PROCEDURE detection (uses the common detector)
    if looks_like_stored_procedure(sql) {
        return true;
    }
    // Case 2: Standalone BEGIN...END block with DECLARE (BQ procedure body without header)
    let trimmed = sql.trim_start();
    let upper_trimmed = trimmed.to_uppercase();
    if upper_trimmed.starts_with("BEGIN")
        && is_word_boundary(trimmed.as_bytes(), 0, 5)
        && upper_trimmed.ends_with("END")
        && upper_trimmed.contains("DECLARE")
    {
        return true;
    }
    false
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

/// Strip ClickHouse `FINAL` keyword from table references.
///
/// ClickHouse DDL allows `FROM table_name FINAL alias` but sqlparser-rs does not
/// recognize FINAL as a keyword. This strips it so the parser can proceed.
/// Sanitize ClickHouse SQL: strip FINAL keyword + CREATE TABLE engine clauses.
fn sanitize_clickhouse_sql(sql: &str) -> Option<String> {
    let mut result = strip_clickhouse_create_table_clauses(sql);
    if let Some(ref mut s) = result {
        if let Some(stripped) = strip_clickhouse_final(s) {
            *s = stripped;
        }
    } else {
        result = strip_clickhouse_final(sql);
    }
    result
}

/// Strip ClickHouse CREATE TABLE clauses: ENGINE, PARTITION BY, ORDER BY,
/// SETTINGS, TTL, SAMPLE BY that appear after the closing `)` of the column list.
fn strip_clickhouse_create_table_clauses(sql: &str) -> Option<String> {
    let upper = sql.to_uppercase();
    if !upper.contains("ENGINE") && !upper.contains("PARTITION BY") {
        return None;
    }
    let lines: Vec<&str> = sql.lines().collect();
    let mut out: Vec<&str> = Vec::new();
    let mut changed = false;
    let mut paren_depth: i32 = 0;
    let mut in_create_table = false;

    for line in &lines {
        let trimmed = line.trim();
        let trimmed_upper = trimmed.to_uppercase();

        // Track parenthesis depth for CREATE TABLE column lists
        paren_depth += line.matches('(').count() as i32 - line.matches(')').count() as i32;

        // Detect CREATE TABLE start
        if trimmed_upper.starts_with("CREATE") && trimmed_upper.contains("TABLE") {
            in_create_table = true;
        }

        // After CREATE TABLE's closing `)`, strip ClickHouse engine clauses
        if in_create_table && paren_depth <= 0 {
            if trimmed_upper.starts_with("ENGINE")
                || trimmed_upper.starts_with("PARTITION BY")
                || trimmed_upper.starts_with("ORDER BY")
                || trimmed_upper.starts_with("SETTINGS")
                || trimmed_upper.starts_with("TTL")
                || trimmed_upper.starts_with("SAMPLE BY")
                || trimmed_upper.starts_with("PRIMARY KEY")
            {
                changed = true;
                continue;
            }
            // End of CREATE TABLE statement
            if trimmed.ends_with(';') {
                in_create_table = false;
            }
        }

        out.push(line);
    }

    if changed {
        Some(out.join("\n"))
    } else {
        None
    }
}

fn strip_clickhouse_final(sql: &str) -> Option<String> {
    // Case-insensitive check for the keyword FINAL
    if !sql.to_uppercase().contains("FINAL") {
        return None;
    }
    let bytes = sql.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    let mut changed = false;
    while i < bytes.len() {
        if bytes[i] == b'F' || bytes[i] == b'f' {
            let remaining = &bytes[i..];
            if remaining.len() >= 5
                && remaining[0].eq_ignore_ascii_case(&b'F')
                && remaining[1].eq_ignore_ascii_case(&b'I')
                && remaining[2].eq_ignore_ascii_case(&b'N')
                && remaining[3].eq_ignore_ascii_case(&b'A')
                && remaining[4].eq_ignore_ascii_case(&b'L')
                && (i == 0 || bytes[i - 1].is_ascii_whitespace())
            {
                let after = remaining.get(5);
                let is_end = after.is_none()
                    || after == Some(&b')')
                    || after.map_or(false, |b| b.is_ascii_whitespace());
                if is_end {
                    i += 5;
                    changed = true;
                    // Skip trailing whitespace after FINAL
                    while i < bytes.len() && bytes[i].is_ascii_whitespace() {
                        i += 1;
                    }
                    // Put back a space between the tokens separated by FINAL
                    if !out.is_empty() && i < bytes.len() && bytes[i] != b')' {
                        out.push(b' ');
                    }
                    continue;
                }
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    if changed {
        Some(String::from_utf8_lossy(&out).to_string())
    } else {
        None
    }
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

/// BigQuery identifiers may contain hyphens (e.g., `my-project.dataset.table`),
/// but sqlparser-rs's BigQuery dialect treats unquoted hyphens as minus signs.
/// Wrap each identifier segment that contains a hyphen in backticks.
fn backtick_quote_hyphenated_identifiers(sql: &str) -> String {
    let bytes = sql.as_bytes();
    let mut out = String::with_capacity(sql.len() + 32);
    let mut i = 0;
    let mut in_backtick = false;
    let mut in_single = false;
    let mut in_double = false;
    let mut in_line_comment = false;
    let mut in_block_comment = false;

    while i < bytes.len() {
        let b = bytes[i];

        // Track string/comment states
        if !in_single && !in_double && !in_backtick && !in_line_comment && !in_block_comment {
            if b == b'`' {
                in_backtick = true;
                out.push(b as char);
                i += 1;
                continue;
            }
            if b == b'\'' {
                in_single = true;
                out.push(b as char);
                i += 1;
                continue;
            }
            if b == b'"' {
                in_double = true;
                out.push(b as char);
                i += 1;
                continue;
            }
            if b == b'-' && i + 1 < bytes.len() && bytes[i + 1] == b'-' {
                in_line_comment = true;
                out.push(b as char);
                i += 1;
                continue;
            }
            if b == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'*' {
                in_block_comment = true;
                out.push(b as char);
                i += 1;
                continue;
            }
            // If this is a letter (start of an identifier), collect the full word
            if b.is_ascii_alphabetic() || b == b'_' {
                let start = i;
                while i < bytes.len() {
                    let c = bytes[i];
                    if c.is_ascii_alphanumeric() || c == b'_' || c == b'-' {
                        i += 1;
                    } else {
                        break;
                    }
                }
                let word = &sql[start..i];
                if word.contains('-') {
                    out.push('`');
                    out.push_str(word);
                    out.push('`');
                } else {
                    out.push_str(word);
                }
                continue;
            }
        } else if in_single {
            if b == b'\'' {
                in_single = false;
            }
        } else if in_double {
            if b == b'"' {
                in_double = false;
            }
        } else if in_backtick {
            if b == b'`' {
                in_backtick = false;
            }
        } else if in_line_comment {
            if b == b'\n' {
                in_line_comment = false;
            }
        } else if in_block_comment {
            if b == b'*' && i + 1 < bytes.len() && bytes[i + 1] == b'/' {
                out.push(b as char);
                out.push('/');
                i += 2;
                in_block_comment = false;
                continue;
            }
        }

        out.push(b as char);
        i += 1;
    }
    out
}

/// Sanitize BigQuery stored procedures: extract DML/SELECT from BEGIN...END body.
fn sanitize_bigquery_procedure(sql: &str) -> Option<String> {
    let upper = sql.to_uppercase();

    // Case 1: CREATE [OR REPLACE] PROCEDURE ... BEGIN ... END;
    if let Some(proc_pos) = upper.find("PROCEDURE") {
        let before_proc = upper[..proc_pos].trim_end();
        if before_proc.ends_with("CREATE") || before_proc.ends_with("REPLACE") {
            if let Some(begin_idx) = upper[proc_pos..].find("BEGIN").map(|i| proc_pos + i) {
                return extract_begin_end_body(sql, &upper, begin_idx)
                    .map(|body| backtick_quote_hyphenated_identifiers(&body));
            }
        }
    }

    // Case 2: Standalone BEGIN...END block (procedure body without header)
    let trimmed_start = sql.trim_start();
    let upper_trimmed = trimmed_start.to_uppercase();
    if upper_trimmed.starts_with("BEGIN") && is_word_boundary(trimmed_start.as_bytes(), 0, 5) {
        let offset = sql.len() - trimmed_start.len();
        return extract_begin_end_body(sql, &upper, offset);
    }

    None
}

/// Check if the bytes after END start with a control-flow keyword (IF, WHILE, LOOP),
/// meaning this END belongs to a control-flow block, not a procedure-level END.
fn is_control_flow_end(after_end: &[u8]) -> bool {
    let mut i = 0;
    while i < after_end.len() && after_end[i].is_ascii_whitespace() {
        i += 1;
    }
    let rest = &after_end[i..];
    rest.len() >= 2
        && (rest[..2].eq_ignore_ascii_case(b"IF")
            || rest.len() >= 5 && rest[..5].eq_ignore_ascii_case(b"WHILE")
            || rest.len() >= 4 && rest[..4].eq_ignore_ascii_case(b"LOOP"))
}

/// Check that after END (skipping whitespace), the next character is `;`.
/// This prevents matching `END,` (CASE WHEN expression) or `END)` as a
/// procedure-level END.
fn is_end_followed_by_semicolon(after_end: &[u8]) -> bool {
    let mut i = 0;
    while i < after_end.len() && after_end[i].is_ascii_whitespace() {
        i += 1;
    }
    // Allow single-line comment before the semicolon
    if i + 1 < after_end.len() && after_end[i] == b'-' && after_end[i + 1] == b'-' {
        // Skip to end of line
        while i < after_end.len() && after_end[i] != b'\n' {
            i += 1;
        }
        while i < after_end.len() && after_end[i].is_ascii_whitespace() {
            i += 1;
        }
    }
    i >= after_end.len() || after_end[i] == b';'
}

/// Extract DML/SELECT from a BEGIN...END body starting at begin_idx
fn extract_begin_end_body(sql: &str, upper: &str, begin_idx: usize) -> Option<String> {
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
            // Skip multi-byte UTF-8 characters to avoid mid-character slicing panic
            if c >= 0x80 {
                i += if c >= 0xF0 {
                    4
                } else if c >= 0xE0 {
                    3
                } else {
                    2
                };
                continue;
            }
            if c == b'-' && i + 1 < bytes.len() && bytes[i + 1] == b'-' {
                in_line_comment = true;
                i += 2;
                continue;
            }
            if c == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'*' {
                in_block_comment = true;
                i += 2;
                continue;
            }
            if c == b'\'' || c == b'"' || c == b'`' {
                in_string = true;
                string_char = c;
            }
        } else if in_string {
            if c == b'\\' && i + 1 < bytes.len() && string_char != b'`' {
                i += 2;
                continue;
            }
            if c == string_char {
                in_string = false;
            }
        } else if in_line_comment {
            if c == b'\n' {
                in_line_comment = false;
            }
            i += 1;
            continue;
        } else if in_block_comment {
            if c == b'*' && i + 1 < bytes.len() && bytes[i + 1] == b'/' {
                in_block_comment = false;
                i += 2;
                continue;
            }
            i += 1;
            continue;
        }
        if !in_string && !in_line_comment && !in_block_comment {
            if i + 5 <= bytes.len()
                && upper[i..].starts_with("BEGIN")
                && is_word_boundary(bytes, i, 5)
                && is_leading_word_boundary(bytes, i)
            {
                depth += 1;
            }
            if i + 3 <= bytes.len()
                && upper[i..].starts_with("END")
                && is_word_boundary(bytes, i, 3)
                && is_leading_word_boundary(bytes, i)
            {
                // Distinguish END IF / END WHILE / END LOOP from procedure-level END
                if is_control_flow_end(&bytes[i + 3..]) {
                    i += 3;
                    continue;
                }
                // Skip END that is not followed by `;` or `--` comment — it's
                // likely a CASE WHEN expression like `END,` or `END)`.
                if !is_end_followed_by_semicolon(&bytes[i + 3..]) {
                    i += 3; // advance past this END keyword
                    continue;
                }
                if depth == 0 {
                    body_end = i;
                    break;
                }
                depth -= 1;
            }
        }
        i += 1;
    }
    if body_end <= body_start {
        body_end = sql.len();
    }
    let body = &sql[body_start..body_end];
    if body.trim().is_empty() {
        return None;
    }

    // Remove block comments entirely (/* ... */ → removed)
    let body_uncommented = strip_block_comments(body);

    let statements = split_sql_statements(&body_uncommented);
    let mut out = String::with_capacity(body.len());
    let mut has_any = false;
    for stmt in &statements {
        let trimmed = stmt.trim();
        if trimmed.is_empty() {
            continue;
        }

        // Skip leading single-line comments (lines starting with "--") so that
        // statements like:
        //     -- Truncate temporary tables
        //     TRUNCATE TABLE ...
        // are correctly identified by their DML keyword.
        let content = {
            let mut s = trimmed;
            loop {
                let ss = s.trim_start();
                if ss.starts_with("--") {
                    // Skip to end of this comment line
                    if let Some(nl) = ss.find('\n') {
                        s = &ss[nl..];
                    } else {
                        break; // entire statement is a comment, drop it
                    }
                } else {
                    break;
                }
            }
            s.trim()
        };
        if content.is_empty() {
            continue;
        }

        let upper_stmt = content.to_uppercase();
        let first_word = upper_stmt.split_whitespace().next().unwrap_or("");
        match first_word {
            "DECLARE" | "IF" | "ELSE" | "ELSEIF" | "WHILE" | "LOOP" | "FOR" | "BREAK"
            | "CONTINUE" | "RETURN" | "RAISE" | "BEGIN" | "END" | "CALL" | "DROP" | "ALTER"
            | "GRANT" | "REVOKE" => {}
            "SET" => {
                // SET variable = "SQL text" — extract the SQL if it contains DML keywords
                if let Some(sql_text) = extract_sql_from_set_stmt(trimmed) {
                    let uw = sql_text.to_uppercase();
                    let fw = uw.split_whitespace().next().unwrap_or("");
                    match fw {
                        "SELECT" | "INSERT" | "DELETE" | "MERGE" | "TRUNCATE" | "WITH"
                        | "CREATE" => {
                            out.push_str(&sql_text);
                            if !sql_text.ends_with(';') {
                                out.push(';');
                            }
                            out.push('\n');
                            has_any = true;
                        }
                        _ => {}
                    }
                }
            }
            "EXECUTE" | "EXEC" => {
                // Extract SQL from EXECUTE IMMEDIATE FORMAT("""...""", ...)
                if let Some(inner) = extract_execute_immediate_sql(trimmed) {
                    for inner_stmt in split_sql_statements(&inner) {
                        let s = inner_stmt.trim();
                        if s.is_empty() {
                            continue;
                        }
                        let uw = s.to_uppercase();
                        let fw = uw.split_whitespace().next().unwrap_or("");
                        match fw {
                            "SELECT" | "INSERT" | "DELETE" | "MERGE" | "TRUNCATE" | "WITH"
                            | "CREATE" => {
                                out.push_str(s);
                                if !s.ends_with(';') {
                                    out.push(';');
                                }
                                out.push('\n');
                                has_any = true;
                            }
                            _ => {}
                        }
                    }
                }
            }
            "CREATE" => {
                let words: Vec<&str> = upper_stmt.split_whitespace().collect();
                // Match AS SELECT, AS (SELECT, or AS WITH ... SELECT (CTE)
                let has_as_select = words.windows(2).any(|w| w[0] == "AS" && (w[1] == "SELECT" || w[1] == "(SELECT"))
                    || words.windows(2).any(|w| w[0] == "AS" && w[1] == "WITH")
                    || (upper_stmt.contains(" AS ") && upper_stmt.contains("SELECT"));
                if has_as_select {
                    out.push_str(content);
                    if !content.ends_with(';') {
                        out.push(';');
                    }
                    out.push('\n');
                    has_any = true;
                }
            }
            "SELECT" | "INSERT" | "DELETE" | "MERGE" | "TRUNCATE" | "WITH" | "UPDATE" => {
                out.push_str(content);
                if !content.ends_with(';') {
                    out.push(';');
                }
                out.push('\n');
                has_any = true;
            }
            _ => {}
        }
    }
    // Remove standalone -- comment lines and empty lines from output
    let filtered: Vec<&str> = out.lines().filter(|l| {
        let t = l.trim();
        !t.is_empty() && !t.starts_with("--")
    }).collect();
    if filtered.is_empty() {
        return None;
    }
    let mut clean = filtered.join("\n");
    clean.push('\n');
    has_any.then_some(clean)
}

fn is_word_boundary(bytes: &[u8], i: usize, word_len: usize) -> bool {
    let next = i + word_len;
    if next >= bytes.len() {
        return true;
    }
    matches!(
        bytes[next],
        b' ' | b'\t' | b'\n' | b'\r' | b';' | b'(' | b')' | b',' | b'.'
    )
}

/// Check that the character before position `i` is not an identifier character
/// (alphanumeric or underscore). Used to prevent matching `v_END` as keyword `END`.
fn is_leading_word_boundary(bytes: &[u8], i: usize) -> bool {
    i == 0 || !bytes[i - 1].is_ascii_alphanumeric() && bytes[i - 1] != b'_'
}

/// Extract the inner SQL string from EXECUTE IMMEDIATE statements.
/// Supports patterns:
///   EXECUTE IMMEDIATE 'SQL'
///   EXECUTE IMMEDIATE """SQL"""
///   EXECUTE IMMEDIATE FORMAT("""SQL""", ...)
fn extract_execute_immediate_sql(s: &str) -> Option<String> {
    let upper = s.to_uppercase();
    // Skip past "EXECUTE IMMEDIATE "
    let after_keyword = upper.find("IMMEDIATE").map(|i| i + 9)?;
    let rest = &s[after_keyword..].trim_start();
    if rest.is_empty() {
        return None;
    }

    // Case 1: FORMAT("""...""", ...) or FORMAT(...)
    if rest.to_uppercase().starts_with("FORMAT") {
        let after = &rest[6..].trim_start();
        let after = if after.starts_with('(') {
            &after[1..].trim_start()
        } else {
            after
        };
        let (q, qlen) = pick_quote(after)?;
        let inner = extract_between_quotes(after, q, qlen)?;
        return Some(inner);    }

    // Case 2: """...""" or '''...''' (direct triple-quoted string, no FORMAT)
    if let Some(inner) = extract_triple_quoted(rest) {
        return Some(inner);    }

    // Case 3: '...' or "..." (direct single-quoted string, no FORMAT)
    let (q, qlen) = pick_quote(rest)?;
    extract_between_quotes(rest, q, qlen)
}

/// Pick the quote type (triple/single) at the start of text
fn pick_quote(text: &str) -> Option<(&str, usize)> {
    if text.starts_with("\"\"\"") {
        Some(("\"\"\"", 3))
    } else if text.starts_with("'''") {
        Some(("'''", 3))
    } else if text.starts_with('"') {
        Some(("\"", 1))
    } else if text.starts_with('\'') {
        Some(("'", 1))
    } else {
        None
    }
}

/// Extract text between opening and closing quotes
fn extract_between_quotes(text: &str, q: &str, qlen: usize) -> Option<String> {
    let bytes = text.as_bytes();
    let mut pos = qlen;
    while pos + qlen <= bytes.len() {
        if &bytes[pos..pos + qlen] == q.as_bytes() {
            return Some(text[qlen..pos].to_string());
        }
        pos += 1;
    }
    None
}

/// Extract from """...""" or '''...''' at the start
fn extract_triple_quoted(text: &str) -> Option<String> {
    let (q, qlen) = if text.starts_with("\"\"\"") {
        ("\"\"\"", 3)
    } else if text.starts_with("'''") {
        ("'''", 3)
    } else {
        return None;
    };
    extract_between_quotes(text, q, qlen)
}

/// Replace BigQuery FORMAT() placeholders with dummy literal values
/// for lineage parsing purposes. %% → %, %d → 0, %s → x, %t → 2024-01-01, etc.
/// Note: values are WITHOUT quotes — the original template already provides them (e.g. '%t')
fn replace_format_placeholders(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 1 < bytes.len() {
            match bytes[i + 1] {
                b'%' => {
                    out.push('%');
                    i += 2;
                    continue;
                }
                b'd' | b'i' | b'u' | b'o' | b'x' | b'X' => {
                    out.push('0');
                    i += 2;
                    continue;
                }
                b's' | b'S' => {
                    out.push('x');
                    i += 2;
                    continue;
                }
                b'f' | b'F' | b'e' | b'E' | b'g' | b'G' => {
                    out.push('0');
                    out.push('.');
                    out.push('0');
                    i += 2;
                    continue;
                }
                b'c' => {
                    out.push('x');
                    i += 2;
                    continue;
                }
                b't' | b'T' => {
                    out.push_str("2024-01-01");
                    i += 2;
                    continue;
                }
                _ => {}
            }
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out
}

/// Extract SQL text from a SET variable = "SQL string..." statement.
/// Returns the SQL content if the value string contains DML keywords.
fn extract_sql_from_set_stmt(s: &str) -> Option<String> {
    let eq_pos = s.find('=')?;
    let after_eq = s[eq_pos + 1..].trim_start();
    if after_eq.is_empty() {
        return None;
    }
    // Handle SET var = FORMAT("""...""", ...)
    let upper = after_eq.to_uppercase();
    if upper.starts_with("FORMAT") {
        let after = &after_eq[6..].trim_start();
        let after = if after.starts_with('(') {
            &after[1..].trim_start()
        } else {
            after
        };
        let (q, qlen) = pick_quote(after)?;
        let inner = extract_between_quotes(after, q, qlen)?;
        let upper_inner = inner.to_uppercase();
        let first_word = upper_inner.split_whitespace().next()?;
        return matches!(
            first_word,
            "SELECT" | "INSERT" | "DELETE" | "MERGE" | "TRUNCATE" | "WITH" | "CREATE" | "EXPLAIN"
        )
        .then_some(inner.trim().to_string());
    }
    // Handle SET var = 'SQL' or SET var = "SQL"
    // Only extract from triple-quoted strings — single-quoted values
    // are typically descriptions, not SQL.
    if after_eq.starts_with("\"\"\"") || after_eq.starts_with("'''") {
        if let Some(inner) = extract_triple_quoted(after_eq) {
            let upper = inner.to_uppercase();
            let first_word = upper.split_whitespace().next()?;
            return matches!(
                first_word,
                "SELECT" | "INSERT" | "DELETE" | "MERGE" | "TRUNCATE" | "WITH" | "CREATE" | "EXPLAIN"
            )
            .then_some(inner.trim().to_string());
        }
    }
    None
}

/// Remove /* ... */ markers, keeping the inner content.
fn strip_block_comments(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    let mut in_s = false;
    let mut in_d = false;
    let mut in_b = false;
    while i < bytes.len() {
        let c = bytes[i];
        if !in_s && !in_d && !in_b {
            if c == b'-' && i + 1 < bytes.len() && bytes[i + 1] == b'-' {
                let mut j = i + 2;
                while j < bytes.len() && bytes[j] != b'\n' {
                    j += 1;
                }
                out.push_str(&s[i..j]);
                i = j;
                continue;
            }
            if c == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'*' {
                // Skip entire block comment (do NOT uncomment content)
                i += 2;
                while i + 1 < bytes.len() {
                    if bytes[i] == b'*' && bytes[i + 1] == b'/' {
                        i += 2;
                        break;
                    }
                    i += 1;
                }
                continue;
            }
            if c == b'\'' {
                in_s = true;
            } else if c == b'"' {
                in_d = true;
            } else if c == b'`' {
                in_b = true;
            }
        } else if in_s {
            if c == b'\'' {
                if i + 1 < bytes.len() && bytes[i + 1] == b'\'' {
                    out.push(c as char);
                    out.push(bytes[i + 1] as char);
                    i += 2;
                    continue;
                }
                in_s = false;
            }
        } else if in_d {
            if c == b'"' {
                if i + 1 < bytes.len() && bytes[i + 1] == b'"' {
                    out.push(c as char);
                    out.push(bytes[i + 1] as char);
                    i += 2;
                    continue;
                }
                in_d = false;
            }
        } else if in_b {
            if c == b'`' {
                in_b = false;
            }
        }
        out.push(c as char);
        i += 1;
    }
    out
}

fn split_sql_statements(body: &str) -> Vec<String> {
    let mut result = Vec::new();
    let mut current = String::new();
    let mut in_s = false;
    let mut in_d = false;
    let mut in_b = false;
    let mut in_trip_s = false;
    let mut in_trip_d = false;
    let mut in_lc = false;
    let mut in_bc = false;
    let bytes = body.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        // Triple-quoted string start (must check before single/double quote logic)
        if !in_s && !in_d && !in_b && !in_trip_s && !in_trip_d && !in_lc && !in_bc {
            if c == b'\'' && i + 2 < bytes.len() && bytes[i + 1] == b'\'' && bytes[i + 2] == b'\'' {
                in_trip_s = true;
                current.push_str("'''");
                i += 3;
                continue;
            }
            if c == b'"' && i + 2 < bytes.len() && bytes[i + 1] == b'"' && bytes[i + 2] == b'"' {
                in_trip_d = true;
                current.push_str("\"\"\"");
                i += 3;
                continue;
            }
        }
        if !in_s && !in_d && !in_b && !in_trip_s && !in_trip_d && !in_lc && !in_bc {
            if c == b'-' && i + 1 < bytes.len() && bytes[i + 1] == b'-' {
                in_lc = true;
                current.push_str("--");
                i += 2;
                continue;
            }
            if c == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'*' {
                in_bc = true;
                current.push_str("/*");
                i += 2;
                continue;
            }
            if c == b'\'' {
                in_s = true;
            } else if c == b'"' {
                in_d = true;
            } else if c == b'`' {
                in_b = true;
            } else if c == b';' {
                result.push(current);
                current = String::new();
                i += 1;
                continue;
            }
        } else if in_s {
            if c == b'\\' && i + 1 < bytes.len() {
                current.push(bytes[i] as char);
                current.push(bytes[i + 1] as char);
                i += 2;
                continue;
            }
            if c == b'\'' {
                in_s = false;
            }
        } else if in_d {
            if c == b'\\' && i + 1 < bytes.len() {
                current.push(bytes[i] as char);
                current.push(bytes[i + 1] as char);
                i += 2;
                continue;
            }
            if c == b'"' {
                in_d = false;
            }
        } else if in_b {
            if c == b'`' {
                in_b = false;
            }
        } else if in_trip_s {
            if c == b'\'' && i + 2 < bytes.len() && bytes[i + 1] == b'\'' && bytes[i + 2] == b'\'' {
                in_trip_s = false;
                current.push_str("'''");
                i += 3;
                continue;
            }
        } else if in_trip_d {
            if c == b'"' && i + 2 < bytes.len() && bytes[i + 1] == b'"' && bytes[i + 2] == b'"' {
                in_trip_d = false;
                current.push_str("\"\"\"");
                i += 3;
                continue;
            }
        } else if in_lc {
            if c == b'\n' {
                in_lc = false;
            }
        } else if in_bc {
            if c == b'*' && i + 1 < bytes.len() && bytes[i + 1] == b'/' {
                in_bc = false;
                current.push_str("*/");
                i += 2;
                continue;
            }
        }
        current.push(c as char);
        i += 1;
    }
    let trimmed = current.trim().to_string();
    if !trimmed.is_empty() {
        result.push(trimmed);
    }
    result
}

pub fn sanitize_bigquery_raw_double_quoted_literals(sql: &str) -> Option<String> {
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

/// Returns the DML and a line map: for each original line index, the
/// corresponding extracted DML line index (or -1 if no match). This lets
/// frontends align original and extracted lines without client-side matching.
pub fn sanitize_with_line_map(sql: &str) -> Option<(String, Vec<i32>)> {
    let dml = sanitize_bigquery_raw_double_quoted_literals(sql)?;
    let original_lines: Vec<&str> = sql.lines().collect();
    let dml_lines: Vec<&str> = dml.lines().collect();

    let begin_line = original_lines
        .iter()
        .position(|l| {
            let upper = l.to_uppercase();
            upper.trim_start().starts_with("BEGIN")
                && (upper.len() == 5
                    || !upper[5..].chars().next().unwrap().is_alphanumeric())
        })
        .unwrap_or(0);

    let skip_words: std::collections::HashSet<&str> =
        ["END;", "BEGIN", ";", ");"].iter().cloned().collect();

    // Filter DML lines to exclude fragments that will never match
    // (separators like ) on their own line inside expressions)
    let dml_keep: Vec<(usize, bool)> = dml_lines
        .iter()
        .enumerate()
        .map(|(i, l)| {
            let t = l.trim();
            (i, !t.is_empty() && !skip_words.contains(t))
        })
        .collect();

    let mut line_map = vec![-1i32; original_lines.len()];
    let mut dml_idx = 0;

    // Advance dml_idx past any initial skip-words
    while dml_idx < dml_keep.len() && !dml_keep[dml_idx].1 {
        dml_idx += 1;
    }

    for orig_idx in begin_line..original_lines.len() {
        let orig_trim = original_lines[orig_idx].trim();
        if orig_trim.is_empty()
            || orig_trim.starts_with("--")
            || orig_trim.starts_with("/*")
            || skip_words.contains(orig_trim)
        {
            continue;
        }
        if dml_idx >= dml_keep.len() {
            break;
        }
        let actual_dml_idx = dml_keep[dml_idx].0;
        let dml_trim = dml_lines[actual_dml_idx].trim();
        // Exact match OR containment for EXECUTE IMMEDIATE extractions
        // (strip trailing ; from DML for containment — original EXECUTE line
        // has ; outside the quoted SQL, not inside)
        let dml_no_sc = dml_trim.strip_suffix(';').unwrap_or(dml_trim).trim();
        let orig_no_sc = orig_trim.strip_suffix(';').unwrap_or(orig_trim).trim();
        if dml_trim == orig_trim
            || dml_no_sc == orig_no_sc
            || dml_no_sc.replace('`', "") == orig_no_sc.replace('`', "")
            || dml_trim.replace('`', "") == orig_trim.replace('`', "")
            || (dml_no_sc.len() > 10
                && orig_trim.len() > dml_no_sc.len()
                && (orig_trim.contains(dml_no_sc)
                    || orig_trim.replace('`', "").contains(dml_no_sc.replace('`', "").as_str())))
        {
            line_map[orig_idx] = actual_dml_idx as i32;
            dml_idx += 1;
            // Skip subsequent DML skip-words
            while dml_idx < dml_keep.len() && !dml_keep[dml_idx].1 {
                dml_idx += 1;
            }
        }
    }

    Some((dml, line_map))
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
        assert!(
            output.is_ok(),
            "Failed to parse combined Spark SQL: {:?}",
            output.err()
        );
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
        assert!(
            output.is_ok(),
            "Databricks parse failed: {:?}",
            output.err()
        );

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
        assert!(
            output.is_ok(),
            "BigQuery procedure parse failed: {:?}",
            output.err()
        );
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
        assert!(
            output.is_ok(),
            "BigQuery multi-DML parse failed: {:?}",
            output.err()
        );
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
        assert!(
            output.is_ok(),
            "Generic dialect procedure parse failed: {:?}",
            output.err()
        );
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
        assert!(
            output.is_ok(),
            "Nested BEGIN..END parse failed: {:?}",
            output.err()
        );
    }

    #[test]
    fn test_bigquery_standalone_begin_end_block() {
        // Standalone BEGIN...END body without CREATE PROCEDURE header,
        // e.g. docs/tmp/1.sql stored procedure
        let sql = "\
BEGIN
  DECLARE v_START TIMESTAMP;
  DECLARE v_FUNCTION_NAME STRING;
  SET v_FUNCTION_NAME = 'rinjani.sp_dim_bts_master';
  SET v_START = CURRENT_TIMESTAMP();

  SELECT 'Start Deleting data for current periode:'|| CURRENT_TIMESTAMP();
  INSERT INTO stg.proc_log(proc_date, func_name, seqno, description)
  VALUES (CURRENT_TIMESTAMP(), v_FUNCTION_NAME, 0, 'param=20251025');

  create or replace table rinjani.dim_btsweb_mapping
  as
  WITH cgi_data AS (
    SELECT date_id, cgi cgi, trim(tower_id) tower_id
    FROM ods_cc.prd_xldim_acl_tb_f_d_bts_ref_hist
  )
  SELECT cgi, tower_id FROM cgi_data;

  drop table if exists rinjani.stg_bts_nwca;
  create table rinjani.stg_bts_nwca as
  SELECT upper(a.bts_code) bts_code, a.longitude, a.latitude
  FROM dwh_cc.d_nwca_bts_lte_master a;

  INSERT INTO rinjani.dim_bts_master
  SELECT bts_code, bts_city FROM rinjani.stg_bts_nwca;
END;
";
        let output = parse_sql_with_dialect_output(sql, Dialect::Bigquery);
        let o = output.expect("Parse failed");
        // May use fallback or native parse — either is acceptable as long as
        // we get DML/SELECT statements extracted from the procedure body.
        println!(
            "BigQuery standalone: {} statements, fallback_used={}",
            o.statements.len(),
            o.parser_fallback_used
        );
        assert!(
            o.statements.len() > 0,
            "Should extract at least one DML/SELECT"
        );
        for (i, stmt) in o.statements.iter().enumerate() {
            println!("  stmt[{}]: {:?}", i, stmt);
        }
    }

    #[test]
    fn test_bigquery_procedure_from_file() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/tmp/1.sql");
        let sql = match std::fs::read_to_string(path) {
            Ok(s) => s,
            Err(_) => {
                eprintln!("Cannot read file, skipping");
                return;
            }
        };
        if sql.trim().is_empty() {
            eprintln!("File empty, skipping");
            return;
        }

        let output = parse_sql_with_dialect_output(&sql, Dialect::Bigquery);
        match &output {
            Ok(o) => println!(
                "BigQuery parsed: {} statements, fallback_used={}",
                o.statements.len(),
                o.parser_fallback_used
            ),
            Err(e) => println!("BigQuery dialect failed: {:?}", e),
        }

        let output = parse_sql_with_dialect_output(&sql, Dialect::Generic);
        match &output {
            Ok(o) => println!(
                "Generic parsed: {} statements, fallback_used={}",
                o.statements.len(),
                o.parser_fallback_used
            ),
            Err(e) => println!("Generic dialect failed: {:?}", e),
        }
    }

    #[test]
    fn test_bigquery_execute_immediate_with_triple_quotes() {
        let sql = r#"
CREATE PROCEDURE ds.foo(i INT64)
BEGIN
    DECLARE v INT64 DEFAULT 0;
    SET v = i * 10;
    DELETE FROM target WHERE id = v;
    EXECUTE IMMEDIATE FORMAT("""
        INSERT INTO ds.target (id, name)
        SELECT a.id, a.name
        FROM ds.source_a a
        LEFT JOIN ds.source_b b ON a.id = b.id
        WHERE a.prd_id = %d
    """, v);
    INSERT INTO ds.monitor(func_name, row_affected) VALUES ('foo', v);
END;"#;
        // Test sanitizer directly
        let sanitized = sanitize_bigquery_procedure(sql);
        match &sanitized {
            Some(body) => println!("SANITIZED:\n---\n{}\n---", body),
            None => println!("sanitize_bigquery_procedure returned None"),
        }
        assert!(sanitized.is_some(), "sanitizer should produce output");
        // Parse the sanitized output
        let generic = GenericDialect {};
        let parsed = Parser::parse_sql(&generic, sanitized.as_deref().unwrap());
        assert!(
            parsed.is_ok(),
            "sanitized SQL parse failed: {:?}",
            parsed.err()
        );
        let stmts = parsed.unwrap();
        println!("Parse OK: {} statements", stmts.len());
        assert!(
            stmts.len() >= 3,
            "Expected >=3 statements from DELETE + EXECUTE IMMEDIATE body + INSERT, got {}",
            stmts.len()
        );
    }

    #[test]
    fn test_bigquery_procedure_from_actual_file() {
        let paths = ["/tmp/fnc_stg_all_balances_wrk.sql", "/tmp/fnc_test_di.sql"];
        for path in paths {
            let sql = match std::fs::read_to_string(path) {
                Ok(s) => s,
                Err(_) => {
                    eprintln!("Cannot read {path}, skipping");
                    continue;
                }
            };
            if sql.trim().is_empty() {
                eprintln!("{path} empty, skipping");
                continue;
            }

            let sanitized = sanitize_bigquery_procedure(&sql);
            match &sanitized {
                Some(body) => {
                    println!("=== {path} ===");
                    println!("SANITIZED LENGTH: {}", body.len());
                    println!("SANITIZED:\n---\n{}\n---", body);
                    let generic = GenericDialect {};
                    match Parser::parse_sql(&generic, body) {
                        Ok(stmts) => println!("Parsed {} statements", stmts.len()),
                        Err(e) => println!("Parse failed: {:?}", e),
                    }
                }
                None => println!("sanitize_bigquery_procedure({path}) returned None"),
            }
            for dialect in [Dialect::Bigquery, Dialect::Generic] {
                match parse_sql_with_dialect_output(&sql, dialect) {
                    Ok(o) => println!(
                        "parse_sql_with_dialect_output({dialect:?}) OK: {} stmts, fallback={}",
                        o.statements.len(),
                        o.parser_fallback_used
                    ),
                    Err(e) => println!("parse_sql_with_dialect_output({dialect:?}) FAILED: {e:?}"),
                }
            }
        }
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

        // Skip Hive shell commands that sqlparser-rs doesn't support
        // (ADD JAR / CREATE|DROP TEMPORARY FUNCTION / ADD FILE / LIST JAR).
        // 剥离后避免整段 parse 失败,导致同范围内的 INSERT/SELECT 血缘语句连带丢失。
        if upper.starts_with("ADD JAR")
            || upper.starts_with("CREATE TEMPORARY FUNCTION")
            || upper.starts_with("DROP TEMPORARY FUNCTION")
            || upper.starts_with("ADD FILE")
            || upper.starts_with("LIST JAR")
            || upper.starts_with("LIST FILES")
        {
            out_lines.push(format!("-- hive-shell: {}", line));
            changed = true;
            continue;
        }

        // Rewrite Hive INSERT INTO TABLE / INSERT OVERWRITE TABLE to standard INSERT INTO
        // sqlparser-rs doesn't understand the Hive-specific 'TABLE' keyword.
        if upper.starts_with("INSERT OVERWRITE TABLE")
            || upper.starts_with("INSERT INTO TABLE")
            || upper.starts_with("INSERT TABLE")
        {
            let mut sanitized = line.to_string();
            // Replace TABLE keyword (case-insensitive combinations)
            for (from, to) in &[
                ("INSERT OVERWRITE TABLE", "INSERT INTO"),
                ("insert overwrite table", "INSERT INTO"),
                ("Insert Overwrite Table", "INSERT INTO"),
                ("INSERT INTO TABLE", "INSERT INTO"),
                ("insert into table", "INSERT INTO"),
                ("Insert Into Table", "INSERT INTO"),
                ("INSERT TABLE", "INSERT INTO"),
                ("insert table", "INSERT INTO"),
                ("Insert Table", "INSERT INTO"),
            ] {
                sanitized = sanitized.replace(from, to);
            }
            // Strip PARTITION(col='val') clause
            if let Some(pi) = sanitized.to_uppercase().find("PARTITION (") {
                sanitized = format!(
                    "{}-- hive partition{}",
                    &sanitized[..pi],
                    &sanitized[pi + "PARTITION (".len()..]
                );
            } else if let Some(pi) = sanitized.to_uppercase().find("PARTITION(") {
                sanitized = format!(
                    "{}-- hive partition{}",
                    &sanitized[..pi],
                    &sanitized[pi + "PARTITION(".len()..]
                );
            }
            out_lines.push(sanitized);
            changed = true;
            continue;
        }

        out_lines.push(line.to_string());
    }

    // Post-process: add semicolons between adjacent INSERT blocks
    let mut result_lines: Vec<String> = Vec::new();
    let mut prev_was_insert = false;
    for line in out_lines.iter() {
        let t = line.trim().to_uppercase();
        if t.starts_with("INSERT ") {
            if prev_was_insert {
                result_lines.push(String::from(";"));
            }
            prev_was_insert = true;
        } else if !t.is_empty() {
            prev_was_insert = false;
        }
        result_lines.push(line.clone());
    }
    let result = result_lines.join("\n");

    // Post-process: handle Hive WITH...INSERT pattern.
    // Hive allows WITH at top level before multiple INSERTs, which sqlparser-rs
    // doesn't support. Convert: WITH cte (...) INSERT ... SELECT ... INSERT ... SELECT ...
    // to: INSERT ... WITH cte (...) SELECT ... \n INSERT ... WITH cte (...) SELECT ...
    let result_upper = result.to_uppercase();

    if let Some(with_start) = result_upper.find("WITH ") {
        if let Some(first_insert) = result_upper[with_start..].find("INSERT ") {
            let first_insert = with_start + first_insert;

            // Extract the WITH clause text (WITH ... up to but not including the first INSERT)
            let with_clause = result[with_start..first_insert].trim().to_string();

            // Find all INSERT positions in the text after the WITH clause
            let rest = &result[first_insert..];
            let rest_upper = rest.to_uppercase();
            let mut insert_positions: Vec<usize> = vec![0]; // First INSERT is at position 0 in `rest`
            let mut pos = 1;
            while let Some(next) = rest_upper[pos..].find("INSERT ") {
                pos += next;
                // Only treat as separate INSERT if it's preceded by whitespace/paren/line end
                if pos > 0 {
                    insert_positions.push(pos);
                }
                pos += 1;
            }

            // For each INSERT block, inject the WITH clause after the INSERT INTO ... clause
            // but before the SELECT/DATA statement. The WITH goes right after column list.
            let mut out = String::new();
            for i in 0..insert_positions.len() {
                let block_start = insert_positions[i];
                let block_end = if i + 1 < insert_positions.len() {
                    insert_positions[i + 1]
                } else {
                    rest.len()
                };
                let block = &rest[block_start..block_end];

                if i > 0 {
                    out.push_str("\n;");
                }

                // Find where to insert WITH: after the INSERT INTO ... clause
                // Look for SELECT keyword to determine insertion point
                let block_upper = block.to_uppercase();
                if let Some(select_pos) = block_upper.find("\nSELECT ") {
                    // Insert WITH clause before SELECT
                    out.push_str(&block[..select_pos]);
                    out.push('\n');
                    out.push_str(&with_clause);
                    out.push_str(&block[select_pos..]);
                } else if let Some(select_pos) = block_upper.find("SELECT ") {
                    // SELECT is on the same line or first line after column list
                    // Insert the WITH clause between column list and SELECT
                    let insert_point = select_pos;
                    out.push_str(&block[..insert_point]);
                    out.push('\n');
                    out.push_str(&with_clause);
                    out.push('\n');
                    out.push_str(&block[insert_point..]);
                } else {
                    out.push_str(block);
                }
            }
            return Some(out);
        }
    }

    if changed || result != out_lines.join("\n") {
        Some(result)
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

    use regex::Regex;
    use std::sync::LazyLock;
    static SPARK_JOIN_RE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)(LEFT|RIGHT)\s+(ANTI|SEMI)\s+(JOIN)").unwrap());
    Some(SPARK_JOIN_RE.replace_all(line, "$1 JOIN").into_owned())
}
