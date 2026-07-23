use utoipa::OpenApi;

use super::api;

#[derive(OpenApi)]
#[openapi(
    info(
        title = "FlowScope API",
        version = env!("CARGO_PKG_VERSION"),
        description = r#"FlowScope SQL lineage analysis engine REST API

## Quick Reference

| Category | Endpoints |
|----------|-----------|
| Core | `/api/health`, `/api/analyze`, `/api/completion`, `/api/split`, `/api/lint-fix`, `/api/config` |
| Files | `/api/files`, `/api/schema` |
| Export | `/api/export/:format`, `/api/project-export/*` |
| DB Files | `/db/project-files`, `/db/files-meta`, `/db/file-content` |
| DB File Ops | `/db/file-upsert-batch`, `/db/file-delete-batch`, `/db/file-rename` |
| DB Dirs | `/db/directories` |
| DB Projects | `/db/projects` |
| DB Lineage | `/db/lineage`, `/db/lineage/*`, `/db/table-level-edges` |
| DB Metadata | `/db/table-metadata`, `/db/column-metadata` |
| DB Cache | `/db/cache`, `/db/cache/clear` |
| DB Views | `/db/view-states` |
| DB Schema | `/db/schema-files`, `/db/file-results`, `/db/file-result` |
"#
    ),
    paths(
        // ── Core ──
        api::health,
        api::analyze,
        api::completion,
        api::split,
        api::lint_fix,
        api::config,
        api::files,
        api::schema,
        api::export,
        api::project_export_start,
        api::project_export_add,
        api::project_export_finish,
        // ── DB: project files ──
        api::get_project_files,
        api::save_project_files_api,
        api::get_files_meta,
        api::get_file_content,
        api::upsert_files_api,
        api::delete_files_api,
        api::rename_file_api,
        // ── DB: directories ──
        api::get_directories,
        // ── DB: schema files ──
        api::get_schema_files,
        api::save_schema_files_api,
        // ── DB: cache ──
        api::get_cache_api,
        api::set_cache_api,
        api::delete_cache_api,
        api::clear_cache_api,
        // ── DB: file results ──
        api::set_file_result_api,
        api::get_file_result_api,
        api::get_file_results_api,
        api::delete_file_results_api,
        // ── DB: anomalies ──
        api::save_anomaly_api,
        api::get_anomalies_api,
        // ── DB: lineage ──
        api::save_lineage_api,
        api::save_table_level_edges_api,
        api::get_table_level_edges,
        api::get_lineage_nodes_api,
        api::get_table_lineage,
        api::get_lineage_columns_api,
        api::get_lineage_edges_api,
        // ── DB: projects ──
        api::get_projects,
        api::save_project_api,
        api::delete_project_api,
        // ── DB: view states ──
        api::get_view_state,
        api::save_view_state,
        // ── DB: table/column metadata ──
        api::save_table_metadata_api,
        api::get_table_metadata_api,
        api::get_column_metadata_api,
    ),
    components(schemas(
        api::HealthResponse,
        api::CompletionRequest,
        api::SplitRequest,
        api::ConfigResponse,
        api::ProjectExportStartResponse,
        api::LintFixRequest,
        api::LintFixResponse,
        api::LintFixCountsResponse,
        api::LintFixSkippedCountsResponse,
        api::ProjectFilesQuery,
        api::SaveProjectFilesRequest,
        api::FileContentQuery,
        api::FileContentResponse,
        api::DeleteFilesRequest,
        api::RenameFileRequest,
        api::ProjectIdQuery,
        api::SaveProjectRequest,
        api::SaveViewStateRequest,
        api::CacheQuery,
        api::SetCacheRequest,
    )),
    tags(
        (name = "Core", description = "Core analysis and configuration"),
        (name = "Files", description = "Project file management"),
        (name = "Directories", description = "Directory tree structure"),
        (name = "Projects", description = "Project CRUD"),
        (name = "Lineage", description = "Lineage data persistence"),
        (name = "Metadata", description = "Table and column metadata"),
        (name = "Cache", description = "Analysis cache"),
        (name = "Views", description = "View state persistence"),
        (name = "Schema", description = "Schema files and file results"),
    )
)]
pub(crate) struct ApiDoc;
