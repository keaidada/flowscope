use rust_xlsxwriter::{Workbook, Worksheet};

use crate::extract::{
    extract_column_mappings, extract_lineage_entries, extract_script_info,
    extract_table_dependencies, extract_table_info,
};
use crate::ExportError;
use crate::csv::ExportSheet;
use capybara_core::AnalyzeResult;
use std::collections::{BTreeSet, HashMap};

const XLSX_MAX_ROWS: usize = 1_048_576;
const XLSX_MAX_COLUMNS: usize = 16_384;

pub fn export_xlsx(
    result: &AnalyzeResult,
    sheets: Option<&[ExportSheet]>,
) -> Result<Vec<u8>, ExportError> {
    let should_include = |s: ExportSheet| -> bool {
        sheets.map_or(true, |filter| filter.contains(&s))
    };

    let mut workbook = Workbook::new();

    if should_include(ExportSheet::Scripts) {
        let scripts_sheet = workbook.add_worksheet();
        scripts_sheet
            .set_name("Scripts")
            .map_err(|err| ExportError::Xlsx(err.to_string()))?;
        write_scripts_sheet(scripts_sheet, result)?;
    }

    if should_include(ExportSheet::Tables) {
        let tables_sheet = workbook.add_worksheet();
        tables_sheet
            .set_name("Tables")
            .map_err(|err| ExportError::Xlsx(err.to_string()))?;
        write_tables_sheet(tables_sheet, result)?;
    }

    if should_include(ExportSheet::ColumnMappings) {
        let mappings_sheet = workbook.add_worksheet();
        mappings_sheet
            .set_name("Column Mappings")
            .map_err(|err| ExportError::Xlsx(err.to_string()))?;
        write_mappings_sheet(mappings_sheet, result)?;
    }

    if should_include(ExportSheet::TableDependencies) {
        let dep_sheet = workbook.add_worksheet();
        dep_sheet
            .set_name("Dependency Matrix")
            .map_err(|err| ExportError::Xlsx(err.to_string()))?;
        write_dependency_matrix_sheet(dep_sheet, result)?;
    }

    if should_include(ExportSheet::Lineage) {
        let lineage_sheet = workbook.add_worksheet();
        lineage_sheet
            .set_name("Lineage")
            .map_err(|err| ExportError::Xlsx(err.to_string()))?;
        write_lineage_sheet(lineage_sheet, result)?;
    }

    if should_include(ExportSheet::Summary) {
        let summary_sheet = workbook.add_worksheet();
        summary_sheet
            .set_name("Summary")
            .map_err(|err| ExportError::Xlsx(err.to_string()))?;
        write_summary_sheet(summary_sheet, result)?;
    }

    workbook
        .save_to_buffer()
        .map_err(|err| ExportError::Xlsx(err.to_string()))
}

fn write_scripts_sheet(sheet: &mut Worksheet, result: &AnalyzeResult) -> Result<(), ExportError> {
    let scripts = extract_script_info(result);
    write_row(
        sheet,
        0,
        &[
            "Script Name",
            "Statement Count",
            "Tables Read",
            "Tables Written",
        ],
    )?;

    for (index, script) in scripts.iter().enumerate() {
        let row = (index + 1) as u32;
        write_row(
            sheet,
            row,
            &[
                &sanitize_xlsx_value(&script.source_name),
                &script.statement_count.to_string(),
                &sanitize_xlsx_value(&script.tables_read.join(", ")),
                &sanitize_xlsx_value(&script.tables_written.join(", ")),
            ],
        )?;
    }

    Ok(())
}

fn write_tables_sheet(sheet: &mut Worksheet, result: &AnalyzeResult) -> Result<(), ExportError> {
    let tables = extract_table_info(result);
    write_row(
        sheet,
        0,
        &[
            "Table Name",
            "Qualified Name",
            "Catalog",
            "Schema",
            "Type",
            "Columns",
            "Source",
        ],
    )?;

    for (index, table) in tables.iter().enumerate() {
        let row = (index + 1) as u32;
        write_row(
            sheet,
            row,
            &[
                &sanitize_xlsx_value(&table.name),
                &sanitize_xlsx_value(&table.qualified_name),
                &sanitize_xlsx_value(table.catalog.as_deref().unwrap_or("")),
                &sanitize_xlsx_value(table.schema.as_deref().unwrap_or("")),
                table.table_type.as_str(),
                &sanitize_xlsx_value(&table.columns.join(", ")),
                &sanitize_xlsx_value(table.source_name.as_deref().unwrap_or("")),
            ],
        )?;
    }

    Ok(())
}

fn write_mappings_sheet(sheet: &mut Worksheet, result: &AnalyzeResult) -> Result<(), ExportError> {
    let mappings = extract_column_mappings(result);
    write_row(
        sheet,
        0,
        &[
            "Source Table",
            "Source Column",
            "Target Table",
            "Target Column",
            "Expression",
            "Edge Type",
        ],
    )?;

    for (index, mapping) in mappings.iter().enumerate() {
        let row = (index + 1) as u32;
        write_row(
            sheet,
            row,
            &[
                &sanitize_xlsx_value(&mapping.source_table),
                &sanitize_xlsx_value(&mapping.source_column),
                &sanitize_xlsx_value(&mapping.target_table),
                &sanitize_xlsx_value(&mapping.target_column),
                &sanitize_xlsx_value(mapping.expression.as_deref().unwrap_or("")),
                &mapping.edge_type,
            ],
        )?;
    }

    Ok(())
}

fn write_summary_sheet(sheet: &mut Worksheet, result: &AnalyzeResult) -> Result<(), ExportError> {
    let summary = &result.summary;
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

    write_row(sheet, 0, &["Metric", "Value"])?;

    for (index, (metric, value)) in metrics.iter().enumerate() {
        let row = (index + 1) as u32;
        write_row(sheet, row, &[metric, value])?;
    }

    Ok(())
}

fn write_dependency_matrix_sheet(
    sheet: &mut Worksheet,
    result: &AnalyzeResult,
) -> Result<(), ExportError> {
    let dependencies = extract_table_dependencies(result);
    let mut tables = BTreeSet::new();
    let mut dep_set = HashMap::new();

    for dep in &dependencies {
        tables.insert(dep.source_table.clone());
        tables.insert(dep.target_table.clone());
        dep_set.insert(format!("{}->{}", dep.source_table, dep.target_table), true);
    }

    let table_list: Vec<String> = tables.into_iter().collect();

    if should_use_dependency_edge_list(table_list.len()) {
        return write_dependency_edge_list_sheet(sheet, &dependencies);
    }

    let mut header = vec![String::new()];
    header.extend(table_list.iter().map(|table| sanitize_xlsx_value(table)));
    write_row(
        sheet,
        0,
        &header
            .iter()
            .map(|value| value.as_str())
            .collect::<Vec<_>>(),
    )?;

    for (row_index, row_table) in table_list.iter().enumerate() {
        let mut row = vec![sanitize_xlsx_value(row_table)];
        for col_table in &table_list {
            let value = if row_table == col_table {
                "-".to_string()
            } else if dep_set.contains_key(&format!("{}->{}", row_table, col_table)) {
                "w".to_string()
            } else if dep_set.contains_key(&format!("{}->{}", col_table, row_table)) {
                "r".to_string()
            } else {
                String::new()
            };
            row.push(value);
        }
        let row_values: Vec<&str> = row.iter().map(|value| value.as_str()).collect();
        write_row(sheet, (row_index + 1) as u32, &row_values)?;
    }

    let legend_start = (table_list.len() + 2) as u32;
    write_row(sheet, legend_start, &["Legend:"])?;
    write_row(
        sheet,
        legend_start + 1,
        &["w", "Row table writes to column table"],
    )?;
    write_row(
        sheet,
        legend_start + 2,
        &["r", "Row table reads from column table"],
    )?;
    write_row(sheet, legend_start + 3, &["-", "Self (same table)"])?;

    Ok(())
}

fn should_use_dependency_edge_list(table_count: usize) -> bool {
    let required_columns = table_count.saturating_add(1);
    let required_rows = table_count.saturating_add(4);
    required_columns > XLSX_MAX_COLUMNS || required_rows > XLSX_MAX_ROWS
}

fn write_dependency_edge_list_sheet(
    sheet: &mut Worksheet,
    dependencies: &[crate::extract::TableDependency],
) -> Result<(), ExportError> {
    write_row(
        sheet,
        0,
        &[
            "Dependency Matrix fallback",
            "Exported as an edge list because the full matrix exceeds Excel sheet limits",
        ],
    )?;
    write_row(sheet, 2, &["Source Table", "Target Table"])?;

    for (index, dependency) in dependencies.iter().enumerate() {
        let row = (index + 3) as u32;
        write_row(
            sheet,
            row,
            &[
                &sanitize_xlsx_value(&dependency.source_table),
                &sanitize_xlsx_value(&dependency.target_table),
            ],
        )?;
    }

    Ok(())
}

fn write_row(sheet: &mut Worksheet, row: u32, values: &[&str]) -> Result<(), ExportError> {
    for (col, value) in values.iter().enumerate() {
        sheet
            .write_string(row, col as u16, *value)
            .map_err(|err| ExportError::Xlsx(err.to_string()))?;
    }
    Ok(())
}

fn sanitize_xlsx_value(value: &str) -> String {
    if value.is_empty() {
        return String::new();
    }
    let first = value.chars().next().unwrap_or_default();
    if first == '=' || first == '+' || first == '-' || first == '@' {
        format!("'{}", value)
    } else {
        value.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::should_use_dependency_edge_list;

    #[test]
    fn dependency_matrix_uses_edge_list_when_excel_limits_would_be_exceeded() {
        assert!(!should_use_dependency_edge_list(16_383));
        assert!(should_use_dependency_edge_list(16_384));
    }
}

fn write_lineage_sheet(
    sheet: &mut Worksheet,
    result: &AnalyzeResult,
) -> Result<(), ExportError> {
    write_row(sheet, 0, &["Script", "Input Tables", "Output Table"])?;

    let entries = extract_lineage_entries(result);
    for (index, entry) in entries.iter().enumerate() {
        let row = (index + 1) as u32;
        write_row(
            sheet,
            row,
            &[
                &sanitize_xlsx_value(&entry.script),
                &sanitize_xlsx_value(&entry.input_table),
                &sanitize_xlsx_value(&entry.output_table),
            ],
        )?;
    }

    Ok(())
}
