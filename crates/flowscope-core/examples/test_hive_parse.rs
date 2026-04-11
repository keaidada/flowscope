use sqlparser::dialect::HiveDialect;
use sqlparser::parser::Parser;

fn main() {
    let sql = r#"
WITH u1 AS (SELECT uid cpid FROM his_db.ctv_user WHERE imp_date='2024')
INSERT OVERWRITE TABLE sum_db.b10_info_cpid PARTITION(data_dt='2024')
SELECT u1.cpid FROM u1;
"#;

    println!("=== Test 1: Hive WITH ... INSERT OVERWRITE ===");
    let dialect = HiveDialect {};
    match Parser::parse_sql(&dialect, sql) {
        Ok(stmts) => {
            println!("Parsed {} statement(s)", stmts.len());
            for (i, stmt) in stmts.iter().enumerate() {
                println!("\nStatement {}: {:#?}", i, stmt);
            }
        }
        Err(e) => println!("PARSE ERROR: {}", e),
    }

    // Also test standard INSERT ... WITH format for comparison
    let sql2 = r#"
INSERT OVERWRITE TABLE sum_db.b10_info_cpid PARTITION(data_dt='2024')
WITH u1 AS (SELECT uid cpid FROM his_db.ctv_user WHERE imp_date='2024')
SELECT u1.cpid FROM u1;
"#;
    println!("\n=== Test 2: INSERT ... WITH (standard) ===");
    match Parser::parse_sql(&dialect, sql2) {
        Ok(stmts) => {
            println!("Parsed {} statement(s)", stmts.len());
            for (i, stmt) in stmts.iter().enumerate() {
                println!("\nStatement {}: {:#?}", i, stmt);
            }
        }
        Err(e) => println!("PARSE ERROR: {}", e),
    }

    // Test 3: INSERT with subquery wrapping CTE
    let sql3 = r#"
INSERT OVERWRITE TABLE sum_db.b10_info_cpid PARTITION(data_dt='2024')
SELECT u1.cpid FROM (SELECT uid cpid FROM his_db.ctv_user WHERE imp_date='2024') u1;
"#;
    println!("\n=== Test 3: INSERT with subquery ===");
    match Parser::parse_sql(&dialect, sql3) {
        Ok(stmts) => {
            println!("Parsed {} statement(s)", stmts.len());
        }
        Err(e) => println!("PARSE ERROR: {}", e),
    }
}
