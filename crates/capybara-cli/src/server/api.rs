//! REST API handlers for serve mode.
//!
//! This module provides the API endpoints for the web UI to interact with
//! the Capybara analysis engine.

use std::{collections::{BTreeMap, HashMap, HashSet}, sync::Arc};

use axum::{
    body::Bytes,
    extract::{Path, State},
    http::StatusCode,
    response::{sse::{Event, Sse}, IntoResponse, Response},
    routing::{delete, get, post, put},
    Json, Router,
};
use capybara_core::{self, AnalyzeRequest as CoreAnalyzeRequest, Dialect};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};
use utoipa::ToSchema;

use super::{state::MergeSession, AppState};
use super::governance::ai::AiConfig;

/// Build the API router with all endpoints.
pub fn api_routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/health", get(health))
        .route("/analyze", post(analyze))
        .route("/completion", post(completion))
        .route("/split", post(split))
        .route("/lint-fix", post(lint_fix))
        .route("/files", get(files))
        .route("/schema", get(schema))
        .route("/export/{format}", post(export))
        .route("/project-export/start", post(project_export_start))
        .route("/project-export/{session_id}/add", post(project_export_add))
        .route(
            "/project-export/{session_id}/finish",
            post(project_export_finish),
        )
        .route("/config", get(config))
        // Persistence endpoints
        .route("/db/project-files", get(get_project_files))
        .route("/db/project-files", post(save_project_files_api))
        .route("/db/files-meta", get(get_files_meta))
        .route("/db/file-content", get(get_file_content))
        .route("/db/file-contents-batch", post(get_file_contents_batch))
        .route("/db/file-upsert-batch", post(upsert_files_api))
        .route("/db/file-delete-batch", post(delete_files_api))
        .route("/db/file-rename", post(rename_file_api))
        .route("/db/directories", get(get_directories))
        .route("/db/schema-files", get(get_schema_files))
        .route("/db/schema-files", post(save_schema_files_api))
        .route("/db/cache", get(get_cache_api))
        .route("/db/cache", post(set_cache_api))
        .route("/db/cache", delete(delete_cache_api))
        .route("/db/cache/clear", post(clear_cache_api))
        .route("/db/file-results", post(set_file_result_api))
        .route("/db/file-results", get(get_file_results_api))
        .route("/db/file-results/light", get(get_file_results_light_api))
        .route("/db/file-results", delete(delete_file_results_api))
        .route("/db/file-result", get(get_file_result_api))
        .route("/db/lineage", post(save_lineage_api))
        .route("/db/projects", get(get_projects))
        .route("/db/projects", post(save_project_api))
        .route("/db/projects", delete(delete_project_api))
        .route("/db/view-states", get(get_view_state))
        .route("/db/view-states", post(save_view_state))
        .route("/db/lineage/nodes", get(get_lineage_nodes_api))
        .route("/db/lineage/tables", get(get_table_lineage))
        .route("/db/table-level-edges", post(save_table_level_edges_api))
        .route("/db/table-level-edges", get(get_table_level_edges))
        .route("/db/rebuild-table-level-edges", post(rebuild_table_level_edges_api))
        .route("/db/lineage/columns", get(get_lineage_columns_api))
        .route("/db/lineage/edges", get(get_lineage_edges_api))
        .route("/db/table-metadata", post(save_table_metadata_api))
        .route("/db/table-metadata", get(get_table_metadata_api))
        .route("/db/column-metadata", get(get_column_metadata_api))
        .route("/db/anomalies", post(save_anomaly_api))
        .route("/db/anomalies", get(get_anomalies_api))
        .route("/db/convert-procedures", post(convert_procedures))
        .route("/db/analyze-batch", post(analyze_batch))
        // Governance endpoints
        .route("/governance/contracts", get(gov_list_contracts).post(gov_create_contract))
        .route("/governance/contracts/{name}", get(gov_get_contract).put(gov_update_contract).delete(gov_delete_contract))
        .route("/governance/contracts/{name}/validate", post(gov_validate_contract))
        .route("/governance/scan", post(gov_scan))
        .route("/governance/report", get(gov_get_report))
        .route("/governance/health", get(gov_get_health))
        .route("/governance/export/{format}", post(gov_export))
        // Model management
        .route("/governance/models", get(gov_list_models))
        .route("/governance/models/auto", post(gov_auto_discover_models))
        .route("/governance/models/{name}", get(gov_get_model).put(gov_update_model))
        .route("/governance/models/stats", get(gov_model_stats))
        // Metric management
        .route("/governance/metrics", get(gov_list_metrics))
        .route("/governance/metrics/conflicts", get(gov_metric_conflicts))
        .route("/governance/metrics/stats", get(gov_metric_stats))
        .route("/governance/metrics/auto", post(gov_auto_detect_metrics))
        .route("/governance/metrics/import-dbt", post(gov_import_dbt_metrics))
        .route("/governance/metrics/extract-lineage", post(gov_extract_lineage_metrics))
        .route("/governance/metrics/analysis", get(gov_metric_analysis))
        .route("/governance/metrics/scripts", get(gov_metric_scripts))
        // Dimensions
        .route("/governance/dimensions", get(gov_list_dimensions))
        .route("/governance/dimensions/discover", post(gov_discover_dimensions))
        .route("/governance/dimensions/{id}", put(gov_update_dimension))
        // Metric decomposition (atomic / qualifier / derived)
        .route("/governance/metrics/decompose", post(gov_decompose_metrics))
        .route("/governance/metrics/atomic", get(gov_list_atomic_metrics))
        .route("/governance/metrics/qualifiers", get(gov_list_qualifiers))
        .route("/governance/metrics/derived", get(gov_list_derived_metrics))
        // Summary table recommendations
        .route("/governance/recommendations/summary-tables", get(gov_list_summary_recs).post(gov_generate_summary_recs))
        .route("/governance/recommendations/summary-tables/{id}", put(gov_update_summary_rec))
        // Modeling (Dataphin-style)
        .route("/governance/domains", get(gov_list_domains))
        .route("/governance/domains/discover", post(gov_discover_domains))
        .route("/governance/modeling/overview", get(gov_modeling_overview))
        // Designer
        .route("/governance/gen-ddl", post(gov_gen_ddl))
        .route("/governance/reverse-engineer", post(gov_reverse_engineer))
        .route("/governance/model-diff", post(gov_model_diff))
        // Settings
        .route("/governance/settings", get(gov_get_settings).put(gov_update_settings))
        // Contract templates
        .route("/governance/contracts/templates", get(gov_contract_templates))
        // dbt fusion: SQL→dbt conversion + DML extraction
        .route("/convert-dbt", post(gov_convert_dbt))
        .route("/convert-dbt-batch", post(gov_convert_dbt_batch))
        .route("/extract-dml", post(gov_extract_dml))
        .route("/files/dbt-content", put(gov_save_dbt_content))
        .route("/generate-semantic-yaml", post(gov_generate_semantic_yaml))
        .route("/generate-semantic-yaml-batch", post(gov_generate_semantic_yaml_batch))
        .route("/files/dbt-yaml", put(gov_save_dbt_yaml))
        .route("/extract-script-metrics", post(gov_extract_script_metrics))
        // AI assistant
        .route("/ai/config", get(gov_get_ai_config).put(gov_save_ai_config))
        .route("/ai/extract-metrics", post(gov_extract_metrics))
        .route("/ai/chat", post(gov_ai_chat))
        }

// === Request/Response types ===

#[derive(Serialize, ToSchema)]
pub(crate) struct HealthResponse {
    status: &'static str,
    version: &'static str,
}

#[derive(Deserialize)]
pub(crate) struct AnalyzeRequest {
    sql: String,
    #[serde(default)]
    files: Option<Vec<capybara_core::FileSource>>,
    #[serde(default)]
    dialect: Option<String>,
    #[serde(default, alias = "sourceName")]
    source_name: Option<String>,
    #[serde(default)]
    hide_ctes: Option<bool>,
    #[serde(default)]
    enable_column_lineage: Option<bool>,
    #[serde(default)]
    template_mode: Option<String>,
}

#[derive(Deserialize, ToSchema)]
pub(crate) struct CompletionRequest {
    sql: String,
    #[serde(alias = "position")]
    cursor_offset: usize,
}

#[derive(Deserialize, ToSchema)]
pub(crate) struct SplitRequest {
    sql: String,
}

#[derive(Serialize, ToSchema)]
pub(crate) struct ConfigResponse {
    dialect: String,
    watch_dirs: Vec<String>,
    has_schema: bool,
    #[cfg(feature = "templating")]
    template_mode: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct ExportRequest {
    sql: String,
    #[serde(default)]
    files: Option<Vec<capybara_core::FileSource>>,
}

#[derive(Serialize, ToSchema)]
pub(crate) struct ProjectExportStartResponse {
    session_id: String,
}

#[derive(Deserialize)]
pub(crate) struct ProjectExportFinishRequest {
    format: String,
    #[serde(default)]
    sheets: Option<Vec<capybara_export::ExportSheet>>,
    #[serde(default)]
    compact: bool,
}

#[derive(Deserialize, ToSchema)]
pub(crate) struct LintFixRequest {
    sql: String,
    #[serde(default, alias = "include_unsafe_fixes")]
    unsafe_fixes: bool,
    #[serde(default, alias = "legacyAstFixes")]
    legacy_ast_fixes: bool,
    #[serde(default, alias = "exclude_rules")]
    disabled_rules: Vec<String>,
    #[serde(default)]
    rule_configs: BTreeMap<String, serde_json::Value>,
}

#[derive(Serialize, ToSchema)]
pub(crate) struct LintFixResponse {
    sql: String,
    changed: bool,
    fix_counts: LintFixCountsResponse,
    skipped_due_to_comments: bool,
    skipped_due_to_regression: bool,
    skipped_counts: LintFixSkippedCountsResponse,
}

#[derive(Serialize, ToSchema)]
pub(crate) struct LintFixCountsResponse {
    total: usize,
}

#[derive(Serialize, ToSchema)]
pub(crate) struct LintFixSkippedCountsResponse {
    unsafe_skipped: usize,
    protected_range_blocked: usize,
    overlap_conflict_blocked: usize,
    display_only: usize,
    blocked_total: usize,
}

// === Handlers ===

/// GET /api/health - Health check with version
#[utoipa::path(
    get,
    path = "/api/health",
    tag = "Core",
    responses(
        (status = 200, description = "Server health status", body = HealthResponse)
    )
)]
pub(crate) async fn health() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        version: env!("CARGO_PKG_VERSION"),
    })
}

/// POST /api/analyze - Run lineage analysis
#[utoipa::path(
    post,
    path = "/api/analyze",
    tag = "Core",
    request_body(content_type = "application/json"),
    responses(
        (status = 200, description = "Analysis result JSON"),
        (status = 500, description = "Analysis error")
    )
)]
pub(crate) async fn analyze(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<AnalyzeRequest>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let schema = state.schema.read().await.clone();

    // Build analysis options from request
    let options = if payload.hide_ctes.is_some() || payload.enable_column_lineage.is_some() {
        Some(capybara_core::AnalysisOptions {
            hide_ctes: payload.hide_ctes,
            enable_column_lineage: payload.enable_column_lineage,
            ..Default::default()
        })
    } else {
        None
    };

    // Build template config if template mode is specified
    #[cfg(feature = "templating")]
    let template_config = resolve_template_config(payload.template_mode.as_deref(), state.as_ref());

    let dialect = payload
        .dialect
        .as_deref()
        .and_then(|d| match d.to_lowercase().as_str() {
            "generic" => Some(capybara_core::Dialect::Generic),
            "hive" => Some(capybara_core::Dialect::Hive),
            "bigquery" => Some(capybara_core::Dialect::Bigquery),
            "mysql" => Some(capybara_core::Dialect::Mysql),
            "postgresql" | "postgres" => Some(capybara_core::Dialect::Postgres),
            "sqlite" => Some(capybara_core::Dialect::Sqlite),
            "snowflake" => Some(capybara_core::Dialect::Snowflake),
            "mssql" | "sqlserver" => Some(capybara_core::Dialect::Mssql),
            "redshift" => Some(capybara_core::Dialect::Redshift),
            "ansi" => Some(capybara_core::Dialect::Ansi),
            "clickhouse" => Some(capybara_core::Dialect::Clickhouse),
            "databricks" => Some(capybara_core::Dialect::Databricks),
            "duckdb" => Some(capybara_core::Dialect::Duckdb),
            "oracle" => Some(capybara_core::Dialect::Oracle),
            _ => None,
        })
        .unwrap_or(state.config.dialect);

    let request = capybara_core::AnalyzeRequest {
        sql: payload.sql,
        files: payload.files,
        dialect,
        source_name: payload.source_name.clone(),
        options,
        schema,
        #[cfg(feature = "templating")]
        template_config,
    };

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        capybara_core::analyze(&request)
    }));
    match result {
        Ok(r) => Ok(Json(r)),
        Err(panic_err) => {
            let msg = if let Some(s) = panic_err.downcast_ref::<&str>() {
                s.to_string()
            } else if let Some(s) = panic_err.downcast_ref::<String>() {
                s.clone()
            } else {
                "unknown panic".to_string()
            };
            eprintln!("flowscope: analyze panicked: {msg}");
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Analysis panic: {msg}"),
            ))
        }
    }
}

/// POST /api/completion - Get code completion items
#[utoipa::path(
    post,
    path = "/api/completion",
    tag = "Core",
    responses(
        (status = 200, description = "Completion items", body = serde_json::Value),
        (status = 500, description = "Server error")
    )
)]
pub(crate) async fn completion(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<CompletionRequest>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let schema = state.schema.read().await.clone();

    let request = capybara_core::CompletionRequest {
        sql: payload.sql,
        cursor_offset: payload.cursor_offset,
        dialect: state.config.dialect,
        schema,
    };

    let result = capybara_core::completion_items(&request);
    Ok(Json(result))
}

/// POST /api/split - Split SQL into statements
#[utoipa::path(
    post,
    path = "/api/split",
    tag = "Core",
    responses(
        (status = 200, description = "Split result", body = Vec<String>),
        (status = 500, description = "Server error")
    )
)]
pub(crate) async fn split(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<SplitRequest>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let request = capybara_core::StatementSplitRequest {
        sql: payload.sql,
        dialect: state.config.dialect,
    };

    let result = capybara_core::split_statements(&request);
    Ok(Json(result))
}

/// POST /api/lint-fix - Apply deterministic lint fixes to SQL text.
#[utoipa::path(
    post,
    path = "/api/lint-fix",
    tag = "Core",
    request_body = LintFixRequest,
    responses(
        (status = 200, description = "Lint fix result", body = LintFixResponse),
        (status = 500, description = "Server error")
    )
)]
pub(crate) async fn lint_fix(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<LintFixRequest>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let rule_configs = normalize_rule_configs(payload.rule_configs)
        .map_err(|err| (StatusCode::BAD_REQUEST, err))?;

    let lint_config = capybara_core::LintConfig {
        enabled: true,
        disabled_rules: payload.disabled_rules,
        rule_configs,
    };

    let execution = crate::fix::apply_lint_fixes_with_runtime_options(
        &payload.sql,
        state.config.dialect,
        &lint_config,
        crate::fix::LintFixRuntimeOptions {
            include_unsafe_fixes: payload.unsafe_fixes,
            legacy_ast_fixes: payload.legacy_ast_fixes,
        },
    )
    .map_err(|err| {
        eprintln!("flowscope: lint-fix failed: {err}");
        (
            StatusCode::BAD_REQUEST,
            "Failed to apply lint fixes".to_string(),
        )
    })?;
    let outcome = execution.outcome;
    let candidate_stats = execution.candidate_stats;

    let skipped_counts = LintFixSkippedCountsResponse {
        unsafe_skipped: candidate_stats.blocked_unsafe,
        protected_range_blocked: candidate_stats.blocked_protected_range,
        overlap_conflict_blocked: candidate_stats.blocked_overlap_conflict,
        display_only: candidate_stats.blocked_display_only,
        blocked_total: candidate_stats.blocked,
    };

    Ok(Json(LintFixResponse {
        sql: outcome.sql,
        changed: outcome.changed,
        fix_counts: LintFixCountsResponse {
            total: outcome.counts.total(),
        },
        skipped_due_to_comments: outcome.skipped_due_to_comments,
        skipped_due_to_regression: outcome.skipped_due_to_regression,
        skipped_counts,
    }))
}

/// GET /api/files - List watched files with content
#[utoipa::path(
    get,
    path = "/api/files",
    tag = "Core",
    responses(
        (status = 200, description = "List of watched files", body = Vec<serde_json::Value>)
    )
)]
pub(crate) async fn files(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let files = state.files.read().await;
    Json(files.clone())
}

/// GET /api/schema - Get schema metadata
#[utoipa::path(
    get,
    path = "/api/schema",
    tag = "Core",
    responses(
        (status = 200, description = "Schema metadata", body = serde_json::Value)
    )
)]
pub(crate) async fn schema(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let schema = state.schema.read().await;
    Json(schema.clone())
}

/// POST /api/export/:format - Export to specified format
#[utoipa::path(
    post,
    path = "/api/export/{format}",
    tag = "Core",
    params(
        ("format" = String, Path, description = "Export format (json/mermaid/html/csv/xlsx)")
    ),
    request_body(content_type = "application/json"),
    responses(
        (status = 200, description = "Exported result", body = serde_json::Value),
        (status = 500, description = "Server error")
    )
)]
pub(crate) async fn export(
    State(state): State<Arc<AppState>>,
    Path(format): Path<String>,
    Json(payload): Json<ExportRequest>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let schema = state.schema.read().await.clone();

    let request = capybara_core::AnalyzeRequest {
        sql: payload.sql,
        files: payload.files,
        dialect: state.config.dialect,
        source_name: None,
        options: None,
        schema,
        #[cfg(feature = "templating")]
        template_config: state.config.template_config.clone(),
    };

    let result = capybara_core::analyze(&request);

    match format.as_str() {
        "json" => {
            let output = capybara_export::export_json(&result, false)
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            Ok((
                [(axum::http::header::CONTENT_TYPE, "application/json")],
                output,
            )
                .into_response())
        }
        "mermaid" => {
            let output =
                capybara_export::export_mermaid(&result, capybara_export::MermaidView::Table)
                    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            Ok(([(axum::http::header::CONTENT_TYPE, "text/plain")], output).into_response())
        }
        "html" => {
            let output = capybara_export::export_html(&result, "lineage", chrono::Utc::now())
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            Ok(([(axum::http::header::CONTENT_TYPE, "text/html")], output).into_response())
        }
        "csv" => {
            let bytes = capybara_export::export_csv_bundle(&result, None)
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            Ok((
                [(axum::http::header::CONTENT_TYPE, "application/zip")],
                bytes,
            )
                .into_response())
        }
        "xlsx" => {
            let bytes = capybara_export::export_xlsx(&result, None)
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            Ok((
                [(
                    axum::http::header::CONTENT_TYPE,
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                )],
                bytes,
            )
                .into_response())
        }
        _ => Err((
            StatusCode::BAD_REQUEST,
            format!("Unknown export format: {format}"),
        )),
    }
}

/// POST /api/project-export/start - Create a new progressive export session.
#[utoipa::path(
    post,
    path = "/api/project-export/start",
    tag = "Core",
    responses(
        (status = 201, description = "Session created", body = ProjectExportStartResponse),
        (status = 500, description = "Server error")
    )
)]
pub(crate) async fn project_export_start(
    State(state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let session_id = {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        format!(
            "{:x}{:x}",
            chrono::Local::now().timestamp_millis(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        )
    };
    state
        .merge_sessions
        .write()
        .await
        .insert(session_id.clone(), MergeSession { merged: None });
    Ok((
        StatusCode::CREATED,
        Json(ProjectExportStartResponse { session_id }),
    ))
}

/// POST /api/project-export/{session_id}/add - Add one AnalyzeResult to a session.
#[utoipa::path(
    post,
    path = "/api/project-export/{session_id}/add",
    tag = "Core",
    params(
        ("session_id" = String, Path, description = "Export session ID")
    ),
    request_body(content_type = "application/json"),
    responses(
        (status = 202, description = "Result added to session", body = serde_json::Value),
        (status = 500, description = "Server error")
    )
)]
pub(crate) async fn project_export_add(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    body: Bytes,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let result = serde_json::from_slice::<capybara_core::AnalyzeResult>(&body).map_err(|e| {
        (
            StatusCode::BAD_REQUEST,
            format!("Invalid AnalyzeResult JSON: {e}"),
        )
    })?;

    let mut sessions = state.merge_sessions.write().await;
    let session = sessions.get_mut(&session_id).ok_or_else(|| {
        (
            StatusCode::NOT_FOUND,
            format!("Unknown export session: {session_id}"),
        )
    })?;

    match session.merged.as_mut() {
        Some(existing) => existing.merge_into(result),
        None => session.merged = Some(result),
    }

    Ok(StatusCode::ACCEPTED)
}

/// POST /api/project-export/{session_id}/finish - Finalize export and return the file.
#[utoipa::path(
    post,
    path = "/api/project-export/{session_id}/finish",
    tag = "Core",
    params(
        ("session_id" = String, Path, description = "Export session ID")
    ),
    request_body(content_type = "application/json"),
    responses(
        (status = 200, description = "Exported file", body = serde_json::Value),
        (status = 500, description = "Server error")
    )
)]
pub(crate) async fn project_export_finish(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    Json(payload): Json<ProjectExportFinishRequest>,
) -> Result<Response, (StatusCode, String)> {
    let merged = {
        let mut sessions = state.merge_sessions.write().await;
        let session = sessions.remove(&session_id).ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                format!("Unknown export session: {session_id}"),
            )
        })?;
        session.merged.ok_or_else(|| {
            (
                StatusCode::BAD_REQUEST,
                "Export session is empty".to_string(),
            )
        })?
    };

    build_project_export_response(
        &merged,
        &payload.format,
        payload.sheets.as_deref(),
        payload.compact,
    )
}

fn build_project_export_response(
    merged: &capybara_core::AnalyzeResult,
    format: &str,
    sheets: Option<&[capybara_export::ExportSheet]>,
    compact: bool,
) -> Result<Response, (StatusCode, String)> {
    match format {
        "json" => {
            let output = if let Some(sheets) = sheets {
                capybara_export::export_json_sheets(merged, Some(sheets), compact)
            } else {
                capybara_export::export_json(merged, compact)
            }
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            Ok((
                [(axum::http::header::CONTENT_TYPE, "application/json")],
                output,
            )
                .into_response())
        }
        "csv" => {
            let bytes = capybara_export::export_csv_bundle(merged, sheets)
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            Ok((
                [(axum::http::header::CONTENT_TYPE, "application/zip")],
                bytes,
            )
                .into_response())
        }
        "xlsx" => {
            let bytes = capybara_export::export_xlsx(merged, sheets)
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            Ok((
                [(
                    axum::http::header::CONTENT_TYPE,
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                )],
                bytes,
            )
                .into_response())
        }
        _ => Err((
            StatusCode::BAD_REQUEST,
            format!("Unknown export format: {format}"),
        )),
    }
}

/// GET /api/config - Get server configuration
#[utoipa::path(
    get,
    path = "/api/config",
    tag = "Core",
    responses(
        (status = 200, description = "Server configuration", body = ConfigResponse)
    )
)]
pub(crate) async fn config(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let has_schema = state.schema.read().await.is_some();

    Json(ConfigResponse {
        dialect: format!("{:?}", state.config.dialect),
        watch_dirs: state
            .config
            .watch_dirs
            .iter()
            .map(|p| p.display().to_string())
            .collect(),
        has_schema,
        #[cfg(feature = "templating")]
        template_mode: state
            .config
            .template_config
            .as_ref()
            .map(|cfg| template_mode_to_str(cfg.mode).to_string()),
    })
}

fn normalize_rule_configs(
    raw_configs: BTreeMap<String, serde_json::Value>,
) -> Result<BTreeMap<String, serde_json::Value>, String> {
    let mut rule_configs = BTreeMap::new();
    let mut indentation_legacy = serde_json::Map::new();

    for (rule_ref, options) in raw_configs {
        if options.is_object() {
            rule_configs.insert(rule_ref, options);
            continue;
        }

        // SQLFluff compatibility: support legacy indentation keys at root.
        if matches!(
            rule_ref.to_ascii_lowercase().as_str(),
            "indent_unit" | "tab_space_size" | "indented_joins" | "indented_using_on"
        ) {
            indentation_legacy.insert(rule_ref, options);
            continue;
        }

        return Err(format!(
            "'rule_configs' entry for '{rule_ref}' must be a JSON object"
        ));
    }

    if !indentation_legacy.is_empty() {
        let merged = match rule_configs.remove("indentation") {
            Some(serde_json::Value::Object(existing)) => {
                let mut merged = existing;
                for (key, value) in indentation_legacy {
                    merged.insert(key, value);
                }
                merged
            }
            Some(other) => {
                return Err(format!(
                    "'rule_configs' entry for 'indentation' must be a JSON object, found {other}"
                ));
            }
            None => indentation_legacy,
        };

        rule_configs.insert("indentation".to_string(), serde_json::Value::Object(merged));
    }

    Ok(rule_configs)
}

#[cfg(feature = "templating")]
fn resolve_template_config(
    mode: Option<&str>,
    state: &AppState,
) -> Option<capybara_core::TemplateConfig> {
    match mode {
        Some("raw") => None,
        Some("jinja") => Some(build_template_config(
            capybara_core::TemplateMode::Jinja,
            state,
        )),
        Some("dbt") => Some(build_template_config(
            capybara_core::TemplateMode::Dbt,
            state,
        )),
        Some(_) => state.config.template_config.clone(),
        None => state.config.template_config.clone(),
    }
}

#[cfg(feature = "templating")]
fn build_template_config(
    template_mode: capybara_core::TemplateMode,
    state: &AppState,
) -> capybara_core::TemplateConfig {
    let context = state
        .config
        .template_config
        .as_ref()
        .map(|cfg| cfg.context.clone())
        .unwrap_or_default();

    capybara_core::TemplateConfig {
        mode: template_mode,
        context,
    }
}

#[cfg(feature = "templating")]
fn template_mode_to_str(mode: capybara_core::TemplateMode) -> &'static str {
    match mode {
        capybara_core::TemplateMode::Raw => "raw",
        capybara_core::TemplateMode::Jinja => "jinja",
        capybara_core::TemplateMode::Dbt => "dbt",
    }
}

// === Persistence Handlers ===

use super::store;
use axum::extract::Query;

#[derive(Deserialize, ToSchema)]
pub(crate) struct ProjectFilesQuery {
    #[serde(alias = "projectId")]
    project_id: String,
}

#[derive(Deserialize, ToSchema)]
pub(crate) struct LineageQuery {
    #[serde(alias = "projectId")]
    project_id: String,
    #[serde(alias = "filePath")]
    file_path: Option<String>,
    #[serde(alias = "edgeType")]
    edge_type: Option<String>,
}

// ── project_files ──────────────────────────────────────────────────────

/// GET /api/db/project-files - Get project files
#[utoipa::path(
    get,
    path = "/api/db/project-files",
    tag = "Files",
    params(
        ("projectId" = String, Query, description = "Project ID")
    ),
    responses(
        (status = 200, description = "Project files", body = Vec<serde_json::Value>),
        (status = 500, description = "Server error")
    )
)]
pub(crate) async fn get_project_files(
    State(state): State<Arc<AppState>>,
    Query(q): Query<ProjectFilesQuery>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let db = state
        .db
        .lock()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let files = store::load_project_files(&db, &q.project_id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(files))
}

#[derive(Deserialize, ToSchema)]
pub(crate) struct SaveProjectFilesRequest {
    #[serde(alias = "projectId")]
    project_id: String,
    files: Vec<store::ProjectFileRow>,
}

/// POST /api/db/project-files - Save project files
#[utoipa::path(
    post,
    path = "/api/db/project-files",
    tag = "Files",
    request_body = SaveProjectFilesRequest,
    responses(
        (status = 200, description = "OK"),
        (status = 500, description = "Server error")
    )
)]
pub(crate) async fn save_project_files_api(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<SaveProjectFilesRequest>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    eprintln!(
        "[api] save_project_files: project={}, files={}",
        payload.project_id,
        payload.files.len()
    );
    let db = state
        .db
        .lock()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    store::save_project_files(&db, &payload.project_id, &payload.files)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(StatusCode::OK)
}

// ── file metadata (no content) ─────────────────────────────────────────

/// GET /api/db/files-meta - Get file metadata
#[utoipa::path(
    get,
    path = "/api/db/files-meta",
    tag = "Files",
    params(
        ("projectId" = String, Query, description = "Project ID")
    ),
    responses(
        (status = 200, description = "File metadata", body = Vec<serde_json::Value>),
        (status = 500, description = "Server error")
    )
)]
pub(crate) async fn get_files_meta(
    State(state): State<Arc<AppState>>,
    Query(q): Query<ProjectFilesQuery>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let db = state
        .db
        .lock()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let files = store::load_file_metadata(&db, &q.project_id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(files))
}

// ── single file content ────────────────────────────────────────────────

#[derive(Deserialize, ToSchema)]
pub(crate) struct FileContentQuery {
    #[serde(alias = "projectId")]
    project_id: String,
    path: String,
}

#[derive(Serialize, ToSchema)]
pub(crate) struct FileContentResponse {
    content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    is_procedure: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    transformed_content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dbt_content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dbt_yaml: Option<String>,
}

/// GET /api/db/file-content - Get file content
#[utoipa::path(
    get,
    path = "/api/db/file-content",
    tag = "Files",
    params(
        ("projectId" = String, Query, description = "Project ID"),
        ("path" = String, Query, description = "File path")
    ),
    responses(
        (status = 200, description = "File content", body = FileContentResponse),
        (status = 500, description = "Server error")
    )
)]
pub(crate) async fn get_file_content(
    State(state): State<Arc<AppState>>,
    Query(q): Query<FileContentQuery>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let db = state
        .db
        .lock()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let full = store::load_file_full(&db, &q.project_id, &q.path)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(FileContentResponse {
        content: full.as_ref().and_then(|f| f.content.clone()),
        is_procedure: full.as_ref().map(|f| f.is_procedure),
        transformed_content: full.as_ref().and_then(|f| f.transformed_content.clone()),
        dbt_content: full.as_ref().and_then(|f| f.dbt_content.clone()),
        dbt_yaml: full.as_ref().and_then(|f| f.dbt_yaml.clone()),
    }))
}

/// POST /api/db/file-contents-batch - Get file content for multiple paths
#[derive(Deserialize)]
struct FileContentsBatchRequest {
    #[serde(alias = "projectId")]
    project_id: String,
    paths: Vec<String>,
}

#[derive(Serialize)]
struct FileContentEntry {
    path: String,
    content: Option<String>,
    is_procedure: Option<i64>,
    transformed_content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dbt_content: Option<String>,
}

pub(crate) async fn get_file_contents_batch(
    State(state): State<Arc<AppState>>,
    Json(req): Json<FileContentsBatchRequest>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let db = state
        .db
        .lock()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let mut results = Vec::with_capacity(req.paths.len());
    for path in &req.paths {
        let full = store::load_file_full(&db, &req.project_id, path)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        results.push(FileContentEntry {
            path: path.clone(),
            content: full.as_ref().and_then(|f| f.content.clone()),
            is_procedure: full.as_ref().map(|f| f.is_procedure),
            transformed_content: full.as_ref().and_then(|f| f.transformed_content.clone()),
            dbt_content: full.as_ref().and_then(|f| f.dbt_content.clone()),
        });
    }
    Ok(Json(results))
}

// ── incremental upsert ─────────────────────────────────────────────────

/// POST /api/db/file-upsert-batch - Upsert files
#[utoipa::path(
    post,
    path = "/api/db/file-upsert-batch",
    tag = "Files",
    request_body = SaveProjectFilesRequest,
    responses(
        (status = 200, description = "OK"),
        (status = 500, description = "Server error")
    )
)]
pub(crate) async fn upsert_files_api(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<SaveProjectFilesRequest>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    eprintln!(
        "[api] upsert_files: project={}, files={}",
        payload.project_id,
        payload.files.len()
    );
    let db = state
        .db
        .lock()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    store::upsert_project_files(&db, &payload.project_id, &payload.files)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(StatusCode::OK)
}

// ── delete by paths ────────────────────────────────────────────────────

#[derive(Deserialize, ToSchema)]
pub(crate) struct DeleteFilesRequest {
    #[serde(alias = "projectId")]
    project_id: String,
    paths: Vec<String>,
}

/// POST /api/db/file-delete-batch - Delete files
#[utoipa::path(
    post,
    path = "/api/db/file-delete-batch",
    tag = "Files",
    request_body = DeleteFilesRequest,
    responses(
        (status = 200, description = "OK"),
        (status = 500, description = "Server error")
    )
)]
pub(crate) async fn delete_files_api(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<DeleteFilesRequest>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let db = state
        .db
        .lock()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    store::delete_project_files_by_paths(&db, &payload.project_id, &payload.paths)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(StatusCode::OK)
}

// ── rename ─────────────────────────────────────────────────────────────

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RenameFileRequest {
    project_id: String,
    old_path: String,
    new_path: String,
    new_name: String,
    #[serde(default)]
    is_folder: bool,
}

/// POST /api/db/file-rename - Rename file
#[utoipa::path(
    post,
    path = "/api/db/file-rename",
    tag = "Files",
    request_body = RenameFileRequest,
    responses(
        (status = 200, description = "OK"),
        (status = 500, description = "Server error")
    )
)]
pub(crate) async fn rename_file_api(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<RenameFileRequest>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let db = state
        .db
        .lock()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    if payload.is_folder {
        store::rename_project_folder(
            &db,
            &payload.project_id,
            &payload.old_path,
            &payload.new_path,
        )
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    } else {
        store::rename_project_file(
            &db,
            &payload.project_id,
            &payload.old_path,
            &payload.new_path,
            &payload.new_name,
        )
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    }
    Ok(StatusCode::OK)
}

// ── directories ────────────────────────────────────────────────────────

/// GET /api/db/directories - Get directories
#[utoipa::path(
    get,
    path = "/api/db/directories",
    tag = "Directories",
    params(
        ("projectId" = String, Query, description = "Project ID")
    ),
    responses(
        (status = 200, description = "Directories", body = Vec<serde_json::Value>),
        (status = 500, description = "Server error")
    )
)]
pub(crate) async fn get_directories(
    State(state): State<Arc<AppState>>,
    Query(q): Query<ProjectFilesQuery>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let db = state
        .db
        .lock()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let dirs = store::load_directories(&db, &q.project_id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(dirs))
}

// ── projects ───────────────────────────────────────────────────────────

/// GET /api/db/projects - Get projects
#[utoipa::path(
    get,
    path = "/api/db/projects",
    tag = "Projects",
    responses(
        (status = 200, description = "Projects", body = Vec<serde_json::Value>),
        (status = 500, description = "Server error")
    )
)]
pub(crate) async fn get_projects(
    State(state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let db = state
        .db
        .lock()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let projects = store::load_projects(&db)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(projects))
}

#[derive(Deserialize, ToSchema)]
pub(crate) struct SaveProjectRequest {
    project: store::ProjectRow,
}

/// POST /api/db/projects - Save project
#[utoipa::path(
    post,
    path = "/api/db/projects",
    tag = "Projects",
    request_body = SaveProjectRequest,
    responses(
        (status = 200, description = "OK"),
        (status = 500, description = "Server error")
    )
)]
pub(crate) async fn save_project_api(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<SaveProjectRequest>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let db = state
        .db
        .lock()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    store::save_project(&db, &payload.project)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(StatusCode::OK)
}

#[derive(Deserialize, ToSchema)]
pub(crate) struct ProjectIdQuery {
    #[serde(alias = "projectId")]
    project_id: String,
}

/// DELETE /api/db/projects - Delete project
#[utoipa::path(
    delete,
    path = "/api/db/projects",
    tag = "Projects",
    params(
        ("projectId" = String, Query, description = "Project ID")
    ),
    responses(
        (status = 200, description = "OK"),
        (status = 500, description = "Server error")
    )
)]
pub(crate) async fn delete_project_api(
    State(state): State<Arc<AppState>>,
    Query(q): Query<ProjectIdQuery>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let db = state
        .db
        .lock()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    store::delete_project(&db, &q.project_id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(StatusCode::OK)
}

// ── view_states ─────────────────────────────────────────────────────────

/// GET /api/db/view-states - Get view state
#[utoipa::path(
    get,
    path = "/api/db/view-states",
    tag = "Views",
    params(
        ("projectId" = String, Query, description = "Project ID")
    ),
    responses(
        (status = 200, description = "View state", body = serde_json::Value),
        (status = 500, description = "Server error")
    )
)]
pub(crate) async fn get_view_state(
    State(state): State<Arc<AppState>>,
    Query(q): Query<ProjectIdQuery>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let db = state
        .db
        .lock()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let state_json = store::load_view_state(&db, &q.project_id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(state_json))
}

#[derive(Deserialize, ToSchema)]
pub(crate) struct SaveViewStateRequest {
    #[serde(alias = "projectId")]
    project_id: String,
    #[serde(alias = "stateJson")]
    state_json: String,
}

/// POST /api/db/view-states - Save view state
#[utoipa::path(
    post,
    path = "/api/db/view-states",
    tag = "Views",
    request_body = SaveViewStateRequest,
    responses(
        (status = 200, description = "OK"),
        (status = 500, description = "Server error")
    )
)]
pub(crate) async fn save_view_state(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<SaveViewStateRequest>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let db = state
        .db
        .lock()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    store::save_view_state(&db, &payload.project_id, &payload.state_json)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(StatusCode::OK)
}

// ── table-level lineage ────────────────────────────────────────────────

/// GET /api/db/lineage/tables - Get table lineage
#[utoipa::path(
    get,
    path = "/api/db/lineage/tables",
    tag = "Lineage",
    params(
        ("projectId" = String, Query, description = "Project ID")
    ),
    responses(
        (status = 200, description = "Table lineage", body = Vec<serde_json::Value>),
        (status = 500, description = "Server error")
    )
)]
pub(crate) async fn get_table_lineage(
    State(state): State<Arc<AppState>>,
    Query(q): Query<ProjectIdQuery>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let db = state
        .db
        .lock()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let edges = store::load_table_lineage(&db, &q.project_id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(edges))
}

// ── table_level_edges (物化预计算) ─────────────────────────────────────

#[derive(Deserialize, ToSchema)]
pub(crate) struct SaveTableLevelEdgesRequest {
    #[serde(alias = "projectId")]
    project_id: String,
    edges: Vec<(String, String, String)>,
}

/// POST /api/db/table-level-edges - Save table level edges
#[utoipa::path(
    post,
    path = "/api/db/table-level-edges",
    tag = "Lineage",
    request_body = SaveTableLevelEdgesRequest,
    responses(
        (status = 200, description = "OK"),
        (status = 500, description = "Server error")
    )
)]
pub(crate) async fn save_table_level_edges_api(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<SaveTableLevelEdgesRequest>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let db = state
        .db
        .lock()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    store::save_table_level_edges(&db, &payload.project_id, &payload.edges)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(StatusCode::OK)
}

/// POST /api/db/rebuild-table-level-edges — rebuild table_level_edges from
/// lineage_nodes + lineage_edges (normalized edge_type, includes old
/// uppercase 'DataFlow'). Deletes existing rows for the project then
/// recomputes reads×writes per statement.
#[derive(Deserialize)]
struct RebuildTableLevelEdgesRequest {
    #[serde(alias = "projectId")]
    project_id: String,
}

pub(crate) async fn rebuild_table_level_edges_api(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<RebuildTableLevelEdgesRequest>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let db = state
        .db
        .lock()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    store::rebuild_table_level_edges(&db, &payload.project_id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(StatusCode::OK)
}

/// GET /api/db/table-level-edges - Get table level edges
#[utoipa::path(
    get,
    path = "/api/db/table-level-edges",
    tag = "Lineage",
    params(
        ("projectId" = String, Query, description = "Project ID")
    ),
    responses(
        (status = 200, description = "Table level edges", body = Vec<serde_json::Value>),
        (status = 500, description = "Server error")
    )
)]
pub(crate) async fn get_table_level_edges(
    State(state): State<Arc<AppState>>,
    Query(q): Query<ProjectIdQuery>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let db = state
        .db
        .lock()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let edges = store::load_table_level_edges(&db, &q.project_id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(edges))
}

// ── schema_files ───────────────────────────────────────────────────────

/// GET /api/db/schema-files - Get schema files
#[utoipa::path(
    get,
    path = "/api/db/schema-files",
    tag = "Schema",
    params(
        ("projectId" = String, Query, description = "Project ID")
    ),
    responses(
        (status = 200, description = "Schema files", body = Vec<serde_json::Value>),
        (status = 500, description = "Server error")
    )
)]
pub(crate) async fn get_schema_files(
    State(state): State<Arc<AppState>>,
    Query(q): Query<ProjectFilesQuery>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let db = state
        .db
        .lock()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let files = store::load_schema_files(&db, &q.project_id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(files))
}

#[derive(Deserialize, ToSchema)]
pub(crate) struct SaveSchemaFilesRequest {
    #[serde(alias = "projectId")]
    project_id: String,
    files: Vec<store::SchemaFileRow>,
}

/// POST /api/db/schema-files - Save schema files
#[utoipa::path(
    post,
    path = "/api/db/schema-files",
    tag = "Schema",
    request_body = SaveSchemaFilesRequest,
    responses(
        (status = 200, description = "OK"),
        (status = 500, description = "Server error")
    )
)]
pub(crate) async fn save_schema_files_api(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<SaveSchemaFilesRequest>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let db = state
        .db
        .lock()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    store::save_schema_files(&db, &payload.project_id, &payload.files)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    // Parse DDL to extract table/column metadata using the flowscope-core analyzer
    if !payload.files.is_empty() {
        eprintln!(
            "[api] save_schema_files_api: extracting DDL metadata from {} files",
            payload.files.len()
        );
        extract_and_save_ddl_metadata(&db, &payload.project_id, &payload.files).map_err(|e| {
            eprintln!("[api] extract_and_save_ddl_metadata error: {:?}", e);
            e
        })?;
    }

    Ok(StatusCode::OK)
}

/// Parse schema DDL text and save table/column metadata to the database.
/// Processes each file individually to avoid large batch sizes.
fn extract_and_save_ddl_metadata(
    db: &rusqlite::Connection,
    project_id: &str,
    files: &[store::SchemaFileRow],
) -> Result<(), (StatusCode, String)> {
    let now = || chrono::Local::now().to_rfc3339();

    let mut all_tables: Vec<store::TableMetadataRow> = Vec::new();
    let mut all_columns: Vec<store::ColumnMetadataRow> = Vec::new();
    let mut table_seq_id: i64 = 0;

    for (fi, f) in files.iter().enumerate() {
        if f.content.trim().is_empty() {
            continue;
        }
        // Log progress every 100 files
        if fi > 0 && fi % 100 == 0 {
            eprintln!(
                "[api] extract_and_save_ddl_metadata: processed {}/{} files",
                fi,
                files.len()
            );
        }

        let result = capybara_core::analyze(&CoreAnalyzeRequest {
            sql: f.content.clone(),
            files: None,
            dialect: Dialect::Hive,
            source_name: None,
            options: None,
            schema: None,
            #[cfg(feature = "templating")]
            template_config: None,
        });

        if let Some(ref resolved) = result.resolved_schema {
            for t in &resolved.tables {
                table_seq_id += 1;
                let table_id = table_seq_id;
                all_tables.push(store::TableMetadataRow {
                    id: 0,
                    project_id: project_id.to_string(),
                    catalog: t.catalog.clone().unwrap_or_default(),
                    schema_name: t.schema.clone().unwrap_or_default(),
                    table_name: t.name.clone(),
                    table_type: "table".to_string(),
                    origin: "imported".to_string(),
                    temporary: t.temporary.unwrap_or(false),
                    partition_keys: String::new(),
                    cluster_keys: String::new(),
                    file_format: String::new(),
                    location: String::new(),
                    properties_json: "{}".to_string(),
                    owner: String::new(),
                    comment: String::new(),
                    row_count: -1,
                    size_bytes: -1,
                    created_at: now(),
                    updated_at: now(),
                    status: 1,
                });

                for (i, col) in t.columns.iter().enumerate() {
                    all_columns.push(store::ColumnMetadataRow {
                        id: 0,
                        project_id: project_id.to_string(),
                        table_id,
                        column_name: col.name.clone(),
                        ordinal: (i + 1) as i32,
                        data_type: col.data_type.clone().unwrap_or_default(),
                        is_nullable: !col.is_primary_key.unwrap_or(false),
                        is_primary_key: col.is_primary_key.unwrap_or(false),
                        is_partition: false,
                        default_value: None,
                        comment: String::new(),
                        created_at: now(),
                        updated_at: now(),
                        status: 1,
                    });
                }
            }
        }
    }

    eprintln!(
        "[api] extract_and_save_ddl_metadata: extracted {} tables, {} columns from {} files",
        all_tables.len(),
        all_columns.len(),
        files.len()
    );

    if !all_tables.is_empty() {
        store::save_table_metadata(db, project_id, &all_tables, &all_columns)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    }

    Ok(())
}

// ── analysis_cache ─────────────────────────────────────────────────────

#[derive(Deserialize, ToSchema)]
pub(crate) struct CacheQuery {
    key: String,
}

/// GET /api/db/cache - Get cache entry
#[utoipa::path(
    get,
    path = "/api/db/cache",
    tag = "Cache",
    params(
        ("key" = String, Query, description = "Cache key")
    ),
    responses(
        (status = 200, description = "Cache entry", body = serde_json::Value),
        (status = 500, description = "Server error")
    )
)]
pub(crate) async fn get_cache_api(
    State(state): State<Arc<AppState>>,
    Query(q): Query<CacheQuery>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let db = state
        .db
        .lock()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    match store::get_cache(&db, &q.key)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    {
        Some(json) => Ok((StatusCode::OK, Json(serde_json::json!({ "cached": true, "result": serde_json::from_str::<serde_json::Value>(&json).unwrap_or_default() }))).into_response()),
        None => Ok((StatusCode::OK, Json(serde_json::json!({ "cached": false }))).into_response()),
    }
}

#[derive(Deserialize, ToSchema)]
pub(crate) struct SetCacheRequest {
    key: String,
    result: serde_json::Value,
}

/// POST /api/db/cache - Set cache entry
#[utoipa::path(
    post,
    path = "/api/db/cache",
    tag = "Cache",
    request_body = SetCacheRequest,
    responses(
        (status = 200, description = "OK"),
        (status = 500, description = "Server error")
    )
)]
pub(crate) async fn set_cache_api(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<SetCacheRequest>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let db = state
        .db
        .lock()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let json = serde_json::to_string(&payload.result)
        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
    store::set_cache(&db, &payload.key, &json)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(StatusCode::OK)
}

/// DELETE /api/db/cache - Delete cache entry
#[utoipa::path(
    delete,
    path = "/api/db/cache",
    tag = "Cache",
    params(
        ("key" = String, Query, description = "Cache key")
    ),
    responses(
        (status = 200, description = "OK"),
        (status = 500, description = "Server error")
    )
)]
pub(crate) async fn delete_cache_api(
    State(state): State<Arc<AppState>>,
    Query(params): Query<CacheQuery>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let db = state
        .db
        .lock()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    store::delete_cache(&db, &params.key)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(StatusCode::OK)
}

/// POST /api/db/cache/clear - Clear all cache
#[utoipa::path(
    post,
    path = "/api/db/cache/clear",
    tag = "Cache",
    responses(
        (status = 200, description = "OK"),
        (status = 500, description = "Server error")
    )
)]
pub(crate) async fn clear_cache_api(
    State(state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let db = state
        .db
        .lock()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    store::clear_all_cache(&db).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(StatusCode::OK)
}

// ── project_file_results ───────────────────────────────────────────────

#[derive(Deserialize, ToSchema)]
pub(crate) struct FileResultItem {
    #[serde(alias = "filePath")]
    file_path: String,
    #[serde(alias = "contentHash")]
    content_hash: String,
}

#[derive(Deserialize, ToSchema)]
pub(crate) struct SetFileResultsRequest {
    #[serde(alias = "projectId")]
    project_id: String,
    rows: Vec<FileResultItem>,
}

/// POST /api/db/file-results - Set file result
#[utoipa::path(
    post,
    path = "/api/db/file-results",
    tag = "Schema",
    request_body = SetFileResultsRequest,
    responses(
        (status = 200, description = "OK"),
        (status = 500, description = "Server error")
    )
)]
pub(crate) async fn set_file_result_api(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<SetFileResultsRequest>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let db = state
        .db
        .lock()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    for r in &payload.rows {
        store::set_file_result(&db, &payload.project_id, &r.file_path, "", &r.content_hash)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    }
    Ok(StatusCode::OK)
}

#[derive(Deserialize, ToSchema)]
pub(crate) struct FileResultQuery {
    #[serde(alias = "projectId")]
    project_id: String,
    #[serde(default, alias = "filePath")]
    file_path: Option<String>,
}

/// GET /api/db/file-result - Get single file result
#[utoipa::path(
    get,
    path = "/api/db/file-result",
    tag = "Schema",
    params(
        ("projectId" = String, Query, description = "Project ID"),
        ("filePath" = String, Query, description = "File path")
    ),
    responses(
        (status = 200, description = "File result", body = serde_json::Value),
        (status = 500, description = "Server error")
    )
)]
pub(crate) async fn get_file_result_api(
    State(state): State<Arc<AppState>>,
    Query(q): Query<FileResultQuery>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let file_path = q
        .file_path
        .as_deref()
        .ok_or_else(|| (StatusCode::BAD_REQUEST, "filePath is required".to_string()))?;
    let db = state
        .db
        .lock()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    match store::get_file_result(&db, &q.project_id, file_path)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    {
        Some((json, hash)) => Ok(Json(serde_json::json!({
            "found": true,
            "resultJson": json,
            "contentHash": hash,
        }))
        .into_response()),
        None => Ok(Json(serde_json::json!({ "found": false })).into_response()),
    }
}

/// GET /api/db/file-results - Get file results
#[utoipa::path(
    get,
    path = "/api/db/file-results",
    tag = "Schema",
    params(
        ("projectId" = String, Query, description = "Project ID")
    ),
    responses(
        (status = 200, description = "File results", body = serde_json::Value),
        (status = 500, description = "Server error")
    )
)]
pub(crate) async fn get_file_results_api(
    State(state): State<Arc<AppState>>,
    Query(q): Query<ProjectFilesQuery>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let db = state
        .db
        .lock()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let results = store::get_file_results(&db, &q.project_id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let list: Vec<serde_json::Value> = results.into_iter().map(|(fp, json, hash, fn_, dp)| {
        serde_json::json!({ "filePath": fp, "resultJson": json, "contentHash": hash, "fileName": fn_, "dirPath": dp })
    }).collect();
    Ok(Json(serde_json::json!({ "files": list })).into_response())
}

/// GET /api/db/file-results/light - 轻量查询 file_path + file_name，不含大字段
pub(crate) async fn get_file_results_light_api(
    State(state): State<Arc<AppState>>,
    Query(q): Query<ProjectFilesQuery>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let db = state
        .db
        .lock()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let results = store::get_file_results_light(&db, &q.project_id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let list: Vec<serde_json::Value> = results
        .into_iter()
        .map(|(fp, fn_)| serde_json::json!({ "filePath": fp, "fileName": fn_ }))
        .collect();
    Ok(Json(serde_json::json!({ "files": list })).into_response())
}

#[derive(Deserialize, ToSchema)]
pub(crate) struct DeleteFileResultsRequest {
    #[serde(alias = "projectId")]
    project_id: String,
    #[serde(default)]
    file_paths: Vec<String>,
}

/// DELETE /api/db/file-results - Delete file results
#[utoipa::path(
    delete,
    path = "/api/db/file-results",
    tag = "Schema",
    request_body = DeleteFileResultsRequest,
    responses(
        (status = 200, description = "OK"),
        (status = 500, description = "Server error")
    )
)]
pub(crate) async fn delete_file_results_api(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<DeleteFileResultsRequest>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let db = state
        .db
        .lock()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    for fp in &payload.file_paths {
        store::delete_file_result(&db, &payload.project_id, fp)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    }
    Ok(StatusCode::OK)
}

// ── lineage_anomalies ──────────────────────────────────────────────────────

#[derive(Deserialize, ToSchema)]
pub(crate) struct SaveAnomalyRequest {
    #[serde(alias = "projectId")]
    project_id: String,
    #[serde(alias = "filePath")]
    file_path: String,
    #[serde(alias = "scriptName")]
    script_name: String,
    #[serde(alias = "scriptContent")]
    script_content: String,
    severity: String,
    #[serde(alias = "anomalyType")]
    anomaly_type: String,
    message: String,
    detail: String,
    #[serde(alias = "isTest")]
    is_test: i64,
}

/// POST /api/db/anomalies - Save anomaly
#[utoipa::path(
    post,
    path = "/api/db/anomalies",
    tag = "Schema",
    request_body = SaveAnomalyRequest,
    responses(
        (status = 200, description = "OK"),
        (status = 500, description = "Server error")
    )
)]
pub(crate) async fn save_anomaly_api(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<SaveAnomalyRequest>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let db = state
        .db
        .lock()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let row = store::LineageAnomalyRow {
        id: 0,
        project_id: payload.project_id,
        file_path: payload.file_path,
        script_name: payload.script_name,
        script_content: payload.script_content,
        severity: payload.severity,
        anomaly_type: payload.anomaly_type,
        message: payload.message,
        detail: payload.detail,
        is_test: payload.is_test,
        created_at: String::new(),
        updated_at: String::new(),
        status: 1,
    };
    store::insert_anomaly(&db, &row)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(StatusCode::OK)
}

/// GET /api/db/anomalies - Get anomalies
#[utoipa::path(
    get,
    path = "/api/db/anomalies",
    tag = "Schema",
    responses(
        (status = 200, description = "OK"),
        (status = 500, description = "Server error")
    )
)]
pub(crate) async fn get_anomalies_api(
    State(state): State<Arc<AppState>>,
    Query(q): Query<ProjectFilesQuery>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let db = state
        .db
        .lock()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let rows = store::get_anomalies(&db, &q.project_id, 100, 0)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(serde_json::json!({ "anomalies": rows })).into_response())
}

// ── lineage ────────────────────────────────────────────────────────────

#[derive(Deserialize, ToSchema)]
pub(crate) struct SaveLineageRequest {
    #[serde(alias = "projectId")]
    project_id: String,
    nodes: Vec<store::LineageNodeRow>,
    columns: Vec<store::LineageColumnRow>,
    edges: Vec<store::LineageEdgeRow>,
}

/// POST /api/db/lineage - Save lineage data
#[utoipa::path(
    post,
    path = "/api/db/lineage",
    tag = "Lineage",
    request_body = SaveLineageRequest,
    responses(
        (status = 200, description = "OK"),
        (status = 500, description = "Server error")
    )
)]
pub(crate) async fn save_lineage_api(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<SaveLineageRequest>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let db = state
        .db
        .lock()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    store::save_lineage_batch(
        &db,
        &payload.project_id,
        &payload.nodes,
        &payload.columns,
        &payload.edges,
    )
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(StatusCode::OK)
}

// ── table_metadata / column_metadata ───────────────────────────────────

#[derive(Deserialize, ToSchema)]
pub(crate) struct SaveTableMetadataRequest {
    #[serde(alias = "projectId")]
    project_id: String,
    tables: Vec<store::TableMetadataRow>,
    columns: Vec<store::ColumnMetadataRow>,
}

/// POST /api/db/table-metadata - Save table metadata
#[utoipa::path(
    post,
    path = "/api/db/table-metadata",
    tag = "Metadata",
    request_body = SaveTableMetadataRequest,
    responses(
        (status = 200, description = "OK"),
        (status = 500, description = "Server error")
    )
)]
pub(crate) async fn save_table_metadata_api(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<SaveTableMetadataRequest>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let db = state
        .db
        .lock()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    store::save_table_metadata(&db, &payload.project_id, &payload.tables, &payload.columns)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(StatusCode::OK)
}

/// GET /api/db/table-metadata - Get table metadata
#[utoipa::path(
    get,
    path = "/api/db/table-metadata",
    tag = "Metadata",
    params(
        ("projectId" = String, Query, description = "Project ID")
    ),
    responses(
        (status = 200, description = "Table metadata", body = Vec<serde_json::Value>),
        (status = 500, description = "Server error")
    )
)]
pub(crate) async fn get_table_metadata_api(
    State(state): State<Arc<AppState>>,
    Query(q): Query<LineageQuery>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let db = state
        .db
        .lock()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let tables = store::load_table_metadata(&db, &q.project_id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(tables))
}

/// GET /api/db/column-metadata - Get column metadata
#[utoipa::path(
    get,
    path = "/api/db/column-metadata",
    tag = "Metadata",
    params(
        ("tableId" = String, Query, description = "Table ID")
    ),
    responses(
        (status = 200, description = "Column metadata", body = Vec<serde_json::Value>),
        (status = 500, description = "Server error")
    )
)]
pub(crate) async fn get_column_metadata_api(
    State(state): State<Arc<AppState>>,
    Query(q): Query<LineageQuery>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let db = state
        .db
        .lock()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let columns = store::load_column_metadata(&db, &q.project_id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(columns))
}

/// GET /api/db/lineage/nodes - Get lineage nodes
#[utoipa::path(
    get,
    path = "/api/db/lineage/nodes",
    tag = "Lineage",
    params(
        ("projectId" = String, Query, description = "Project ID")
    ),
    responses(
        (status = 200, description = "Lineage nodes", body = Vec<serde_json::Value>),
        (status = 500, description = "Server error")
    )
)]
pub(crate) async fn get_lineage_nodes_api(
    State(state): State<Arc<AppState>>,
    Query(q): Query<LineageQuery>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let db = state
        .db
        .lock()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let nodes = store::load_lineage_nodes(&db, &q.project_id, q.file_path.as_deref())
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(nodes))
}

/// GET /api/db/lineage/columns - Get lineage columns
#[utoipa::path(
    get,
    path = "/api/db/lineage/columns",
    tag = "Lineage",
    params(
        ("projectId" = String, Query, description = "Project ID")
    ),
    responses(
        (status = 200, description = "Lineage columns", body = Vec<serde_json::Value>),
        (status = 500, description = "Server error")
    )
)]
pub(crate) async fn get_lineage_columns_api(
    State(state): State<Arc<AppState>>,
    Query(q): Query<LineageQuery>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let db = state
        .db
        .lock()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let columns = store::load_lineage_columns(&db, &q.project_id, q.file_path.as_deref())
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(columns))
}

/// GET /api/db/lineage/edges - Get lineage edges
#[utoipa::path(
    get,
    path = "/api/db/lineage/edges",
    tag = "Lineage",
    params(
        ("projectId" = String, Query, description = "Project ID")
    ),
    responses(
        (status = 200, description = "Lineage edges", body = Vec<serde_json::Value>),
        (status = 500, description = "Server error")
    )
)]
pub(crate) async fn get_lineage_edges_api(
    State(state): State<Arc<AppState>>,
    Query(q): Query<LineageQuery>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let db = state
        .db
        .lock()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let edges = store::load_lineage_edges(
        &db,
        &q.project_id,
        q.file_path.as_deref(),
        q.edge_type.as_deref(),
    )
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(edges))
}

// ── Convert procedures endpoint ─────────────────────────────────────────

#[derive(Deserialize, ToSchema)]
pub(crate) struct ConvertProceduresRequest {
    #[serde(alias = "projectId")]
    project_id: String,
    #[serde(alias = "folderPath")]
    folder_path: Option<String>,
}

#[derive(Serialize, ToSchema)]
pub(crate) struct ConvertProceduresResponse {
    success: usize,
    empty: usize,
    errors: usize,
    total: usize,
    #[serde(rename = "successPaths")]
    success_paths: Vec<String>,
    #[serde(rename = "emptyPaths")]
    empty_paths: Vec<String>,
    #[serde(rename = "errorPaths")]
    error_paths: Vec<String>,
}

#[utoipa::path(
    post,
    path = "/api/convert-procedures",
    request_body = ConvertProceduresRequest,
    responses(
        (status = 200, description = "Conversion completed", body = ConvertProceduresResponse),
        (status = 500, description = "Server error")
    )
)]
pub(crate) async fn convert_procedures(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ConvertProceduresRequest>,
) -> Result<Json<ConvertProceduresResponse>, (StatusCode, String)> {
    let prefix = req.folder_path.as_deref().map(|p| {
        if p.ends_with('/') { p.to_string() } else { format!("{}/", p) }
    });

    let db = state
        .db
        .lock()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let all_files = store::load_project_files(&db, &req.project_id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    drop(db);

    let start = std::time::Instant::now();
    eprintln!(
        "[api] convert_procedures: project={}, folder={:?}, total_files={}",
        req.project_id, req.folder_path, all_files.len()
    );

    let proc_files: Vec<&store::ProjectFileRow> = all_files
        .iter()
        .filter(|f| {
            if let Some(ref pfx) = prefix {
                if !f.path.starts_with(pfx.as_str()) {
                    return false;
                }
            }
            f.is_procedure != 0
                || f.content.to_uppercase().contains("CREATE PROCEDURE")
                || f.content.to_uppercase().contains("CREATE PROC ")
        })
        .collect();

    let total = proc_files.len();
    let mut success_count = 0usize;
    let mut success_paths = Vec::new();
    let mut empty_paths = Vec::new();
    let mut error_paths = Vec::new();
    let mut updates: Vec<(String, String)> = Vec::with_capacity(total);

    for (idx, f) in proc_files.iter().enumerate() {
        if idx > 0 && idx % 500 == 0 {
            eprintln!("[api] convert_procedures: progress {idx}/{total}");
        }
        match capybara_core::parser::sanitize_bigquery_raw_double_quoted_literals(&f.content) {
            Some(transformed) => {
                success_count += 1;
                success_paths.push(f.path.clone());
                updates.push((f.path.clone(), transformed));
            }
            None => {
                empty_paths.push(f.path.clone());
                updates.push((f.path.clone(), String::new()));
            }
        }
    }

    // Persist to DB in chunks
    if !updates.is_empty() {
        let db = state
            .db
            .lock()
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        const CHUNK: usize = 500;
        for chunk in updates.chunks(CHUNK) {
            store::batch_update_transformed(&db, &req.project_id, chunk)
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        }
    }

    let elapsed = start.elapsed();
    eprintln!(
        "[api] convert_procedures: done in {elapsed:.2?}, success={}, empty={}",
        success_count, empty_paths.len()
    );

    Ok(Json(ConvertProceduresResponse {
        success: success_count,
        empty: empty_paths.len(),
        errors: error_paths.len(),
        total,
        success_paths,
        empty_paths,
        error_paths,
    }))
}

// ── batch analysis endpoint ────────────────────────────────────────────

#[derive(Deserialize)]
struct AnalyzeBatchRequest {
    #[serde(alias = "projectId")]
    project_id: String,
    #[serde(alias = "folderPath")]
    folder_path: Option<String>,
    paths: Option<Vec<String>>,
    dialect: Option<String>,
    #[serde(alias = "templateMode")]
    template_mode: Option<String>,
}

#[derive(Serialize)]
struct AnalyzeBatchResponse {
    total: usize,
    success: usize,
    errors: usize,
    empty: usize,
    error_details: Vec<String>,
}

pub(crate) async fn analyze_batch(
    State(state): State<Arc<AppState>>,
    Json(req): Json<AnalyzeBatchRequest>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let prefix = req.folder_path.as_deref().map(|p| {
        if p.ends_with('/') { p.to_string() } else { format!("{}/", p) }
    });

    let db = state
        .db
        .lock()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let all_files = store::load_project_files(&db, &req.project_id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    drop(db);

    let dialect = req
        .dialect
        .as_deref()
        .and_then(|d| match d.to_lowercase().as_str() {
            "bigquery" => Some(capybara_core::Dialect::Bigquery),
            "generic" => Some(capybara_core::Dialect::Generic),
            "hive" => Some(capybara_core::Dialect::Hive),
            _ => None,
        })
        .unwrap_or(capybara_core::Dialect::Generic);

    #[allow(unused_variables)]
    let template_config = resolve_template_config(req.template_mode.as_deref(), state.as_ref());

    let path_set: Option<std::collections::HashSet<String>> = req.paths.as_ref().map(|p| p.iter().cloned().collect());

    let sql_files: Vec<store::ProjectFileRow> = all_files
        .into_iter()
        .filter(|f| {
            if let Some(ref set) = path_set {
                if !set.contains(&f.path) { return false; }
            } else if let Some(ref pfx) = prefix {
                if !f.path.starts_with(pfx.as_str()) { return false; }
            }
            let lower = f.name.to_lowercase();
            lower.ends_with(".sql") || lower.ends_with(".hql")
        })
        .collect();

    let total = sql_files.len();
    eprintln!("[api] analyze_batch: project={}, files={total}", req.project_id);
    let start = std::time::Instant::now();
    let progress = std::sync::atomic::AtomicUsize::new(0);

    // Phase 1: parallel per-file analysis via rayon
    use rayon::prelude::*;
    let empty = sql_files.iter().filter(|f| f.content.trim().is_empty()).count();
    let non_empty: Vec<_> = sql_files.iter().filter(|f| !f.content.trim().is_empty()).collect();

    struct FileResult {
        path: String,
        name: String,
        sql: String,
        nodes: Vec<store::LineageNodeRow>,
        columns: Vec<store::LineageColumnRow>,
        edges: Vec<store::LineageEdgeRow>,
        ok: bool,
    }

    let results: Vec<FileResult> = non_empty
        .par_chunks(100)
        .flat_map_iter(|chunk| {
            chunk.iter().map(|f| {
            let sql = if f.is_procedure != 0 {
                f.transformed_content.clone()
            } else {
                f.content.clone()
            };

            let request = capybara_core::AnalyzeRequest {
                sql: sql.clone(),
                files: Some(vec![capybara_core::FileSource {
                    name: f.name.clone(),
                    content: f.content.clone(),
                    is_procedure: f.is_procedure != 0,
                    transformed_content: if sql != f.content { Some(sql.clone()) } else { None },
                }]),
                dialect,
                source_name: Some(f.path.clone()),
                options: None,
                schema: None,
                #[cfg(feature = "templating")]
                template_config: None,
            };

            let result = capybara_core::analyzer::analyze(&request);

            if result.statements.is_empty() {
                FileResult {
                    path: f.path.clone(),
                    name: f.name.clone(),
                    sql,
                    nodes: vec![],
                    columns: vec![],
                    edges: vec![],
                    ok: false,
                }
            } else {
                let (nodes, columns, edges) = convert_to_lineage_rows(&result, &f.path);
                FileResult { path: f.path.clone(), name: f.name.clone(), sql, nodes, columns, edges, ok: true }
            }
        })
    })
    .collect();
    eprintln!("[api] analyze_batch: phase1 (parallel analysis) done in {:?}", start.elapsed());

    // Phase 2: aggregate and save to DB
    let mut all_nodes = Vec::new();
    let mut all_columns = Vec::new();
    let mut all_edges = Vec::new();
    let mut success = 0;
    let mut errors = 0;
    let mut error_details = Vec::new();

    for r in &results {
        if r.ok {
            all_nodes.extend(r.nodes.clone());
            all_columns.extend(r.columns.clone());
            all_edges.extend(r.edges.clone());
            success += 1;
        } else {
            errors += 1;
            error_details.push(format!("{}: no statements parsed", r.path));
        }
    }

    let db = state.db.lock().ok();
    if let Some(db) = db {
        if !all_nodes.is_empty() {
            let _ = store::save_lineage_batch(&db, &req.project_id, &all_nodes, &all_columns, &all_edges);
        }
        // Bulk save anomalies
        let anomaly_rows: Vec<store::LineageAnomalyRow> = results.iter()
            .filter(|r| !r.ok)
            .map(|r| store::LineageAnomalyRow {
                id: 0, project_id: req.project_id.clone(), file_path: r.path.clone(),
                script_name: r.name.clone(), script_content: r.sql.clone(),
                severity: "error".to_string(), anomaly_type: "analysis_error".to_string(),
                message: "no statements parsed".to_string(), detail: String::new(),
                is_test: 0, created_at: String::new(), updated_at: String::new(), status: 1,
            })
            .collect();
        let _ = store::insert_anomalies_bulk(&db, &anomaly_rows);
    }

    eprintln!("[api] analyze_batch: done in {:?} — success={success}, errors={errors}, empty={empty}", start.elapsed());

    Ok(Json(AnalyzeBatchResponse {
        total,
        success,
        errors,
        empty,
        error_details,
    }))
}

/// Convert analysis result statements to DB row types for lineage storage.
fn convert_to_lineage_rows(
    result: &capybara_core::AnalyzeResult,
    file_path: &str,
) -> (Vec<store::LineageNodeRow>, Vec<store::LineageColumnRow>, Vec<store::LineageEdgeRow>) {
    use std::collections::{HashMap, HashSet};

    let file_name = file_path.split('/').last().unwrap_or(file_path).to_string();
    let dir_path = file_path
        .rfind('/')
        .map(|i| file_path[..i].to_string())
        .unwrap_or_default();

    let fn_ref = &file_name;
    let dp_ref = &dir_path;
    let fp = file_path;

    let mut nodes = Vec::new();
    let mut columns = Vec::new();
    let mut edges = Vec::new();

    for stmt in &result.statements {
        let si = stmt.statement_index;

        let mut ownership: HashMap<&str, &str> = HashMap::new();
        for edge in &stmt.edges {
            if edge.edge_type == capybara_core::EdgeType::Ownership {
                ownership.insert(edge.to.as_ref(), edge.from.as_ref());
            }
        }

        let all_ids: HashSet<&str> = stmt.nodes.iter().map(|n| n.id.as_ref()).collect();
        let mut persisted_ids = HashSet::new();

        for node in &stmt.nodes {
            if node.node_type == capybara_core::NodeType::Column {
                if let Some(parent) = ownership.get(node.id.as_ref()) {
                    if all_ids.contains(parent) {
                        columns.push(store::LineageColumnRow {
                            column_id: node.id.to_string(),
                            label: node.label.to_string(),
                            qualified_name: Some(node.qualified_name.as_ref().map(|s| s.to_string()).unwrap_or_default()),
                            parent_node_id: Some(parent.to_string()),
                            expression: node.expression.as_ref().map(|s| s.to_string()),
                            statement_index: si as i64,
                            file_path: fp.to_string(),
                            file_name: fn_ref.clone(),
                            dir_path: dp_ref.clone(),
                        });
                        persisted_ids.insert(node.id.as_ref());
                    }
                }
            } else {
                nodes.push(store::LineageNodeRow {
                    node_id: node.id.to_string(),
                    node_type: format!("{:?}", node.node_type).to_lowercase(),
                    label: node.label.to_string(),
                    qualified_name: node.qualified_name.as_ref().map(|s| s.to_string()),
                    statement_index: si as i64,
                    resolution_source: node.resolution_source.as_ref().map(|rs| format!("{:?}", rs).to_lowercase()),
                    file_path: fp.to_string(),
                    file_name: fn_ref.clone(),
                    dir_path: dp_ref.clone(),
                });
                persisted_ids.insert(node.id.as_ref());
            }
        }

        for edge in &stmt.edges {
            if persisted_ids.contains(edge.from.as_ref())
                && persisted_ids.contains(edge.to.as_ref())
            {
                edges.push(store::LineageEdgeRow {
                    edge_id: edge.id.to_string(),
                    from_id: edge.from.to_string(),
                    to_id: edge.to.to_string(),
                    edge_type: edge.edge_type.as_str().to_string(),
                    expression: edge.expression.as_ref().map(|s| s.to_string()),
                    statement_index: Some(si as i64),
                    file_path: fp.to_string(),
                    file_name: fn_ref.clone(),
                    dir_path: dp_ref.clone(),
                });
            }
        }
    }

    (nodes, columns, edges)
}

// ============================================================
// Governance API handlers
// ============================================================

#[derive(Serialize, ToSchema)]
struct GovContractInfo {
    name: String,
    file_path: String,
    status: String,
    violation_count: i64,
}

/// GET /api/governance/contracts — list all contracts.
async fn gov_list_contracts(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let dir = &state.contracts_dir;
    let files = super::governance::contract::scan_contract_files(dir);
    let mut result = Vec::new();
    for path in files {
        let name = path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let content = std::fs::read_to_string(&path).unwrap_or_default();
        let contract = super::governance::contract::parse_contract(&content).ok();
        let status = contract
            .as_ref()
            .map(|c| c.status.clone())
            .unwrap_or_else(|| "error".to_string());
        result.push(GovContractInfo {
            name,
            file_path: path.to_string_lossy().to_string(),
            status,
            violation_count: 0,
        });
    }
    // Batch upsert contracts in a single lock acquisition (not per-file).
    if !result.is_empty() {
        if let Ok(conn) = state.gov_db.lock() {
            for c in &result {
                let _ = super::governance::db::upsert_contract(
                    &conn, "default", &c.name, &c.file_path, "",
                );
            }
        }
    }
    Json(result)
}

#[derive(Deserialize, ToSchema)]
struct GovCreateContractRequest {
    name: String,
    content: String,
}

/// POST /api/governance/contracts — create a new contract.
async fn gov_create_contract(
    State(state): State<Arc<AppState>>,
    Json(req): Json<GovCreateContractRequest>,
) -> impl IntoResponse {
    let safe_name = sanitize_contract_name(&req.name);
    let path = state.contracts_dir.join(format!("{safe_name}.odcs.yaml"));
    if path.exists() {
        return (
            StatusCode::CONFLICT,
            "Contract already exists".to_string(),
        )
            .into_response();
    }
    if let Err(e) = std::fs::write(&path, &req.content) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to write contract: {e}"),
        )
            .into_response();
    }
    let hash = super::governance::contract::compute_file_hash(&req.content);
    if let Ok(conn) = state.gov_db.lock() {
        let _ = super::governance::db::upsert_contract(
            &conn, "default", &safe_name,
            &path.to_string_lossy().to_string(), &hash,
        );
    }
    Json(serde_json::json!({"status": "created", "name": safe_name})).into_response()
}

/// GET /api/governance/contracts/{name} — get contract content.
async fn gov_get_contract(
    State(state): State<Arc<AppState>>,
    Path(name): Path<String>,
) -> impl IntoResponse {
    let path = find_contract_path(&state.contracts_dir, &name);
    match path {
        Some(p) => match std::fs::read_to_string(&p) {
            Ok(content) => {
                let contract = super::governance::contract::parse_contract(&content).ok();
                Json(serde_json::json!({
                    "name": name,
                    "content": content,
                    "version": contract.as_ref().map(|c| c.version.clone()).unwrap_or_default(),
                    "status": contract.as_ref().map(|c| c.status.clone()).unwrap_or_default(),
                }))
                .into_response()
            }
            Err(e) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to read contract: {e}"),
            )
                .into_response(),
        },
        None => (StatusCode::NOT_FOUND, "Contract not found".to_string()).into_response(),
    }
}

/// PUT /api/governance/contracts/{name} — update contract.
async fn gov_update_contract(
    State(state): State<Arc<AppState>>,
    Path(name): Path<String>,
    body: String,
) -> impl IntoResponse {
    let path = find_contract_path(&state.contracts_dir, &name);
    let path = match path {
        Some(p) => p,
        None => {
            // Create new file if not found
            let safe_name = sanitize_contract_name(&name);
            state.contracts_dir.join(format!("{safe_name}.odcs.yaml"))
        }
    };
    // Parse body as JSON to extract content, or treat body as raw YAML
    let content = if let Ok(req) = serde_json::from_str::<GovCreateContractRequest>(&body) {
        req.content
    } else {
        // Treat as raw YAML
        body
    };
    if let Err(e) = std::fs::write(&path, &content) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to write contract: {e}"),
        )
            .into_response();
    }
    let hash = super::governance::contract::compute_file_hash(&content);
    if let Ok(conn) = state.gov_db.lock() {
        let _ = super::governance::db::upsert_contract(
            &conn,
            "default",
            &name,
            &path.to_string_lossy().to_string(),
            &hash,
        );
    }
    Json(serde_json::json!({"status": "updated", "contract_hash": hash})).into_response()
}

/// DELETE /api/governance/contracts/{name} — delete contract.
async fn gov_delete_contract(
    State(state): State<Arc<AppState>>,
    Path(name): Path<String>,
) -> impl IntoResponse {
    let path = find_contract_path(&state.contracts_dir, &name);
    match path {
        Some(p) => {
            if let Err(e) = std::fs::remove_file(&p) {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("Failed to delete: {e}"),
                )
                    .into_response();
            }
            Json(serde_json::json!({"status": "deleted"})).into_response()
        }
        None => (StatusCode::NOT_FOUND, "Contract not found".to_string()).into_response(),
    }
}

/// POST /api/governance/contracts/{name}/validate — validate YAML format.
async fn gov_validate_contract(
    State(state): State<Arc<AppState>>,
    Path(name): Path<String>,
) -> impl IntoResponse {
    let path = find_contract_path(&state.contracts_dir, &name);
    match path {
        Some(p) => match std::fs::read_to_string(&p) {
            Ok(content) => {
                match super::governance::contract::validate_contract(&content) {
                    Ok(()) => Json(serde_json::json!({"valid": true})).into_response(),
                    Err(errors) => Json(serde_json::json!({"valid": false, "errors": errors}))
                        .into_response(),
                }
            }
            Err(e) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to read: {e}"),
            )
                .into_response(),
        },
        None => (StatusCode::NOT_FOUND, "Contract not found".to_string()).into_response(),
    }
}

/// POST /api/governance/scan — run governance evaluation.
async fn gov_scan(
    State(state): State<Arc<AppState>>,
    Json(req): Json<super::governance::ScanRequest>,
) -> impl IntoResponse {
    let project_id = &req.project_id;

    // 1. Load all active contracts
    let contract_files =
        super::governance::contract::scan_contract_files(&state.contracts_dir);
    let mut contracts = Vec::new();
    for path in &contract_files {
        if let Ok(content) = std::fs::read_to_string(path) {
            if let Ok(contract) = super::governance::contract::parse_contract(&content) {
                if contract.status == "active" {
                    contracts.push(contract);
                }
            }
        }
    }

    // Always include default contract even if parsing fails for others
    if contracts.is_empty() {
        if let Ok(default) =
            super::governance::contract::parse_contract(
                super::governance::contract::DEFAULT_CONTRACT_YAML,
            )
        {
            contracts.push(default);
        }
    }

    // 2. Load file results from main DB
    let (file_results_raw, file_contents, table_edges) = {
        let conn = match state.db.lock() {
            Ok(c) => c,
            Err(e) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("DB lock error: {e}"),
                )
                    .into_response();
            }
        };
        load_governance_inputs(&conn, project_id)
    };

    // 3. Parse AnalyzeResult JSONs
    let file_results: Vec<(String, capybara_core::AnalyzeResult)> = file_results_raw
        .into_iter()
        .filter_map(|(path, json)| {
            serde_json::from_str::<capybara_core::AnalyzeResult>(&json)
                .ok()
                .map(|r| (path, r))
        })
        .collect();

    // 4. Generate models from lineage data (the contract)
    let gen_input = super::governance::contract_generator::GenerationInput {
        project_id: project_id.clone(),
        table_edges: table_edges.clone(),
    };
    let models = super::governance::contract_generator::generate_models(&gen_input);

    // 5. Generate governance contract and save it
    let generated_contract =
        super::governance::contract_generator::generate_governance_contract(project_id, &models);
    let _ = super::governance::contract_generator::save_contract(
        &state.contracts_dir, project_id, &generated_contract,
    );
    // Add generated contract to evaluation list
    if !contracts.iter().any(|c: &super::governance::contract::Contract| c.id == generated_contract.id) {
        contracts.push(generated_contract);
    }

    // 6. Build context and evaluate
    let ctx = super::governance::evaluator::GovernanceContext {
        project_id,
        file_results: &file_results,
        file_contents: &file_contents,
        table_edges: &table_edges,
        models: &models,
    };

    let (violations, pending) = super::governance::evaluator::evaluate_all_contracts(&contracts, &ctx);

    // 5. Build report
    let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
    let total_files = file_results.len();
    let report = super::governance::health::build_report(
        project_id,
        violations,
        pending,
        total_files,
        &now,
    );

    let health_score = report.health_score;
    let violation_count = report.summary.total_violations;

    // 6. Save to governance DB
    let report_id = {
        let conn = match state.gov_db.lock() {
            Ok(c) => c,
            Err(e) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("Gov DB lock error: {e}"),
                )
                    .into_response();
            }
        };
        match super::governance::db::save_report(&conn, project_id, &report) {
            Ok(id) => id,
            Err(e) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("Failed to save report: {e}"),
                )
                    .into_response();
            }
        }
    };

    Json(super::governance::ScanResponse {
        report_id,
        health_score,
        violation_count,
    })
    .into_response()
}

/// GET /api/governance/report — get latest reports.
#[derive(Deserialize)]
struct GovReportQuery {
    project_id: String,
    #[serde(default = "default_report_limit")]
    limit: usize,
}

fn default_report_limit() -> usize {
    5
}

async fn gov_get_report(
    State(state): State<Arc<AppState>>,
    Query(q): Query<GovReportQuery>,
) -> impl IntoResponse {
    let conn = match state.gov_db.lock() {
        Ok(c) => c,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("DB lock error: {e}"),
            )
                .into_response();
        }
    };
    match super::governance::db::get_report_summary(&conn, &q.project_id, q.limit) {
        Ok(reports) => Json(reports).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to get reports: {e}"),
        )
            .into_response(),
    }
}

/// GET /api/governance/health — get health score with trend.
async fn gov_get_health(
    State(state): State<Arc<AppState>>,
    Query(q): Query<GovReportQuery>,
) -> impl IntoResponse {
    let conn = match state.gov_db.lock() {
        Ok(c) => c,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("DB lock error: {e}"),
            )
                .into_response();
        }
    };
    let reports = super::governance::db::get_reports(&conn, &q.project_id, 1).unwrap_or_default();
    let trend = super::governance::db::get_health_trend(&conn, &q.project_id, 10).unwrap_or_default();

    if let Some(latest) = reports.first() {
        Json(serde_json::json!({
            "total_score": latest.health_score,
            "dimension_scores": latest.dimension_scores,
            "summary": latest.summary,
            "trend": trend,
        }))
        .into_response()
    } else {
        Json(serde_json::json!({
            "total_score": null,
            "dimension_scores": {},
            "trend": [],
        }))
        .into_response()
    }
}

/// POST /api/governance/export/{format} — export report.
#[derive(Deserialize)]
struct GovExportRequest {
    project_id: String,
}

async fn gov_export(
    State(state): State<Arc<AppState>>,
    Path(format): Path<String>,
    Json(req): Json<GovExportRequest>,
) -> impl IntoResponse {
    let conn = match state.gov_db.lock() {
        Ok(c) => c,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("DB lock error: {e}"),
            )
                .into_response();
        }
    };
    let reports = super::governance::db::get_reports(&conn, &req.project_id, 1).unwrap_or_default();
    let report = match reports.first() {
        Some(r) => r.clone(),
        None => {
            return (StatusCode::NOT_FOUND, "No report found".to_string()).into_response();
        }
    };

    match format.as_str() {
        "json" => {
            let json = super::governance::report::export_json(&report);
            (
                StatusCode::OK,
                [
                    ("content-type", "application/json"),
                    (
                        "content-disposition",
                        "attachment; filename=\"governance-report.json\"",
                    ),
                ],
                json,
            )
                .into_response()
        }
        "html" => {
            let html = super::governance::report::export_html(&report);
            (
                StatusCode::OK,
                [
                    ("content-type", "text/html; charset=utf-8"),
                    (
                        "content-disposition",
                        "attachment; filename=\"governance-report.html\"",
                    ),
                ],
                html,
            )
                .into_response()
        }
        _ => (StatusCode::BAD_REQUEST, "Unsupported format".to_string()).into_response(),
    }
}

// ============================================================
// Governance helpers
// ============================================================

fn sanitize_contract_name(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '_' || c == '-' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

fn find_contract_path(dir: &std::path::Path, name: &str) -> Option<std::path::PathBuf> {
    let safe_name = sanitize_contract_name(name);
    // Try multiple extensions
    for ext in &[".odcs.yaml", ".odcs.yml", ".yaml", ".yml"] {
        let path = dir.join(format!("{safe_name}{ext}"));
        if path.exists() {
            return Some(path);
        }
    }
    None
}

/// Load governance inputs from the main flowscope.db.
fn load_governance_inputs(
    conn: &rusqlite::Connection,
    project_id: &str,
) -> (
    Vec<(String, String)>,                  // (file_path, result_json)
    Vec<(String, String)>,                  // (file_path, content)
    Vec<(String, String, String)>,          // (from_table, to_table, script)
) {
    // Load file results
    let mut file_results = Vec::new();
    if let Ok(mut stmt) = conn.prepare(
        "SELECT file_path, result_json FROM project_file_results WHERE project_id = ?1 AND status = 1",
    ) {
        if let Ok(rows) = stmt.query_map(rusqlite::params![project_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
            ))
        }) {
            file_results = rows.filter_map(|r| r.ok()).collect();
        }
    }

    // Load file contents
    let mut file_contents = Vec::new();
    if let Ok(mut stmt) = conn.prepare(
        "SELECT path, content FROM project_files WHERE project_id = ?1 AND status = 1",
    ) {
        if let Ok(rows) = stmt.query_map(rusqlite::params![project_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
            ))
        }) {
            file_contents = rows.filter_map(|r| r.ok()).collect();
        }
    }

    // Load table-level edges
    let mut table_edges = Vec::new();
    if let Ok(mut stmt) = conn.prepare(
        "SELECT from_table, to_table, script FROM table_level_edges WHERE project_id = ?1 AND status = 1",
    ) {
        if let Ok(rows) = stmt.query_map(rusqlite::params![project_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        }) {
            table_edges = rows.filter_map(|r| r.ok()).collect();
        }
    }

    (file_results, file_contents, table_edges)
}

// ============================================================
// Model management handlers
// ============================================================

#[derive(Deserialize)]
struct GovModelQuery {
    project_id: String,
    #[serde(default)]
    layer: Option<String>,
    #[serde(default)]
    domain: Option<String>,
    #[serde(default)]
    owner: Option<String>,
    #[serde(default)]
    q: Option<String>,
}

/// GET /api/governance/models
async fn gov_list_models(
    State(state): State<Arc<AppState>>,
    Query(q): Query<GovModelQuery>,
) -> impl IntoResponse {
    let conn = match state.gov_db.lock() {
        Ok(c) => c,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("DB lock: {e}")).into_response(),
    };
    match super::governance::model::list_models(
        &conn, &q.project_id, q.layer.as_deref(), q.domain.as_deref(), q.owner.as_deref(), q.q.as_deref(),
    ) {
        Ok(models) => Json(models).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("Query failed: {e}")).into_response(),
    }
}

/// GET /api/governance/models/{name}
async fn gov_get_model(
    State(state): State<Arc<AppState>>,
    Path(name): Path<String>,
    Query(q): Query<GovReportQuery>,
) -> impl IntoResponse {
    let conn = match state.gov_db.lock() {
        Ok(c) => c,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("DB lock: {e}")).into_response(),
    };
    match super::governance::model::get_model(&conn, &q.project_id, &name) {
        Ok(Some(model)) => Json(model).into_response(),
        Ok(None) => (StatusCode::NOT_FOUND, "Model not found").into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("Query failed: {e}")).into_response(),
    }
}

/// PUT /api/governance/models/{name}
#[derive(Deserialize)]
struct GovUpdateModelRequest {
    project_id: String,
    #[serde(default)]
    layer: Option<String>,
    #[serde(default)]
    domain: Option<String>,
    #[serde(default)]
    owner: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    lifecycle: Option<String>,
}

async fn gov_update_model(
    State(state): State<Arc<AppState>>,
    Path(name): Path<String>,
    Json(req): Json<GovUpdateModelRequest>,
) -> impl IntoResponse {
    let conn = match state.gov_db.lock() {
        Ok(c) => c,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("DB lock: {e}")).into_response(),
    };
    match super::governance::model::update_model(
        &conn, &req.project_id, &name,
        req.layer.as_deref(), req.domain.as_deref(), req.owner.as_deref(),
        req.description.as_deref(), req.lifecycle.as_deref(),
    ) {
        Ok(()) => Json(serde_json::json!({"status": "updated"})).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("Update failed: {e}")).into_response(),
    }
}

/// POST /api/governance/models/auto — auto-discover from lineage + contracts
#[derive(Deserialize)]
struct GovAutoDiscoverRequest {
    project_id: String,
}

async fn gov_auto_discover_models(
    State(state): State<Arc<AppState>>,
    Json(req): Json<GovAutoDiscoverRequest>,
) -> impl IntoResponse {
    // Load table edges from main DB
    let table_edges = {
        let conn = match state.db.lock() {
            Ok(c) => c,
            Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("DB lock: {e}")).into_response(),
        };
        let mut edges = Vec::new();
        if let Ok(mut stmt) = conn.prepare(
            "SELECT from_table, to_table, script FROM table_level_edges WHERE project_id = ?1 AND status = 1",
        ) {
            if let Ok(rows) = stmt.query_map(rusqlite::params![req.project_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            }) {
                edges = rows.filter_map(|r| r.ok()).collect();
            }
        }
        edges
    };

    // Load contracts
    let contract_files = super::governance::contract::scan_contract_files(&state.contracts_dir);
    let mut contracts = Vec::new();
    for path in &contract_files {
        if let Ok(content) = std::fs::read_to_string(path) {
            if let Ok(contract) = super::governance::contract::parse_contract(&content) {
                if contract.status == "active" {
                    contracts.push(contract);
                }
            }
        }
    }

    let conn = match state.gov_db.lock() {
        Ok(c) => c,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("Gov DB lock: {e}")).into_response(),
    };

    match super::governance::model::auto_discover_models(
        &conn, &req.project_id, &table_edges, &contracts,
    ) {
        Ok((created, updated)) => {
            Json(serde_json::json!({
                "discovered": created + updated,
                "created": created,
                "updated": updated,
            }))
            .into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("Discovery failed: {e}")).into_response(),
    }
}

/// GET /api/governance/models/stats
async fn gov_model_stats(
    State(state): State<Arc<AppState>>,
    Query(q): Query<GovProjectIdQuery>,
) -> impl IntoResponse {
    let conn = match state.gov_db.lock() {
        Ok(c) => c,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("DB lock: {e}")).into_response(),
    };
    match super::governance::model::get_model_stats(&conn, &q.project_id) {
        Ok(stats) => Json(stats).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("Stats failed: {e}")).into_response(),
    }
}

// ============================================================
// Metric management handlers
// ============================================================

#[derive(Deserialize)]
struct GovMetricQuery {
    project_id: String,
    #[serde(default)]
    layer: Option<String>,
    #[serde(default)]
    owner: Option<String>,
    #[serde(default)]
    q: Option<String>,
    #[serde(default)]
    contract_id: Option<String>,
}

/// GET /api/governance/metrics
async fn gov_list_metrics(
    State(state): State<Arc<AppState>>,
    Query(q): Query<GovMetricQuery>,
) -> impl IntoResponse {
    let conn = match state.gov_db.lock() {
        Ok(c) => c,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("DB lock: {e}")).into_response(),
    };
    match super::governance::metric::list_metrics(
        &conn, &q.project_id, q.layer.as_deref(), q.owner.as_deref(), q.q.as_deref(), q.contract_id.as_deref(),
    ) {
        Ok(metrics) => Json(metrics).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("Query failed: {e}")).into_response(),
    }
}

/// GET /api/governance/metrics/conflicts
async fn gov_metric_conflicts(
    State(state): State<Arc<AppState>>,
    Query(q): Query<GovProjectIdQuery>,
) -> impl IntoResponse {
    let conn = match state.gov_db.lock() {
        Ok(c) => c,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("DB lock: {e}")).into_response(),
    };
    match super::governance::metric::detect_conflicts(&conn, &q.project_id) {
        Ok(conflicts) => Json(conflicts).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("Conflict detection failed: {e}")).into_response(),
    }
}

/// GET /api/governance/metrics/stats
async fn gov_metric_stats(
    State(state): State<Arc<AppState>>,
    Query(q): Query<GovProjectIdQuery>,
) -> impl IntoResponse {
    let conn = match state.gov_db.lock() {
        Ok(c) => c,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("DB lock: {e}")).into_response(),
    };
    match super::governance::metric::get_metric_stats(&conn, &q.project_id) {
        Ok(stats) => Json(stats).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("Stats failed: {e}")).into_response(),
    }
}

/// POST /api/governance/metrics/auto — auto-detect metrics from SQL analysis
async fn gov_auto_detect_metrics(
    State(state): State<Arc<AppState>>,
    Json(req): Json<GovAutoDetectMetricsRequest>,
) -> impl IntoResponse {
    // Read file contents from main DB (result_json may be empty, so we analyze ourselves)
    let file_contents: Vec<(String, String)> = {
        let conn = match state.db.lock() {
            Ok(c) => c,
            Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("DB lock: {e}")).into_response(),
        };
        let mut results = Vec::new();
        if let Ok(mut stmt) = conn.prepare(
            "SELECT path, content FROM project_files WHERE project_id = ?1 AND status = 1",
        ) {
            if let Ok(rows) = stmt.query_map(rusqlite::params![req.project_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            }) {
                results = rows.filter_map(|r| r.ok()).collect();
            }
        }
        results
    };

    // Also check existing file_results (if any have actual json)
    let file_results: Vec<(String, capybara_core::AnalyzeResult)> = {
        let conn = match state.db.lock() {
            Ok(c) => c,
            Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("DB lock: {e}")).into_response(),
        };
        let mut results = Vec::new();
        if let Ok(mut stmt) = conn.prepare(
            "SELECT file_path, result_json FROM project_file_results WHERE project_id = ?1 AND status = 1 AND length(result_json) > 0",
        ) {
            if let Ok(rows) = stmt.query_map(rusqlite::params![req.project_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            }) {
                results = rows.filter_map(|r| r.ok()).collect();
            }
        }
        results
            .into_iter()
            .filter_map(|(path, json)| {
                serde_json::from_str::<capybara_core::AnalyzeResult>(&json)
                    .ok()
                    .map(|r| (path, r))
            })
            .collect()
    };

    // If no existing results, analyze file contents (limited to prevent timeout)
    let analyze_results = if file_results.is_empty() && !file_contents.is_empty() {
        let mut results = Vec::new();
        for (path, content) in file_contents.iter().take(500) {
            if content.trim().is_empty() { continue; }
            let request = capybara_core::AnalyzeRequest {
                sql: content.clone(),
                files: None,
                dialect: state.config.dialect,
                source_name: Some(path.clone()),
                options: None,
                schema: None,
                #[cfg(feature = "templating")]
                template_config: None,
            };
            let result = capybara_core::analyze(&request);
            results.push((path.clone(), result));
        }
        results
    } else {
        file_results
    };

    let conn = match state.gov_db.lock() {
        Ok(c) => c,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("Gov DB lock: {e}")).into_response(),
    };

    match super::governance::metric::auto_detect_metrics(&conn, &req.project_id, &analyze_results) {
        Ok(count) => Json(serde_json::json!({"detected": count})).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("Auto-detect failed: {e}")).into_response(),
    }
}

/// POST /api/governance/metrics/import-dbt — import metrics from dbt MetricFlow definitions
async fn gov_import_dbt_metrics(
    State(state): State<Arc<AppState>>,
    Json(req): Json<GovImportDbtRequest>,
) -> impl IntoResponse {
    let conn = match state.gov_db.lock() {
        Ok(c) => c,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("DB lock: {e}")).into_response(),
    };
    let watch_dirs = state.config.watch_dirs.clone();
    match super::governance::dbt::import_dbt_metrics(&conn, &req.project_id, &watch_dirs) {
        Ok(result) => Json(result).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("dbt import failed: {e}")).into_response(),
    }
}

/// POST /api/governance/metrics/extract-lineage — extract metrics from column-level lineage
async fn gov_extract_lineage_metrics(
    State(state): State<Arc<AppState>>,
    Json(req): Json<GovProjectIdBody>,
) -> impl IntoResponse {
    // Lock main DB (read lineage) and governance DB (write metrics)
    let main_conn = match state.db.lock() {
        Ok(c) => c,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("Main DB lock: {e}")).into_response(),
    };
    let gov_conn = match state.gov_db.lock() {
        Ok(c) => c,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("Gov DB lock: {e}")).into_response(),
    };
    match super::governance::metric::extract_metrics_from_lineage(&main_conn, &gov_conn, &req.project_id) {
        Ok(count) => Json(serde_json::json!({"extracted": count})).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("Lineage extraction failed: {e}")).into_response(),
    }
}

/// GET /api/governance/metrics/analysis — metric intelligence analysis
async fn gov_metric_analysis(
    State(state): State<Arc<AppState>>,
    Query(q): Query<GovProjectIdQuery>,
) -> impl IntoResponse {
    let conn = match state.gov_db.lock() {
        Ok(c) => c,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("DB lock: {e}")).into_response(),
    };
    match super::governance::metric::analyze_metrics(&conn, &q.project_id) {
        Ok(analysis) => Json(analysis).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("Analysis failed: {e}")).into_response(),
    }
}

/// GET /api/governance/metrics/scripts — lightweight script list for lazy loading
async fn gov_metric_scripts(
    State(state): State<Arc<AppState>>,
    Query(q): Query<GovProjectIdQuery>,
) -> impl IntoResponse {
    let conn = match state.gov_db.lock() {
        Ok(c) => c,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("DB lock: {e}")).into_response(),
    };
    match super::governance::metric::list_script_summaries(&conn, &q.project_id) {
        Ok(scripts) => Json(scripts).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("Script list failed: {e}")).into_response(),
    }
}

// ============================================================
// Dimension Registry handlers
// ============================================================

/// POST /api/governance/dimensions/discover — auto-discover dimension candidates
async fn gov_discover_dimensions(
    State(state): State<Arc<AppState>>,
    Json(req): Json<GovProjectIdBody>,
) -> impl IntoResponse {
    // Phase 1: Read from main DB (scan lineage). Hold ONLY main lock.
    let candidates = {
        let main_conn = match state.db.lock() {
            Ok(c) => c,
            Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("DB lock: {e}")).into_response(),
        };
        match super::governance::dimension::discover_read(&main_conn, &req.project_id) {
            Ok(c) => c,
            Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("Discovery read failed: {e}")).into_response(),
        }
    };
    // Phase 2: Write to gov DB. Hold ONLY gov lock.
    let count = {
        let gov_conn = match state.gov_db.lock() {
            Ok(c) => c,
            Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("Gov DB lock: {e}")).into_response(),
        };
        match super::governance::dimension::discover_write(&gov_conn, &req.project_id, &candidates) {
            Ok(n) => n,
            Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("Discovery write failed: {e}")).into_response(),
        }
    };
    Json(serde_json::json!({"discovered": count})).into_response()
}

/// GET /api/governance/dimensions — list dimensions (optional ?status=candidate|confirmed)
async fn gov_list_dimensions(
    State(state): State<Arc<AppState>>,
    Query(mut q): Query<std::collections::HashMap<String, String>>,
) -> impl IntoResponse {
    let conn = match state.gov_db.lock() {
        Ok(c) => c,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("DB lock: {e}")).into_response(),
    };
    let project_id = q.remove("project_id").unwrap_or_default();
    let status = q.get("status").map(|s| s.as_str());
    let limit: usize = q.get("limit").and_then(|s| s.parse().ok()).unwrap_or(50);
    let offset: usize = q.get("offset").and_then(|s| s.parse().ok()).unwrap_or(0);
    match super::governance::dimension::list_dimensions(&conn, &project_id, status, limit, offset) {
        Ok((dims, total)) => Json(serde_json::json!({
            "items": dims,
            "total": total,
            "limit": limit,
            "offset": offset,
        })).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("List failed: {e}")).into_response(),
    }
}

#[derive(Deserialize)]
struct UpdateDimensionRequest {
    project_id: String,
    status: Option<String>,
    dim_name: Option<String>,
    dim_name_cn: Option<String>,
    description: Option<String>,
}

/// PUT /api/governance/dimensions/:id — confirm/edit/dismiss a dimension
async fn gov_update_dimension(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i64>,
    Json(req): Json<UpdateDimensionRequest>,
) -> impl IntoResponse {
    let conn = match state.gov_db.lock() {
        Ok(c) => c,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("DB lock: {e}")).into_response(),
    };
    match super::governance::dimension::update_dimension(
        &conn, &req.project_id, id,
        req.status.as_deref(),
        req.dim_name.as_deref(),
        req.dim_name_cn.as_deref(),
        req.description.as_deref(),
    ) {
        Ok(()) => Json(serde_json::json!({"ok": true})).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("Update failed: {e}")).into_response(),
    }
}

// ============================================================
// Metric Decomposition handlers (atomic / qualifier / derived)
// ============================================================

/// POST /api/governance/metrics/decompose — decompose metrics into atomic/qualifier/derived
async fn gov_decompose_metrics(
    State(state): State<Arc<AppState>>,
    Json(req): Json<GovProjectIdBody>,
) -> impl IntoResponse {
    let gov_conn = match state.gov_db.lock() {
        Ok(c) => c,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("Gov DB lock: {e}")).into_response(),
    };
    match super::governance::metric::decompose_metrics(&gov_conn, &req.project_id) {
        Ok(stats) => Json(stats).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("Decompose failed: {e}")).into_response(),
    }
}

/// GET /api/governance/metrics/atomic — list atomic metrics
async fn gov_list_atomic_metrics(
    State(state): State<Arc<AppState>>,
    Query(q): Query<GovProjectIdQuery>,
) -> impl IntoResponse {
    let conn = match state.gov_db.lock() {
        Ok(c) => c,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("DB lock: {e}")).into_response(),
    };
    match super::governance::metric::list_atomic_metrics(&conn, &q.project_id) {
        Ok(metrics) => Json(metrics).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("List failed: {e}")).into_response(),
    }
}

/// GET /api/governance/metrics/qualifiers — list business qualifiers
async fn gov_list_qualifiers(
    State(state): State<Arc<AppState>>,
    Query(q): Query<GovProjectIdQuery>,
) -> impl IntoResponse {
    let conn = match state.gov_db.lock() {
        Ok(c) => c,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("DB lock: {e}")).into_response(),
    };
    match super::governance::metric::list_qualifiers(&conn, &q.project_id) {
        Ok(qualifiers) => Json(qualifiers).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("List failed: {e}")).into_response(),
    }
}

/// GET /api/governance/metrics/derived — list derived metrics
async fn gov_list_derived_metrics(
    State(state): State<Arc<AppState>>,
    Query(q): Query<GovProjectIdQuery>,
) -> impl IntoResponse {
    let conn = match state.gov_db.lock() {
        Ok(c) => c,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("DB lock: {e}")).into_response(),
    };
    match super::governance::metric::list_derived_metrics(&conn, &q.project_id) {
        Ok(metrics) => Json(metrics).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("List failed: {e}")).into_response(),
    }
}

// ============================================================
// Summary Table Recommendation handlers
// ============================================================

/// GET /api/governance/recommendations/summary-tables — list recommendations
async fn gov_list_summary_recs(
    State(state): State<Arc<AppState>>,
    Query(q): Query<GovProjectIdQuery>,
) -> impl IntoResponse {
    let conn = match state.gov_db.lock() {
        Ok(c) => c,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("DB lock: {e}")).into_response(),
    };
    match super::governance::metric::list_summary_recommendations(&conn, &q.project_id) {
        Ok(recs) => Json(recs).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("List failed: {e}")).into_response(),
    }
}

/// POST /api/governance/recommendations/summary-tables — generate recommendations
async fn gov_generate_summary_recs(
    State(state): State<Arc<AppState>>,
    Json(req): Json<GovProjectIdBody>,
) -> impl IntoResponse {
    let gov_conn = match state.gov_db.lock() {
        Ok(c) => c,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("Gov DB lock: {e}")).into_response(),
    };
    match super::governance::metric::generate_summary_recommendations(&gov_conn, &req.project_id) {
        Ok(count) => Json(serde_json::json!({"generated": count})).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("Generation failed: {e}")).into_response(),
    }
}

#[derive(Deserialize)]
struct UpdateSummaryRecRequest {
    project_id: String,
    status: Option<String>,
}

/// PUT /api/governance/recommendations/summary-tables/:id — update status
async fn gov_update_summary_rec(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i64>,
    Json(req): Json<UpdateSummaryRecRequest>,
) -> impl IntoResponse {
    let conn = match state.gov_db.lock() {
        Ok(c) => c,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("DB lock: {e}")).into_response(),
    };
    let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
    if let Some(status) = req.status {
        let _ = conn.execute(
            "UPDATE summary_table_recommendation SET status = ?1, updated_at = ?2 WHERE id = ?3 AND project_id = ?4",
            rusqlite::params![status, now, id, req.project_id],
        );
    }
    Json(serde_json::json!({"ok": true})).into_response()
}

#[derive(Deserialize)]
struct GovAutoDetectMetricsRequest {
    project_id: String,
}

#[derive(Deserialize)]
struct GovImportDbtRequest {
    project_id: String,
}

#[derive(Deserialize)]
struct GovProjectIdBody {
    project_id: String,
}

#[derive(Deserialize)]
struct GovProjectIdQuery {
    project_id: String,
}

// ============================================================
// Modeling (Dataphin-style) handlers
// ============================================================

/// POST /api/governance/domains/discover — discover domains from file paths
async fn gov_discover_domains(
    State(state): State<Arc<AppState>>,
    Json(req): Json<GovProjectIdBody>,
) -> impl IntoResponse {
    // Phase 1: read file paths from main DB (hold main lock only).
    let domains = {
        let main_conn = match state.db.lock() {
            Ok(c) => c,
            Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("DB lock: {e}")).into_response(),
        };
        let mut map: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
        let sql = "SELECT DISTINCT file_path FROM lineage_nodes WHERE project_id = ?1 AND file_path != ''";
        if let Ok(mut stmt) = main_conn.prepare(sql) {
            let rows = stmt.query_map(rusqlite::params![&req.project_id], |row| row.get::<_, String>(0));
            if let Ok(rows) = rows {
                for fp in rows.flatten() {
                    let normalized = fp.replace('\\', "/");
                    let segs: Vec<&str> = normalized.split('/').filter(|s| !s.is_empty()).collect();
                    if segs.len() >= 2 {
                        let d = segs[1].to_string();
                        if d.len() >= 2 && !matches!(d.as_str(), "ALL" | "TMP" | "tmp" | "temp") {
                            *map.entry(d).or_insert(0) += 1;
                        }
                    }
                }
            }
        }
        map
    };
    // Phase 2: write to gov DB (hold gov lock only).
    let count = {
        let gov_conn = match state.gov_db.lock() {
            Ok(c) => c,
            Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("Gov DB lock: {e}")).into_response(),
        };
        let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
        let mut upserted = 0usize;
        for (name, cnt) in &domains {
            let desc = format!("{cnt} 个模型");
            let _ = gov_conn.execute(
                "INSERT INTO domain_registry (project_id, domain_name, description, status, created_at, updated_at)
                 VALUES (?1, ?2, ?3, 1, ?4, ?4)
                 ON CONFLICT(project_id, domain_name) DO UPDATE SET
                    description = excluded.description, updated_at = excluded.updated_at",
                rusqlite::params![&req.project_id, name, desc, now],
            );
            upserted += 1;
        }
        upserted
    };
    Json(serde_json::json!({"discovered": count})).into_response()
}

/// GET /api/governance/domains — list domains
async fn gov_list_domains(
    State(state): State<Arc<AppState>>,
    Query(q): Query<GovProjectIdQuery>,
) -> impl IntoResponse {
    let conn = match state.gov_db.lock() {
        Ok(c) => c,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("DB lock: {e}")).into_response(),
    };
    match super::governance::modeling::list_domains(&conn, &q.project_id) {
        Ok(domains) => Json(domains).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("List failed: {e}")).into_response(),
    }
}

/// GET /api/governance/modeling/overview — modeling overview stats
async fn gov_modeling_overview(
    State(state): State<Arc<AppState>>,
    Query(q): Query<GovProjectIdQuery>,
) -> impl IntoResponse {
    let conn = match state.gov_db.lock() {
        Ok(c) => c,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("DB lock: {e}")).into_response(),
    };
    match super::governance::modeling::modeling_overview(&conn, &q.project_id) {
        Ok(overview) => Json(overview).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("Overview failed: {e}")).into_response(),
    }
}

// ============================================================
// Designer handlers
// ============================================================

#[derive(Deserialize, ToSchema)]
struct GovGenDdlRequest {
    model: super::governance::designer::ModelDefinition,
    #[serde(default)]
    dialect: String,
}

/// POST /api/governance/gen-ddl
async fn gov_gen_ddl(Json(req): Json<GovGenDdlRequest>) -> impl IntoResponse {
    let dialect = if req.dialect.is_empty() { "postgresql" } else { &req.dialect };
    let ddl = super::governance::designer::generate_ddl(&req.model, dialect);
    Json(serde_json::json!({ "ddl": ddl }))
}

#[derive(Deserialize, ToSchema)]
struct GovReverseEngineerRequest {
    sql: String,
}

/// POST /api/governance/reverse-engineer
async fn gov_reverse_engineer(Json(req): Json<GovReverseEngineerRequest>) -> impl IntoResponse {
    let models = super::governance::designer::reverse_engineer(&req.sql);
    Json(models)
}

#[derive(Deserialize, ToSchema)]
struct GovModelDiffRequest {
    old: super::governance::designer::ModelDefinition,
    new: super::governance::designer::ModelDefinition,
}

/// POST /api/governance/model-diff
async fn gov_model_diff(Json(req): Json<GovModelDiffRequest>) -> impl IntoResponse {
    let diff = super::governance::designer::diff_models(&req.old, &req.new);
    Json(diff)
}

// ============================================================
// Settings handlers
// ============================================================

#[derive(Serialize, Deserialize, ToSchema, Default)]
struct GovSettings {
    #[serde(default)]
    scan_cron: String,
    #[serde(default = "default_alert_threshold")]
    alert_threshold: i64,
    #[serde(default)]
    webhook_url: String,
    #[serde(default)]
    notify_emails: Vec<String>,
}

fn default_alert_threshold() -> i64 {
    60
}

/// GET /api/governance/settings
async fn gov_get_settings(
    State(state): State<Arc<AppState>>,
    Query(q): Query<GovProjectIdQuery>,
) -> impl IntoResponse {
    let conn = match state.gov_db.lock() {
        Ok(c) => c,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("DB lock: {e}")).into_response(),
    };

    let result: Result<GovSettings, _> = conn.query_row(
        "SELECT scan_cron, alert_threshold, webhook_url, notify_emails FROM governance_settings WHERE project_id = ?1 AND status = 1",
        rusqlite::params![q.project_id],
        |row| {
            let emails_json: String = row.get(3)?;
            let emails: Vec<String> = serde_json::from_str(&emails_json).unwrap_or_default();
            Ok(GovSettings {
                scan_cron: row.get(0)?,
                alert_threshold: row.get(1)?,
                webhook_url: row.get(2)?,
                notify_emails: emails,
            })
        },
    );

    match result {
        Ok(s) => Json(s).into_response(),
        Err(rusqlite::Error::QueryReturnedNoRows) => Json(GovSettings::default()).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("Query failed: {e}")).into_response(),
    }
}

/// PUT /api/governance/settings
async fn gov_update_settings(
    State(state): State<Arc<AppState>>,
    Json(req): Json<GovSettingsUpdate>,
) -> impl IntoResponse {
    let conn = match state.gov_db.lock() {
        Ok(c) => c,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("DB lock: {e}")).into_response(),
    };

    let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
    let emails_json = serde_json::to_string(&req.notify_emails).unwrap_or_default();

    match conn.execute(
        "INSERT INTO governance_settings (project_id, scan_cron, alert_threshold, webhook_url, notify_emails, settings_json, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, '{}', 1, ?6, ?6)
         ON CONFLICT(project_id) DO UPDATE SET
            scan_cron = excluded.scan_cron,
            alert_threshold = excluded.alert_threshold,
            webhook_url = excluded.webhook_url,
            notify_emails = excluded.notify_emails,
            updated_at = excluded.updated_at",
        rusqlite::params![req.project_id, req.scan_cron, req.alert_threshold, req.webhook_url, emails_json, now],
    ) {
        Ok(_) => Json(serde_json::json!({"status": "updated"})).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("Update failed: {e}")).into_response(),
    }
}

#[derive(Deserialize, ToSchema)]
struct GovSettingsUpdate {
    project_id: String,
    #[serde(default)]
    scan_cron: String,
    #[serde(default = "default_alert_threshold")]
    alert_threshold: i64,
    #[serde(default)]
    webhook_url: String,
    #[serde(default)]
    notify_emails: Vec<String>,
}

// ============================================================
// Contract templates
// ============================================================

/// GET /api/governance/contracts/templates — list available templates
async fn gov_contract_templates() -> impl IntoResponse {
    Json(vec![
        serde_json::json!({
            "name": "default",
            "description": "FlowScope default governance rules",
            "content": super::governance::contract::DEFAULT_CONTRACT_YAML,
        }),
        serde_json::json!({
            "name": "ecommerce",
            "description": "E-commerce data warehouse template",
            "content": TEMPLATE_ECOMMERCE,
        }),
        serde_json::json!({
            "name": "finance",
            "description": "Finance risk control template (enforced masking + audit)",
            "content": TEMPLATE_FINANCE,
        }),
        serde_json::json!({
            "name": "blank",
            "description": "Blank template",
            "content": TEMPLATE_BLANK,
        }),
    ])
}

const TEMPLATE_ECOMMERCE: &str = r#"apiVersion: v3.1.0
kind: DataContract
id: ecommerce_governance
name: E-commerce Data Warehouse Governance
version: 1.0.0
status: active

custom:
  flowscope:
    lineage_rules:
      - id: no_cross_layer
        description: "禁止跨层依赖"
        forbidden_edges: [[ODS, DWS], [ODS, ADS], [DWD, ADS]]
        severity: P1
      - id: no_orphan_output
        severity: P2
      - id: lineage_completeness
        severity: P0

    sql_rules:
      - id: no_select_star
        severity: P2
      - id: no_update_without_where
        severity: P0
      - id: max_complexity
        threshold: 80
        severity: P2

    metric_rules:
      - id: no_duplicate_computation
        similarity_threshold: 0.85
        severity: P1
      - id: no_write_conflict
        severity: P1

    modeling_rules:
      - id: naming_must_match_layer
        severity: P2
        patterns: {ODS: "^ods_", DWD: "^dwd_", DWS: "^dws_", ADS: "^(ads_|app_)", DIM: "^dim_"}
      - id: layer_must_be_assigned
        severity: P2
"#;

const TEMPLATE_FINANCE: &str = r#"apiVersion: v3.1.0
kind: DataContract
id: finance_governance
name: Finance & Risk Control Governance
version: 1.0.0
status: active

custom:
  flowscope:
    security_rules:
      - id: no_hardcoded_secrets
        description: "禁止硬编码密码/令牌/密钥"
        patterns: ["password", "token", "secret", "api_key", "private_key"]
        severity: P0
      - id: sensitive_column_exposure
        description: "敏感字段必须脱敏"
        column_patterns: ["id_card", "credit", "phone", "email", "account"]
        severity: P0

    sql_rules:
      - id: no_update_without_where
        severity: P0
      - id: no_select_star
        severity: P1
      - id: max_complexity
        threshold: 60
        severity: P1

    lineage_rules:
      - id: lineage_completeness
        severity: P0
      - id: no_cross_layer
        forbidden_edges: [[ODS, DWS], [ODS, ADS], [DWD, ADS]]
        severity: P0

    modeling_rules:
      - id: naming_must_match_layer
        severity: P1
        patterns: {ODS: "^ods_", DWD: "^dwd_", DWS: "^dws_", ADS: "^(ads_|app_)", DIM: "^dim_"}
"#;

const TEMPLATE_BLANK: &str = r#"apiVersion: v3.1.0
kind: DataContract
id: blank_contract
name: Blank Contract
version: 1.0.0
status: draft

custom:
  flowscope: {}
"#;

// ============================================================
// dbt fusion: SQL→dbt conversion + DML extraction
// ============================================================

#[derive(Deserialize)]
struct ConvertDbtRequest {
    project_id: String,
    file_path: String,
}

/// POST /api/convert-dbt — convert SQL to dbt format
async fn gov_convert_dbt(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ConvertDbtRequest>,
) -> impl IntoResponse {
    let _dbg_t0 = std::time::Instant::now();
    eprintln!("[convert-dbt] START: {}", req.file_path);
    // Read file content: try disk (watch dirs) first, fallback to DB
    let sql = read_project_file(&state, &req.project_id, &req.file_path);
    eprintln!(
        "[convert-dbt] read {} bytes: {:?}",
        sql.len(),
        _dbg_t0.elapsed()
    );

    // Convert
    let conn = match state.db.lock() {
        Ok(c) => c,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("DB lock: {e}")).into_response(),
    };

    // Try edge-based conversion first (precise table names from lineage).
    // Fall back to regex-based conversion if no edges data exists.
    let script_name = std::path::Path::new(&req.file_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(&req.file_path);
    let model_tables = super::governance::dbt_fusion::load_model_tables_pub(&conn, &req.project_id);
    let (sources, targets) =
        super::governance::dbt_fusion::load_script_edges(&conn, &req.project_id, script_name);

    let result = std::panic::catch_unwind(|| {
        if !sources.is_empty() || !targets.is_empty() {
            super::governance::dbt_fusion::convert_sql_to_dbt_with_edges(
                &sources, &targets, &model_tables, &sql,
            )
        } else {
            super::governance::dbt_fusion::convert_sql_to_dbt_with_tables(&model_tables, &sql)
        }
    });
    let result = match result {
        Ok(r) => r,
        Err(panic_info) => {
            let msg = panic_info
                .downcast_ref::<&str>()
                .copied()
                .or_else(|| panic_info.downcast_ref::<String>().map(|s| s.as_str()))
                .unwrap_or("unknown panic");
            eprintln!("[convert-dbt] PANIC converting {}: {msg}", req.file_path);
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Conversion panic: {msg}"),
            )
                .into_response();
        }
    };
    eprintln!(
        "[convert-dbt] DONE: {} bytes ({} sources, {} models, {} warnings) elapsed={:?}",
        result.dbt_content.len(),
        result.source_count,
        result.model_count,
        result.warnings.len(),
        _dbg_t0.elapsed()
    );

    Json(result).into_response()
}

#[derive(Deserialize)]
struct ConvertDbtBatchRequest {
    project_id: String,
    #[serde(default)]
    folder_path: Option<String>,
    /// Optional per-file SQL content from the frontend (fallback when DB content is empty)
    #[serde(default)]
    files: Vec<BatchFileContent>,
}

#[derive(Deserialize)]
struct BatchFileContent {
    path: String,
    content: String,
}

/// POST /api/convert-dbt-batch — convert a folder's SQL files to dbt in one request.
///
/// Mirrors the stored-procedure batch convert pattern: enumerate SQL files,
/// read content (DB first, frontend-provided content as fallback), convert,
/// save dbt_content, and report per-file success/error.
async fn gov_convert_dbt_batch(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ConvertDbtBatchRequest>,
) -> impl IntoResponse {
    let _dbg_t0 = std::time::Instant::now();
    eprintln!(
        "[convert-dbt-batch] START: {} files, folder={:?}",
        req.files.len(),
        req.folder_path
    );
    // 1. Load ONLY the requested file paths from the DB (not the whole
    //    project). Loading everything per 100-file chunk is O(project size)
    //    and gets slower as dbt_content grows — the "slows down after 1400"
    //    symptom.
    let req_paths: Vec<String> = req
        .files
        .iter()
        .map(|f| f.path.clone())
        .collect();
    let db_files: Vec<store::ProjectFileRow> = {
        let conn = match state.db.lock() {
            Ok(c) => c,
            Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("DB lock: {e}")).into_response(),
        };
        store::load_project_files_by_paths(&conn, &req.project_id, &req_paths).unwrap_or_default()
    };
    eprintln!(
        "[convert-dbt-batch] load {} project rows: {:?}",
        db_files.len(),
        _dbg_t0.elapsed()
    );

    // Map path → DB row for content fallback.
    let db_by_path: std::collections::HashMap<&str, &store::ProjectFileRow> =
        db_files.iter().map(|f| (f.path.as_str(), f)).collect();

    let mut skipped = 0usize;
    let mut sql_files: Vec<(String, String)> = Vec::new(); // (path, sql)

    for bf in &req.files {
        let path = &bf.path;
        // Only accept SQL-type paths.
        let lower = path.to_lowercase();
        if !(lower.ends_with(".sql") || lower.ends_with(".hql")) {
            continue;
        }

        // Resolve content: DB → frontend-provided → disk.
        let db_content = db_by_path
            .get(path.as_str())
            .map(|f| f.content.trim())
            .filter(|c| !c.is_empty())
            .unwrap_or("");
        let sql = if !db_content.is_empty() {
            db_content.to_string()
        } else if !bf.content.trim().is_empty() {
            bf.content.clone()
        } else {
            read_project_file(&state, &req.project_id, path)
        };

        // Skip empty-content files silently (counted as skipped).
        if sql.trim().is_empty() {
            skipped += 1;
            continue;
        }
        sql_files.push((path.clone(), sql));
    }

    let total = sql_files.len();
    let mut success_paths = Vec::new();
    let mut error_paths = Vec::new();
    let mut updates: Vec<(String, String)> = Vec::new();

    // 3. Preload model tables and edges once (avoids per-file DB queries)
    let (model_tables, all_edges) = {
        let conn = match state.db.lock() {
            Ok(c) => c,
            Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("DB lock: {e}")).into_response(),
        };
        let mt = super::governance::dbt_fusion::load_model_tables_pub(&conn, &req.project_id);
        // Preload all edges as (script_name → (sources, targets)) map.
        let mut edges_map: HashMap<String, (HashSet<String>, HashSet<String>)> = HashMap::new();
        if let Ok(mut stmt) = conn.prepare(
            "SELECT script_name, from_table, to_table FROM table_level_edges WHERE project_id = ?1",
        ) {
            use rusqlite::params;
            let rows = stmt.query_map(rusqlite::params![&req.project_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))
            });
            if let Ok(rows) = rows {
                for row in rows.flatten() {
                    let entry: &mut (HashSet<String>, HashSet<String>) =
                        edges_map.entry(row.0).or_insert_with(|| (HashSet::new(), HashSet::new()));
                    entry.0.insert(row.1); // from_table
                    entry.1.insert(row.2); // to_table
                }
            }
        }
        (mt, edges_map)
    };
    eprintln!(
        "[convert-dbt-batch] preload model_tables({}) + edges({}): {:?}",
        model_tables.len(),
        all_edges.len(),
        _dbg_t0.elapsed()
    );
    for (path, sql) in &sql_files {
        // Derive script_name from path (e.g. "etl/ALL/Foo.sql" → "Foo.sql").
        let script_name = std::path::Path::new(path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(path);

        // Use edge-based conversion if edges data exists, else fallback to regex.
        // catch_unwind so a panic in conversion (e.g. UTF-8 slice) is logged and
        // skipped instead of aborting the handler mid-transaction — which would
        // leave the DB connection stuck IN TRANSACTION (the 'stuck at 1400'
        // root cause).
        let result = std::panic::catch_unwind(|| {
            if let Some((sources, targets)) = all_edges.get(script_name) {
                if !sources.is_empty() || !targets.is_empty() {
                    super::governance::dbt_fusion::convert_sql_to_dbt_with_edges(
                        sources, targets, &model_tables, sql,
                    )
                } else {
                    super::governance::dbt_fusion::convert_sql_to_dbt_with_tables(&model_tables, sql)
                }
            } else {
                super::governance::dbt_fusion::convert_sql_to_dbt_with_tables(&model_tables, sql)
            }
        });

        let result = match result {
            Ok(r) => r,
            Err(panic_info) => {
                let msg = panic_info
                    .downcast_ref::<&str>()
                    .copied()
                    .or_else(|| panic_info.downcast_ref::<String>().map(|s| s.as_str()))
                    .unwrap_or("unknown panic");
                eprintln!("[convert-dbt-batch] PANIC converting {path}: {msg}");
                // Treat as an error file, do not persist.
                error_paths.push(path.clone());
                continue;
            }
        };

        if !result.dbt_content.trim().is_empty() {
            success_paths.push(path.clone());
            updates.push((path.clone(), result.dbt_content));
        } else {
            error_paths.push(path.clone());
        }
    }
    eprintln!(
        "[convert-dbt-batch] converted {} files ({} success, {} errors, {} skipped): {:?}",
        sql_files.len(),
        success_paths.len(),
        error_paths.len(),
        skipped,
        _dbg_t0.elapsed()
    );
    // 4. Persist dbt_content in chunks
    if !updates.is_empty() {
        let conn = match state.db.lock() {
            Ok(c) => c,
            Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("DB lock: {e}")).into_response(),
        };
        const CHUNK: usize = 500;
        for chunk in updates.chunks(CHUNK) {
            if let Err(e) = store::batch_update_dbt_content(&conn, &req.project_id, chunk) {
                eprintln!("[api] convert-dbt-batch persist error: {e}");
            }
        }
    }
    eprintln!(
        "[convert-dbt-batch] persist {} updates: {:?}",
        updates.len(),
        _dbg_t0.elapsed()
    );
    eprintln!(
        "[convert-dbt-batch] DONE total={} success={} errors={} skipped={} elapsed={:?}",
        total,
        success_paths.len(),
        error_paths.len(),
        skipped,
        _dbg_t0.elapsed()
    );

    Json(serde_json::json!({
        "success": success_paths.len(),
        "errors": error_paths.len(),
        "skipped": skipped,
        "total": total,
        "successPaths": success_paths,
        "errorPaths": error_paths,
    }))
    .into_response()
}

/// POST /api/extract-dml — extract DML statements from SQL
async fn gov_extract_dml(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ConvertDbtRequest>,
) -> impl IntoResponse {
    let sql = read_project_file(&state, &req.project_id, &req.file_path);
    let result = super::governance::dbt_fusion::extract_dml(&sql);
    Json(result).into_response()
}

/// Read a project file's content: try the watch directories on disk first,
/// then fall back to the DB (content may be lazily loaded / not persisted).
fn read_project_file(state: &Arc<AppState>, project_id: &str, file_path: &str) -> String {
    // 1. Try disk: file_path is relative to a watch directory
    for dir in &state.config.watch_dirs {
        let candidate = dir.join(file_path);
        if candidate.is_file() {
            if let Ok(content) = std::fs::read_to_string(&candidate) {
                return content;
            }
        }
    }

    // 2. Fallback: read from DB
    if let Ok(conn) = state.db.lock() {
        if let Ok(Some(content)) = store::load_file_content(&conn, project_id, file_path) {
            return content;
        }
    }

    String::new()
}

#[derive(Deserialize)]
struct SaveDbtContentRequest {
    project_id: String,
    file_path: String,
    dbt_content: String,
}

/// PUT /api/files/dbt-content — save dbt_content for a file
async fn gov_save_dbt_content(
    State(state): State<Arc<AppState>>,
    Json(req): Json<SaveDbtContentRequest>,
) -> impl IntoResponse {
    let conn = match state.db.lock() {
        Ok(c) => c,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("DB lock: {e}")).into_response(),
    };
    match store::update_dbt_content(&conn, &req.project_id, &req.file_path, &req.dbt_content) {
        Ok(()) => Json(serde_json::json!({"ok": true})).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("Save failed: {e}")).into_response(),
    }
}

// ── Semantic YAML endpoints ──────────────────────────────────────────────

#[derive(Deserialize)]
struct GenerateSemanticYamlRequest {
    project_id: String,
    file_path: String,
}

/// POST /api/generate-semantic-yaml — generate dbt Semantic Layer YAML for a file
async fn gov_generate_semantic_yaml(
    State(state): State<Arc<AppState>>,
    Json(req): Json<GenerateSemanticYamlRequest>,
) -> impl IntoResponse {
    let conn = match state.db.lock() {
        Ok(c) => c,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("DB lock: {e}")).into_response(),
    };
    match super::governance::semantic_yaml::generate_semantic_yaml(&conn, &req.project_id, &req.file_path) {
        Ok(result) => Json(serde_json::json!({
            "yaml": result.yaml,
            "model_name": result.model_name,
            "dimension_count": result.dimension_count,
            "measure_count": result.measure_count,
            "source_count": result.source_count,
            "skipped": result.skipped,
        })).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("Generation failed: {e}")).into_response(),
    }
}

/// POST /api/generate-semantic-yaml-batch — batch generate YAML for a folder
async fn gov_generate_semantic_yaml_batch(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ConvertDbtBatchRequest>,
) -> impl IntoResponse {
    // Reuse ConvertDbtBatchRequest (project_id, folder_path, files).
    let mut success_paths = Vec::new();
    let mut error_paths = Vec::new();
    let mut skipped_paths = Vec::new();
    let mut updates: Vec<(String, String)> = Vec::new();

    let conn = match state.db.lock() {
        Ok(c) => c,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("DB lock: {e}")).into_response(),
    };

    for bf in &req.files {
        let path = &bf.path;
        let lower = path.to_lowercase();
        if !(lower.ends_with(".sql") || lower.ends_with(".hql")) {
            continue;
        }
        // Each file independently queries only its OWN lineage edges from the
        // DB (scoped by file_path). No full-project preload — the DB is the
        // single source of truth.
        match super::governance::semantic_yaml::generate_semantic_yaml(
            &conn,
            &req.project_id,
            path,
        ) {
            Ok(result) => {
                if result.skipped {
                    skipped_paths.push(path.clone());
                } else {
                    success_paths.push(path.clone());
                    updates.push((path.clone(), result.yaml));
                }
            }
            Err(_) => {
                error_paths.push(path.clone());
            }
        }
    }

    // Persist in chunks
    if !updates.is_empty() {
        const CHUNK: usize = 500;
        for chunk in updates.chunks(CHUNK) {
            if let Err(e) = store::batch_update_dbt_yaml(&conn, &req.project_id, chunk) {
                eprintln!("[api] generate-semantic-yaml-batch persist error: {e}");
            }
        }
    }

    Json(serde_json::json!({
        "success": success_paths.len(),
        "errors": error_paths.len(),
        "skipped": skipped_paths.len(),
        "total": success_paths.len() + error_paths.len() + skipped_paths.len(),
        "successPaths": success_paths,
        "errorPaths": error_paths,
        "skippedPaths": skipped_paths,
    }))
    .into_response()
}

#[derive(Deserialize)]
struct SaveDbtYamlRequest {
    project_id: String,
    file_path: String,
    dbt_yaml: String,
}

/// PUT /api/files/dbt-yaml — save dbt_yaml for a file
async fn gov_save_dbt_yaml(
    State(state): State<Arc<AppState>>,
    Json(req): Json<SaveDbtYamlRequest>,
) -> impl IntoResponse {
    let conn = match state.db.lock() {
        Ok(c) => c,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("DB lock: {e}")).into_response(),
    };
    match store::update_dbt_yaml(&conn, &req.project_id, &req.file_path, &req.dbt_yaml) {
        Ok(()) => Json(serde_json::json!({"ok": true})).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("Save failed: {e}")).into_response(),
    }
}

#[derive(Deserialize)]
struct ExtractScriptMetricsRequest {
    project_id: String,
    file_path: String,
}

/// POST /api/extract-script-metrics — extract metrics from a single script
/// by actually analyzing its SQL (not mock). Returns real aggregation columns
/// (SUM/COUNT/AVG/MIN/MAX) with expressions, filters, and source tables.
async fn gov_extract_script_metrics(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ExtractScriptMetricsRequest>,
) -> impl IntoResponse {
    // Extract metrics by querying persisted lineage_* tables (project_id +
    // file_path scoped, indexed — no full scan). The aggregation expressions
    // (SUM/COUNT/AVG/MIN/MAX incl. IF/CASE conditions) are already stored in
    // lineage_edges derivation edges. The script SQL is also read to infer
    // period (data_dt/imp_date) and GROUP BY dimensions.
    let sql = read_project_file(&state, &req.project_id, &req.file_path);
    let conn = match state.db.lock() {
        Ok(c) => c,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("DB lock: {e}")).into_response(),
    };
    let metrics = super::governance::metric::extract_script_metrics_from_lineage(
        &conn, &req.project_id, &req.file_path, &sql,
    );

    Json(serde_json::json!({
        "metrics": metrics,
        "script_name": req.file_path.split('/').next_back().unwrap_or(&req.file_path),
    }))
    .into_response()
}

// ============================================================
// AI Assistant handlers
// ============================================================

/// GET /api/ai/config — get AI configuration (active model + all model configs)
async fn gov_get_ai_config(
    State(state): State<Arc<AppState>>,
    Query(q): Query<GovProjectIdQuery>,
) -> impl IntoResponse {
    eprintln!("[ai] GET config project={}", q.project_id);
    let conn = match state.gov_db.lock() {
        Ok(c) => c,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("DB lock: {e}")).into_response(),
    };
    let active = super::governance::ai::get_ai_config(&conn, &q.project_id);
    let models = super::governance::ai::list_models_with_shared(&conn, &q.project_id);
    eprintln!(
        "[ai] GET config active={}/{} models={}",
        active.provider, active.model,
        models.len()
    );
    Json(serde_json::json!({
        "active": {
            "provider": active.provider,
            "model": active.model,
        },
        "config": active,
        "models": models,
    }))
    .into_response()
}

#[derive(Deserialize)]
struct SaveAiConfigRequest {
    project_id: String,
    provider: Option<String>,
    api_key: Option<String>,
    model: Option<String>,
    endpoint: Option<String>,
    system_prompt: Option<String>,
    temperature: Option<f64>,
    output_template: Option<String>,
}

/// PUT /api/ai/config — save AI configuration.
/// If only provider+model are given → switch the active model.
/// If a full config is given → save that model's config and make it active.
async fn gov_save_ai_config(
    State(state): State<Arc<AppState>>,
    Json(req): Json<SaveAiConfigRequest>,
) -> impl IntoResponse {
    eprintln!(
        "[ai] PUT config project={} provider={:?} model={:?} api_key={:?} endpoint={:?} sys={} temp={:?}",
        req.project_id,
        req.provider,
        req.model,
        req.api_key.as_ref().map(|k| if k.is_empty() { "(empty)" } else { "(set)" }),
        req.endpoint,
        req.system_prompt.is_some(),
        req.temperature
    );
    let conn = match state.gov_db.lock() {
        Ok(c) => c,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("DB lock: {e}")).into_response(),
    };

    // Full config present → save this model's own config and activate it.
    let has_full = req.api_key.is_some()
        || req.endpoint.is_some()
        || req.system_prompt.is_some()
        || req.temperature.is_some();

    if has_full && req.provider.is_some() && req.model.is_some() {
        let provider = req.provider.clone().unwrap();
        let model = req.model.clone().unwrap();
        let mut cfg = super::governance::ai::get_model_config(&conn, &req.project_id, &provider, &model)
            .unwrap_or(AiConfig {
                provider: provider.clone(),
                model: model.clone(),
                ..Default::default()
            });
        if let Some(k) = req.api_key { cfg.api_key = k; }
        if let Some(e) = req.endpoint { cfg.endpoint = e; }
        if let Some(s) = req.system_prompt { cfg.system_prompt = s; }
        if let Some(t) = req.temperature { cfg.temperature = t; }
        if let Some(t) = req.output_template { cfg.output_template = t; }
        if let Err(e) = super::governance::ai::save_model_config(&conn, &req.project_id, &cfg) {
            eprintln!("[ai] PUT save_model_config FAILED: {e}");
            return (StatusCode::INTERNAL_SERVER_ERROR, format!("Save failed: {e}")).into_response();
        }
        if let Err(e) = super::governance::ai::set_active_model(&conn, &req.project_id, &provider, &model) {
            eprintln!("[ai] PUT set_active_model FAILED: {e}");
            return (StatusCode::INTERNAL_SERVER_ERROR, format!("Save failed: {e}")).into_response();
        }
        eprintln!("[ai] PUT saved+activated {provider}/{model}");
        return Json(serde_json::json!({"ok": true})).into_response();
    }

    // Only provider+model → just switch active model.
    if let (Some(p), Some(m)) = (req.provider, req.model) {
        match super::governance::ai::set_active_model(&conn, &req.project_id, &p, &m) {
            Ok(()) => {
                eprintln!("[ai] PUT switched active to {p}/{m}");
                Json(serde_json::json!({"ok": true})).into_response()
            }
            Err(e) => {
                eprintln!("[ai] PUT switch active FAILED: {e}");
                (StatusCode::INTERNAL_SERVER_ERROR, format!("Save failed: {e}")).into_response()
            }
        }
    } else {
        eprintln!("[ai] PUT bad request: provider/model required");
        (StatusCode::BAD_REQUEST, "provider and model required").into_response()
    }
}

/// POST /api/ai/extract-metrics — extract metrics from a script via the
/// active model. Non-streaming so JSON output arrives intact.
#[derive(Deserialize)]
struct ExtractMetricsRequest {
    project_id: String,
    file_path: Option<String>,
    sql: String,
}

async fn gov_extract_metrics(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ExtractMetricsRequest>,
) -> (StatusCode, Json<serde_json::Value>) {
    let cfg = {
        let conn = match state.gov_db.lock() {
            Ok(c) => c,
            Err(e) => {
                return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"ok": false, "error": format!("DB lock: {e}")})))
            }
        };
        super::governance::ai::get_ai_config(&conn, &req.project_id)
    };
    match super::governance::ai::extract_metrics(&cfg, req.file_path.as_deref().unwrap_or(""), &req.sql).await {
        Ok(metrics) => (StatusCode::OK, Json(serde_json::json!({"ok": true, "metrics": metrics}))),
        Err(e) => {
            eprintln!("[ai] extract FAILED: {e}");
            (StatusCode::OK, Json(serde_json::json!({"ok": false, "error": e})))
        }
    }
}

/// POST /api/ai/chat — streaming chat via SSE (proxies to DeepSeek/Ollama)
async fn gov_ai_chat(
    State(state): State<Arc<AppState>>,
    Json(req): Json<super::governance::ai::ChatRequest>,
) -> impl IntoResponse {
    // Load config.
    let cfg = {
        let conn = match state.gov_db.lock() {
            Ok(c) => c,
            Err(e) => return error_sse(format!("DB lock: {e}")),
        };
        super::governance::ai::get_ai_config(&conn, &req.project_id)
    };
    eprintln!(
        "[ai] chat project={} using provider={} model={} api_key={}",
        req.project_id,
        cfg.provider,
        cfg.model,
        if cfg.api_key.is_empty() { "(empty)" } else { "(set)" }
    );

    // Validate config.
    if cfg.provider != "ollama" && cfg.api_key.is_empty() {
        eprintln!("[ai] chat REJECTED: api_key empty for provider={}", cfg.provider);
        return error_sse("AI 未配置 API Key，请在设置中配置。".into());
    }

    // Build messages with context injection.
    let llm_messages = super::governance::ai::build_llm_messages(&cfg, &req.messages, &req.context);
    let body = super::governance::ai::build_request_body(&cfg, llm_messages);
    let url = super::governance::ai::provider_chat_url(&cfg);

    // Build HTTP request to LLM provider.
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
    {
        Ok(c) => c,
        Err(e) => return error_sse(format!("HTTP client error: {e}")),
    };

    let mut http_req = client
        .post(&url)
        .header("Content-Type", "application/json");

    if let Some(auth) = super::governance::ai::auth_header(&cfg) {
        http_req = http_req.header("Authorization", auth);
    }

    let http_req = http_req.json(&body);

    // Send request and get streaming response.
    let response = match http_req.send().await {
        Ok(r) => r,
        Err(e) => return error_sse(format!("LLM 请求失败: {e}\nURL: {url}\n请检查 endpoint 和网络。")),
    };

    if !response.status().is_success() {
        let status = response.status();
        let body_text = response.text().await.unwrap_or_default();
        return error_sse(format!("LLM 返回错误 {status}: {body_text}"));
    }

    // Convert the reqwest streaming body into an axum SSE stream.
    let byte_stream = response.bytes_stream();
    let mut buffer = String::new();
    let stream = async_stream::stream! {
        use futures_util::StreamExt;
        let mut byte_stream = byte_stream;
        while let Some(chunk_result) = byte_stream.next().await {
            match chunk_result {
                Ok(chunk) => {
                    buffer.push_str(&String::from_utf8_lossy(&chunk));
                    // Process complete lines.
                    while let Some(newline_pos) = buffer.find('\n') {
                        let line = buffer[..newline_pos].to_string();
                        buffer = buffer[newline_pos + 1..].to_string();
                        if let Some(content) = super::governance::ai::parse_sse_delta(&line) {
                            yield Ok::<_, std::convert::Infallible>(
                                Event::default().data(content)
                            );
                        }
                    }
                }
                Err(e) => {
                    yield Ok(Event::default().data(format!("[ERROR] {e}")));
                    break;
                }
            }
        }
        // Flush remaining buffer.
        if !buffer.is_empty() {
            if let Some(content) = super::governance::ai::parse_sse_delta(&buffer) {
                yield Ok(Event::default().data(content));
            }
        }
        yield Ok(Event::default().data("[DONE]"));
    };

    Sse::new(stream).into_response()
}

/// Helper: return an SSE stream with a single error message.
fn error_sse(msg: String) -> Response {
    let stream = async_stream::stream! {
        yield Ok::<_, std::convert::Infallible>(
            Event::default().data(format!("[ERROR] {msg}"))
        );
        yield Ok(Event::default().data("[DONE]"));
    };
    Sse::new(stream).into_response()
}
