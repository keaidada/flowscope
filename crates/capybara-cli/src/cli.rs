//! CLI argument parsing using clap.

use clap::{Parser, ValueEnum};
use std::path::PathBuf;

/// Capybara - SQL lineage analyzer
#[derive(Parser, Debug)]
#[command(name = "capybara")]
#[command(about = "Analyze SQL files for data lineage", long_about = None)]
#[command(version)]
pub struct Args {
    /// SQL files to analyze (reads from stdin if none provided; --lint also accepts directories)
    #[arg(value_name = "FILES")]
    pub files: Vec<PathBuf>,

    /// SQL dialect
    #[arg(short, long, default_value = "generic", value_enum)]
    pub dialect: DialectArg,

    /// Output format
    #[arg(short, long, default_value = "table", value_enum)]
    pub format: OutputFormat,

    /// Schema DDL file for table/column resolution
    #[arg(short, long, value_name = "FILE")]
    pub schema: Option<PathBuf>,

    /// Database connection URL for live schema introspection
    /// (e.g., postgres://user:pass@host/db, mysql://..., sqlite://...)
    #[cfg(feature = "metadata-provider")]
    #[arg(long, value_name = "URL")]
    pub metadata_url: Option<String>,

    /// Schema name to filter when using --metadata-url
    /// (e.g., 'public' for PostgreSQL, database name for MySQL)
    #[cfg(feature = "metadata-provider")]
    #[arg(long, value_name = "SCHEMA")]
    pub metadata_schema: Option<String>,

    /// Output file (defaults to stdout)
    #[arg(short, long, value_name = "FILE")]
    pub output: Option<PathBuf>,

    /// Project name used for default export filenames
    #[arg(long, default_value = "lineage")]
    pub project_name: String,

    /// Schema name to prefix DuckDB SQL export
    #[arg(long, value_name = "SCHEMA")]
    pub export_schema: Option<String>,

    /// Graph detail level for mermaid output
    #[arg(short, long, default_value = "table", value_enum)]
    pub view: ViewMode,

    /// Run SQL linter and report violations
    #[arg(long)]
    pub lint: bool,

    /// Apply deterministic SQL lint auto-fixes in place (requires --lint)
    #[arg(long, requires = "lint")]
    pub fix: bool,

    /// Apply fixes only and skip post-fix lint reporting (requires --lint and --fix)
    #[arg(long, requires_all = ["lint", "fix"])]
    pub fix_only: bool,

    /// Include unsafe lint auto-fixes (requires --lint and --fix)
    #[arg(long, requires_all = ["lint", "fix"])]
    pub unsafe_fixes: bool,

    /// Enable legacy AST-based lint rewrites (opt-in; defaults to off)
    #[arg(long, requires_all = ["lint", "fix"])]
    pub legacy_ast_fixes: bool,

    /// Show blocked/display-only fix candidates in lint mode (requires --lint)
    #[arg(long, requires = "lint")]
    pub show_fixes: bool,

    /// Comma-separated list of lint rule codes to exclude (e.g., LINT_AM_008,LINT_ST_006)
    #[arg(long, requires = "lint", value_delimiter = ',')]
    pub exclude_rules: Vec<String>,

    /// JSON object for per-rule lint options keyed by rule reference
    /// (e.g., '{"structure.subquery":{"forbid_subquery_in":"both"}}')
    #[arg(long, requires = "lint", value_name = "JSON")]
    pub rule_configs: Option<String>,

    /// Number of worker threads to use for lint/fix file processing
    #[arg(
        long,
        requires = "lint",
        value_name = "N",
        value_parser = parse_positive_usize
    )]
    pub jobs: Option<usize>,

    /// Disable `.gitignore` and standard ignore-file filtering during lint path discovery
    #[arg(long, requires = "lint")]
    pub no_respect_gitignore: bool,

    /// Suppress warnings on stderr
    #[arg(short, long)]
    pub quiet: bool,

    /// Compact JSON output (no pretty-printing)
    #[arg(short, long)]
    pub compact: bool,

    /// Template mode for preprocessing SQL (jinja or dbt)
    #[cfg(feature = "templating")]
    #[arg(long, value_enum)]
    pub template: Option<TemplateArg>,

    /// Template variable in KEY=VALUE format (can be repeated)
    #[cfg(feature = "templating")]
    #[arg(long = "template-var", value_name = "KEY=VALUE")]
    pub template_vars: Vec<String>,

    /// Start HTTP server with embedded web UI
    #[cfg(feature = "serve")]
    #[arg(long)]
    pub serve: bool,

    /// API-only mode: no embedded UI, just the REST API + SQLite database
    /// (use with Vite dev server on a different port)
    #[cfg(feature = "serve")]
    #[arg(long)]
    pub db_only: bool,

    /// Port for HTTP server (default: 3000)
    #[cfg(feature = "serve")]
    #[arg(long, default_value = "3000")]
    pub port: u16,

    /// Host/interface to bind for HTTP server (default: 0.0.0.0)
    /// 0.0.0.0 allows access from other machines (LAN/external IP);
    /// use 127.0.0.1 to restrict to localhost only
    #[cfg(feature = "serve")]
    #[arg(long, default_value = "0.0.0.0")]
    pub host: String,

    /// Directories to watch for SQL files (can be repeated)
    #[cfg(feature = "serve")]
    #[arg(long, value_name = "DIR")]
    pub watch: Vec<PathBuf>,

    /// Open browser automatically when server starts
    #[cfg(feature = "serve")]
    #[arg(long)]
    pub open: bool,
}

/// SQL dialect options
#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum DialectArg {
    Generic,
    Ansi,
    Bigquery,
    Clickhouse,
    #[value(alias = "sparksql")]
    Databricks,
    Duckdb,
    Hive,
    Mssql,
    Mysql,
    Oracle,
    Postgres,
    Redshift,
    Snowflake,
    Sqlite,
}

impl From<DialectArg> for capybara_core::Dialect {
    fn from(d: DialectArg) -> Self {
        match d {
            DialectArg::Generic => capybara_core::Dialect::Generic,
            DialectArg::Ansi => capybara_core::Dialect::Ansi,
            DialectArg::Bigquery => capybara_core::Dialect::Bigquery,
            DialectArg::Clickhouse => capybara_core::Dialect::Clickhouse,
            DialectArg::Databricks => capybara_core::Dialect::Databricks,
            DialectArg::Duckdb => capybara_core::Dialect::Duckdb,
            DialectArg::Hive => capybara_core::Dialect::Hive,
            DialectArg::Mssql => capybara_core::Dialect::Mssql,
            DialectArg::Mysql => capybara_core::Dialect::Mysql,
            DialectArg::Oracle => capybara_core::Dialect::Oracle,
            DialectArg::Postgres => capybara_core::Dialect::Postgres,
            DialectArg::Redshift => capybara_core::Dialect::Redshift,
            DialectArg::Snowflake => capybara_core::Dialect::Snowflake,
            DialectArg::Sqlite => capybara_core::Dialect::Sqlite,
        }
    }
}

/// Output format options
#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum OutputFormat {
    /// Human-readable table format
    Table,
    /// JSON output
    Json,
    /// Mermaid diagram
    Mermaid,
    /// HTML report
    Html,
    /// DuckDB SQL export
    Sql,
    /// CSV archive (zip)
    Csv,
    /// XLSX export
    Xlsx,
    /// DuckDB database file
    Duckdb,
}

fn parse_positive_usize(value: &str) -> Result<usize, String> {
    let parsed = value
        .parse::<usize>()
        .map_err(|_| format!("invalid value '{value}', expected a positive integer"))?;
    if parsed == 0 {
        return Err("must be greater than zero".to_string());
    }
    Ok(parsed)
}

/// Template mode for SQL preprocessing
#[cfg(feature = "templating")]
#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum TemplateArg {
    /// Plain Jinja2 templating
    Jinja,
    /// dbt-style templating with builtin macros
    Dbt,
}

#[cfg(feature = "templating")]
impl From<TemplateArg> for capybara_core::TemplateMode {
    fn from(t: TemplateArg) -> Self {
        match t {
            TemplateArg::Jinja => capybara_core::TemplateMode::Jinja,
            TemplateArg::Dbt => capybara_core::TemplateMode::Dbt,
        }
    }
}

/// Graph detail level for visualization
#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum ViewMode {
    /// Script/file level relationships
    Script,
    /// Table level lineage (default)
    Table,
    /// Column level lineage
    Column,
    /// Hybrid view (scripts + tables)
    Hybrid,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_dialect_conversion() {
        let dialect: capybara_core::Dialect = DialectArg::Postgres.into();
        assert_eq!(dialect, capybara_core::Dialect::Postgres);
    }

    #[test]
    fn test_sparksql_dialect_alias_maps_to_databricks() {
        let args = Args::parse_from(["capybara", "-d", "sparksql", "test.sql"]);
        assert_eq!(args.dialect, DialectArg::Databricks);
        let core_dialect: capybara_core::Dialect = args.dialect.into();
        assert_eq!(core_dialect, capybara_core::Dialect::Databricks);
    }

    #[test]
    fn test_parse_minimal_args() {
        let args = Args::parse_from(["capybara", "test.sql"]);
        assert_eq!(args.files.len(), 1);
        assert_eq!(args.dialect, DialectArg::Generic);
        assert_eq!(args.format, OutputFormat::Table);
        assert_eq!(args.project_name, "lineage");
        assert!(args.export_schema.is_none());
    }

    #[test]
    fn test_parse_full_args() {
        let args = Args::parse_from([
            "capybara",
            "-d",
            "postgres",
            "-f",
            "json",
            "-s",
            "schema.sql",
            "-o",
            "output.json",
            "-v",
            "column",
            "--quiet",
            "--compact",
            "--project-name",
            "demo",
            "--export-schema",
            "lineage",
            "file1.sql",
            "file2.sql",
        ]);
        assert_eq!(args.dialect, DialectArg::Postgres);
        assert_eq!(args.format, OutputFormat::Json);
        assert_eq!(args.schema.unwrap().to_str().unwrap(), "schema.sql");
        assert_eq!(args.output.unwrap().to_str().unwrap(), "output.json");
        assert_eq!(args.view, ViewMode::Column);
        assert_eq!(args.project_name, "demo");
        assert_eq!(args.export_schema.as_deref(), Some("lineage"));
        assert!(args.quiet);
        assert!(args.compact);
        assert_eq!(args.files.len(), 2);
    }

    #[test]
    fn test_lint_flag() {
        let args = Args::parse_from(["capybara", "--lint", "test.sql"]);
        assert!(args.lint);
        assert!(!args.fix);
        assert!(!args.fix_only);
        assert!(!args.unsafe_fixes);
        assert!(!args.legacy_ast_fixes);
        assert!(!args.show_fixes);
        assert!(args.exclude_rules.is_empty());
        assert!(args.rule_configs.is_none());
        assert!(args.jobs.is_none());
        assert!(!args.no_respect_gitignore);
    }

    #[test]
    fn test_lint_fix_flag() {
        let args = Args::parse_from(["capybara", "--lint", "--fix", "test.sql"]);
        assert!(args.lint);
        assert!(args.fix);
        assert!(!args.fix_only);
        assert!(!args.unsafe_fixes);
        assert!(!args.legacy_ast_fixes);
        assert!(!args.show_fixes);
    }

    #[test]
    fn test_fix_only_flag() {
        let args = Args::parse_from(["capybara", "--lint", "--fix", "--fix-only", "test.sql"]);
        assert!(args.lint);
        assert!(args.fix);
        assert!(args.fix_only);
    }

    #[test]
    fn test_fix_only_requires_lint_and_fix() {
        let missing_both = Args::try_parse_from(["capybara", "--fix-only", "test.sql"]);
        assert!(missing_both.is_err());

        let missing_fix = Args::try_parse_from(["capybara", "--lint", "--fix-only", "test.sql"]);
        assert!(missing_fix.is_err());
    }

    #[test]
    fn test_fix_requires_lint() {
        let result = Args::try_parse_from(["capybara", "--fix", "test.sql"]);
        assert!(result.is_err());
    }

    #[test]
    fn test_unsafe_fixes_flag() {
        let args = Args::parse_from(["capybara", "--lint", "--fix", "--unsafe-fixes", "test.sql"]);
        assert!(args.lint);
        assert!(args.fix);
        assert!(args.unsafe_fixes);
    }

    #[test]
    fn test_unsafe_fixes_requires_lint_and_fix() {
        let missing_both = Args::try_parse_from(["capybara", "--unsafe-fixes", "test.sql"]);
        assert!(missing_both.is_err());

        let missing_fix =
            Args::try_parse_from(["capybara", "--lint", "--unsafe-fixes", "test.sql"]);
        assert!(missing_fix.is_err());
    }

    #[test]
    fn test_legacy_ast_fixes_flag() {
        let args = Args::parse_from([
            "capybara",
            "--lint",
            "--fix",
            "--legacy-ast-fixes",
            "test.sql",
        ]);
        assert!(args.lint);
        assert!(args.fix);
        assert!(args.legacy_ast_fixes);
    }

    #[test]
    fn test_legacy_ast_fixes_requires_lint_and_fix() {
        let missing_both = Args::try_parse_from(["capybara", "--legacy-ast-fixes", "test.sql"]);
        assert!(missing_both.is_err());

        let missing_fix =
            Args::try_parse_from(["capybara", "--lint", "--legacy-ast-fixes", "test.sql"]);
        assert!(missing_fix.is_err());
    }

    #[test]
    fn test_show_fixes_flag() {
        let args = Args::parse_from(["capybara", "--lint", "--show-fixes", "test.sql"]);
        assert!(args.lint);
        assert!(args.show_fixes);
    }

    #[test]
    fn test_show_fixes_requires_lint() {
        let result = Args::try_parse_from(["capybara", "--show-fixes", "test.sql"]);
        assert!(result.is_err());
    }

    #[test]
    fn test_lint_exclude_rules() {
        let args = Args::parse_from([
            "capybara",
            "--lint",
            "--exclude-rules",
            "LINT_AM_008,LINT_ST_006",
            "test.sql",
        ]);
        assert!(args.lint);
        assert_eq!(args.exclude_rules, vec!["LINT_AM_008", "LINT_ST_006"]);
    }

    #[test]
    fn test_lint_exclude_rules_repeated() {
        let args = Args::parse_from([
            "capybara",
            "--lint",
            "--exclude-rules",
            "LINT_AM_008",
            "--exclude-rules",
            "LINT_ST_006",
            "test.sql",
        ]);
        assert_eq!(args.exclude_rules, vec!["LINT_AM_008", "LINT_ST_006"]);
    }

    #[test]
    fn test_lint_exclude_rules_requires_lint() {
        let result = Args::try_parse_from([
            "capybara",
            "--exclude-rules",
            "LINT_AM_008,LINT_ST_006",
            "test.sql",
        ]);
        assert!(result.is_err());
    }

    #[test]
    fn test_lint_rule_configs_json() {
        let args = Args::parse_from([
            "capybara",
            "--lint",
            "--rule-configs",
            r#"{"structure.subquery":{"forbid_subquery_in":"both"}}"#,
            "test.sql",
        ]);
        assert_eq!(
            args.rule_configs.as_deref(),
            Some(r#"{"structure.subquery":{"forbid_subquery_in":"both"}}"#)
        );
    }

    #[test]
    fn test_lint_jobs_flag() {
        let args = Args::parse_from(["capybara", "--lint", "--jobs", "4", "test.sql"]);
        assert_eq!(args.jobs, Some(4));
    }

    #[test]
    fn test_lint_jobs_requires_lint() {
        let result = Args::try_parse_from(["capybara", "--jobs", "4", "test.sql"]);
        assert!(result.is_err());
    }

    #[test]
    fn test_lint_jobs_must_be_positive() {
        let result = Args::try_parse_from(["capybara", "--lint", "--jobs", "0", "test.sql"]);
        assert!(result.is_err());
    }

    #[test]
    fn test_lint_no_respect_gitignore_flag() {
        let args = Args::parse_from(["capybara", "--lint", "--no-respect-gitignore", "test.sql"]);
        assert!(args.no_respect_gitignore);
    }

    #[test]
    fn test_lint_no_respect_gitignore_requires_lint() {
        let result = Args::try_parse_from(["capybara", "--no-respect-gitignore", "test.sql"]);
        assert!(result.is_err());
    }

    #[cfg(feature = "serve")]
    #[test]
    fn test_serve_args_defaults() {
        let args = Args::parse_from(["capybara", "--serve"]);
        assert!(args.serve);
        assert_eq!(args.port, 3000);
        assert!(args.watch.is_empty());
        assert!(!args.open);
    }

    #[cfg(feature = "serve")]
    #[test]
    fn test_serve_args_custom_port() {
        let args = Args::parse_from(["capybara", "--serve", "--port", "8080"]);
        assert!(args.serve);
        assert_eq!(args.port, 8080);
    }

    #[cfg(feature = "serve")]
    #[test]
    fn test_serve_args_watch_dirs() {
        let args = Args::parse_from([
            "capybara",
            "--serve",
            "--watch",
            "./sql",
            "--watch",
            "./queries",
        ]);
        assert!(args.serve);
        assert_eq!(args.watch.len(), 2);
        assert_eq!(args.watch[0].to_str().unwrap(), "./sql");
        assert_eq!(args.watch[1].to_str().unwrap(), "./queries");
    }

    #[cfg(feature = "serve")]
    #[test]
    fn test_serve_args_open_browser() {
        let args = Args::parse_from(["capybara", "--serve", "--open"]);
        assert!(args.serve);
        assert!(args.open);
    }

    #[cfg(feature = "serve")]
    #[test]
    fn test_serve_args_full() {
        let args = Args::parse_from([
            "capybara",
            "--serve",
            "--port",
            "9000",
            "--watch",
            "./examples",
            "--open",
            "-d",
            "postgres",
        ]);
        assert!(args.serve);
        assert_eq!(args.port, 9000);
        assert_eq!(args.watch.len(), 1);
        assert!(args.open);
        assert_eq!(args.dialect, DialectArg::Postgres);
    }
}
