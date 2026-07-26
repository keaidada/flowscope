//! Input collection and validation for SQL analysis requests.
//!
//! This module handles the parsing and collection of SQL statements from analysis requests,
//! supporting both file-based and inline SQL inputs.

use crate::parser::{parse_sql_with_dialect, parse_sql_with_dialect_output};
use crate::types::{issue_codes, AnalyzeRequest, Dialect, Issue, Span};
use sqlparser::ast::Statement;
use sqlparser::dialect::MsSqlDialect;
use sqlparser::tokenizer::{Token, Tokenizer};
use std::borrow::Cow;
use std::ops::Range;
use std::rc::Rc;
use thiserror::Error;

#[cfg(feature = "templating")]
use crate::templater::{template_sql, TemplateMode};

/// Maximum iterations allowed when merging statement ranges to prevent infinite loops
/// on malformed SQL input.
const MAX_MERGE_ITERATIONS: usize = 10_000;

/// Wraps bare shell-style template variables in single quotes so the SQL
/// parser treats them as string literals.  Variables already inside single
/// quotes are left untouched — their content is a string constant.
///
/// This is a standalone version usable without the `templating` feature flag.
///
/// # Examples
///
/// - `WHERE dt = ${DATA_DT}` → `WHERE dt = '${DATA_DT}'`
/// - `WHERE dt = {date_id}` → `WHERE dt = '{date_id}'`
/// - `WHERE dt = '${DATA_DT}'` → unchanged
/// - `WHERE dt = 'prefix_${DATA_DT}23'` → unchanged (inside quotes)
/// - `{1, 2, 3}` → unchanged (non-identifier content)
fn quote_shell_vars(sql: &str) -> String {
    let mut result = String::with_capacity(sql.len() + 32);
    let mut remaining = sql;
    let mut in_single_quote = false;

    while let Some(special_pos) = remaining.find(['{', '$', '\'']) {
        let ch = remaining.as_bytes()[special_pos];

        if ch == b'\'' {
            // Track single-quote state
            in_single_quote = !in_single_quote;
            result.push_str(&remaining[..special_pos + 1]);
            remaining = &remaining[special_pos + 1..];
            continue;
        }

        // Push everything up to the special character
        result.push_str(&remaining[..special_pos]);

        // Inside single quotes → copy as-is (string literal, don't touch)
        if in_single_quote {
            result.push(ch as char);
            remaining = &remaining[special_pos + 1..];
            continue;
        }

        let rest = &remaining[special_pos..];

        if let Some(after_open) = rest.strip_prefix("${") {
            if let Some(close_pos) = after_open.find('}') {
                let var_end = 2 + close_pos + 1;
                let var_text = &rest[..var_end];
                result.push('\'');
                result.push_str(var_text);
                result.push('\'');
                remaining = &rest[var_end..];
            } else {
                result.push_str(rest);
                return result;
            }
        } else if let Some(after_open) = rest.strip_prefix('{') {
            if let Some(close_pos) = after_open.find('}') {
                let content = &after_open[..close_pos];
                let is_template_var = content
                    .starts_with(|c: char| c.is_ascii_alphabetic() || c == '_')
                    && content.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');

                let var_end = 1 + close_pos + 1;
                if !is_template_var {
                    result.push_str(&rest[..var_end]);
                } else {
                    result.push('\'');
                    result.push_str(&rest[..var_end]);
                    result.push('\'');
                }
                remaining = &rest[var_end..];
            } else {
                result.push_str(rest);
                return result;
            }
        } else {
            // Lone '$' not followed by '{' — copy as-is
            result.push('$');
            remaining = &rest[1..];
        }
    }

    result.push_str(remaining);
    result
}


/// Creates an issue for a template rendering error.
#[cfg(feature = "templating")]
fn template_error_issue(
    error: &crate::templater::TemplateError,
    source_name: Option<&str>,
) -> Issue {
    let message = match source_name {
        Some(name) => format!("Template error in {name}: {error}"),
        None => format!("Template error: {error}"),
    };
    let mut issue = Issue::error(issue_codes::TEMPLATE_ERROR, message);
    if let Some(name) = source_name {
        issue = issue.with_source_name(name);
    }
    issue
}

/// Applies template preprocessing to SQL if configured.
///
/// Returns the (possibly transformed) SQL and whether templating was applied.
/// The boolean is true when templating was run in non-raw mode, regardless of
/// whether the rendered result differs from the original SQL.
///
/// Shell-style template variables (`{var}` and `${var}`) are always wrapped in
/// single quotes so the SQL parser treats them as string literals.
#[cfg(feature = "templating")]
fn apply_template<'a>(
    sql: &'a str,
    config: Option<&crate::templater::TemplateConfig>,
) -> Result<(Cow<'a, str>, bool), crate::templater::TemplateError> {
    // Always preprocess shell-style template vars: {var} → '{var}', ${var} → '${var}'
    let sql = quote_shell_vars(sql);
    match config {
        Some(cfg) if cfg.mode != TemplateMode::Raw => {
            let rendered = template_sql(&sql, cfg)?;
            // Templating was applied
            Ok((Cow::Owned(rendered), true))
        }
        _ => Ok((Cow::Owned(sql), false)),
    }
}

/// Errors that can occur when aligning statement ranges.
#[derive(Debug, Error)]
enum RangeAlignmentError {
    /// No ranges provided when statements were expected.
    #[error("no ranges provided when {0} statements were expected")]
    NoRanges(usize),
    /// Fewer ranges than statements (cannot split a range).
    #[error("fewer ranges ({0}) than statements ({1}), cannot split ranges")]
    FewerRangesThanStatements(usize, usize),
    /// Failed to merge ranges to match statement count.
    #[error("failed to merge ranges to match statement count")]
    MergeFailed,
    /// Iteration limit exceeded during merge (possible infinite loop).
    #[error("iteration limit ({0}) exceeded during merge, possible infinite loop")]
    IterationLimitExceeded(usize),
    /// A range extends beyond the source SQL bounds.
    #[error("range end ({0}) exceeds source SQL length ({1})")]
    OutOfBounds(usize, usize),
    /// Invalid range where start exceeds end.
    #[error("invalid range: start ({0}) > end ({1})")]
    InvalidRange(usize, usize),
}

/// Context for parsing SQL from a single source.
struct ParseContext<'a> {
    /// The full SQL buffer to parse.
    ///
    /// Uses `Cow` to support both borrowed SQL (from request) and owned SQL
    /// (from template rendering).
    source_sql: Cow<'a, str>,
    /// Optional source file name for error reporting.
    ///
    /// Wrapped in `Rc` so multiple `StatementInput` instances can share
    /// the same name without additional allocations.
    source_name: Option<Rc<String>>,
    /// SQL dialect for parsing.
    dialect: Dialect,
    /// Original SQL before template rendering, when templating is applied.
    untemplated_sql: Option<Cow<'a, str>>,
    /// Whether template processing was applied to produce `source_sql`.
    templating_applied: bool,
}

/// A parsed statement alongside optional source metadata.
pub(crate) struct StatementInput<'a> {
    /// The parsed SQL statement.
    pub(crate) statement: Statement,
    /// Optional source file name for error reporting and tracing.
    ///
    /// Uses `Rc<String>` to avoid repeated heap allocations when the same file
    /// contains multiple statements. All statements from a single file share
    /// the same `Rc`, so cloning is just a reference count increment.
    pub(crate) source_name: Option<Rc<String>>,
    /// The full SQL buffer this statement came from.
    ///
    /// Uses `Cow` to support both borrowed SQL (from request) and owned SQL
    /// (from template rendering). When templated, each statement owns its
    /// copy of the rendered SQL; when not templated, all statements from the
    /// same source share a borrowed reference.
    pub(crate) source_sql: Cow<'a, str>,
    /// Byte range of the statement within `source_sql`.
    pub(crate) source_range: Range<usize>,
    /// Original SQL before template rendering, when templating is applied.
    pub(crate) source_sql_untemplated: Option<Cow<'a, str>>,
    /// Byte range of the statement within `source_sql_untemplated`, when available.
    pub(crate) source_range_untemplated: Option<Range<usize>>,
    /// Whether template processing was applied to produce `source_sql`.
    /// When true, `source_sql` contains the resolved/compiled SQL.
    pub(crate) templating_applied: bool,
    /// Whether parser fallback was used while parsing this statement.
    pub(crate) parser_fallback_used: bool,
}

/// Collects and parses SQL statements from the analysis request.
///
/// This function handles both file-based and inline SQL inputs, combining them into
/// a single ordered list of statements for analysis.
///
/// # Input Sources
///
/// The request can provide SQL through two mechanisms:
///
/// 1. **File sources** (`request.files`): A list of named SQL files with content
/// 2. **Inline SQL** (`request.sql`): Direct SQL text in the request body
///
/// Both sources are processed and combined. At least one must contain valid SQL.
///
/// # Processing Order
///
/// When both sources are present, statements are collected in this order:
///
/// 1. File statements (in the order files appear in the array)
/// 2. Inline SQL statements
///
/// This ordering ensures predictable cross-statement dependency detection,
/// where earlier statements can be referenced by later ones.
///
/// # Error Handling
///
/// Parse errors from individual files or inline SQL are collected as issues
/// rather than failing immediately. This allows partial analysis when some
/// inputs are valid.
///
/// # Returns
///
/// A tuple of `(statements, issues)` where:
/// - `statements`: Successfully parsed statements with source attribution
/// - `issues`: Any validation errors or parse failures encountered
pub(crate) fn collect_statements<'a>(
    request: &'a AnalyzeRequest,
) -> (Vec<StatementInput<'a>>, Vec<Issue>) {
    let mut issues = Vec::new();
    let mut statements = Vec::new();

    let has_sql = !request.sql.trim().is_empty();
    let has_files = request
        .files
        .as_ref()
        .map(|files| !files.is_empty())
        .unwrap_or(false);

    if !has_sql && !has_files {
        issues.push(Issue::error(
            issue_codes::INVALID_REQUEST,
            "Provide inline SQL or at least one file to analyze",
        ));
        return (Vec::new(), issues);
    }

    // Parse files first (if present)
    if let Some(files) = &request.files {
        for file in files {
            // When a file is a stored procedure with pre-transformed content,
            // use the transformed (sanitized) SQL for lineage analysis instead
            // of the original CREATE PROCEDURE wrapper. This lets the parser
            // directly analyze the extracted DML statements.
            let proc_sql: &str = if file.is_procedure {
                match &file.transformed_content {
                    Some(t) if !t.trim().is_empty() => t.as_str(),
                    _ => file.content.as_str(),
                }
            } else {
                file.content.as_str()
            };

            // Apply templating if configured
            #[cfg(feature = "templating")]
            let (source_sql, templating_applied): (Cow<'_, str>, bool) = {
                match apply_template(proc_sql, request.template_config.as_ref()) {
                    Ok((sql, applied)) => (sql, applied),
                    Err(e) => {
                        issues.push(template_error_issue(&e, Some(&file.name)));
                        continue; // Skip this file but continue with others
                    }
                }
            };
            #[cfg(not(feature = "templating"))]
            let (source_sql, templating_applied): (Cow<'_, str>, bool) =
                (Cow::Owned(quote_shell_vars(proc_sql)), false);

            let ctx = ParseContext {
                source_sql,
                source_name: Some(Rc::new(file.name.clone())),
                dialect: request.dialect,
                untemplated_sql: templating_applied.then_some(Cow::Borrowed(file.content.as_str())),
                templating_applied,
            };
            let (file_stmts, file_issues) = parse_statements_individually(&ctx);
            statements.extend(file_stmts);
            issues.extend(file_issues);
        }
    }

    // Parse inline SQL if present (appended after file statements)
    if has_sql {
        // Apply templating if configured
        #[cfg(feature = "templating")]
        let (source_sql, templating_applied): (Cow<'_, str>, bool) = {
            match apply_template(&request.sql, request.template_config.as_ref()) {
                Ok((sql, applied)) => (sql, applied),
                Err(e) => {
                    // Record error and return collected statements (same as file error handling).
                    // Inline SQL is processed last, so returning here is equivalent to continuing.
                    issues.push(template_error_issue(&e, request.source_name.as_deref()));
                    return (statements, issues);
                }
            }
        };
        #[cfg(not(feature = "templating"))]
        let (source_sql, templating_applied): (Cow<'_, str>, bool) =
            (Cow::Owned(quote_shell_vars(request.sql.as_str())), false);

        let ctx = ParseContext {
            source_sql,
            source_name: request.source_name.clone().map(Rc::new),
            dialect: request.dialect,
            untemplated_sql: templating_applied.then_some(Cow::Borrowed(request.sql.as_str())),
            templating_applied,
        };
        let (inline_stmts, inline_issues) = parse_statements_individually(&ctx);
        statements.extend(inline_stmts);
        issues.extend(inline_issues);
    }

    (statements, issues)
}

/// Parses SQL from a single buffer with best-effort error handling.
///
/// The parser first tries to process the entire buffer so statements containing
/// embedded semicolons (e.g. procedures) remain intact. If that fails, it
/// falls back to parsing semicolon-delimited slices individually so later
/// statements can still be analyzed.
fn parse_statements_individually<'a>(
    ctx: &ParseContext<'a>,
) -> (Vec<StatementInput<'a>>, Vec<Issue>) {
    let statement_ranges = compute_statement_ranges_for_dialect(&ctx.source_sql, ctx.dialect);

    // For Hive dialect, INSERT-based splitting means each range must be parsed
    // independently so that CTE contexts don't cross pollinate across INSERTs.
    // Also applies when multiple ranges exist (semicolons are present).
    let use_best_effort = matches!(ctx.dialect, Dialect::Hive) && statement_ranges.len() > 1;

    if !use_best_effort {
        match parse_full_sql_buffer(ctx, &statement_ranges) {
            Ok(statements) => return (statements, Vec::new()),
            Err(fallback_error) => {
                let (statements, mut issues) =
                    parse_statement_ranges_best_effort(ctx, statement_ranges);
                // Surface the fallback reason
                if let Some(error) = fallback_error {
                    let source_info = ctx
                        .source_name
                        .as_deref()
                        .map(|n| format!(" in {n}"))
                        .unwrap_or_default();
                    let message = format!(
                        "Full SQL parsing failed{source_info}, using best-effort mode: {error}"
                    );
                    let mut issue = Issue::warning(issue_codes::PARSE_ERROR, message);
                    if let Some(name) = ctx.source_name.as_deref() {
                        issue = issue.with_source_name(name);
                    }
                    issues.push(issue);
                }
                return (statements, issues);
            }
        }
    }

    // Best-effort mode: parse each range independently
    let (statements, issues) = parse_statement_ranges_best_effort(ctx, statement_ranges);
    (statements, issues)
}

/// Attempts full SQL buffer parsing with statement range alignment.
///
/// Returns:
/// - `Ok(statements)` if parsing and range alignment succeeded
/// - `Err(None)` if SQL parsing failed (no specific error to report)
/// - `Err(Some(error))` if range alignment failed (error should be surfaced)
fn parse_full_sql_buffer<'a>(
    ctx: &ParseContext<'a>,
    statement_ranges: &[Range<usize>],
) -> Result<Vec<StatementInput<'a>>, Option<RangeAlignmentError>> {
    let parsed_output =
        parse_sql_with_dialect_output(&ctx.source_sql, ctx.dialect).map_err(|_| None)?;
    let parser_fallback_used = parsed_output.parser_fallback_used;
    let parsed = parsed_output.statements;

    if parsed.is_empty() {
        return Ok(Vec::new());
    }

    // When parser fallback was used (e.g., BigQuery procedure sanitizer), the parsed
    // statements come from a different SQL text. Use the sanitized SQL for range
    // computation instead of trying to align with the original statement ranges.
    if parser_fallback_used {
        if let Some(sanitized_sql) = parsed_output.source_sql {
            let sanitized_sql: Cow<'a, str> = Cow::Owned(sanitized_sql);
            let sanitized_ranges =
                compute_statement_ranges_for_dialect(&sanitized_sql, ctx.dialect);
            let aligned_ranges = align_statement_ranges(
                &sanitized_sql,
                &sanitized_ranges,
                ctx.dialect,
                parsed.len(),
            )
            .map_err(|e| Some(e))?;

            let mut statements = Vec::with_capacity(parsed.len());
            for (_index, (stmt, range)) in parsed
                .into_iter()
                .zip(aligned_ranges.into_iter())
                .enumerate()
            {
                statements.push(StatementInput {
                    statement: stmt,
                    source_name: ctx.source_name.clone(),
                    source_sql: sanitized_sql.clone(),
                    source_range: range,
                    source_sql_untemplated: None,
                    source_range_untemplated: None,
                    templating_applied: false,
                    parser_fallback_used,
                });
            }
            return Ok(statements);
        }
        // If no sanitized SQL available, fall through to normal alignment
    }

    let aligned_ranges = match align_statement_ranges(
        &ctx.source_sql,
        statement_ranges,
        ctx.dialect,
        parsed.len(),
    ) {
        Ok(ranges) => ranges,
        Err(e) => {
            #[cfg(feature = "tracing")]
            tracing::debug!(
                source = ?ctx.source_name.as_deref(),
                error = %e,
                "Failed to align statement ranges, falling back to best-effort parsing"
            );
            return Err(Some(e));
        }
    };

    let aligned_untemplated_ranges = ctx.untemplated_sql.as_deref().and_then(|sql| {
        let ranges = compute_statement_ranges_for_dialect(sql, ctx.dialect);
        align_statement_ranges(sql, &ranges, ctx.dialect, parsed.len()).ok()
    });

    let mut statements = Vec::with_capacity(parsed.len());
    for (index, (stmt, range)) in parsed
        .into_iter()
        .zip(aligned_ranges.into_iter())
        .enumerate()
    {
        statements.push(StatementInput {
            statement: stmt,
            source_name: ctx.source_name.clone(),
            source_sql: ctx.source_sql.clone(),
            source_range: range,
            source_sql_untemplated: ctx.untemplated_sql.clone(),
            source_range_untemplated: aligned_untemplated_ranges
                .as_ref()
                .and_then(|ranges| ranges.get(index).cloned()),
            templating_applied: ctx.templating_applied,
            parser_fallback_used,
        });
    }

    Ok(statements)
}

fn align_statement_ranges(
    source_sql: &str,
    statement_ranges: &[Range<usize>],
    dialect: Dialect,
    statement_count: usize,
) -> Result<Vec<Range<usize>>, RangeAlignmentError> {
    if statement_count == 0 {
        return Ok(Vec::new());
    }

    if statement_ranges.is_empty() {
        return Err(RangeAlignmentError::NoRanges(statement_count));
    }

    if statement_ranges.len() == statement_count {
        return Ok(statement_ranges.to_vec());
    }

    if statement_ranges.len() < statement_count {
        return Err(RangeAlignmentError::FewerRangesThanStatements(
            statement_ranges.len(),
            statement_count,
        ));
    }

    merge_statement_ranges(source_sql, statement_ranges, dialect, statement_count)
}

/// Re-aligns semicolon-delimited ranges with the statements parsed by `sqlparser`.
///
/// This is necessary because `sqlparser` may parse a single statement that contains
/// multiple semicolons (e.g., a `CREATE PROCEDURE` block). In such cases, our
/// naive `compute_statement_ranges` will produce more ranges than `sqlparser` produces
/// statements. This function greedily merges consecutive ranges until the resulting
/// SQL snippet successfully parses as a single statement, ensuring each parsed AST
/// node is mapped to its correct, complete source text.
fn merge_statement_ranges(
    source_sql: &str,
    statement_ranges: &[Range<usize>],
    dialect: Dialect,
    statement_count: usize,
) -> Result<Vec<Range<usize>>, RangeAlignmentError> {
    let mut merged = Vec::with_capacity(statement_count);
    let mut range_index = 0usize;

    // Process each expected statement, greedily merging ranges as needed
    for _ in 0..statement_count {
        // Ensure we have ranges left to process
        if range_index >= statement_ranges.len() {
            return Err(RangeAlignmentError::MergeFailed);
        }

        let mut statement_iterations = 0usize;

        // Start with the current range; we'll extend it if needed
        let mut current_range = statement_ranges[range_index].clone();
        range_index += 1;

        // Keep extending the range until we get exactly one parsed statement
        loop {
            statement_iterations += 1;
            if statement_iterations > MAX_MERGE_ITERATIONS {
                return Err(RangeAlignmentError::IterationLimitExceeded(
                    MAX_MERGE_ITERATIONS,
                ));
            }

            // Validate range boundaries
            if current_range.start > current_range.end {
                return Err(RangeAlignmentError::InvalidRange(
                    current_range.start,
                    current_range.end,
                ));
            }
            if current_range.end > source_sql.len() {
                return Err(RangeAlignmentError::OutOfBounds(
                    current_range.end,
                    source_sql.len(),
                ));
            }

            let snippet = &source_sql[current_range.clone()];
            match parse_sql_with_dialect(snippet, dialect) {
                // Found exactly one statement - this range is complete
                Ok(parsed) if parsed.len() == 1 => {
                    merged.push(current_range);
                    break;
                }
                // Either parsed multiple statements, zero statements, or failed to parse.
                // Extend the range by including the next semicolon-delimited segment and retry.
                _ => {
                    if range_index >= statement_ranges.len() {
                        return Err(RangeAlignmentError::MergeFailed);
                    }
                    // Merge current range with the next range
                    current_range = current_range.start..statement_ranges[range_index].end;
                    range_index += 1;
                }
            }
        }
    }

    // Verify we consumed all ranges - if not, the merge logic is incorrect
    if range_index != statement_ranges.len() {
        return Err(RangeAlignmentError::MergeFailed);
    }

    Ok(merged)
}

/// Parses SQL slices defined by `statement_ranges`, recording parse errors per slice.
fn parse_statement_ranges_best_effort<'a>(
    ctx: &ParseContext<'a>,
    statement_ranges: Vec<Range<usize>>,
) -> (Vec<StatementInput<'a>>, Vec<Issue>) {
    let mut statements = Vec::new();
    let mut issues = Vec::new();

    let source_sql_ref: &str = &ctx.source_sql;

    for range in statement_ranges {
        // Skip invalid ranges
        if range.start > range.end || range.end > source_sql_ref.len() {
            continue;
        }

        let statement_sql = &source_sql_ref[range.clone()];

        match parse_sql_with_dialect_output(statement_sql, ctx.dialect) {
            Ok(parsed_output) => {
                let parser_fallback_used = parsed_output.parser_fallback_used;

                // Typically one statement per range, but handle multiple if present
                for stmt in parsed_output.statements {
                    statements.push(StatementInput {
                        statement: stmt,
                        source_name: ctx.source_name.clone(),
                        source_sql: ctx.source_sql.clone(),
                        source_range: range.clone(),
                        source_sql_untemplated: ctx.untemplated_sql.clone(),
                        source_range_untemplated: None,
                        templating_applied: ctx.templating_applied,
                        parser_fallback_used,
                    });
                }
            }
            Err(e) => {
                // Record the parse error but continue with remaining statements
                let message = match ctx.source_name.as_deref() {
                    Some(name) => format!("Parse error in {name}: {e}"),
                    None => format!("Parse error: {e}"),
                };

                let mut issue = Issue::error(issue_codes::PARSE_ERROR, message)
                    .with_span(Span::new(range.start, range.end));
                if let Some(name) = ctx.source_name.as_deref() {
                    issue = issue.with_source_name(name);
                }
                issues.push(issue);
            }
        }
    }

    (statements, issues)
}

pub(crate) fn split_statement_spans_with_dialect(sql: &str, dialect: Dialect) -> Vec<Span> {
    compute_statement_ranges_for_dialect(sql, dialect)
        .into_iter()
        .map(|range| Span::new(range.start, range.end))
        .collect()
}

fn compute_statement_ranges_for_dialect(sql: &str, dialect: Dialect) -> Vec<Range<usize>> {
    let ranges = compute_statement_ranges(sql);
    if matches!(dialect, Dialect::Hive) {
        return split_ranges_on_hive_insert_boundaries(sql, ranges);
    }
    if !matches!(dialect, Dialect::Mssql) {
        return ranges;
    }
    split_ranges_on_mssql_go_separators(sql, ranges)
}

fn split_ranges_on_hive_insert_boundaries(sql: &str, ranges: Vec<Range<usize>>) -> Vec<Range<usize>> {
    let mut out = Vec::new();
    for range in ranges {
        let slice = &sql[range.start..range.end];
        let insert_positions = find_hive_insert_starts(slice);
        // No INSERT found or single INSERT: keep range as-is
        if insert_positions.len() <= 1 {
            out.push(range);
            continue;
        }
        // Identify the main WITH clause at the beginning of the range
        let first_with = find_first_with_in_range(slice);
        let mut sub_start = range.start;
        for i in 0..insert_positions.len() {
            let abs_insert = range.start + insert_positions[i];
            // If a WITH clause exists at the range start and this isn't the first INSERT,
            // check if there's a WITH between the previous INSERT and this one
            let effective_start = if i == 0 {
                // First INSERT: include the WITH clause if present
                if let Some(w) = first_with {
                    range.start
                } else {
                    abs_insert
                }
            } else {
                // Check for a WITH between the end of previous INSERT and this INSERT
                let prev_end = range.start + insert_positions[i - 1];
                let gap = &sql[prev_end..abs_insert];
                find_first_with_in_range(gap).map(|_| prev_end).unwrap_or(abs_insert)
            };
            
            let end = if i + 1 < insert_positions.len() {
                range.start + insert_positions[i + 1]
            } else {
                range.end
            };
            
            if let Some(chunk) = trim_statement_range(sql, effective_start, end) {
                out.push(chunk);
            }
            sub_start = end;
        }
    }
    out
}

fn find_first_with_in_range(sql: &str) -> Option<usize> {
    let trimmed = sql.trim_start();
    let trimmed_upper = trimmed.to_uppercase();
    if trimmed_upper.starts_with("WITH ") {
        let with_end = sql.len() - trimmed.len();
        // Verify the WITH is at the start of a logical line (preceded only by whitespace/comments)
        let before = &sql[..with_end];
        if before.is_empty() || before.ends_with('\n') {
            return Some(with_end);
        }
    }
    None
}

/// Find the start positions of top-level INSERT statements within SQL.
/// Looks for lines starting with `insert` (case-insensitive) that are not
/// inside comments or strings.
fn find_hive_insert_starts(sql: &str) -> Vec<usize> {
    let mut positions = Vec::new();
    let bytes = sql.as_bytes();
    let len = bytes.len();
    let mut i = 0;
    
    while i < len {
        // Skip to next newline to find line starts
        let line_start = i;
        
        // Find end of this line
        let line_end = bytes[i..].iter().position(|&b| b == b'\n').map(|p| i + p).unwrap_or(len);
        
        // Check if this line starts with INSERT (case-insensitive)
        let line = std::str::from_utf8(&bytes[line_start..line_end]).unwrap_or("");
        let trimmed = line.trim();
        let upper = trimmed.to_uppercase();
        
        if upper.starts_with("INSERT ") || upper.starts_with("INSERT\t") {
            // Locate the absolute position of INSERT in the original SQL
            let insert_pos = line_start + (trimmed.as_ptr() as usize - line.as_ptr() as usize);
            positions.push(insert_pos);
        }
        
        i = line_end + 1;
        if i >= len { break; }
    }
    
    positions
}

fn split_ranges_on_mssql_go_separators(sql: &str, ranges: Vec<Range<usize>>) -> Vec<Range<usize>> {
    let go_line_ranges = mssql_go_line_ranges(sql);
    if go_line_ranges.is_empty() {
        return ranges;
    }

    let mut out = Vec::new();
    for range in ranges {
        let mut cursor = range.start;
        for go_range in &go_line_ranges {
            if go_range.start < range.start || go_range.end > range.end || go_range.start < cursor {
                continue;
            }
            if let Some(chunk) = trim_statement_range(sql, cursor, go_range.start) {
                out.push(chunk);
            }
            cursor = go_range.end;
        }

        if let Some(chunk) = trim_statement_range(sql, cursor, range.end) {
            out.push(chunk);
        }
    }

    out
}

fn mssql_go_line_ranges(sql: &str) -> Vec<Range<usize>> {
    let mut tokenizer = Tokenizer::new(&MsSqlDialect {}, sql);
    let Ok(tokens) = tokenizer.tokenize_with_location() else {
        return Vec::new();
    };

    let mut go_lines = Vec::new();
    for token in tokens {
        let Token::Word(word) = token.token else {
            continue;
        };
        if !word.value.eq_ignore_ascii_case("GO") {
            continue;
        }
        let line = token.span.start.line as usize;
        if line_is_go_separator(sql, line) {
            go_lines.push(line);
        }
    }

    if go_lines.is_empty() {
        return Vec::new();
    }

    go_lines.sort_unstable();
    go_lines.dedup();

    go_lines
        .into_iter()
        .filter_map(|line| line_byte_range(sql, line))
        .collect()
}

fn line_is_go_separator(sql: &str, line_number: usize) -> bool {
    line_text(sql, line_number).is_some_and(|line| line.trim().eq_ignore_ascii_case("GO"))
}

fn line_text(sql: &str, line_number: usize) -> Option<&str> {
    let range = line_byte_range(sql, line_number)?;
    let line = &sql[range];
    Some(line.trim_end_matches(['\n', '\r']))
}

fn line_byte_range(sql: &str, line_number: usize) -> Option<Range<usize>> {
    if line_number == 0 {
        return None;
    }

    let bytes = sql.as_bytes();
    let mut starts = vec![0usize];
    for (idx, byte) in bytes.iter().enumerate() {
        if *byte == b'\n' {
            starts.push(idx + 1);
        }
    }

    let start = *starts.get(line_number - 1)?;
    let end = starts.get(line_number).copied().unwrap_or(sql.len());
    Some(start..end)
}

/// Split SQL text into statement ranges by finding semicolons outside of strings/comments.
///
/// # Design Decision: Character-Level State Machine
///
/// This function intentionally uses a character-by-character state machine rather than
/// leveraging sqlparser's tokenizer. This is necessary for several reasons:
///
/// 1. **Pre-tokenization requirement**: Statement splitting must happen *before* parsing
///    because some analysis modes need statement boundaries before the dialect is
///    determined. This is a chicken-and-egg problem where we can't tokenize without
///    knowing the dialect, but we may need statement boundaries to help determine context.
///
/// 2. **Error tolerance**: The parser/tokenizer may fail on incomplete or invalid SQL,
///    but we still need to identify statement boundaries for partial analysis, error
///    recovery, and editor features like completions that work with incomplete input.
///
/// 3. **Multi-dialect support**: The state machine handles quoting styles from multiple
///    dialects simultaneously (double quotes, single quotes, backticks, brackets),
///    allowing statement splitting to work regardless of dialect.
///
/// 4. **Dollar-quoted strings**: PostgreSQL's `$tag$...$tag$` strings require special
///    handling that's simpler to implement in a dedicated state machine.
///
/// # Note on Alternatives
///
/// While it might seem cleaner to use sqlparser's tokenizer (which properly handles
/// all these cases), the tokenizer is designed to work on single statements and may
/// fail on multi-statement input with syntax errors. This function is specifically
/// designed to be resilient to partial/invalid SQL.
///
/// A future improvement could use error-recovering tokenization when available in
/// sqlparser, but for now this manual approach provides the most reliable results
/// for the analysis use cases.
fn compute_statement_ranges(sql: &str) -> Vec<Range<usize>> {
    let mut ranges = Vec::new();
    if sql.is_empty() {
        return ranges;
    }

    let mut start = 0usize;
    let mut i = 0usize;
    let len = sql.len();

    let mut in_single_quote = false;
    let mut in_double_quote = false;
    let mut in_backtick = false;
    let mut in_bracket = false;
    let mut in_line_comment = false;
    let mut in_block_comment = false;
    let mut dollar_delimiter: Option<String> = None;

    while i < len {
        if let Some(delim) = &dollar_delimiter {
            if sql[i..].starts_with(delim) {
                i += delim.len();
                dollar_delimiter = None;
            } else {
                let (_, advance) = next_char(sql, i);
                i += advance;
            }
            continue;
        }

        if in_line_comment {
            let (ch, advance) = next_char(sql, i);
            i += advance;
            if ch == '\n' || ch == '\r' {
                in_line_comment = false;
            }
            continue;
        }

        if in_block_comment {
            if starts_with_at(sql, i, "*/") {
                i += 2;
                in_block_comment = false;
            } else {
                let (_, advance) = next_char(sql, i);
                i += advance;
            }
            continue;
        }

        if in_single_quote {
            let (ch, advance) = next_char(sql, i);
            i += advance;
            if ch == '\'' {
                if let Some((next, next_len)) = char_at(sql, i) {
                    if next == '\'' {
                        i += next_len;
                    } else {
                        in_single_quote = false;
                    }
                } else {
                    in_single_quote = false;
                }
            }
            continue;
        }

        if in_double_quote {
            let (ch, advance) = next_char(sql, i);
            i += advance;
            if ch == '"' {
                if let Some((next, next_len)) = char_at(sql, i) {
                    if next == '"' {
                        i += next_len;
                    } else {
                        in_double_quote = false;
                    }
                } else {
                    in_double_quote = false;
                }
            }
            continue;
        }

        if in_backtick {
            let (ch, advance) = next_char(sql, i);
            i += advance;
            if ch == '`' {
                if let Some((next, next_len)) = char_at(sql, i) {
                    if next == '`' {
                        i += next_len;
                    } else {
                        in_backtick = false;
                    }
                } else {
                    in_backtick = false;
                }
            }
            continue;
        }

        if in_bracket {
            let (ch, advance) = next_char(sql, i);
            i += advance;
            if ch == ']' {
                if let Some((next, next_len)) = char_at(sql, i) {
                    if next == ']' {
                        i += next_len;
                    } else {
                        in_bracket = false;
                    }
                } else {
                    in_bracket = false;
                }
            }
            continue;
        }

        let (ch, advance) = next_char(sql, i);
        match ch {
            '\'' => {
                in_single_quote = true;
                i += advance;
                continue;
            }
            '"' => {
                in_double_quote = true;
                i += advance;
                continue;
            }
            '`' => {
                in_backtick = true;
                i += advance;
                continue;
            }
            '[' => {
                in_bracket = true;
                i += advance;
                continue;
            }
            '-' => {
                if starts_with_at(sql, i + advance, "-") {
                    in_line_comment = true;
                    i += advance + 1;
                    continue;
                }
            }
            '#' => {
                in_line_comment = true;
                i += advance;
                continue;
            }
            '/' => {
                if starts_with_at(sql, i + advance, "*") {
                    in_block_comment = true;
                    i += advance + 1;
                    continue;
                }
            }
            '$' => {
                if let Some((delim, end_idx)) = detect_dollar_quote(sql, i) {
                    dollar_delimiter = Some(delim);
                    i = end_idx;
                    continue;
                }
            }
            ';' => {
                push_statement_range(&mut ranges, sql, start, i);
                start = i + advance;
            }
            _ => {}
        }

        i += advance;
    }

    push_statement_range(&mut ranges, sql, start, len);
    ranges
}

fn detect_dollar_quote(sql: &str, start: usize) -> Option<(String, usize)> {
    let len = sql.len();
    if start + 1 >= len {
        return None;
    }

    let mut idx = start + 1;
    while idx < len {
        let (ch, advance) = next_char(sql, idx);
        idx += advance;
        if ch == '$' {
            let delimiter = sql[start..idx].to_string();
            return Some((delimiter, idx));
        }
        if !(ch == '_' || ch.is_ascii_alphanumeric()) {
            return None;
        }
    }

    None
}

fn starts_with_at(sql: &str, index: usize, pattern: &str) -> bool {
    if index >= sql.len() {
        return false;
    }
    if !sql.is_char_boundary(index) {
        return false;
    }
    sql[index..].starts_with(pattern)
}

fn next_char(sql: &str, index: usize) -> (char, usize) {
    debug_assert!(sql.is_char_boundary(index));
    let mut iter = sql[index..].char_indices();
    let (_, ch) = iter.next().expect("index should point to a char boundary");
    let advance = ch.len_utf8();
    (ch, advance)
}

fn char_at(sql: &str, index: usize) -> Option<(char, usize)> {
    if index >= sql.len() {
        return None;
    }
    if !sql.is_char_boundary(index) {
        return None;
    }
    let mut iter = sql[index..].char_indices();
    let (_, ch) = iter.next().expect("index should point to a char boundary");
    let advance = ch.len_utf8();
    Some((ch, advance))
}

fn push_statement_range(ranges: &mut Vec<Range<usize>>, sql: &str, start: usize, end: usize) {
    if let Some(range) = trim_statement_range(sql, start, end) {
        ranges.push(range);
    }
}

fn trim_statement_range(sql: &str, start: usize, end: usize) -> Option<Range<usize>> {
    if start >= end {
        return None;
    }

    let mut s = start;
    let mut e = end;

    let bytes = sql.as_bytes();

    while s < e {
        if s + 1 < e {
            let first = bytes[s];
            let second = bytes[s + 1];
            if first == b'-' && second == b'-' {
                s = skip_line_comment(bytes, s + 2, e);
                continue;
            }
            if first == b'/' && second == b'*' {
                s = skip_block_comment(bytes, s + 2, e);
                continue;
            }
        }

        let b = bytes[s];
        match b {
            b'#' => {
                s = skip_line_comment(bytes, s + 1, e);
            }
            b' ' | b'\t' | b'\r' | b'\n' => {
                s += 1;
            }
            _ => break,
        }
    }

    while s < e {
        let b = bytes[e - 1];
        match b {
            b' ' | b'\t' | b'\r' | b'\n' => {
                e -= 1;
            }
            _ => break,
        }
    }

    if s >= e {
        return None;
    }

    Some(s..e)
}

fn skip_line_comment(bytes: &[u8], mut index: usize, end: usize) -> usize {
    while index < end {
        let byte = bytes[index];
        index += 1;
        if byte == b'\n' || byte == b'\r' {
            break;
        }
    }
    index
}

fn skip_block_comment(bytes: &[u8], mut index: usize, end: usize) -> usize {
    while index < end {
        if index + 1 < end && bytes[index] == b'*' && bytes[index + 1] == b'/' {
            return index + 2;
        }
        index += 1;
    }
    end
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{Dialect, FileSource};

    fn base_request() -> AnalyzeRequest {
        AnalyzeRequest {
            sql: String::new(),
            files: None,
            dialect: Dialect::Generic,
            source_name: None,
            options: None,
            schema: None,
            #[cfg(feature = "templating")]
            template_config: None,
        }
    }

    #[test]
    fn collects_file_and_inline_statements() {
        let mut request = base_request();
        request.sql = "SELECT 2".to_string();
        request.source_name = Some("inline.sql".to_string());
        request.files = Some(vec![FileSource {
            name: "file.sql".to_string(),
            content: "SELECT 1".to_string(),
            is_procedure: false,
            transformed_content: None,
        }]);

        let (statements, issues) = collect_statements(&request);
        assert!(issues.is_empty());
        assert_eq!(statements.len(), 2);
        assert_eq!(
            statements[0].source_name.as_deref().map(String::as_str),
            Some("file.sql")
        );
        assert_eq!(
            statements[0].source_sql[statements[0].source_range.clone()].trim(),
            "SELECT 1"
        );
        assert_eq!(
            statements[1].source_name.as_deref().map(String::as_str),
            Some("inline.sql")
        );
        assert_eq!(
            statements[1].source_sql[statements[1].source_range.clone()].trim(),
            "SELECT 2"
        );
    }

    #[test]
    fn reports_invalid_request_without_inputs() {
        let request = base_request();
        let (_statements, issues) = collect_statements(&request);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].code, issue_codes::INVALID_REQUEST);
    }

    #[test]
    fn statement_ranges_respect_strings() {
        let sql = "SELECT ';' as value;SELECT 2;";
        let ranges = compute_statement_ranges(sql);
        assert_eq!(ranges.len(), 2);
        assert_eq!(&sql[ranges[0].clone()], "SELECT ';' as value");
        assert_eq!(&sql[ranges[1].clone()], "SELECT 2");
    }

    #[test]
    fn statement_ranges_skip_comments() {
        let sql = "SELECT 1; -- comment; still comment\nSELECT 2; /* block; comment */ SELECT 3;";
        let ranges = compute_statement_ranges(sql);
        assert_eq!(ranges.len(), 3);
        assert_eq!(&sql[ranges[0].clone()], "SELECT 1");
        assert_eq!(&sql[ranges[1].clone()], "SELECT 2");
        assert_eq!(&sql[ranges[2].clone()], "SELECT 3");
    }

    #[test]
    fn statement_ranges_handle_dollar_quoting() {
        let sql = "DO $$ BEGIN RAISE NOTICE ';'; END $$; SELECT 1;";
        let ranges = compute_statement_ranges(sql);
        assert_eq!(ranges.len(), 2);
        assert_eq!(
            &sql[ranges[0].clone()],
            "DO $$ BEGIN RAISE NOTICE ';'; END $$"
        );
        assert_eq!(&sql[ranges[1].clone()], "SELECT 1");
    }

    #[test]
    fn mssql_statement_ranges_split_go_batch_separators() {
        let sql = "CREATE SCHEMA staging;\nGO\nCREATE TABLE test (id INT)\n";
        let ranges = compute_statement_ranges_for_dialect(sql, Dialect::Mssql);
        assert_eq!(ranges.len(), 2);
        assert_eq!(&sql[ranges[0].clone()], "CREATE SCHEMA staging");
        assert_eq!(&sql[ranges[1].clone()], "CREATE TABLE test (id INT)");
    }

    #[test]
    fn collect_statements_mssql_go_batch_without_final_semicolon_parses_statements() {
        let mut request = base_request();
        request.dialect = Dialect::Mssql;
        request.sql = "CREATE SCHEMA staging;\nGO\nCREATE TABLE test (id INT)\n".to_string();

        let (statements, issues) = collect_statements(&request);
        assert!(
            issues.is_empty(),
            "MSSQL GO separators should not produce parse errors: {issues:?}"
        );
        assert_eq!(statements.len(), 2);
    }

    #[test]
    fn parses_procedure_with_inner_semicolons() {
        let mut request = base_request();
        request.dialect = Dialect::Snowflake;
        request.sql = r#"
            CREATE PROCEDURE demo()
            LANGUAGE SQL
            AS
            BEGIN
                SELECT 'a';
                SELECT 'b';
                RETURN 'done';
            END;
            SELECT 1;
        "#
        .to_string();

        let (statements, issues) = collect_statements(&request);
        assert!(issues.is_empty(), "Expected no issues, got {issues:?}");
        assert_eq!(
            statements.len(),
            2,
            "Expected procedure and trailing select"
        );
        assert!(matches!(
            statements[0].statement,
            Statement::CreateProcedure { .. }
        ));
        let procedure_source = &statements[0].source_sql[statements[0].source_range.clone()];
        assert!(
            procedure_source.contains("SELECT 'b';") && procedure_source.contains("RETURN 'done';"),
            "Procedure source should include entire body: {procedure_source:?}"
        );
        assert!(matches!(statements[1].statement, Statement::Query(_)));
    }

    #[test]
    fn best_effort_parsing_continues_after_error() {
        // SQL with valid statement, invalid statement, then valid statement
        let mut request = base_request();
        request.sql = r#"
            SELECT 1 FROM users;
            SELECT FROM;
            SELECT 2 FROM orders;
        "#
        .to_string();

        let (statements, issues) = collect_statements(&request);

        // Should have parsed 2 valid statements
        assert_eq!(statements.len(), 2, "Expected 2 valid statements");

        // Should have 1 parse error for the invalid statement
        assert_eq!(issues.len(), 1, "Expected 1 parse error");
        assert_eq!(issues[0].code, issue_codes::PARSE_ERROR);

        // The error should have a span pointing to the invalid statement
        assert!(issues[0].span.is_some(), "Error should have span info");
    }

    #[test]
    fn best_effort_parsing_with_file_source() {
        let mut request = base_request();
        request.files = Some(vec![FileSource {
            name: "test.sql".to_string(),
            content: r#"
                SELECT a FROM t1;
                INVALID SYNTAX HERE;
                SELECT b FROM t2;
            "#
            .to_string(),
            is_procedure: false,
            transformed_content: None,
        }]);

        let (statements, issues) = collect_statements(&request);

        assert_eq!(statements.len(), 2, "Expected 2 valid statements");
        assert_eq!(issues.len(), 1, "Expected 1 parse error");

        // Error message should include file name
        assert!(
            issues[0].message.contains("test.sql"),
            "Error should mention file name"
        );

        // Issue should have source_name set
        assert_eq!(
            issues[0].source_name.as_deref(),
            Some("test.sql"),
            "Issue should have source_name set"
        );
    }

    #[test]
    fn best_effort_parsing_multiple_errors() {
        let mut request = base_request();
        request.sql = r#"
            SELECT 1;
            BROKEN STATEMENT 1;
            SELECT 2;
            BROKEN STATEMENT 2;
            SELECT 3;
        "#
        .to_string();

        let (statements, issues) = collect_statements(&request);

        assert_eq!(statements.len(), 3, "Expected 3 valid statements");
        assert_eq!(issues.len(), 2, "Expected 2 parse errors");
    }

    #[test]
    fn empty_sql_returns_no_statements() {
        let sql = "";
        let ranges = compute_statement_ranges(sql);
        assert!(ranges.is_empty(), "Empty SQL should produce no ranges");
    }

    #[test]
    fn whitespace_only_sql_returns_no_statements() {
        let sql = "   \n\t\r\n   ";
        let ranges = compute_statement_ranges(sql);
        assert!(
            ranges.is_empty(),
            "Whitespace-only SQL should produce no ranges"
        );
    }

    #[test]
    fn comments_only_sql_returns_no_statements() {
        let sql = "-- just a comment\n/* another comment */";
        let ranges = compute_statement_ranges(sql);
        assert!(
            ranges.is_empty(),
            "Comments-only SQL should produce no ranges"
        );
    }

    #[test]
    fn empty_inline_sql_with_valid_file() {
        let mut request = base_request();
        request.sql = "   ".to_string(); // whitespace only
        request.files = Some(vec![FileSource {
            name: "file.sql".to_string(),
            content: "SELECT 1".to_string(),
            is_procedure: false,
            transformed_content: None,
        }]);

        let (statements, issues) = collect_statements(&request);
        assert!(issues.is_empty());
        assert_eq!(statements.len(), 1);
        assert_eq!(
            statements[0].source_name.as_deref().map(String::as_str),
            Some("file.sql")
        );
    }

    #[test]
    fn statement_ranges_handle_unicode_identifiers() {
        // Test with multi-byte Unicode characters (Japanese, emoji, etc.)
        let sql = "SELECT '日本語' AS 名前; SELECT '🎉' AS emoji;";
        let ranges = compute_statement_ranges(sql);
        assert_eq!(ranges.len(), 2);
        assert_eq!(&sql[ranges[0].clone()], "SELECT '日本語' AS 名前");
        assert_eq!(&sql[ranges[1].clone()], "SELECT '🎉' AS emoji");
    }

    #[test]
    fn statement_ranges_handle_unicode_in_strings() {
        // Ensure semicolons inside Unicode strings are not treated as delimiters
        let sql = "SELECT '你好;世界' AS greeting; SELECT 2;";
        let ranges = compute_statement_ranges(sql);
        assert_eq!(ranges.len(), 2);
        assert_eq!(&sql[ranges[0].clone()], "SELECT '你好;世界' AS greeting");
        assert_eq!(&sql[ranges[1].clone()], "SELECT 2");
    }

    #[test]
    fn statement_ranges_handle_mixed_ascii_unicode() {
        // Mix of ASCII and various Unicode scripts
        let sql = "SELECT 'café' AS drink; SELECT 'naïve' AS word; SELECT 'Müller' AS name;";
        let ranges = compute_statement_ranges(sql);
        assert_eq!(ranges.len(), 3);
        assert_eq!(&sql[ranges[0].clone()], "SELECT 'café' AS drink");
        assert_eq!(&sql[ranges[1].clone()], "SELECT 'naïve' AS word");
        assert_eq!(&sql[ranges[2].clone()], "SELECT 'Müller' AS name");
    }

    #[test]
    fn quote_shell_vars_wraps_bare_curly() {
        assert_eq!(
            quote_shell_vars("WHERE date_id BETWEEN {date_id} AND {max_dt}"),
            "WHERE date_id BETWEEN '{date_id}' AND '{max_dt}'"
        );
    }

    #[test]
    fn quote_shell_vars_preserves_vars_inside_single_quotes() {
        // Anything inside single quotes is a string literal — don't touch it
        assert_eq!(
            quote_shell_vars("WHERE tdbank_imp_date='${DATA_DT}23'"),
            "WHERE tdbank_imp_date='${DATA_DT}23'"
        );
        assert_eq!(
            quote_shell_vars("WHERE dt = '${DATA_DT}'"),
            "WHERE dt = '${DATA_DT}'"
        );
        assert_eq!(
            quote_shell_vars("WHERE date_id = '{date_id}'"),
            "WHERE date_id = '{date_id}'"
        );
        // Prefix text before the variable — still inside quotes
        assert_eq!(
            quote_shell_vars("WHERE dt = concat('prefix_', '${DATA_DT}23')"),
            "WHERE dt = concat('prefix_', '${DATA_DT}23')"
        );
        // Multi-variable inside single quotes
        assert_eq!(
            quote_shell_vars("WHERE x = '${A}_${B}'"),
            "WHERE x = '${A}_${B}'"
        );
    }

    #[test]
    fn quote_shell_vars_still_wraps_unquoted_dollar_brace_with_trailing_digits() {
        // ${DATA_DT}23 without surrounding quotes should still be wrapped
        assert_eq!(
            quote_shell_vars("WHERE dt = ${DATA_DT}23"),
            "WHERE dt = '${DATA_DT}'23"
        );
    }

    #[test]
    fn quote_shell_vars_wraps_dollar_brace() {
        assert_eq!(
            quote_shell_vars("WHERE dt = ${DATA_DT}"),
            "WHERE dt = '${DATA_DT}'"
        );
    }

    #[test]
    fn quote_shell_vars_handles_line_with_select_and_where() {
        let input = "WHERE date_id BETWEEN {date_id}\n         AND (SELECT max(date_id) FROM src)\n         AND length(ELEMENT_AT(SPLIT(cgi, '-'), 4)) <= 3";
        let expected = "WHERE date_id BETWEEN '{date_id}'\n         AND (SELECT max(date_id) FROM src)\n         AND length(ELEMENT_AT(SPLIT(cgi, '-'), 4)) <= 3";
        assert_eq!(quote_shell_vars(input), expected);
    }

    #[test]
    fn quote_shell_vars_skips_non_identifier_braces() {
        assert_eq!(quote_shell_vars("{1, 2, 3}"), "{1, 2, 3}");
        assert_eq!(quote_shell_vars("x = {-5}"), "x = {-5}");
    }

    #[test]
    fn end_to_end_bare_curly_parses() {
        let sql = "SELECT date_id, cgi AS cgi, trim(tower_id) AS tower_id FROM smartfren_analytic_prd.ods_cc.prd_xldim_acl_tb_f_d_bts_ref_hist WHERE date_id BETWEEN {date_id} AND (SELECT max(date_id) FROM smartfren_analytic_prd.ods_cc.prd_xldim_acl_tb_f_d_bts_ref_hist) AND length(ELEMENT_AT(SPLIT(cgi, '-'), 4)) <= 3";
        let mut request = base_request();
        request.dialect = Dialect::Hive;
        request.sql = sql.to_string();
        let (statements, issues) = collect_statements(&request);
        for issue in &issues {
            eprintln!("ISSUE: {:?}", issue);
        }
        assert!(issues.is_empty(), "Expected no parse issues, got {:?}", issues);
        assert!(!statements.is_empty(), "Should have at least one statement");
    }

    #[test]
    fn unicode_sql_parses_correctly() {
        let mut request = base_request();
        request.sql = "SELECT '日本' AS country; SELECT 'émoji: 🚀' AS test;".to_string();

        let (statements, issues) = collect_statements(&request);
        assert!(issues.is_empty(), "Expected no issues, got {issues:?}");
        assert_eq!(statements.len(), 2);

        // Verify the source ranges correctly capture the Unicode content
        let first_sql = &statements[0].source_sql[statements[0].source_range.clone()];
        let second_sql = &statements[1].source_sql[statements[1].source_range.clone()];
        assert!(
            first_sql.contains("日本"),
            "First statement should contain Japanese: {first_sql}"
        );
        assert!(
            second_sql.contains("🚀"),
            "Second statement should contain rocket emoji: {second_sql}"
        );
    }
}
