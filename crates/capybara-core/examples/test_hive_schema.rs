use capybara_core::{analyze, AnalyzeRequest, Dialect};
use std::fs;

fn main() {
    let sql = fs::read_to_string("/Users/liwei/work/study/web/sql-to-er/bloodline-app/data/ysp_dw-master/etl/SUM_公共汇总库/B10_INFO_CPID.HQL").unwrap();

    let req = AnalyzeRequest {
        sql,
        files: None,
        dialect: Dialect::Hive,
        source_name: None,
        options: None,
        schema: None,
        template_config: None,
    };

    let result = analyze(&req);

    println!("=== Resolved Schema ===");
    if let Some(schema) = &result.resolved_schema {
        println!("Tables: {}", schema.tables.len());
        for table in &schema.tables {
            let full_name = if let Some(s) = &table.schema {
                format!("{}.{}", s, table.name)
            } else {
                table.name.clone()
            };
            println!(
                "\n  {} (origin: {:?}, columns: {})",
                full_name,
                table.origin,
                table.columns.len()
            );
            for col in &table.columns {
                println!("    - {} ({:?})", col.name, col.data_type);
            }
        }
    } else {
        println!("No resolved schema!");
    }
}
