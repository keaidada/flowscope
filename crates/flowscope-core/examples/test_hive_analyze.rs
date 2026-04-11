use flowscope_core::{analyze, AnalyzeRequest, Dialect};
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
    println!("statements: {}", result.statements.len());
    for (i, s) in result.statements.iter().enumerate() {
        println!("\n--- Statement {} (type: {}) ---", i, s.statement_type);
        // Only show non-column nodes
        let table_nodes: Vec<_> = s
            .nodes
            .iter()
            .filter(|n| n.node_type != flowscope_core::NodeType::Column)
            .collect();
        println!("  table/cte/output nodes: {}", table_nodes.len());
        for n in &table_nodes {
            println!("    {:?} {} (id: {})", n.node_type, n.label, n.id);
        }
        // Only show table-level edges
        let table_ids: std::collections::HashSet<_> = table_nodes.iter().map(|n| &n.id).collect();
        let table_edges: Vec<_> = s
            .edges
            .iter()
            .filter(|e| table_ids.contains(&e.from) && table_ids.contains(&e.to))
            .collect();
        println!("  table-level edges: {}", table_edges.len());
        for e in &table_edges {
            let from = table_nodes
                .iter()
                .find(|n| n.id == e.from)
                .map(|n| n.label.as_ref())
                .unwrap_or(&e.from);
            let to = table_nodes
                .iter()
                .find(|n| n.id == e.to)
                .map(|n| n.label.as_ref())
                .unwrap_or(&e.to);
            println!("    {} -> {}", from, to);
        }
    }
    println!("\nissues:");
    for i in &result.issues {
        println!("  [{}] {}", i.code, i.message);
    }
}
