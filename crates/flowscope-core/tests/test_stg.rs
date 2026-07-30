use flowscope_core::parser;
#[test]
fn test() {
    let sql = std::fs::read_to_string("/tmp/fnc_stg_big.sql").unwrap();
    if let Some((dml, map)) = parser::sanitize_with_line_map(&sql) {
        let dml_lines: Vec<_> = dml.lines().collect();
        let mut d2o = vec![-1i32; dml_lines.len()];
        for (oi, &di) in map.iter().enumerate() { if di >= 0 { d2o[di as usize] = oi as i32; } }
        eprintln!("Unmatched DML lines:");
        let mut c = 0;
        for (di, &oi) in d2o.iter().enumerate() {
            if oi < 0 && c < 10 {
                eprintln!("  dml[{}]: '{}'", di, dml_lines[di].trim());
                c += 1;
            }
        }
    }
}
