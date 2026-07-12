use flowscope_core::AnalyzeResult;
use serde::Serialize;

use crate::extract::{
    extract_column_mappings, extract_lineage_entries, extract_script_info,
    extract_table_dependencies, extract_table_info,
};
use crate::csv::ExportSheet;
use crate::ExportError;

/// Export the full AnalyzeResult as JSON (legacy, for compatibility).
pub fn export_json(result: &AnalyzeResult, compact: bool) -> Result<String, ExportError> {
    if compact {
        serde_json::to_string(result).map_err(|err| ExportError::Serialization(err.to_string()))
    } else {
        serde_json::to_string_pretty(result)
            .map_err(|err| ExportError::Serialization(err.to_string()))
    }
}

/// Export selected sheets as a structured JSON object.
/// Returns a JSON object with each selected sheet's data under its key.
pub fn export_json_sheets(
    result: &AnalyzeResult,
    sheets: Option<&[ExportSheet]>,
    compact: bool,
) -> Result<String, ExportError> {
    #[derive(Serialize)]
    struct SheetExport<'a> {
        #[serde(skip_serializing_if = "Option::is_none")]
        summary: Option<&'a flowscope_core::Summary>,
        #[serde(skip_serializing_if = "Option::is_none")]
        scripts: Option<Vec<super::extract::ScriptInfo>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        tables: Option<Vec<super::extract::TableInfo>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        column_mappings: Option<Vec<super::extract::ColumnMapping>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        table_dependencies: Option<Vec<super::extract::TableDependency>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        issues: Option<Vec<&'a flowscope_core::Issue>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        lineage: Option<Vec<super::extract::LineageEntry>>,
        #[serde(skip_serializing_if = "Option::is_none", rename = "resolved_schema")]
        schema_info: Option<&'a flowscope_core::ResolvedSchemaMetadata>,
        #[serde(skip_serializing_if = "Option::is_none", rename = "mermaid")]
        mermaid_lines: Option<String>,
    }

    let all_sheets = [
        ExportSheet::Summary,
        ExportSheet::Scripts,
        ExportSheet::Tables,
        ExportSheet::ColumnMappings,
        ExportSheet::TableDependencies,
        ExportSheet::Issues,
        ExportSheet::Lineage,
        ExportSheet::ResolvedSchema,
    ];

    let should_include = |s: ExportSheet| -> bool {
        sheets.map_or(true, |filter| filter.contains(&s))
    };

    let summary = if should_include(ExportSheet::Summary) {
        Some(&result.summary)
    } else {
        None
    };

    let scripts = if should_include(ExportSheet::Scripts) {
        Some(extract_script_info(result))
    } else {
        None
    };

    let tables = if should_include(ExportSheet::Tables) {
        Some(extract_table_info(result))
    } else {
        None
    };

    let column_mappings = if should_include(ExportSheet::ColumnMappings) {
        Some(extract_column_mappings(result))
    } else {
        None
    };

    let table_dependencies = if should_include(ExportSheet::TableDependencies) {
        Some(extract_table_dependencies(result))
    } else {
        None
    };

    let issues = if should_include(ExportSheet::Issues) {
        Some(result.issues.iter().collect())
    } else {
        None
    };

    let lineage = if should_include(ExportSheet::Lineage) {
        Some(extract_lineage_entries(result))
    } else {
        None
    };

    let schema_info = if should_include(ExportSheet::ResolvedSchema) {
        result.resolved_schema.as_ref()
    } else {
        None
    };

    let mermaid_lines = if should_include(ExportSheet::ResolvedSchema) {
        Some(crate::mermaid::export_mermaid(
            result,
            crate::mermaid::MermaidView::All,
        ))
    } else {
        None
    };

    let _ = all_sheets; // suppress unused warning when sheets is Some
    let export = SheetExport {
        summary,
        scripts,
        tables,
        column_mappings,
        table_dependencies,
        issues,
        lineage,
        schema_info,
        mermaid_lines,
    };

    if compact {
        serde_json::to_string(&export).map_err(|err| ExportError::Serialization(err.to_string()))
    } else {
        serde_json::to_string_pretty(&export)
            .map_err(|err| ExportError::Serialization(err.to_string()))
    }
}
