use std::collections::BTreeSet;
use std::io::{Cursor, Write};

use csv::WriterBuilder;
use flowscope_core::{AnalyzeResult, SchemaOrigin};
use zip::write::FileOptions;
use zip::CompressionMethod;

use crate::extract::{
    extract_column_mappings, extract_lineage_entries, extract_script_info,
    extract_table_dependencies, extract_table_info,
};
use crate::ExportError;
use serde::{Deserialize, Serialize};

/// Sheet/file identifiers used for selective export filtering.
/// Matches the TypeScript `ExportSheetType`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExportSheet {
    Summary,
    Scripts,
    Tables,
    ColumnMappings,
    TableDependencies,
    Issues,
    Lineage,
    ResolvedSchema,
}

pub fn export_csv_bundle(
    result: &AnalyzeResult,
    sheets: Option<&[ExportSheet]>,
) -> Result<Vec<u8>, ExportError> {
    let file_name = |sheet: ExportSheet| -> &str {
        match sheet {
            ExportSheet::Summary => "summary.csv",
            ExportSheet::Scripts => "scripts.csv",
            ExportSheet::Tables => "tables.csv",
            ExportSheet::ColumnMappings => "column_mappings.csv",
            ExportSheet::TableDependencies => "table_dependencies.csv",
            ExportSheet::Issues => "issues.csv",
            ExportSheet::Lineage => "lineage.csv",
            ExportSheet::ResolvedSchema => "resolved_schema.csv",
        }
    };

    let gen = |sheet: ExportSheet| -> Result<Vec<u8>, ExportError> {
        match sheet {
            ExportSheet::Summary => export_summary_csv(result),
            ExportSheet::Scripts => export_scripts_csv(result),
            ExportSheet::Tables => export_tables_csv(result),
            ExportSheet::ColumnMappings => export_column_mappings_csv(result),
            ExportSheet::TableDependencies => export_table_dependencies_csv(result),
            ExportSheet::Issues => export_issues_csv(result),
            ExportSheet::Lineage => export_lineage_csv(result),
            ExportSheet::ResolvedSchema => export_schema_csv(result),
        }
    };

    let all_sheets = [
        ExportSheet::Scripts,
        ExportSheet::Tables,
        ExportSheet::ColumnMappings,
        ExportSheet::TableDependencies,
        ExportSheet::Summary,
        ExportSheet::Issues,
        ExportSheet::Lineage,
        ExportSheet::ResolvedSchema,
    ];

    let files: Vec<(String, Vec<u8>)> = all_sheets
        .iter()
        .filter(|s| sheets.map_or(true, |filter| filter.contains(s)))
        .map(|s| Ok((file_name(*s).to_string(), gen(*s)?)))
        .collect::<Result<_, ExportError>>()?;

    let cursor = Cursor::new(Vec::new());
    let mut zip = zip::ZipWriter::new(cursor);
    let options = FileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .unix_permissions(0o644);

    for (name, content) in files {
        zip.start_file(name, options)
            .map_err(|err| ExportError::Archive(err.to_string()))?;
        zip.write_all(&content)
            .map_err(|err| ExportError::Archive(err.to_string()))?;
    }

    let cursor = zip
        .finish()
        .map_err(|err| ExportError::Archive(err.to_string()))?;
    Ok(cursor.into_inner())
}

fn export_scripts_csv(result: &AnalyzeResult) -> Result<Vec<u8>, ExportError> {
    let scripts = extract_script_info(result);
    let mut writer = WriterBuilder::new()
        .has_headers(true)
        .from_writer(Vec::new());

    writer
        .write_record([
            "Script Name",
            "Statement Count",
            "Tables Read",
            "Tables Written",
        ])
        .map_err(|err| ExportError::Csv(err.to_string()))?;

    for script in scripts {
        writer
            .write_record([
                script.source_name,
                script.statement_count.to_string(),
                script.tables_read.join(", "),
                script.tables_written.join(", "),
            ])
            .map_err(|err| ExportError::Csv(err.to_string()))?;
    }

    writer
        .into_inner()
        .map_err(|err| ExportError::Csv(err.to_string()))
}

fn export_tables_csv(result: &AnalyzeResult) -> Result<Vec<u8>, ExportError> {
    let tables = extract_table_info(result);
    let mut writer = WriterBuilder::new()
        .has_headers(true)
        .from_writer(Vec::new());

    writer
        .write_record([
            "Table Name",
            "Qualified Name",
            "Catalog",
            "Schema",
            "Type",
            "Columns",
            "Source",
        ])
        .map_err(|err| ExportError::Csv(err.to_string()))?;

    for table in tables {
        writer
            .write_record([
                table.name,
                table.qualified_name,
                table.catalog.unwrap_or_default(),
                table.schema.unwrap_or_default(),
                table.table_type.as_str().to_string(),
                table.columns.join(", "),
                table.source_name.unwrap_or_default(),
            ])
            .map_err(|err| ExportError::Csv(err.to_string()))?;
    }

    writer
        .into_inner()
        .map_err(|err| ExportError::Csv(err.to_string()))
}

fn export_column_mappings_csv(result: &AnalyzeResult) -> Result<Vec<u8>, ExportError> {
    let mappings = extract_column_mappings(result);
    let mut writer = WriterBuilder::new()
        .has_headers(true)
        .from_writer(Vec::new());

    writer
        .write_record([
            "Source Table",
            "Source Column",
            "Target Table",
            "Target Column",
            "Expression",
            "Edge Type",
        ])
        .map_err(|err| ExportError::Csv(err.to_string()))?;

    for mapping in mappings {
        writer
            .write_record([
                mapping.source_table,
                mapping.source_column,
                mapping.target_table,
                mapping.target_column,
                mapping.expression.unwrap_or_default(),
                mapping.edge_type,
            ])
            .map_err(|err| ExportError::Csv(err.to_string()))?;
    }

    writer
        .into_inner()
        .map_err(|err| ExportError::Csv(err.to_string()))
}

fn export_table_dependencies_csv(result: &AnalyzeResult) -> Result<Vec<u8>, ExportError> {
    let dependencies = extract_table_dependencies(result);
    let mut writer = WriterBuilder::new()
        .has_headers(true)
        .from_writer(Vec::new());

    writer
        .write_record(["Source Table", "Target Table"])
        .map_err(|err| ExportError::Csv(err.to_string()))?;

    for dependency in dependencies {
        writer
            .write_record([dependency.source_table, dependency.target_table])
            .map_err(|err| ExportError::Csv(err.to_string()))?;
    }

    writer
        .into_inner()
        .map_err(|err| ExportError::Csv(err.to_string()))
}

fn export_summary_csv(result: &AnalyzeResult) -> Result<Vec<u8>, ExportError> {
    let summary = &result.summary;
    let mut writer = WriterBuilder::new()
        .has_headers(true)
        .from_writer(Vec::new());

    writer
        .write_record(["Metric", "Value"])
        .map_err(|err| ExportError::Csv(err.to_string()))?;

    let metrics = [
        ("Total Statements", summary.statement_count.to_string()),
        ("Total Tables", summary.table_count.to_string()),
        ("Total Columns", summary.column_count.to_string()),
        ("Total Joins", summary.join_count.to_string()),
        ("Complexity Score", summary.complexity_score.to_string()),
        ("Errors", summary.issue_count.errors.to_string()),
        ("Warnings", summary.issue_count.warnings.to_string()),
        ("Info", summary.issue_count.infos.to_string()),
    ];

    for (metric, value) in metrics {
        writer
            .write_record([metric, &value])
            .map_err(|err| ExportError::Csv(err.to_string()))?;
    }

    writer
        .into_inner()
        .map_err(|err| ExportError::Csv(err.to_string()))
}

fn export_issues_csv(result: &AnalyzeResult) -> Result<Vec<u8>, ExportError> {
    let mut writer = WriterBuilder::new()
        .has_headers(true)
        .from_writer(Vec::new());

    writer
        .write_record([
            "Severity",
            "Code",
            "Message",
            "Statement",
            "Span Start",
            "Span End",
        ])
        .map_err(|err| ExportError::Csv(err.to_string()))?;

    for issue in &result.issues {
        let statement = issue
            .statement_index
            .map(|idx| idx.to_string())
            .unwrap_or_default();
        let (start, end) = issue
            .span
            .map(|span| (span.start.to_string(), span.end.to_string()))
            .unwrap_or_default();

        writer
            .write_record([
                format!("{:?}", issue.severity).to_lowercase(),
                issue.code.clone(),
                issue.message.clone(),
                statement,
                start,
                end,
            ])
            .map_err(|err| ExportError::Csv(err.to_string()))?;
    }

    writer
        .into_inner()
        .map_err(|err| ExportError::Csv(err.to_string()))
}

fn export_schema_csv(result: &AnalyzeResult) -> Result<Vec<u8>, ExportError> {
    let mut writer = WriterBuilder::new()
        .has_headers(true)
        .from_writer(Vec::new());

    writer
        .write_record([
            "Catalog",
            "Schema",
            "Table",
            "Column",
            "Data Type",
            "Origin",
            "Primary Key",
            "Foreign Key",
        ])
        .map_err(|err| ExportError::Csv(err.to_string()))?;

    if let Some(resolved_schema) = &result.resolved_schema {
        for table in &resolved_schema.tables {
            let origin = match table.origin {
                SchemaOrigin::Imported => "imported",
                SchemaOrigin::Implied => "implied",
            };

            let mut column_names = BTreeSet::new();
            for column in &table.columns {
                if column_names.insert(column.name.clone()) {
                    let fk = column
                        .foreign_key
                        .as_ref()
                        .map(|fk| format!("{}.{}", fk.table, fk.column));

                    writer
                        .write_record([
                            table.catalog.clone().unwrap_or_default(),
                            table.schema.clone().unwrap_or_default(),
                            table.name.clone(),
                            column.name.clone(),
                            column.data_type.clone().unwrap_or_default(),
                            origin.to_string(),
                            column
                                .is_primary_key
                                .map(|value| value.to_string())
                                .unwrap_or_default(),
                            fk.unwrap_or_default(),
                        ])
                        .map_err(|err| ExportError::Csv(err.to_string()))?;
                }
            }
        }
    }

    writer
        .into_inner()
        .map_err(|err| ExportError::Csv(err.to_string()))
}

fn export_lineage_csv(result: &AnalyzeResult) -> Result<Vec<u8>, ExportError> {
    let entries = extract_lineage_entries(result);
    let mut writer = WriterBuilder::new()
        .has_headers(true)
        .from_writer(Vec::new());

    writer
        .write_record(["Script", "Input Tables", "Output Table"])
        .map_err(|err| ExportError::Csv(err.to_string()))?;

    for entry in entries {
        writer
            .write_record([entry.script, entry.input_table, entry.output_table])
            .map_err(|err| ExportError::Csv(err.to_string()))?;
    }

    writer
        .into_inner()
        .map_err(|err| ExportError::Csv(err.to_string()))
}
