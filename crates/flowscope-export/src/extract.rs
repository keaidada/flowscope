use std::collections::{BTreeMap, BTreeSet, HashMap};

use flowscope_core::{AnalyzeResult, EdgeType, NodeType};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScriptInfo {
    pub source_name: String,
    pub statement_count: usize,
    pub tables_read: Vec<String>,
    pub tables_written: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TableInfo {
    pub name: String,
    pub qualified_name: String,
    pub catalog: Option<String>,
    pub schema: Option<String>,
    #[serde(rename = "type")]
    pub table_type: TableType,
    pub columns: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_name: Option<String>,
}

/// Split a qualified table name into (catalog, schema, name) parts.
fn split_qualified_parts(qualified: &str) -> (Option<String>, Option<String>, String) {
    let parts: Vec<&str> = qualified.split('.').collect();
    match parts.len() {
        3 => (Some(parts[0].to_string()), Some(parts[1].to_string()), parts[2].to_string()),
        2 => (None, Some(parts[0].to_string()), parts[1].to_string()),
        _ => (None, None, qualified.to_string()),
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TableType {
    Table,
    View,
    Cte,
}

impl TableType {
    pub fn as_str(&self) -> &'static str {
        match self {
            TableType::Table => "table",
            TableType::View => "view",
            TableType::Cte => "cte",
        }
    }
}

impl std::fmt::Display for TableType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ColumnMapping {
    pub source_table: String,
    pub source_column: String,
    pub target_table: String,
    pub target_column: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expression: Option<String>,
    pub edge_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LineageEntry {
    /// Script file name
    pub script: String,
    /// Single input (source) physical table qualified name
    pub input_table: String,
    /// Single output (target) physical table qualified name
    pub output_table: String,
}

/// Extract physical-table-level lineage: one row per (script, input_table, output_table).
///
/// Logically mirrors `extractSchemaFromResult` in the Schema view (AnalysisView.tsx):
/// - `isPhysicalTable`: type is table/view, not temp, has resolutionSource or qualified name contains '.'
/// - Per-statement BFS through intermediate nodes (CTE, output, column) to find physical→physical flows
/// - Also uses globalLineage for cross-statement flows through temp tables
/// - Deduplicated and sorted by script, output, then input
pub fn extract_lineage_entries(result: &AnalyzeResult) -> Vec<LineageEntry> {
    // If the frontend has already computed the correct lineage (using the Schema
    // module's logic), use it directly.
    if let Some(ref pre) = result.precomputed_lineage {
        let mut entries: Vec<LineageEntry> = pre
            .iter()
            .map(|e| LineageEntry {
                script: e.script.clone(),
                input_table: e.input_table.clone(),
                output_table: e.output_table.clone(),
            })
            .collect();
        entries.sort_by(|a, b| {
            a.script
                .cmp(&b.script)
                .then(a.output_table.cmp(&b.output_table))
                .then(a.input_table.cmp(&b.input_table))
        });
        entries.dedup_by(|a, b| {
            a.script == b.script && a.input_table == b.input_table && a.output_table == b.output_table
        });
        return entries;
    }

    // Fallback: compute lineage from raw graph (may be incomplete compared to
    // the Schema module's BFS logic).
    /// True if any part of the name starts with Temp_ or TMP_ (Spark/Hive cache temp tables).
    fn is_spark_temp(name: &str) -> bool {
        name.split('.').any(|part| {
            let upper = part.to_uppercase();
            upper.starts_with("TEMP_") || upper.starts_with("TMP_")
        })
    }

    /// Check if a node is a real physical table (not CTE, alias, subquery, or temp table).
    /// Mirrors `isPhysicalTable` in AnalysisView.tsx.
    fn is_physical(node: &flowscope_core::Node) -> bool {
        if !matches!(node.node_type, NodeType::Table | NodeType::View) {
            return false;
        }
        let qn = node.qualified_name.as_deref().unwrap_or(&node.label);
        if is_spark_temp(qn) || is_spark_temp(&node.label) {
            return false;
        }
        if node.resolution_source.is_some() {
            return true;
        }
        qn.contains('.')
    }

    let mut entries: Vec<LineageEntry> = Vec::new();

    for stmt in &result.statements {
        let script = stmt
            .source_name
            .clone()
            .unwrap_or_else(|| "default".to_string());

        // Collect physical node ids & qualified names
        let physical_ids: std::collections::HashSet<&str> = stmt
            .nodes
            .iter()
            .filter(|n| is_physical(n))
            .map(|n| n.id.as_ref())
            .collect();
        let physical_qn: std::collections::HashMap<&str, &str> = stmt
            .nodes
            .iter()
            .filter(|n| is_physical(n))
            .map(|n| (n.id.as_ref(), n.qualified_name.as_deref().unwrap_or(&n.label)))
            .collect();

        // Build adjacency for BFS (ownership edges reversed: column → owner table)
        let mut adj: std::collections::HashMap<&str, Vec<&str>> = std::collections::HashMap::new();
        for edge in &stmt.edges {
            if edge.edge_type == EdgeType::Ownership {
                // Reverse: column → owner table
                adj.entry(edge.to.as_ref()).or_default().push(edge.from.as_ref());
            } else {
                adj.entry(edge.from.as_ref()).or_default().push(edge.to.as_ref());
            }
        }

        // BFS from each physical source to find reachable physical targets
        for (&src_id, &src_qn) in &physical_qn {
            let mut visited: std::collections::HashSet<&str> = std::collections::HashSet::new();
            let mut queue: Vec<&str> = vec![src_id];
            visited.insert(src_id);
            while let Some(current) = queue.pop() {
                for &next in adj.get(current).unwrap_or(&vec![]) {
                    if !visited.insert(next) {
                        continue;
                    }
                    if physical_ids.contains(next) {
                        let tgt_qn = physical_qn[&next];
                        if src_qn != tgt_qn {
                            entries.push(LineageEntry {
                                script: script.clone(),
                                input_table: src_qn.to_string(),
                                output_table: tgt_qn.to_string(),
                            });
                        }
                    } else {
                        // Intermediate node — continue BFS
                        queue.push(next);
                    }
                }
            }
        }
    }

    // Deduplicate and sort.
    // Also filter: only keep entries where BOTH input and output table names
    // contain a dot (schema-qualified) — this excludes SQL aliases that happen
    // to have resolutionSource set, matching the Schema view's logic.
    entries.retain(|e| e.input_table.contains('.') && e.output_table.contains('.'));
    entries.sort_by(|a, b| {
        a.script
            .cmp(&b.script)
            .then(a.output_table.cmp(&b.output_table))
            .then(a.input_table.cmp(&b.input_table))
    });
    entries.dedup_by(|a, b| {
        a.script == b.script && a.input_table == b.input_table && a.output_table == b.output_table
    });

    entries
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TableDependency {
    pub source_table: String,
    pub target_table: String,
}

pub fn extract_script_info(result: &AnalyzeResult) -> Vec<ScriptInfo> {
    let mut script_map: HashMap<String, ScriptInfo> = HashMap::new();

    for stmt in &result.statements {
        let source_name = stmt
            .source_name
            .clone()
            .unwrap_or_else(|| "default".to_string());
        let entry = script_map
            .entry(source_name.clone())
            .or_insert_with(|| ScriptInfo {
                source_name: source_name.clone(),
                statement_count: 0,
                tables_read: Vec::new(),
                tables_written: Vec::new(),
            });

        entry.statement_count += 1;

        let mut tables_read: BTreeSet<String> = entry.tables_read.iter().cloned().collect();
        let mut tables_written: BTreeSet<String> = entry.tables_written.iter().cloned().collect();

        for node in &stmt.nodes {
            if matches!(node.node_type, NodeType::Table | NodeType::View) {
                let is_written = stmt
                    .edges
                    .iter()
                    .any(|edge| edge.to == node.id && edge.edge_type == EdgeType::DataFlow);
                let is_read = stmt
                    .edges
                    .iter()
                    .any(|edge| edge.from == node.id && edge.edge_type == EdgeType::DataFlow);

                let table_name = node
                    .qualified_name
                    .as_deref()
                    .unwrap_or(&node.label)
                    .to_string();

                if is_written {
                    tables_written.insert(table_name.clone());
                }
                // A table is considered "read" if it's explicitly read OR if it's
                // referenced but not written (implying it's an external/source table)
                if is_read || !is_written {
                    tables_read.insert(table_name);
                }
            }
        }

        entry.tables_read = tables_read.into_iter().collect();
        entry.tables_written = tables_written.into_iter().collect();
    }

    let mut values: Vec<_> = script_map.into_values().collect();
    values.sort_by(|a, b| a.source_name.cmp(&b.source_name));
    values
}

pub fn extract_table_info(result: &AnalyzeResult) -> Vec<TableInfo> {
    let mut table_map: BTreeMap<String, TableInfo> = BTreeMap::new();

    for stmt in &result.statements {
        let table_nodes: Vec<_> = stmt
            .nodes
            .iter()
            .filter(|node| node.node_type.is_table_like())
            .collect();
        let column_nodes: Vec<_> = stmt
            .nodes
            .iter()
            .filter(|node| node.node_type == NodeType::Column)
            .collect();

        for table_node in table_nodes {
            let key = table_node
                .qualified_name
                .as_deref()
                .unwrap_or(&table_node.label)
                .to_string();

            let owned_column_ids: BTreeSet<_> = stmt
                .edges
                .iter()
                .filter(|edge| edge.edge_type == EdgeType::Ownership && edge.from == table_node.id)
                .map(|edge| edge.to.as_ref())
                .collect();

            let columns: BTreeSet<String> = column_nodes
                .iter()
                .filter(|col| owned_column_ids.contains(col.id.as_ref()))
                .map(|col| col.label.to_string())
                .collect();

            let table_type = match table_node.node_type {
                NodeType::View => TableType::View,
                NodeType::Cte => TableType::Cte,
                _ => TableType::Table,
            };

            let entry = table_map.entry(key.clone()).or_insert_with(|| {
                let (catalog, schema, _name) = split_qualified_parts(&key);
                TableInfo {
                    name: table_node.label.to_string(),
                    qualified_name: key.clone(),
                    catalog,
                    schema,
                    table_type,
                    columns: Vec::new(),
                    source_name: stmt.source_name.clone(),
                }
            });

            let mut merged: BTreeSet<String> = entry.columns.iter().cloned().collect();
            merged.extend(columns);
            entry.columns = merged.into_iter().collect();
        }
    }

    table_map.into_values().collect()
}

pub fn extract_column_mappings(result: &AnalyzeResult) -> Vec<ColumnMapping> {
    let mut mappings = Vec::new();

    for stmt in &result.statements {
        let table_nodes: Vec<_> = stmt
            .nodes
            .iter()
            .filter(|node| node.node_type.is_table_like())
            .collect();
        let column_nodes: Vec<_> = stmt
            .nodes
            .iter()
            .filter(|node| node.node_type == NodeType::Column)
            .collect();

        let mut column_to_table: HashMap<&str, &str> = HashMap::new();
        for edge in &stmt.edges {
            if edge.edge_type == EdgeType::Ownership {
                if let Some(table_node) = table_nodes.iter().find(|node| node.id == edge.from) {
                    let table_name = table_node
                        .qualified_name
                        .as_deref()
                        .unwrap_or(&table_node.label);
                    column_to_table.insert(edge.to.as_ref(), table_name);
                }
            }
        }

        for edge in &stmt.edges {
            if edge.edge_type == EdgeType::Derivation || edge.edge_type == EdgeType::DataFlow {
                let source_col = column_nodes.iter().find(|col| col.id == edge.from);
                let target_col = column_nodes.iter().find(|col| col.id == edge.to);

                if let (Some(source), Some(target)) = (source_col, target_col) {
                    let source_table = column_to_table
                        .get(edge.from.as_ref())
                        .copied()
                        .unwrap_or("Output");
                    let target_table = column_to_table
                        .get(edge.to.as_ref())
                        .copied()
                        .unwrap_or("Output");

                    let expression = edge
                        .expression
                        .as_ref()
                        .map(|value| value.to_string())
                        .or_else(|| target.expression.as_ref().map(|value| value.to_string()));

                    mappings.push(ColumnMapping {
                        source_table: source_table.to_string(),
                        source_column: source.label.to_string(),
                        target_table: target_table.to_string(),
                        target_column: target.label.to_string(),
                        expression,
                        edge_type: edge_type_label(edge.edge_type).to_string(),
                    });
                }
            }
        }
    }

    mappings
}

pub fn extract_table_dependencies(result: &AnalyzeResult) -> Vec<TableDependency> {
    let mut dependencies = Vec::new();
    let mut seen: BTreeSet<String> = BTreeSet::new();

    for stmt in &result.statements {
        let relation_nodes: Vec<_> = stmt
            .nodes
            .iter()
            .filter(|node| node.node_type.is_relation())
            .collect();

        for edge in &stmt.edges {
            if edge.edge_type == EdgeType::DataFlow || edge.edge_type == EdgeType::JoinDependency {
                let source_node = relation_nodes.iter().find(|node| node.id == edge.from);
                let target_node = relation_nodes.iter().find(|node| node.id == edge.to);

                if let (Some(source), Some(target)) = (source_node, target_node) {
                    let source_key = source
                        .qualified_name
                        .as_deref()
                        .unwrap_or(&source.label)
                        .to_string();
                    let target_key = target
                        .qualified_name
                        .as_deref()
                        .unwrap_or(&target.label)
                        .to_string();
                    let dep_key = format!("{source_key}->{target_key}");

                    if source_key != target_key && seen.insert(dep_key) {
                        dependencies.push(TableDependency {
                            source_table: source_key,
                            target_table: target_key,
                        });
                    }
                }
            }
        }
    }

    dependencies
}

fn edge_type_label(edge_type: EdgeType) -> &'static str {
    match edge_type {
        EdgeType::Ownership => "ownership",
        EdgeType::DataFlow => "data_flow",
        EdgeType::Derivation => "derivation",
        EdgeType::JoinDependency => "join_dependency",
        EdgeType::CrossStatement => "cross_statement",
    }
}

#[cfg(test)]
mod tests {
    use super::extract_lineage_entries;
    use flowscope_core::{AnalyzeResult, Edge, Node, StatementLineage};

    #[test]
    fn lineage_export_does_not_trace_into_other_statements() {
        let shared_cte_id = "cte_shared";

        let stmt_a = StatementLineage {
            statement_index: 0,
            statement_type: "INSERT".to_string(),
            source_name: Some("S02_VPLAY_STATT_MTH.HQL".to_string()),
            nodes: vec![
                Node::table("table_src_a", "src_a").with_qualified_name("db.src_a"),
                Node::cte(shared_cte_id, "tmp_shared"),
                Node::table("table_out_a", "out_a").with_qualified_name("db.out_a"),
            ],
            edges: vec![
                Edge::data_flow("edge_a1", "table_src_a", shared_cte_id),
                Edge::data_flow("edge_a2", shared_cte_id, "table_out_a"),
            ],
            span: None,
            join_count: 0,
            complexity_score: 1,
            resolved_sql: None,
        };

        let stmt_b = StatementLineage {
            statement_index: 1,
            statement_type: "INSERT".to_string(),
            source_name: Some("OTHER.HQL".to_string()),
            nodes: vec![
                Node::table("table_src_b", "src_b").with_qualified_name("db.src_b"),
                Node::cte(shared_cte_id, "tmp_shared"),
                Node::table("table_out_b", "out_b").with_qualified_name("db.out_b"),
            ],
            edges: vec![
                Edge::data_flow("edge_b1", "table_src_b", shared_cte_id),
                Edge::data_flow("edge_b2", shared_cte_id, "table_out_b"),
            ],
            span: None,
            join_count: 0,
            complexity_score: 1,
            resolved_sql: None,
        };

        let result = AnalyzeResult {
            statements: vec![stmt_a, stmt_b],
            ..AnalyzeResult::default()
        };

        let entries = extract_lineage_entries(&result);

        assert_eq!(
            entries,
            vec![
                super::LineageEntry {
                    script: "OTHER.HQL".to_string(),
                    input_table: "db.src_b".to_string(),
                    output_table: "db.out_b".to_string(),
                },
                super::LineageEntry {
                    script: "S02_VPLAY_STATT_MTH.HQL".to_string(),
                    input_table: "db.src_a".to_string(),
                    output_table: "db.out_a".to_string(),
                },
            ]
        );
    }
}
