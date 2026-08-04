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
    /// True when the script has no usable lineage data (no output table /
    /// no columns) — not an error, just nothing to generate. Frontend counts
    /// these as "skipped" rather than "failed".
    pub skipped: bool,
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
    let (mut to_table, mut from_tables) = query_table_edges(conn, project_id, script_name)?;

    // Fallback 1: if table_level_edges has no row for this script (e.g. the
    // repopulate step hasn't run), derive the output table + source tables
    // from lineage_nodes + data_flow edges directly.
    if to_table.is_empty() {
        if let Some((out, srcs)) = find_output_from_nodes(conn, project_id, file_path) {
            to_table = out;
            from_tables = srcs;
        }
    }

    // Fallback 2: if still no to_table AND lineage_nodes is empty for this
    // file (analysis never ran on it), parse the SQL content for INSERT
    // INTO/OVERWRITE TABLE to find the output table name.
    if to_table.is_empty() {
        let content = store_load_content(conn, project_id, file_path).unwrap_or_default();
        if content.trim().is_empty() {
            return Ok(SemanticYamlResult {
                yaml: String::new(),
                model_name: script_name.to_string(),
                dimension_count: 0,
                measure_count: 0,
                source_count: 0,
                skipped: true,
            });
        }
        if let Some(table) = parse_insert_target_from_sql(&content) {
            to_table = table;
        }
    }

    if to_table.is_empty() {
        let has_content = match store_load_content(conn, project_id, file_path) {
            Some(c) => !c.trim().is_empty(),
            None => false,
        };
        if !has_content {
            return Ok(SemanticYamlResult {
                yaml: String::new(),
                model_name: script_name.to_string(),
                dimension_count: 0,
                measure_count: 0,
                source_count: 0,
                skipped: true,
            });
        }
        return Err(format!(
            "No output table found for {script_name} (content present but lineage has no to_table)"
        ));
    }

    let model_name = normalize_name(&to_table);

    // 2. Find output table node in lineage_nodes (try multiple match strategies).
    let output_node_id = match find_output_node(conn, project_id, file_path, &to_table) {
        Ok(nid) => nid,
        Err(_) => {
            // No lineage node at all — analysis never ran on this file.
            // Generate a minimal YAML from the SQL content (INSERT target +
            // column list from the SELECT).
            let content = store_load_content(conn, project_id, file_path).unwrap_or_default();
            return Ok(generate_minimal_yaml_from_sql(&content, &to_table, &from_tables, script_name));
        }
    };

    // 3. Get all columns of the output table — scoped to THIS file only.
    let columns = match query_output_columns(conn, project_id, file_path, &output_node_id) {
        Ok(c) if !c.is_empty() => c,
        _ => {
            // No columns in lineage — try SQL content.
            let content = store_load_content(conn, project_id, file_path).unwrap_or_default();
            return Ok(generate_minimal_yaml_from_sql(&content, &to_table, &from_tables, script_name));
        }
    };

    if columns.is_empty() {
        // Table node exists but no columns recorded. If the script has
        // content, treat as failed (lineage incomplete); else skipped.
        let has_content = match store_load_content(conn, project_id, file_path) {
            Some(c) => !c.trim().is_empty(),
            None => false,
        };
        if !has_content {
            return Ok(SemanticYamlResult {
                yaml: String::new(),
                model_name,
                dimension_count: 0,
                measure_count: 0,
                source_count: 0,
                skipped: true,
            });
        }
        return Err(format!(
            "No columns found for output table {to_table} (content present but lineage has no columns)"
        ));
    }

    // 4. Classify each column as measure or dimension via BFS lineage tracing.
    //    Load ONLY this script's lineage edges (by file_name) — the DB is the
    //    source of truth, no full-project preload.
    let edge_map = load_edges_map(conn, project_id, script_name);
    let mut dimensions: Vec<DimInfo> = Vec::new();
    let mut measures: Vec<MeasureInfo> = Vec::new();
    let time_dim_name = find_time_dimension(&columns);

    for col in &columns {
        if let Some((agg, expr)) = trace_aggregation_mem(&edge_map, &col.column_id) {
            measures.push(MeasureInfo {
                name: to_snake_case(&col.label),
                agg,
                expr,
                agg_time_dimension: time_dim_name.clone(),
            });
        } else {
            let dim_type = classify_dimension(&col.label);
            // Generate description from expression
            let description = col.expression.as_ref().and_then(|expr| {
                let trimmed = expr.trim();
                if trimmed.is_empty() {
                    None
                } else {
                    Some(trimmed.to_string())
                }
            });
            // For col_N auto-named columns, try to infer a better name
            let name = if col.label.starts_with("col_") {
                if let Some(ref expr) = col.expression {
                    infer_name_from_expression(expr).unwrap_or_else(|| to_snake_case(&col.label))
                } else {
                    to_snake_case(&col.label)
                }
            } else {
                to_snake_case(&col.label)
            };
            dimensions.push(DimInfo {
                name,
                dim_type,
                description,
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
        skipped: false,
    })
}

// ── Data structures ──────────────────────────────────────────────────────

struct ColInfo {
    column_id: String,
    label: String,
    expression: Option<String>,
}

struct DimInfo {
    name: String,
    dim_type: DimensionType,
    description: Option<String>,
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

/// Load the file content from project_files for a given path.
/// Returns None if the file doesn't exist or has no content.
fn store_load_content(conn: &Connection, project_id: &str, file_path: &str) -> Option<String> {
    let sql = "SELECT content FROM project_files WHERE project_id = ?1 AND path = ?2 AND status = 1";
    if let Ok(mut stmt) = conn.prepare(sql) {
        if let Ok(mut rows) = stmt.query_map(params![project_id, file_path], |row| {
            row.get::<_, String>(0)
        }) {
            if let Some(Ok(content)) = rows.next() {
                return Some(content);
            }
        }
    }
    None
}

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

/// Find the output table and source tables of a script from lineage_nodes +
/// data_flow edges, WITHOUT relying on table_level_edges.
///
/// A table node that has an incoming data_flow edge whose from is a CTE (or
/// another table) is a candidate output; tables that only appear as FROM
/// sources are inputs.
fn find_output_from_nodes(
    conn: &Connection,
    project_id: &str,
    file_path: &str,
) -> Option<(String, Vec<String>)> {
    // 1. table/view nodes in this file.
    let mut node_qn: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let sql_nodes = "SELECT node_id, COALESCE(qualified_name, label) FROM lineage_nodes \
                     WHERE project_id = ?1 AND file_path = ?2 AND node_type IN ('table', 'view')";
    if let Ok(mut stmt) = conn.prepare(sql_nodes) {
        if let Ok(rows) = stmt.query_map(params![project_id, file_path], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        }) {
            for r in rows.flatten() {
                node_qn.insert(r.0, r.1.to_lowercase());
            }
        }
    }
    if node_qn.is_empty() {
        return None;
    }

    // 2. Which table nodes are written to (have a data_flow edge as `to`)?
    let mut written: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut read: std::collections::HashSet<String> = std::collections::HashSet::new();
    let sql_edges = "SELECT from_id, to_id FROM lineage_edges \
                     WHERE project_id = ?1 AND file_path = ?2 \
                     AND REPLACE(LOWER(edge_type),'_','') = 'dataflow'";
    if let Ok(mut stmt) = conn.prepare(sql_edges) {
        if let Ok(rows) = stmt.query_map(params![project_id, file_path], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        }) {
            for (f, t) in rows.flatten() {
                if node_qn.contains_key(&t) {
                    written.insert(node_qn[&t].clone());
                }
                if node_qn.contains_key(&f) {
                    read.insert(node_qn[&f].clone());
                }
            }
        }
    }

    // 3. Output = written table (prefer one that's NOT also read-only).
    let outputs: Vec<&String> = written.iter().collect();
    if outputs.is_empty() {
        return None;
    }
    let output = outputs[0].clone();
    // Sources = read tables except the output itself.
    let mut sources: Vec<String> = read
        .iter()
        .filter(|q| *q != &output)
        .cloned()
        .collect();
    sources.sort();
    sources.dedup();

    Some((output, sources))
}

/// Parse the SQL content for an `INSERT INTO/OVERWRITE TABLE <name>` to
/// determine the output table when lineage analysis hasn't run on the file.
///
/// Handles `USE db;` to prepend the schema when the table name has no prefix.
fn parse_insert_target_from_sql(sql: &str) -> Option<String> {
    // Track current database from USE statements.
    let mut current_db = String::new();
    for line in sql.lines() {
        let trimmed = line.trim();
        let lower = trimmed.to_lowercase();

        // USE <db>;
        if lower.starts_with("use ") {
            let rest = trimmed[4..].trim().trim_end_matches(';').trim();
            if !rest.is_empty() {
                current_db = rest.to_string();
            }
            continue;
        }

        // INSERT INTO TABLE <name>  /  INSERT OVERWRITE TABLE <name>
        // INSERT INTO <name>        /  INSERT OVERWRITE <name>
        if lower.starts_with("insert ") {
            let after_insert = &trimmed[7..]; // skip "insert "
            let after_lower = after_insert.to_lowercase();
            let rest = if after_lower.starts_with("overwrite ") {
                &after_insert[10..] // skip "overwrite "
            } else if after_lower.starts_with("into ") {
                &after_insert[5..] // skip "into "
            } else {
                continue;
            };
            let rest_lower = rest.to_lowercase();
            let after_table = if rest_lower.starts_with("table ") {
                rest[6..].trim_start() // skip "table " + any extra spaces
            } else {
                rest.trim_start()
            };
            // Read table name until space, paren, or end.
            let name: String = after_table
                .chars()
                .take_while(|c| !c.is_whitespace() && *c != '(' && *c != ';')
                .collect();
            let name = name.trim();
            if name.is_empty() {
                continue;
            }
            // Prepend current_db if the name has no schema prefix.
            if !name.contains('.') && !current_db.is_empty() {
                return Some(format!("{current_db}.{name}").to_lowercase());
            }
            return Some(name.to_lowercase());
        }
    }
    None
}

/// Find the lineage_nodes node_id for the output table of this script.
///
/// A physical table may be written by MANY scripts (each a copy / different
/// report over the same table), so its node is NOT guaranteed to live under
/// the current file_path. Match by qualified_name / label across the whole
/// project instead — the DB is the source of truth.
fn find_output_node(
    conn: &Connection,
    project_id: &str,
    file_path: &str,
    to_table: &str,
) -> Result<String, String> {
    let to_table_lower = to_table.to_lowercase();
    let short_name = normalize_name(&to_table_lower);

    // Strategy 1: qualified_name exact match (whole project).
    let sql_qn = "SELECT node_id, qualified_name FROM lineage_nodes \
                  WHERE project_id = ?1 AND lower(qualified_name) = ?2 \
                  AND node_type IN ('output', 'table', 'view') LIMIT 1";
    if let Ok(mut stmt) = conn.prepare(sql_qn) {
        if let Ok(mut rows) = stmt.query_map(params![project_id, &to_table_lower], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        }) {
            if let Some(Ok((nid, _))) = rows.next() {
                return Ok(nid);
            }
        }
    }

    // Strategy 2: qualified_name ends_with the short name (case-insensitive),
    // scoped to the current file first, then whole project.
    let like = format!("%.{short_name}");
    let sql_end = "SELECT node_id, qualified_name FROM lineage_nodes \
                   WHERE project_id = ?1 AND node_type IN ('output', 'table', 'view') \
                   AND lower(qualified_name) LIKE ?2 LIMIT 1";
    let sql_scoped = "SELECT node_id, qualified_name FROM lineage_nodes \
                      WHERE project_id = ?1 AND file_path = ?2 \
                      AND node_type IN ('output', 'table', 'view') \
                      AND lower(qualified_name) LIKE ?3 LIMIT 1";
    if let Ok(mut stmt) = conn.prepare(sql_scoped) {
        if let Ok(mut rows) = stmt.query_map(
            params![project_id, file_path, &like],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        ) {
            if let Some(Ok((nid, _))) = rows.next() {
                return Ok(nid);
            }
        }
    }
    if let Ok(mut stmt) = conn.prepare(sql_end) {
        if let Ok(mut rows) = stmt.query_map(
            params![project_id, &like],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        ) {
            if let Some(Ok((nid, _))) = rows.next() {
                return Ok(nid);
            }
        }
    }

    // Strategy 3: label exact match (whole project).
    let sql_lbl = "SELECT node_id, label FROM lineage_nodes \
                   WHERE project_id = ?1 AND lower(label) = ?2 \
                   AND node_type IN ('output', 'table', 'view') LIMIT 1";
    if let Ok(mut stmt) = conn.prepare(sql_lbl) {
        if let Ok(mut rows) = stmt.query_map(params![project_id, &to_table_lower], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        }) {
            if let Some(Ok((nid, _))) = rows.next() {
                return Ok(nid);
            }
        }
    }

    // Strategy 4: normalized short label match (whole project).
    let sql_short = "SELECT node_id, label FROM lineage_nodes \
                     WHERE project_id = ?1 AND node_type IN ('output', 'table', 'view')";
    if let Ok(mut stmt) = conn.prepare(sql_short) {
        let rows = stmt.query_map(params![project_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        });
        if let Ok(rows) = rows {
            for row in rows.flatten() {
                if normalize_name(&row.1.to_lowercase()) == short_name {
                    return Ok(row.0);
                }
            }
        }
    }

    Err(format!(
        "Output table node '{to_table}' not found in lineage_nodes for {file_path}"
    ))
}

/// Query columns belonging to the output table node, **scoped to the
/// current file_path only**. This prevents column contamination from other
/// scripts that reference the same table (they share the same node_id hash
/// but have their own columns under a different file_path).
fn query_output_columns(
    conn: &Connection,
    project_id: &str,
    file_path: &str,
    node_id: &str,
) -> Result<Vec<ColInfo>, String> {
    let mut columns = Vec::new();

    // Query ONLY this file's columns for the output node.
    let sql = "SELECT column_id, label, expression FROM lineage_columns \
               WHERE project_id = ?1 AND file_path = ?2 AND parent_node_id = ?3 \
               ORDER BY label";
    if let Ok(mut stmt) = conn.prepare(sql) {
        let rows = stmt.query_map(params![project_id, file_path, node_id], |row| {
            Ok(ColInfo {
                column_id: row.get(0)?,
                label: row.get(1)?,
                expression: row.get::<_, Option<String>>(2).unwrap_or(None),
            })
        });
        if let Ok(rows) = rows {
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

/// In-memory lineage edge graph: to_id → list of (edge_type, expr, from_id).
type EdgeGraph = std::collections::HashMap<String, Vec<(String, String, String)>>;

/// Load lineage edges for a SINGLE script by its file_name. Scripts may be
/// stored under multiple file_paths (copies), but share the same file_name —
/// this fetches all of them in one scoped query. Only the current script's
/// edges are loaded; no full-project scan.
pub fn load_edges_map(
    conn: &Connection,
    project_id: &str,
    file_name: &str,
) -> EdgeGraph {
    let mut graph: EdgeGraph = std::collections::HashMap::new();
    let sql = "SELECT to_id, edge_type, expression, from_id FROM lineage_edges \
               WHERE project_id = ?1 AND file_name = ?2 \
               AND REPLACE(LOWER(edge_type),'_','') IN ('derivation', 'dataflow', 'crossstatement')";
    if let Ok(mut stmt) = conn.prepare(sql) {
        let rows = stmt.query_map(params![project_id, file_name], |row| {
            Ok((
                row.get::<_, String>(0)?, // to_id
                row.get::<_, String>(1)?, // edge_type
                row.get::<_, String>(2).unwrap_or_default(), // expression
                row.get::<_, String>(3).unwrap_or_default(), // from_id
            ))
        });
        if let Ok(rows) = rows {
            for (to_id, etype, expr, from_id) in rows.flatten() {
                graph
                    .entry(to_id)
                    .or_insert_with(Vec::new)
                    .push((etype, expr, from_id));
            }
        }
    }
    graph
}

/// BFS backward over the in-memory edge graph to find if a column traces
/// back to an aggregation derivation.
/// Returns (agg_function, inner_expression).
fn trace_aggregation_mem(
    graph: &EdgeGraph,
    column_id: &str,
) -> Option<(String, String)> {
    let mut visited = HashSet::new();
    let mut queue = vec![column_id.to_string()];

    while let Some(col_id) = queue.pop() {
        if !visited.insert(col_id.clone()) {
            continue;
        }
        if let Some(edges) = graph.get(&col_id) {
            for (etype, expr, from_id) in edges {
                if etype == "derivation" {
                    if let Some(parsed) = parse_aggregation(expr) {
                        return Some(parsed);
                    }
                } else if !from_id.is_empty() {
                    queue.push(from_id.clone());
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

/// Try to infer a meaningful dimension name from a column's SQL expression.
/// Used when the lineage engine auto-named a column `col_N` (no alias).
///
/// Examples:
///   `'tags'` / `'ctgy'` / `'lid'` → `attr_type` (type indicator column)
///   `from_unixtime(...)` → keep `col_N` (too complex to name)
fn infer_name_from_expression(expr: &str) -> Option<String> {
    let trimmed = expr.trim();
    // String constant like 'tags', 'ctgy', 'lid'
    if trimmed.starts_with('\'') && trimmed.ends_with('\'') {
        let inner = &trimmed[1..trimmed.len() - 1];
        // If it's a short identifier-like value, it's likely a type indicator
        if !inner.is_empty()
            && inner.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
            && inner.len() <= 20
        {
            return Some(format!("attr_type_{}", to_snake_case(inner)));
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

/// Generate a minimal semantic model YAML from SQL content when lineage
/// analysis hasn't run (no nodes/edges). Extracts the INSERT target as the
/// model name and the SELECT column list / aliases as dimensions.
fn generate_minimal_yaml_from_sql(
    sql: &str,
    to_table: &str,
    from_tables: &[String],
    script_name: &str,
) -> SemanticYamlResult {
    let model_name = normalize_name(to_table);

    // Parse column names from SELECT clauses: look for aliases after AS or
    // after column expressions (last identifier on the line before comma/--)
    let mut dimensions: Vec<DimInfo> = Vec::new();
    let mut in_select = false;

    for line in sql.lines() {
        let trimmed = line.trim();
        let lower = trimmed.to_lowercase();

        if lower.starts_with("select") && !lower.contains("partition") {
            in_select = true;
            continue;
        }
        if in_select {
            // End of SELECT on FROM, INSERT, or semicolon
            if lower.starts_with("from")
                || lower.starts_with("insert")
                || lower.starts_with("where")
                || lower.starts_with("group")
                || lower.starts_with("union")
                || lower.starts_with("limit")
            {
                in_select = false;
                continue;
            }
            // Skip comments and empty
            if trimmed.starts_with("--") || trimmed.is_empty() {
                continue;
            }
            // Try to extract column alias:
            // `expr as alias` or `expr alias,` or `expr alias --comment`
            let cleaned = trimmed.split("--").next().unwrap_or(trimmed).trim();
            let cleaned = cleaned.trim_end_matches(',');
            // Check for `as alias`
            let alias = if let Some(pos) = cleaned.to_lowercase().rfind(" as ") {
                cleaned[pos + 4..].trim()
            } else {
                // Last word might be the alias
                cleaned.split_whitespace().last().unwrap_or("")
            };
            // Only add if it looks like an identifier
            if !alias.is_empty()
                && alias.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
                && alias != "as"
            {
                let dim_type = classify_dimension(alias);
                dimensions.push(DimInfo {
                    name: to_snake_case(alias),
                    dim_type,
                    description: None,
                });
            }
        }
    }

    // Deduplicate
    let mut seen = HashSet::new();
    dimensions.retain(|d| seen.insert(d.name.clone()));

    let time_dim_name = dimensions
        .iter()
        .find(|d| matches!(d.dim_type, DimensionType::Time { .. }))
        .map(|d| d.name.clone());
    let measures: Vec<MeasureInfo> = Vec::new(); // no lineage → no measures

    let yaml = format_yaml(
        &model_name,
        to_table,
        from_tables,
        &dimensions,
        &measures,
        &time_dim_name,
    );

    SemanticYamlResult {
        yaml,
        model_name,
        dimension_count: dimensions.len(),
        measure_count: 0,
        source_count: from_tables.len(),
        skipped: false,
    }
}

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
    let desc_text = if !from_tables.is_empty() {
        format!("Sources: {}", from_tables.join(", "))
    } else {
        String::new()
    };
    yaml.push_str(&format!("    description: '{}'\n", desc_text.replace('\'', "''")));

    // defaults
    if let Some(td) = time_dim {
        yaml.push_str(&format!("    defaults:\n"));
        yaml.push_str(&format!("      agg_time_dimension: {td}\n"));
    }

    yaml.push('\n');

    // entities — best-effort primary key detection
    let entity_name = detect_primary_entity(dimensions);
    yaml.push_str("    entities:\n");
    yaml.push_str(&format!("      - name: {}\n", entity_name));
    yaml.push_str("        type: primary\n");
    yaml.push_str(&format!("        expr: {}\n", entity_name));
    yaml.push_str(&format!("        description: 'Primary key (auto-detected)'\n"));

    // Dimensions — ALL properties
    if !dimensions.is_empty() {
        yaml.push_str("    dimensions:\n");
        let mut first_time = true;
        for d in dimensions {
            yaml.push_str(&format!("      - name: {}\n", d.name));
            let desc = d.description.as_deref().unwrap_or("");
            yaml.push_str(&format!("        description: '{}'\n", desc.replace('\'', "''")));
            let expr_val = d.description.as_deref().filter(|s| !s.is_empty()).unwrap_or(&d.name);
            match &d.dim_type {
                DimensionType::Time { granularity } => {
                    yaml.push_str("        type: time\n");
                    yaml.push_str(&format!("        expr: {}\n", expr_val));
                    yaml.push_str("        type_params:\n");
                    yaml.push_str(&format!("          time_granularity: {granularity}\n"));
                    if first_time {
                        yaml.push_str("          is_primary: true\n");
                        first_time = false;
                    }
                }
                DimensionType::Categorical => {
                    yaml.push_str("        type: categorical\n");
                    yaml.push_str(&format!("        expr: {}\n", expr_val));
                }
            }
        }
        yaml.push('\n');
    }

    // Measures — ALL properties
    if !measures.is_empty() {
        yaml.push_str("    measures:\n");
        for m in measures {
            yaml.push_str(&format!("      - name: {}\n", m.name));
            yaml.push_str(&format!("        description: '{}'\n", m.name.replace('_', " ")));
            yaml.push_str(&format!("        agg: {}\n", m.agg));
            yaml.push_str(&format!("        expr: {}\n", m.expr));
            if let Some(td) = &m.agg_time_dimension {
                yaml.push_str(&format!("        agg_time_dimension: {td}\n"));
            }
            yaml.push_str("        create_metric: true\n");
        }
        yaml.push('\n');
    }

    // Metrics — ALL properties
    if !measures.is_empty() {
        yaml.push_str("metrics:\n");
        for m in measures {
            yaml.push_str(&format!("  - name: {}\n", m.name));
            yaml.push_str(&format!("    description: '{}'\n", m.name.replace('_', " ")));
            yaml.push_str(&format!("    label: '{}'\n", capitalize_words(&m.name)));
            yaml.push_str("    type: simple\n");
            yaml.push_str("    type_params:\n");
            yaml.push_str("      measure:\n");
            yaml.push_str(&format!("        name: {}\n", m.name));
            yaml.push_str("        filter: ''\n");
            if let Some(td) = &m.agg_time_dimension {
                yaml.push_str(&format!("      agg_time_dimension: {td}\n"));
            }
            yaml.push('\n');
        }
    }

    let _ = time_dim;
    yaml
}

/// Best-effort primary entity name detection from dimension names.
fn detect_primary_entity(dimensions: &[DimInfo]) -> String {
    // Look for a column ending with _id or named 'id'
    for d in dimensions {
        let lower = d.name.to_lowercase();
        if lower == "id" || lower.ends_with("_id") {
            return d.name.clone();
        }
    }
    // Fallback: use first dimension name + _id
    if let Some(first) = dimensions.first() {
        return format!("{}_id", first.name);
    }
    "row_id".to_string()
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
