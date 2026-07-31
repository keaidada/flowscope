use capybara_core::parser;
#[test]
fn test_ck() {
    let sql = std::fs::read_to_string("/tmp/new_query.sql").unwrap();
    if let Some(out) = parser::sanitize_bigquery_raw_double_quoted_literals(&sql) {
        // Find the temp_loyalty_segment CREATE TABLE in output
        for (i, line) in out.lines().enumerate() {
            if line.to_uppercase().contains("LOYALTY") {
                println!("{}: {}", i, line);
            }
        }
        let loyalty_lines: Vec<_> = out.lines().filter(|l| l.to_uppercase().contains("LOYALTY")).collect();
        println!("\nloyalty lines found: {}", loyalty_lines.len());
        if loyalty_lines.is_empty() {
            // Check if CREATE TABLE loyalty is there at all
            let ct = out.find("loyalty");
            println!("loyalty in output: {:?}", ct);
            // Check if CREATE OR REPLACE TEMP TABLE appears
            println!("CREATE OR REPLACE count: {}", out.to_uppercase().matches("CREATE OR REPLACE TEMP TABLE").count());
        }
    }
}
