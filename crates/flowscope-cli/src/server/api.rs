//! REST API handlers for serve mode.
//!
//! This module provides the API endpoints for the web UI to interact with
//! the FlowScope analysis engine.

use std::{collections::BTreeMap, sync::Arc};

use axum::{
    body::Bytes,
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{delete, get, post},
    Json, Router,
};
use flowscope_core::{self, AnalyzeRequest as CoreAnalyzeRequest, Dialect};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use std::sync::atomic::{AtomicU64, Ordering};

use super::{AppState, state::MergeSession};

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
        .route("/db/lineage/columns", get(get_lineage_columns_api))
        .route("/db/lineage/edges", get(get_lineage_edges_api))
        .route("/db/table-metadata", post(save_table_metadata_api))
        .route("/db/table-metadata", get(get_table_metadata_api))
        .route("/db/column-metadata", get(get_column_metadata_api))
        .route("/db/anomalies", post(save_anomaly_api))
        .route("/db/anomalies", get(get_anomalies_api))
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
    files: Option<Vec<flowscope_core::FileSource>>,
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
    files: Option<Vec<flowscope_core::FileSource>>,
}

#[derive(Serialize, ToSchema)]
pub(crate) struct ProjectExportStartResponse {
    session_id: String,
}

#[derive(Deserialize)]
pub(crate) struct ProjectExportFinishRequest {
    format: String,
    #[serde(default)]
    sheets: Option<Vec<flowscope_export::ExportSheet>>,
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
        Some(flowscope_core::AnalysisOptions {
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

    let request = flowscope_core::AnalyzeRequest {
        sql: payload.sql,
        files: payload.files,
        dialect: state.config.dialect,
        source_name: payload.source_name.clone(),
        options,
        schema,
        #[cfg(feature = "templating")]
        template_config,
    };

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| flowscope_core::analyze(&request)));
    match result {
        Ok(r) => Ok(Json(r)),
        Err(panic_err) => {
            let msg = if let Some(s) = panic_err.downcast_ref::<&str>() { s.to_string() }
                else if let Some(s) = panic_err.downcast_ref::<String>() { s.clone() }
                else { "unknown panic".to_string() };
            eprintln!("flowscope: analyze panicked: {msg}");
            Err((StatusCode::INTERNAL_SERVER_ERROR, format!("Analysis panic: {msg}")))
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

    let request = flowscope_core::CompletionRequest {
        sql: payload.sql,
        cursor_offset: payload.cursor_offset,
        dialect: state.config.dialect,
        schema,
    };

    let result = flowscope_core::completion_items(&request);
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
    let request = flowscope_core::StatementSplitRequest {
        sql: payload.sql,
        dialect: state.config.dialect,
    };

    let result = flowscope_core::split_statements(&request);
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

    let lint_config = flowscope_core::LintConfig {
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

    let request = flowscope_core::AnalyzeRequest {
        sql: payload.sql,
        files: payload.files,
        dialect: state.config.dialect,
        source_name: None,
        options: None,
        schema,
        #[cfg(feature = "templating")]
        template_config: state.config.template_config.clone(),
    };

    let result = flowscope_core::analyze(&request);

    match format.as_str() {
        "json" => {
            let output = flowscope_export::export_json(&result, false)
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            Ok((
                [(axum::http::header::CONTENT_TYPE, "application/json")],
                output,
            )
                .into_response())
        }
        "mermaid" => {
            let output =
                flowscope_export::export_mermaid(&result, flowscope_export::MermaidView::Table)
                    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            Ok(([(axum::http::header::CONTENT_TYPE, "text/plain")], output).into_response())
        }
        "html" => {
            let output = flowscope_export::export_html(&result, "lineage", chrono::Utc::now())
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            Ok(([(axum::http::header::CONTENT_TYPE, "text/html")], output).into_response())
        }
        "csv" => {
            let bytes = flowscope_export::export_csv_bundle(&result, None)
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            Ok((
                [(axum::http::header::CONTENT_TYPE, "application/zip")],
                bytes,
            )
                .into_response())
        }
        "xlsx" => {
            let bytes = flowscope_export::export_xlsx(&result, None)
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
            chrono::Utc::now().timestamp_millis(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        )
    };
    state.merge_sessions.write().await.insert(
        session_id.clone(),
        MergeSession { merged: None },
    );
    Ok((StatusCode::CREATED, Json(ProjectExportStartResponse { session_id })))
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
    let result = serde_json::from_slice::<flowscope_core::AnalyzeResult>(&body)
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("Invalid AnalyzeResult JSON: {e}")))?;

    let mut sessions = state.merge_sessions.write().await;
    let session = sessions
        .get_mut(&session_id)
        .ok_or_else(|| (StatusCode::NOT_FOUND, format!("Unknown export session: {session_id}")))?;

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
            (StatusCode::NOT_FOUND, format!("Unknown export session: {session_id}"))
        })?;
        session
            .merged
            .ok_or_else(|| (StatusCode::BAD_REQUEST, "Export session is empty".to_string()))?
    };

    build_project_export_response(
        &merged,
        &payload.format,
        payload.sheets.as_deref(),
        payload.compact,
    )
}

fn build_project_export_response(
    merged: &flowscope_core::AnalyzeResult,
    format: &str,
    sheets: Option<&[flowscope_export::ExportSheet]>,
    compact: bool,
) -> Result<Response, (StatusCode, String)> {
    match format {
        "json" => {
            let output = if let Some(sheets) = sheets {
                flowscope_export::export_json_sheets(merged, Some(sheets), compact)
            } else {
                flowscope_export::export_json(merged, compact)
            }
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            Ok((
                [(axum::http::header::CONTENT_TYPE, "application/json")],
                output,
            )
                .into_response())
        }
        "csv" => {
            let bytes = flowscope_export::export_csv_bundle(merged, sheets)
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            Ok((
                [(axum::http::header::CONTENT_TYPE, "application/zip")],
                bytes,
            )
                .into_response())
        }
        "xlsx" => {
            let bytes = flowscope_export::export_xlsx(merged, sheets)
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
) -> Option<flowscope_core::TemplateConfig> {
    match mode {
        Some("raw") => None,
        Some("jinja") => Some(build_template_config(
            flowscope_core::TemplateMode::Jinja,
            state,
        )),
        Some("dbt") => Some(build_template_config(
            flowscope_core::TemplateMode::Dbt,
            state,
        )),
        Some(_) => state.config.template_config.clone(),
        None => state.config.template_config.clone(),
    }
}

#[cfg(feature = "templating")]
fn build_template_config(
    template_mode: flowscope_core::TemplateMode,
    state: &AppState,
) -> flowscope_core::TemplateConfig {
    let context = state
        .config
        .template_config
        .as_ref()
        .map(|cfg| cfg.context.clone())
        .unwrap_or_default();

    flowscope_core::TemplateConfig {
        mode: template_mode,
        context,
    }
}

#[cfg(feature = "templating")]
fn template_mode_to_str(mode: flowscope_core::TemplateMode) -> &'static str {
    match mode {
        flowscope_core::TemplateMode::Raw => "raw",
        flowscope_core::TemplateMode::Jinja => "jinja",
        flowscope_core::TemplateMode::Dbt => "dbt",
    }
}

// === Persistence Handlers ===

use axum::extract::Query;
use super::store;

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
    let db = state.db.lock().map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
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
    let db = state.db.lock().map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
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
    let db = state.db.lock().map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
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
    let db = state.db.lock().map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let content = store::load_file_content(&db, &q.project_id, &q.path)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(FileContentResponse { content }))
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
    let db = state.db.lock().map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
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
    let db = state.db.lock().map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
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
    let db = state.db.lock().map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    if payload.is_folder {
        store::rename_project_folder(&db, &payload.project_id, &payload.old_path, &payload.new_path)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    } else {
        store::rename_project_file(&db, &payload.project_id, &payload.old_path, &payload.new_path, &payload.new_name)
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
    let db = state.db.lock().map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
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
    let db = state.db.lock().map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
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
    let db = state.db.lock().map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
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
    let db = state.db.lock().map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
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
    let db = state.db.lock().map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
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
    let db = state.db.lock().map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
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
    let db = state.db.lock().map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
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
    let db = state.db.lock().map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    store::save_table_level_edges(&db, &payload.project_id, &payload.edges)
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
    let db = state.db.lock().map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
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
    let db = state.db.lock().map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
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
    let db = state.db.lock().map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    store::save_schema_files(&db, &payload.project_id, &payload.files)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    // Parse DDL to extract table/column metadata using the flowscope-core analyzer
    if !payload.files.is_empty() {
        eprintln!("[api] save_schema_files_api: extracting DDL metadata from {} files", payload.files.len());
        extract_and_save_ddl_metadata(&db, &payload.project_id, &payload.files)
            .map_err(|e| {
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
    let now = || chrono::Utc::now().to_rfc3339();

    let mut all_tables: Vec<store::TableMetadataRow> = Vec::new();
    let mut all_columns: Vec<store::ColumnMetadataRow> = Vec::new();
    let mut table_seq_id: i64 = 0;

    for (fi, f) in files.iter().enumerate() {
        if f.content.trim().is_empty() {
            continue;
        }
        // Log progress every 100 files
        if fi > 0 && fi % 100 == 0 {
            eprintln!("[api] extract_and_save_ddl_metadata: processed {}/{} files", fi, files.len());
        }

        let result = flowscope_core::analyze(&CoreAnalyzeRequest {
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

    eprintln!("[api] extract_and_save_ddl_metadata: extracted {} tables, {} columns from {} files",
        all_tables.len(), all_columns.len(), files.len());

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
    let db = state.db.lock().map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
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
    let db = state.db.lock().map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
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
    let db = state.db.lock().map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
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
    let db = state.db.lock().map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    store::clear_all_cache(&db)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
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
    let db = state.db.lock().map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
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
    let file_path = q.file_path.as_deref().ok_or_else(|| {
        (StatusCode::BAD_REQUEST, "filePath is required".to_string())
    })?;
    let db = state.db.lock().map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    match store::get_file_result(&db, &q.project_id, file_path)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    {
        Some((json, hash)) => Ok(Json(serde_json::json!({
            "found": true,
            "resultJson": json,
            "contentHash": hash,
        })).into_response()),
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
    let db = state.db.lock().map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let results = store::get_file_results(&db, &q.project_id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let list: Vec<serde_json::Value> = results.into_iter().map(|(fp, json, hash, fn_, dp)| {
        serde_json::json!({ "filePath": fp, "resultJson": json, "contentHash": hash, "fileName": fn_, "dirPath": dp })
    }).collect();
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
    let db = state.db.lock().map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
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
    let db = state.db.lock().map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
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
    let db = state.db.lock().map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
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
    let db = state.db.lock().map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    store::save_lineage_batch(&db, &payload.project_id, &payload.nodes, &payload.columns, &payload.edges)
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
    let db = state.db.lock().map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
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
    let db = state.db.lock().map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
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
    let db = state.db.lock().map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
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
    let db = state.db.lock().map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
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
    let db = state.db.lock().map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
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
    let db = state.db.lock().map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let edges = store::load_lineage_edges(&db, &q.project_id, q.file_path.as_deref())
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(edges))
}
