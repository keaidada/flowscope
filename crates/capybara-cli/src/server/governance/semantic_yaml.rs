//! dbt Semantic Layer YAML generation from lineage data.
//!
//! Uses `lineage_columns`, `lineage_edges`, `lineage_nodes` (column-level
//! lineage) plus `table_level_edges` (table relationships) to generate
//! `semantic_models.yml` format YAML for each script's output table.

use rusqlite::{params, Connection};
use std::collections::{HashMap, HashSet};

/// Result of semantic YAML generation.
pub struct SemanticYamlResult {
    pub yaml: String,
    pub model_name: String,
    pub dimension_count: usize,
    pub measure_count: usize,
    pub source_count: usize,
}

/// Generate dbt Semantic Layer YAML for a single script.
///
/// Reads lineage data (scoped by `file_path`) to classify each output column
/// as a measure (aggregation) or dimension (categorical/time), then emits YAML.
pub fn generate_semantic_yaml(
    conn: &Connection,
    project_id: &str,
    file_path: &str,
) -> Result<SemanticYamlResult, String> {
    let script_name = std::path::Path::new(file_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(file_path);

    // 1. Get to_table and from_tables from table_level_edges.
    let (to_table, from_tables) = query_table_edges(conn, project_id, script_name)?;

    if to_table.is_empty() {
        return Err(format!("No output table found for {script_name}"));
    }

    let model_name = normalize_name(&to_table);

    // 2. Find output table node in lineage_nodes (try multiple match strategies).
    let output_node_id = find_output_node(conn, project_id, file_path, &to_table)?;

    // 3. Get all columns of the output table.
    let columns = query_output_columns(conn, project_id, file_path, &output_node_id)?;

    if columns.is_empty() {
        return Err(format!("No columns found for output table {to_table}"));
    }

    // 4. Classify each column as measure or dimension via BFS lineage tracing.
    let mut dimensions: Vec<DimInfo> = Vec::new();
    let mut measures: Vec<MeasureInfo> = Vec::new();
    let time_dim_name = find_time_dimension(&columns);

    for col in &columns {
        if let Some((agg, expr)) = trace_aggregation(conn, project_id, &col.column_id) {
            measures.push(MeasureInfo {
                name: to_snake_case(&col.label),
                agg,
                expr,
                agg_time_dimension: time_dim_name.clone(),
            });
        } else {
            let dim_type = classify_dimension(&col.label);
            dimensions.push(DimInfo {
                name: to_snake_case(&col.label),
                dim_type,
            });
        }
    }

    let source_count = from_tables.len();
    let yaml = format_yaml(&model_name, &to_table, &from_tables, &dimensions, &measures, &time_dim_name);

    Ok(SemanticYamlResult {
        yaml,
        model_name,
        dimension_count: dimensions.len(),
        measure_count: measures.len(),
        source_count,
    })
}

// ── Data structures ──────────────────────────────────────────────────────

struct ColInfo {
    column_id: String,
    label: String,
}

struct DimInfo {
    name: String,
    dim_type: DimensionType,
}

enum DimensionType {
    Time { granularity: String },
    Categorical,
}

struct MeasureInfo {
    name: String,
    agg: String,
    expr: String,
    agg_time_dimension: Option<String>,
}

// ── Query helpers ────────────────────────────────────────────────────────

/// Query to_table and from_tables from table_level_edges.
fn query_table_edges(
    conn: &Connection,
    project_id: &str,
    script_name: &str,
) -> Result<(String, Vec<String>), String> {
    let mut to_table = String::new();
    let mut from_tables: Vec<String> = Vec::new();

    // Try script_name match first, then script (full path) match.
    let sql = "SELECT DISTINCT from_table, to_table FROM table_level_edges \
               WHERE project_id = ?1 AND script_name = ?2";
    if let Ok(mut stmt) = conn.prepare(sql) {
        let rows = stmt.query_map(params![project_id, script_name], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        });
        if let Ok(rows) = rows {
            let mut seen_from = HashSet::new();
            for row in rows.flatten() {
                if to_table.is_empty() {
                    to_table = row.1.clone();
                }
                if seen_from.insert(row.0.clone()) {
                    from_tables.push(row.0);
                }
            }
        }
    }

    Ok((to_table, from_tables))
}

/// Find the lineage_nodes node_id for the output table of this script.
fn find_output_node(
    conn: &Connection,
    project_id: &str,
    file_path: &str,
    to_table: &str,
) -> Result<String, String> {
    let to_table_lower = to_table.to_lowercase();
    let short_name = normalize_name(&to_table_lower);

    // Collect all output/table/view nodes for this file.
    let sql = "SELECT node_id, label FROM lineage_nodes \
               WHERE project_id = ?1 AND file_path = ?2 AND node_type IN ('output', 'table', 'view')";
    let candidates: Vec<(String, String)> = if let Ok(mut stmt) = conn.prepare(sql) {
        let rows = stmt.query_map(params![project_id, file_path], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        });
        rows.ok()
            .map(|r| r.flatten().collect())
            .unwrap_or_default()
    } else {
        Vec::new()
    };

    // Strategy 1: exact label match (case-insensitive).
    for (node_id, label) in &candidates {
        if label.to_lowercase() == to_table_lower {
            return Ok(node_id.clone());
        }
    }

    // Strategy 2: normalized short name match.
    for (node_id, label) in &candidates {
        if normalize_name(&label.to_lowercase()) == short_name {
            return Ok(node_id.clone());
        }
    }

    // Strategy 3: partial contains match.
    for (node_id, label) in &candidates {
        if normalize_name(&label.to_lowercase()).contains(&short_name) {
            return Ok(node_id.clone());
        }
    }

    Err(format!(
        "Output table node '{to_table}' not found in lineage_nodes for {file_path}"
    ))
}

/// Query all columns belonging to the output table node.
fn query_output_columns(
    conn: &Connection,
    project_id: &str,
    file_path: &str,
    node_id: &str,
) -> Result<Vec<ColInfo>, String> {
    let mut columns = Vec::new();

    let sql = "SELECT column_id, label FROM lineage_columns \
               WHERE project_id = ?1 AND file_path = ?2 AND parent_node_id = ?3 \
               ORDER BY label";
    if let Ok(mut stmt) = conn.prepare(sql) {
        let rows = stmt.query_map(params![project_id, file_path, node_id], |row| {
            Ok(ColInfo {
                column_id: row.get(0)?,
                label: row.get(1)?,
            })
        });
        if let Ok(rows) = rows {
            // Deduplicate by label (some files have duplicate column entries).
            let mut seen = HashSet::new();
            for col in rows.flatten() {
                if seen.insert(col.label.to_lowercase()) {
                    columns.push(col);
                }
            }
        }
    }

    Ok(columns)
}

/// BFS backward through data_flow/cross_statement edges to find if a column
/// traces back to an aggregation derivation.
/// Returns (agg_function, inner_expression).
///
/// NOTE: The BFS does NOT filter by file_path — column_id values are globally
/// unique (hash-based), and the lineage chain may span multiple copies of the
/// same script (e.g. `etl/ALL/` and `etl/A01_应用集市库-BI/`).
fn trace_aggregation(
    conn: &Connection,
    project_id: &str,
    column_id: &str,
) -> Option<(String, String)> {
    let mut visited = HashSet::new();
    let mut queue = vec![column_id.to_string()];

    while let Some(col_id) = queue.pop() {
        if !visited.insert(col_id.clone()) {
            continue;
        }

        // Single query: get all edges pointing TO this column (no file_path filter).
        let sql = "SELECT edge_type, expression, from_id FROM lineage_edges \
                   WHERE project_id = ?1 AND to_id = ?2 \
                   AND edge_type IN ('derivation', 'data_flow', 'cross_statement')";
        if let Ok(mut stmt) = conn.prepare(sql) {
            let rows = stmt.query_map(params![project_id, &col_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1).unwrap_or_default(),
                    row.get::<_, String>(2).unwrap_or_default(),
                ))
            });
            if let Ok(rows) = rows {
                for (etype, expr, from_id) in rows.flatten() {
                    if etype == "derivation" {
                        if let Some(parsed) = parse_aggregation(&expr) {
                            return Some(parsed);
                        }
                    } else {
                        // data_flow or cross_statement: follow upstream.
                        if !from_id.is_empty() {
                            queue.push(from_id);
                        }
                    }
                }
            }
        }
    }

    None
}

/// Parse an SQL expression and extract aggregation function + inner expression.
/// Returns Some((agg, inner)) if the expression is an aggregation.
fn parse_aggregation(expr: &str) -> Option<(String, String)> {
    let trimmed = expr.trim();
    let lower = trimmed.to_lowercase();

    // Check if this is a pure aggregation (starts with agg( and ends with ))
    // vs a compound expression (e.g. sum(a) / sum(b)).
    for agg in &[
        "count_distinct",
        "count",
        "sum",
        "avg",
        "min",
        "max",
        "median",
    ] {
        let prefix = format!("{}(", agg);
        let prefix_lower = prefix.to_lowercase();
        if lower.starts_with(&prefix_lower) {
            // Find the matching closing paren for the first '('.
            let open_pos = agg.len(); // position of '('
            let mut depth = 0i32;
            let mut close_pos = None;
            for (i, ch) in trimmed.char_indices() {
                if i < open_pos {
                    continue;
                }
                match ch {
                    '(' => depth += 1,
                    ')' => {
                        depth -= 1;
                        if depth == 0 {
                            close_pos = Some(i);
                            break;
                        }
                    }
                    _ => {}
                }
            }

            // Check if the expression is PURE aggregation (nothing after closing paren).
            let is_pure = close_pos.map_or(false, |cp| {
                trimmed[cp + 1..].trim().is_empty()
            });

            if is_pure && close_pos.is_some() {
                let inner = &trimmed[open_pos + 1..close_pos.unwrap()];
                let inner_clean = inner.trim();
                // Strip "distinct" keyword for count.
                if inner_clean.to_lowercase().starts_with("distinct ") {
                    let stripped = inner_clean["distinct ".len()..].trim();
                    return Some((agg.to_string(), stripped.to_string()));
                }
                return Some((agg.to_string(), inner_clean.to_string()));
            } else {
                // Compound expression like sum(a) / sum(b) → derived.
                return Some(("derived".to_string(), trimmed.to_string()));
            }
        }
    }

    // Check if expression contains aggregations anywhere (derived/ratio).
    let has_agg = ["sum(", "count(", "avg(", "min(", "max("]
        .iter()
        .any(|a| lower.contains(a));
    if has_agg {
        return Some(("derived".to_string(), trimmed.to_string()));
    }

    None
}

/// Strip the outermost parentheses from an expression: "(x)" → "x".
fn strip_outer_parens(s: &str) -> String {
    let s = s.trim();
    if s.starts_with('(') && s.ends_with(')') {
        // Verify the closing paren matches the opening one.
        let mut depth = 0i32;
        let chars: Vec<char> = s.chars().collect();
        for (i, &ch) in chars.iter().enumerate() {
            match ch {
                '(' => depth += 1,
                ')' => {
                    depth -= 1;
                    if depth == 0 && i == chars.len() - 1 {
                        return s[1..s.len() - 1].trim().to_string();
                    } else if depth == 0 {
                        break; // Closing paren doesn't match opening.
                    }
                }
                _ => {}
            }
        }
    }
    s.to_string()
}

/// Find the first time-like column name to use as the default time dimension.
fn find_time_dimension(columns: &[ColInfo]) -> Option<String> {
    for col in columns {
        let lower = col.label.to_lowercase();
        if is_time_column(&lower) {
            return Some(to_snake_case(&col.label));
        }
    }
    None
}

/// Classify a column as time or categorical based on its name.
fn classify_dimension(label: &str) -> DimensionType {
    let lower = label.to_lowercase();
    if is_time_column(&lower) {
        let granularity = infer_granularity(&lower);
        DimensionType::Time { granularity }
    } else {
        DimensionType::Categorical
    }
}

/// Check if a column name looks like a time/date column.
fn is_time_column(lower: &str) -> bool {
    // Exact matches.
    const TIME_EXACT: &[&str] = &[
        "data_dt", "statt_tm", "stat_tm", "partition", "data_date",
        "imp_date", "tdbank_imp_date",
    ];
    for &t in TIME_EXACT {
        if lower == t {
            return true;
        }
    }
    // Suffix matches.
    const TIME_SUFFIX: &[&str] = &["_dt", "_date", "_time", "_tm"];
    for &s in TIME_SUFFIX {
        if lower.ends_with(s) {
            return true;
        }
    }
    false
}

/// Infer time granularity from a column name.
fn infer_granularity(lower: &str) -> String {
    if lower.contains("hour") {
        "hour".to_string()
    } else if lower.contains("week") {
        "week".to_string()
    } else if lower.contains("month") {
        "month".to_string()
    } else if lower.contains("quarter") {
        "quarter".to_string()
    } else if lower.contains("year") {
        "year".to_string()
    } else {
        // Default to day for _dt/_date/statt_tm patterns.
        "day".to_string()
    }
}

/// Normalize a table name for use as a YAML key: strip schema prefix, then
/// lowercase + snake_case.
fn normalize_name(name: &str) -> String {
    // Strip schema/database prefix: "mat_db.table" → "table"
    let short = match name.rfind('.') {
        Some(pos) => &name[pos + 1..],
        None => name,
    };
    to_snake_case(short)
}

/// Convert CamelCase or mixed case to snake_case.
/// Handles consecutive uppercase letters (e.g. "UV" → "uv", not "u_v").
fn to_snake_case(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut result = String::with_capacity(s.len() + 4);
    for (i, &ch) in chars.iter().enumerate() {
        if ch.is_uppercase() {
            // Add underscore before uppercase char IF:
            // - previous char is lowercase, OR
            // - next char is lowercase (transition from uppercase block to lowercase)
            if i > 0 && !result.ends_with('_') {
                let prev = chars[i - 1];
                let next = chars.get(i + 1);
                if prev.is_lowercase() || prev.is_ascii_digit() {
                    result.push('_');
                } else if prev.is_uppercase() && next.map_or(false, |c| c.is_lowercase()) {
                    result.push('_');
                }
            }
            result.extend(ch.to_lowercase());
        } else if ch == '-' || ch == ' ' {
            result.push('_');
        } else {
            result.push(ch);
        }
    }
    result
}

// ── YAML formatting ──────────────────────────────────────────────────────

fn format_yaml(
    model_name: &str,
    to_table: &str,
    from_tables: &[String],
    dimensions: &[DimInfo],
    measures: &[MeasureInfo],
    time_dim: &Option<String>,
) -> String {
    let mut yaml = String::with_capacity(2048);

    yaml.push_str("semantic_models:\n");
    yaml.push_str(&format!("  - name: {model_name}\n"));
    yaml.push_str(&format!("    model: ref('{to_table}')\n"));

    if !from_tables.is_empty() {
        yaml.push_str(&format!(
            "    description: 'Sources: {}'\n",
            from_tables.join(", ")
        ));
    }

    yaml.push('\n');

    // Default entity (best-effort: use table short name + _id).
    // Skipped for now — user can add manually.

    // Dimensions
    if !dimensions.is_empty() {
        yaml.push_str("    dimensions:\n");
        for d in dimensions {
            yaml.push_str(&format!("      - name: {}\n", d.name));
            match &d.dim_type {
                DimensionType::Time { granularity } => {
                    yaml.push_str("        type: time\n");
                    yaml.push_str("        type_params:\n");
                    yaml.push_str(&format!("          time_granularity: {granularity}\n"));
                }
                DimensionType::Categorical => {
                    yaml.push_str("        type: categorical\n");
                }
            }
        }
        yaml.push('\n');
    }

    // Measures
    if !measures.is_empty() {
        yaml.push_str("    measures:\n");
        for m in measures {
            yaml.push_str(&format!("      - name: {}\n", m.name));
            yaml.push_str(&format!("        agg: {}\n", m.agg));
            yaml.push_str(&format!("        expr: {}\n", m.expr));
            if let Some(td) = &m.agg_time_dimension {
                yaml.push_str(&format!("        agg_time_dimension: {td}\n"));
            }
            yaml.push_str("        create_metric: true\n");
        }
        yaml.push('\n');
    }

    // Also generate simple metrics list (one per measure with create_metric).
    if !measures.is_empty() {
        yaml.push_str("metrics:\n");
        for m in measures {
            yaml.push_str(&format!("  - name: {}\n", m.name));
            yaml.push_str(&format!("    label: {}\n", capitalize_words(&m.name)));
            yaml.push_str("    type: simple\n");
            yaml.push_str("    type_params:\n");
            yaml.push_str(&format!("      measure:\n"));
            yaml.push_str(&format!("        name: {}\n", m.name));
            yaml.push('\n');
        }
    }

    let _ = time_dim; // already used in measures
    yaml
}

/// Capitalize each word in a snake_case name for human-readable labels.
fn capitalize_words(s: &str) -> String {
    s.split('_')
        .map(|w| {
            let mut c = w.chars();
            match c.next() {
                Some(first) => first.to_uppercase().collect::<String>() + c.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

// ── Tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_aggregation_sum() {
        let (agg, expr) = parse_aggregation("sum(Exp_UV)").unwrap();
        assert_eq!(agg, "sum");
        assert_eq!(expr, "Exp_UV");
    }

    #[test]
    fn test_parse_aggregation_count_distinct() {
        let (agg, expr) = parse_aggregation("count(distinct Usr_ID)").unwrap();
        assert_eq!(agg, "count");
        assert_eq!(expr, "Usr_ID");
    }

    #[test]
    fn test_parse_aggregation_ratio() {
        let (agg, _expr) = parse_aggregation("sum(a) / sum(b)").unwrap();
        assert_eq!(agg, "derived");
    }

    #[test]
    fn test_parse_aggregation_non_agg() {
        assert!(parse_aggregation("a1.Acct_Num_Desc").is_none());
        assert!(parse_aggregation("current_date").is_none());
    }

    #[test]
    fn test_to_snake_case() {
        assert_eq!(to_snake_case("Exp_UV"), "exp_uv");
        assert_eq!(to_snake_case("AcctNumDesc"), "acct_num_desc");
        assert_eq!(to_snake_case("PV"), "pv");
        assert_eq!(to_snake_case("per_capt_pdura"), "per_capt_pdura");
    }

    #[test]
    fn test_is_time_column() {
        assert!(is_time_column("data_dt"));
        assert!(is_time_column("statt_tm"));
        assert!(is_time_column("imp_date"));
        assert!(!is_time_column("acct_num_desc"));
        assert!(!is_time_column("pv"));
    }

    #[test]
    fn test_strip_outer_parens() {
        assert_eq!(strip_outer_parens("(x)"), "x");
        assert_eq!(strip_outer_parens("((x))"), "(x)");
        assert_eq!(strip_outer_parens("(a)+(b)"), "(a)+(b)");
    }

    #[test]
    fn test_capitalize_words() {
        assert_eq!(capitalize_words("exp_uv"), "Exp Uv");
        assert_eq!(capitalize_words("pv"), "Pv");
        assert_eq!(capitalize_words("per_capt_pdura"), "Per Capt Pdura");
    }
}
