use sqlparser::dialect::{HiveDialect, DatabricksDialect, GenericDialect};
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

    // Test 4: User's Spark SQL with ELEMENT_AT, SPLIT, TRY_CAST (Hive)
    let sql4 = r#"INSERT OVERWRITE TABLE smartfren_analytic_prd.rinjani.dim_btsweb_mapping
WITH cgi_data AS (
  SELECT date_id,
    cgi AS cgi,
    trim(tower_id) AS tower_id,
    ELEMENT_AT(SPLIT(cgi, '-'), 1) AS mcc,
    ELEMENT_AT(SPLIT(cgi, '-'), 2) AS mnc,
    ELEMENT_AT(SPLIT(cgi, '-'), 3) AS enode_b,
    ELEMENT_AT(SPLIT(cgi, '-'), 4) AS cell_id
  FROM smartfren_analytic_prd.ods_cc.prd_xldim_acl_tb_f_d_bts_ref_hist
  WHERE date_id BETWEEN (SELECT max(date_id) - 5 FROM smartfren_analytic_prd.ods_cc.prd_xldim_acl_tb_f_d_bts_ref_hist)
        AND (SELECT max(date_id) FROM smartfren_analytic_prd.ods_cc.prd_xldim_acl_tb_f_d_bts_ref_hist)
        AND length(ELEMENT_AT(SPLIT(cgi, '-'), 4)) <= 3
)
SELECT cgi, tower_id FROM cgi_data;"#;
    println!("\n=== Test 4: User Spark SQL with ELEMENT_AT/SPLIT/subquery-WHERE (Hive) ===");
    match Parser::parse_sql(&dialect, sql4) {
        Ok(stmts) => println!("Hive: {} statement(s) parsed", stmts.len()),
        Err(e) => println!("Hive PARSE ERROR: {}", e),
    }

    // Test 5: Same with Databricks
    println!("\n=== Test 5: User Spark SQL (Databricks) ===");
    let db = DatabricksDialect {};
    match Parser::parse_sql(&db, sql4) {
        Ok(stmts) => println!("Databricks: {} statement(s) parsed", stmts.len()),
        Err(e) => println!("Databricks PARSE ERROR: {}", e),
    }

    // Test 6: Same with Generic
    println!("\n=== Test 6: User Spark SQL (Generic) ===");
    let gen = GenericDialect {};
    match Parser::parse_sql(&gen, sql4) {
        Ok(stmts) => println!("Generic: {} statement(s) parsed", stmts.len()),
        Err(e) => println!("Generic PARSE ERROR: {}", e),
    }

    // Test 7: Simple ELEMENT_AT
    println!("\n=== Test 7: Simple ELEMENT_AT (Hive) ===");
    let sql7 = "SELECT ELEMENT_AT(SPLIT(cgi, '-'), 1) AS mcc FROM src;";
    match Parser::parse_sql(&dialect, sql7) {
        Ok(stmts) => println!("Hive: {} statement(s) parsed", stmts.len()),
        Err(e) => println!("Hive PARSE ERROR: {}", e),
    }

    // Test 8: TRY_CAST
    println!("\n=== Test 8: TRY_CAST (Hive) ===");
    let sql8 = "SELECT TRY_CAST(cgi AS BIGINT) FROM src;";
    match Parser::parse_sql(&dialect, sql8) {
        Ok(stmts) => println!("Hive: {} statement(s) parsed", stmts.len()),
        Err(e) => println!("Hive PARSE ERROR: {}", e),
    }

    // Test 9: CONV
    println!("\n=== Test 9: CONV (Hive) ===");
    let sql9 = "SELECT CONV('FF', 16, 10) FROM src;";
    match Parser::parse_sql(&dialect, sql9) {
        Ok(stmts) => println!("Hive: {} statement(s) parsed", stmts.len()),
        Err(e) => println!("Hive PARSE ERROR: {}", e),
    }

    // Test 10: INSERT OVERWRITE TABLE ... WITH (reverse order, user's pattern)
    println!("\n=== Test 10: INSERT OVERWRITE TABLE ... WITH (reverse, Hive) ===");
    let sql10 = "INSERT OVERWRITE TABLE tgt WITH u AS (SELECT uid FROM src) SELECT uid FROM u;";
    match Parser::parse_sql(&dialect, sql10) {
        Ok(stmts) => println!("Hive: {} statement(s) parsed", stmts.len()),
        Err(e) => println!("Hive PARSE ERROR: {}", e),
    }
}
