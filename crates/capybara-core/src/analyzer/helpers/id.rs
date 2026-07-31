use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::sync::Arc;

/// Generate a deterministic node ID based on type and name
pub fn generate_node_id(node_type: &str, name: &str) -> Arc<str> {
    let mut hasher = DefaultHasher::new();
    node_type.hash(&mut hasher);
    name.hash(&mut hasher);
    let hash = hasher.finish();

    format!("{node_type}_{hash:016x}").into()
}

/// Generate a deterministic edge ID
pub fn generate_edge_id(from: &str, to: &str) -> Arc<str> {
    let mut hasher = DefaultHasher::new();
    from.hash(&mut hasher);
    to.hash(&mut hasher);
    let hash = hasher.finish();

    format!("edge_{hash:016x}").into()
}

/// Generate a deterministic column node ID
pub fn generate_column_node_id(parent_id: Option<&str>, column_name: &str) -> Arc<str> {
    let mut hasher = DefaultHasher::new();
    "column".hash(&mut hasher);
    if let Some(parent) = parent_id {
        parent.hash(&mut hasher);
    }
    column_name.hash(&mut hasher);
    let hash = hasher.finish();

    format!("column_{hash:016x}").into()
}

/// Generate a deterministic node ID scoped to a specific statement.
///
/// This ensures that identically-named nodes (e.g., CTEs, derived tables) in different
/// statements produce distinct IDs, preventing unintended merging in the global graph.
pub fn generate_statement_scoped_node_id(
    node_type: &str,
    statement_index: usize,
    name: &str,
) -> Arc<str> {
    generate_node_id(node_type, &format!("statement_{statement_index}::{name}"))
}

/// Generate a deterministic output node ID scoped to a statement.
pub fn generate_output_node_id(statement_index: usize) -> Arc<str> {
    generate_statement_scoped_node_id("output", statement_index, "output")
}
