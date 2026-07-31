//! Visual modeling: DDL generation, reverse engineering, model diff.
//!
//! Provides the backend logic for the visual model designer:
//! - Generate CREATE TABLE DDL from model definitions
//! - Reverse-engineer SQL files to extract model structure
//! - Diff two model versions to show changes

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::model::ModelEntry;

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ModelDefinition {
    pub table_name: String,
    pub columns: Vec<ColumnDefinition>,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ColumnDefinition {
    pub name: String,
    pub data_type: String,
    pub primary_key: bool,
    pub nullable: bool,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ModelDiff {
    pub added: Vec<String>,
    pub removed: Vec<String>,
    pub modified: Vec<ColumnDiff>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ColumnDiff {
    pub column: String,
    pub old_type: String,
    pub new_type: String,
}

/// Generate DDL (CREATE TABLE) from a model definition.
pub fn generate_ddl(model: &ModelDefinition, dialect: &str) -> String {
    let mut sql = String::new();

    if !model.description.is_empty() {
        sql.push_str(&format!("-- {}\n", model.description));
    }

    sql.push_str(&format!("CREATE TABLE {} (\n", model.table_name));

    let cols: Vec<String> = model
        .columns
        .iter()
        .map(|c| {
            let mut line = format!("    {} {}", c.name, c.data_type);
            if c.primary_key {
                line.push_str(" PRIMARY KEY");
            }
            if !c.nullable {
                line.push_str(" NOT NULL");
            }
            if !c.description.is_empty() {
                line.push_str(&format!(" COMMENT '{}'", c.description.replace('\'', "''")));
            }
            line
        })
        .collect();

    sql.push_str(&cols.join(",\n"));
    sql.push_str("\n);");

    // Dialect-specific adjustments
    match dialect.to_lowercase().as_str() {
        "bigquery" => {
            // BigQuery doesn't support COMMENT inline — would need ALTER TABLE
            sql = sql.replace(" COMMENT '", " /* ");
            sql = sql.replace("'''", "' */");
        }
        "postgresql" | "mysql" | "snowflake" | "clickhouse" | _ => {
            // Standard SQL DDL works for these
        }
    }

    sql
}

/// Reverse-engineer a SQL string to extract model definitions.
///
/// Parses CREATE TABLE statements to extract column names, types, and constraints.
pub fn reverse_engineer(sql: &str) -> Vec<ModelDefinition> {
    let mut models = Vec::new();
    let lines: Vec<&str> = sql.lines().collect();
    let mut i = 0;

    while i < lines.len() {
        let line = lines[i].trim();
        let upper = line.to_uppercase();

        if upper.starts_with("CREATE TABLE") || upper.starts_with("CREATE OR REPLACE TABLE") {
            // Extract table name
            let after_create = if upper.starts_with("CREATE OR REPLACE TABLE") {
                &line["CREATE OR REPLACE TABLE".len()..]
            } else {
                &line["CREATE TABLE".len()..]
            };

            // Check IF NOT EXISTS
            let after_create = after_create.trim_start();
            let after_create = if after_create.to_uppercase().starts_with("IF NOT EXISTS") {
                &after_create["IF NOT EXISTS".len()..]
            } else {
                after_create
            };

            let table_name = after_create
                .trim()
                .trim_start_matches('(')
                .trim()
                .replace('`', "")
                .replace('"', "")
                .split_whitespace()
                .next()
                .unwrap_or("unknown")
                .to_string();

            // Collect columns until closing parenthesis
            let mut columns = Vec::new();
            let mut comment = String::new();
            let mut j = i + 1;

            // Check for preceding comment
            if i > 0 {
                let prev = lines[i - 1].trim();
                if prev.starts_with("--") {
                    comment = prev.trim_start_matches('-').trim().to_string();
                }
            }

            // Collect column definitions
            let mut depth = if line.contains('(') { 1 } else { 0 };
            while j < lines.len() && depth > 0 {
                let col_line = lines[j].trim().trim_end_matches(',');
                for ch in lines[j].chars() {
                    if ch == '(' { depth += 1; }
                    if ch == ')' { depth -= 1; }
                }

                if depth <= 0 { break; }

                let upper_col = col_line.to_uppercase();
                if upper_col.starts_with("PRIMARY KEY")
                    || upper_col.starts_with("FOREIGN KEY")
                    || upper_col.starts_with("CONSTRAINT")
                    || upper_col.starts_with("UNIQUE")
                    || upper_col.starts_with("KEY")
                    || upper_col.starts_with("INDEX")
                {
                    j += 1;
                    continue;
                }

                // Parse column: "name TYPE [constraints]"
                let parts: Vec<&str> = col_line.splitn(2, char::is_whitespace).collect();
                if parts.len() >= 2 {
                    let col_name = parts[0].replace('`', "").replace('"', "");
                    let rest = parts[1];
                    let upper_rest = rest.to_uppercase();
                    let is_pk = upper_rest.contains("PRIMARY KEY");
                    let is_nullable = !upper_rest.contains("NOT NULL");
                    let data_type = extract_type(rest);

                    columns.push(ColumnDefinition {
                        name: col_name,
                        data_type,
                        primary_key: is_pk,
                        nullable: is_nullable,
                        description: String::new(),
                    });
                }
                j += 1;
            }

            models.push(ModelDefinition {
                table_name,
                columns,
                description: comment,
            });
            i = j;
        } else {
            i += 1;
        }
    }

    models
}

/// Extract the data type from a column definition string.
fn extract_type(def: &str) -> String {
    let upper = def.to_uppercase();
    let type_end = upper
        .find(|c: char| c.is_whitespace())
        .unwrap_or(def.len());
    let mut type_str = def[..type_end.min(def.len())].to_string();

    // Include type parameters like VARCHAR(255), DECIMAL(10,2)
    if type_str.contains('(') && !type_str.contains(')') {
        if let Some(paren_end) = def.find(')') {
            type_str = def[..paren_end + 1].split_whitespace().next().unwrap_or(&type_str).to_string();
        }
    }

    type_str.to_uppercase()
}

/// Diff two model definitions to show changes.
pub fn diff_models(old: &ModelDefinition, new: &ModelDefinition) -> ModelDiff {
    let old_cols: std::collections::HashMap<&str, &ColumnDefinition> = old
        .columns
        .iter()
        .map(|c| (c.name.as_str(), c))
        .collect();
    let new_cols: std::collections::HashMap<&str, &ColumnDefinition> = new
        .columns
        .iter()
        .map(|c| (c.name.as_str(), c))
        .collect();

    let mut added = Vec::new();
    let mut removed = Vec::new();
    let mut modified = Vec::new();

    for (name, col) in &new_cols {
        match old_cols.get(*name) {
            None => added.push(name.to_string()),
            Some(old_col) => {
                if old_col.data_type != col.data_type {
                    modified.push(ColumnDiff {
                        column: name.to_string(),
                        old_type: old_col.data_type.clone(),
                        new_type: col.data_type.clone(),
                    });
                }
            }
        }
    }

    for name in old_cols.keys() {
        if !new_cols.contains_key(*name) {
            removed.push(name.to_string());
        }
    }

    ModelDiff {
        added,
        removed,
        modified,
    }
}

/// Convert a ModelEntry (from registry) to a ModelDefinition (for designer).
pub fn model_entry_to_definition(entry: &ModelEntry) -> ModelDefinition {
    ModelDefinition {
        table_name: entry.table_name.clone(),
        columns: vec![],
        description: entry.description.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_ddl() {
        let model = ModelDefinition {
            table_name: "dws_gmv".to_string(),
            columns: vec![
                ColumnDefinition { name: "dt".into(), data_type: "DATE".into(), primary_key: true, nullable: false, description: "".into() },
                ColumnDefinition { name: "gmv".into(), data_type: "DECIMAL(10,2)".into(), primary_key: false, nullable: false, description: "GMV".into() },
            ],
            description: "GMV汇总".to_string(),
        };
        let ddl = generate_ddl(&model, "postgresql");
        assert!(ddl.contains("CREATE TABLE dws_gmv"));
        assert!(ddl.contains("dt DATE PRIMARY KEY"));
        assert!(ddl.contains("gmv DECIMAL(10,2) NOT NULL"));
        assert!(ddl.contains("GMV汇总"));
    }

    #[test]
    fn test_reverse_engineer() {
        let sql = r#"
CREATE TABLE dws_gmv (
    dt DATE PRIMARY KEY,
    gmv DECIMAL(10,2) NOT NULL,
    region VARCHAR(50)
);
"#;
        let models = reverse_engineer(sql);
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].table_name, "dws_gmv");
        assert_eq!(models[0].columns.len(), 3);
        assert!(models[0].columns[0].primary_key);
        assert!(!models[0].columns[1].nullable);
    }

    #[test]
    fn test_diff_models() {
        let old = ModelDefinition {
            table_name: "t".into(),
            columns: vec![
                ColumnDefinition { name: "a".into(), data_type: "INT".into(), primary_key: false, nullable: true, description: "".into() },
                ColumnDefinition { name: "b".into(), data_type: "VARCHAR(10)".into(), primary_key: false, nullable: true, description: "".into() },
            ],
            description: "".into(),
        };
        let new = ModelDefinition {
            table_name: "t".into(),
            columns: vec![
                ColumnDefinition { name: "a".into(), data_type: "BIGINT".into(), primary_key: false, nullable: true, description: "".into() },
                ColumnDefinition { name: "c".into(), data_type: "DATE".into(), primary_key: false, nullable: true, description: "".into() },
            ],
            description: "".into(),
        };
        let diff = diff_models(&old, &new);
        assert_eq!(diff.added, vec!["c"]);
        assert_eq!(diff.removed, vec!["b"]);
        assert_eq!(diff.modified.len(), 1);
        assert_eq!(diff.modified[0].column, "a");
        assert_eq!(diff.modified[0].old_type, "INT");
        assert_eq!(diff.modified[0].new_type, "BIGINT");
    }
}
