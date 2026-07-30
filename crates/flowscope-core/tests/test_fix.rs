#[test]
fn test() {
    let sql = std::fs::read_to_string("/tmp/wf_imei.sql").unwrap();
    if let Some(out) = flowscope_core::parser::sanitize_bigquery_raw_double_quoted_literals(&sql) {
        eprintln!("Lines: {}", out.lines().count());
        // Show lines around the ;
        for (i, line) in out.lines().enumerate() {
            if i >= 28 && i <= 35 { eprintln!("{i}: {line}"); }
        }
    }
}
