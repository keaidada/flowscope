use flowscope_core::parser;
#[test]
fn test() {
    for (n,p) in [("calc","/tmp/test_calc.sql"),("training","/tmp/fnc_re_training_data.sql"),("newq","/tmp/new_query.sql")] {
        let sql = std::fs::read_to_string(p).unwrap_or_default();
        if sql.is_empty() { continue; }
        if let Some((dml,map)) = parser::sanitize_with_line_map(&sql) {
            let m = map.iter().filter(|&&x| x>=0).count();
            println!("{n}: DML={}, mapped={}/{}", dml.lines().count(), m, map.len());
        }
    }
}
