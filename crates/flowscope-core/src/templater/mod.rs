//! SQL template preprocessing for Jinja2 and dbt-style templates.
//!
//! This module provides preprocessing support for templated SQL, allowing FlowScope
//! to analyze SQL files that use Jinja2 syntax or dbt macros.
//!
//! # Architecture
//!
//! Templating is a preprocessing step that runs before SQL parsing:
//!
//! ```text
//! Templated SQL → [templater] → Raw SQL → [parser] → AST → [analyzer] → Lineage
//! ```
//!
//! # Modes
//!
//! - **Raw**: No templating, SQL is passed through unchanged (default)
//! - **Jinja**: Standard Jinja2 template rendering with strict variable checking
//! - **Dbt**: Jinja2 with dbt builtin macros (`ref`, `source`, `config`, `var`, etc.)
//!
//! # Example
//!
//! ```
//! use flowscope_core::templater::{template_sql, TemplateConfig, TemplateMode};
//! use std::collections::HashMap;
//!
//! // dbt-style template
//! let template = r#"
//! {{ config(materialized='table') }}
//! SELECT * FROM {{ ref('users') }}
//! WHERE created_at > '{{ var("start_date", "2024-01-01") }}'
//! "#;
//!
//! let config = TemplateConfig {
//!     mode: TemplateMode::Dbt,
//!     context: HashMap::new(),
//! };
//!
//! let rendered = template_sql(template, &config).unwrap();
//! assert!(rendered.contains("FROM users"));
//! ```

mod dbt;
mod error;
mod jinja;

pub use error::TemplateError;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Configuration for SQL template preprocessing.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, Default)]
#[serde(rename_all = "camelCase")]
pub struct TemplateConfig {
    /// The templating mode to use.
    #[serde(default)]
    pub mode: TemplateMode,

    /// Context variables available to the template.
    ///
    /// For dbt mode, variables under the "vars" key are accessible via `var()`.
    #[serde(default)]
    pub context: HashMap<String, serde_json::Value>,
}

/// Templating mode for SQL preprocessing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Default)]
#[serde(rename_all = "lowercase")]
pub enum TemplateMode {
    /// No templating - SQL is passed through unchanged.
    #[default]
    Raw,

    /// Standard Jinja2 template rendering.
    ///
    /// Uses strict mode: undefined variables cause an error.
    Jinja,

    /// dbt-style templating with builtin macros.
    ///
    /// Includes stub implementations of:
    /// - `ref('model')` / `ref('project', 'model')` - model references
    /// - `source('schema', 'table')` - source table references
    /// - `config(...)` - model configuration (returns empty string)
    /// - `var('name')` / `var('name', 'default')` - variable access
    /// - `is_incremental()` - always returns false for lineage analysis
    /// - `this` - undefined (incremental model self-reference)
    Dbt,
}

/// Renders a SQL template according to the specified configuration.
///
/// This is the main entry point for template preprocessing. It dispatches
/// to the appropriate renderer based on the configured mode.
///
/// # Arguments
///
/// * `sql` - The SQL template string to render
/// * `config` - Configuration specifying the mode and context variables
///
/// # Returns
///
/// The rendered SQL string, or an error if rendering fails.
///
/// # Errors
///
/// - `TemplateError::SyntaxError` - Invalid template syntax
/// - `TemplateError::UndefinedVariable` - Undefined variable in Jinja mode
/// - `TemplateError::RenderError` - Other rendering failures
pub fn template_sql(sql: &str, config: &TemplateConfig) -> Result<String, TemplateError> {
    match config.mode {
        TemplateMode::Raw => Ok(sql.to_string()),
        TemplateMode::Jinja => jinja::render_jinja(sql, &config.context),
        TemplateMode::Dbt => jinja::render_dbt(sql, &config.context),
    }
}

/// Wraps template variables (`${var}` or `{var}`) in single quotes when they
/// appear as bare tokens (not already inside quotes), so the SQL parser treats
/// them as string literals.
///
/// # Examples
///
/// - `WHERE dt = ${DATA_DT}` → `WHERE dt = '${DATA_DT}'`
/// - `WHERE dt = {date_id}` → `WHERE dt = '{date_id}'`
/// - `WHERE dt = '${DATA_DT}'` → unchanged
/// - `PARTITION(dt='${DT}')` → unchanged
pub fn quote_shell_template_vars(sql: &str) -> String {
    let mut result = String::with_capacity(sql.len() + 32);
    let mut remaining = sql;

    while let Some(special_pos) = remaining.find(['{', '$']) {
        result.push_str(&remaining[..special_pos]);

        let rest = &remaining[special_pos..];

        if let Some(after_open) = rest.strip_prefix("${") {
            if let Some(close_pos) = after_open.find('}') {
                let var_end = 2 + close_pos + 1;

                let already_quoted = special_pos > 0
                    && remaining.as_bytes().get(special_pos.wrapping_sub(1)) == Some(&b'\'')
                    && rest.as_bytes().get(var_end) == Some(&b'\'');

                let var_text = &rest[..var_end];
                if already_quoted {
                    result.push_str(var_text);
                } else {
                    result.push('\'');
                    result.push_str(var_text);
                    result.push('\'');
                }
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
                    && content
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '_');

                let var_end = 1 + close_pos + 1;

                if !is_template_var {
                    result.push_str(&rest[..var_end]);
                    remaining = &rest[var_end..];
                    continue;
                }

                let already_quoted = special_pos > 0
                    && remaining.as_bytes().get(special_pos.wrapping_sub(1)) == Some(&b'\'')
                    && rest.as_bytes().get(var_end) == Some(&b'\'');

                let var_text = &rest[..var_end];
                if already_quoted {
                    result.push_str(var_text);
                } else {
                    result.push('\'');
                    result.push_str(var_text);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raw_mode_passes_through() {
        let sql = "SELECT * FROM {{ not_a_template }}";
        let config = TemplateConfig::default();

        let result = template_sql(sql, &config).unwrap();
        // `{{ }}` is not `${ }`, so pass-through unchanged
        assert_eq!(result, sql);
    }

    #[test]
    fn quote_shell_var_wraps_bare_variable() {
        assert_eq!(
            quote_shell_template_vars("WHERE dt = ${DATA_DT}"),
            "WHERE dt = '${DATA_DT}'"
        );
    }

    #[test]
    fn quote_bare_curly_var_wraps() {
        assert_eq!(
            quote_shell_template_vars("WHERE dt = {date_id}"),
            "WHERE dt = '{date_id}'"
        );
    }

    #[test]
    fn quote_bare_curly_var_already_quoted_preserved() {
        assert_eq!(
            quote_shell_template_vars("WHERE dt = '{date_id}'"),
            "WHERE dt = '{date_id}'"
        );
    }

    #[test]
    fn quote_bare_curly_mixed_with_dollar() {
        assert_eq!(
            quote_shell_template_vars("WHERE dt = ${DATA_DT} AND id = {user_id}"),
            "WHERE dt = '${DATA_DT}' AND id = '{user_id}'"
        );
    }

    #[test]
    fn bare_curly_skips_non_identifier_content() {
        // JSON-like `{"key": 1}` should NOT be wrapped
        assert_eq!(
            quote_shell_template_vars("SELECT * FROM t WHERE col = {1, 2, 3}"),
            "SELECT * FROM t WHERE col = {1, 2, 3}"
        );
        // struct literal should NOT be wrapped
        assert_eq!(
            quote_shell_template_vars("SELECT ROW(1, 'a') AS {\"id\", \"name\"}"),
            "SELECT ROW(1, 'a') AS {\"id\", \"name\"}"
        );
    }

    #[test]
    fn quote_shell_var_preserves_already_quoted() {
        assert_eq!(
            quote_shell_template_vars("WHERE dt = '${DATA_DT}'"),
            "WHERE dt = '${DATA_DT}'"
        );
    }

    #[test]
    fn quote_shell_var_multiple_variables() {
        assert_eq!(
            quote_shell_template_vars("BETWEEN ${start} AND ${end}"),
            "BETWEEN '${start}' AND '${end}'"
        );
    }

    #[test]
    fn quote_shell_var_mixed_quoted_and_bare() {
        assert_eq!(
            quote_shell_template_vars("WHERE dt = '${DATA_DT}' AND id = ${ID}"),
            "WHERE dt = '${DATA_DT}' AND id = '${ID}'"
        );
    }

    #[test]
    fn quote_shell_var_in_partition_clause() {
        assert_eq!(
            quote_shell_template_vars("PARTITION(data_dt='${DATA_DT}')"),
            "PARTITION(data_dt='${DATA_DT}')"
        );
    }

    #[test]
    fn quote_shell_var_in_insert_target() {
        assert_eq!(
            quote_shell_template_vars("INSERT OVERWRITE TABLE ${target_db}.dim_table"),
            "INSERT OVERWRITE TABLE '${target_db}'.dim_table"
        );
    }

    #[test]
    fn quote_shell_var_no_variables() {
        assert_eq!(
            quote_shell_template_vars("SELECT * FROM users WHERE id = 1"),
            "SELECT * FROM users WHERE id = 1"
        );
    }

    #[test]
    fn quote_shell_var_real_world_spark_sql() {
        let input = "INSERT OVERWRITE TABLE rinjani.dim_btsweb_mapping\nWITH cgi AS (\n  SELECT * FROM ods_cc.src_table\n  WHERE date_id BETWEEN ${date_id}\n        AND (SELECT max(date_id) FROM ods_cc.src_table)\n)\nSELECT * FROM cgi;";
        let expected = "INSERT OVERWRITE TABLE rinjani.dim_btsweb_mapping\nWITH cgi AS (\n  SELECT * FROM ods_cc.src_table\n  WHERE date_id BETWEEN '${date_id}'\n        AND (SELECT max(date_id) FROM ods_cc.src_table)\n)\nSELECT * FROM cgi;";
        assert_eq!(quote_shell_template_vars(input), expected);
    }

    #[test]
    fn raw_mode_does_not_wrap_shell_vars() {
        // quote_shell_template_vars is called by apply_template in input.rs, not template_sql
        let sql = "WHERE dt = ${DATA_DT}";
        let config = TemplateConfig::default();

        let result = template_sql(sql, &config).unwrap();
        assert_eq!(result, sql);
    }

    #[test]
    fn jinja_mode_renders_variables() {
        let sql = "SELECT * FROM {{ table }}";
        let mut context = HashMap::new();
        context.insert("table".to_string(), serde_json::json!("users"));

        let config = TemplateConfig {
            mode: TemplateMode::Jinja,
            context,
        };

        let result = template_sql(sql, &config).unwrap();
        assert_eq!(result, "SELECT * FROM users");
    }

    #[test]
    fn dbt_mode_renders_ref() {
        let sql = "SELECT * FROM {{ ref('users') }}";
        let config = TemplateConfig {
            mode: TemplateMode::Dbt,
            context: HashMap::new(),
        };

        let result = template_sql(sql, &config).unwrap();
        assert_eq!(result, "SELECT * FROM users");
    }

    #[test]
    fn config_serialization() {
        let config = TemplateConfig {
            mode: TemplateMode::Dbt,
            context: HashMap::new(),
        };

        let json = serde_json::to_string(&config).unwrap();
        assert!(json.contains("\"mode\":\"dbt\""));

        let parsed: TemplateConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.mode, TemplateMode::Dbt);
    }

    #[test]
    fn config_deserialization_with_defaults() {
        let json = r#"{ "mode": "jinja" }"#;
        let config: TemplateConfig = serde_json::from_str(json).unwrap();

        assert_eq!(config.mode, TemplateMode::Jinja);
        assert!(config.context.is_empty());
    }
}
