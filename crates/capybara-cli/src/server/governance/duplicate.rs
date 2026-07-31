//! Duplicate detection: find scripts with identical or similar computation patterns.

use std::collections::HashMap;

use super::contract::SeverityDef;
use super::fingerprint::{fingerprint_sql, jaccard_similarity, Fingerprint};
use super::{ContractViolation, Severity};

/// Detect duplicates among a set of file fingerprints.
pub fn detect_duplicates(
    fingerprints: &[Fingerprint],
) -> (Vec<ContractViolation>, Vec<DuplicateGroup>) {
    let mut violations = Vec::new();
    let mut groups = Vec::new();

    // 1. Exact fingerprint duplicates
    let mut hash_groups: HashMap<&str, Vec<&Fingerprint>> = HashMap::new();
    for fp in fingerprints {
        hash_groups.entry(fp.canonical_hash.as_str()).or_default().push(fp);
    }

    for (hash, fps) in &hash_groups {
        if fps.len() > 1 {
            let scripts: Vec<String> = fps.iter().map(|f| f.file_path.clone()).collect();
            let normalized = fps[0].normalized_sql.clone();

            groups.push(DuplicateGroup {
                group_type: "exact_fingerprint".to_string(),
                similarity: 1.0,
                scripts: scripts.clone(),
                normalized_sql: normalized.clone(),
                recommendation: "建议合并为一个通用 ETL，用参数区分目标表".to_string(),
            });

            violations.push(ContractViolation {
                contract_id: "auto".to_string(),
                contract_name: "auto".to_string(),
                rule_id: "no_duplicate_computation".to_string(),
                rule_section: "metric_rules".to_string(),
                severity: Severity::P1,
                title: format!("重复计算检测: {} 个脚本计算逻辑相同", fps.len()),
                detail: serde_json::json!({
                    "hash": hash,
                    "scripts": scripts,
                    "normalized_sql": normalized,
                }),
                file_paths: scripts,
            });
        }
    }

    // 2. Similar (not exact) fingerprints — Jaccard similarity
    let fps_vec: Vec<&Fingerprint> = fingerprints.iter().collect();
    for i in 0..fps_vec.len() {
        for j in (i + 1)..fps_vec.len() {
            if fps_vec[i].canonical_hash == fps_vec[j].canonical_hash {
                continue; // Already caught as exact duplicate
            }
            let sim = jaccard_similarity(
                &fps_vec[i].structured_tokens,
                &fps_vec[j].structured_tokens,
            );
            if sim > 0.85 {
                let scripts = vec![
                    fps_vec[i].file_path.clone(),
                    fps_vec[j].file_path.clone(),
                ];
                groups.push(DuplicateGroup {
                    group_type: "similar".to_string(),
                    similarity: sim,
                    scripts: scripts.clone(),
                    normalized_sql: fps_vec[i].normalized_sql.clone(),
                    recommendation: "计算逻辑高度相似，建议检查是否可合并".to_string(),
                });

                violations.push(ContractViolation {
                    contract_id: "auto".to_string(),
                    contract_name: "auto".to_string(),
                    rule_id: "no_duplicate_computation".to_string(),
                    rule_section: "metric_rules".to_string(),
                    severity: Severity::P2,
                    title: format!(
                        "逻辑相似检测: {} ≈ {} (相似度 {:.0}%)",
                        fps_vec[i].file_path, fps_vec[j].file_path, sim * 100.0
                    ),
                    detail: serde_json::json!({
                        "similarity": sim,
                        "scripts": scripts,
                    }),
                    file_paths: scripts,
                });
            }
        }
    }

    (violations, groups)
}

/// Detect write conflicts: multiple scripts writing to the same table.
/// Skips editor scratchpad, temp tables, and sync tables.
pub fn detect_write_conflicts(
    table_writes: &[(String, String)], // (file_path, table_name)
) -> Vec<ContractViolation> {
    let mut table_groups: HashMap<&str, Vec<&str>> = HashMap::new();
    for (file, table) in table_writes {
        if should_skip_write_conflict(table, file) {
            continue;
        }
        table_groups
            .entry(table.as_str())
            .or_default()
            .push(file.as_str());
    }

    let mut violations = Vec::new();
    for (table, files) in &table_groups {
        // Deduplicate scripts
        let mut unique_files: Vec<&str> = files.iter().copied().collect();
        unique_files.sort();
        unique_files.dedup();
        if unique_files.len() > 1 {
            violations.push(ContractViolation {
                contract_id: "auto".to_string(),
                contract_name: "auto".to_string(),
                rule_id: "no_write_conflict".to_string(),
                rule_section: "metric_rules".to_string(),
                severity: Severity::P2,
                title: format!("写入冲突: {} 个脚本写入表 {}", unique_files.len(), table),
                detail: serde_json::json!({
                    "table": table,
                    "total_writes": files.len(),
                    "unique_scripts": unique_files.len(),
                    "scripts": unique_files,
                }),
                file_paths: unique_files.iter().map(|s| s.to_string()).collect(),
            });
        }
    }
    violations
}

/// Skip editor scratchpads, temp tables, and sync database tables.
fn should_skip_write_conflict(table_name: &str, script: &str) -> bool {
    if script == "scratchpad.sql" || script.is_empty() {
        return true;
    }
    let lower = table_name.to_lowercase();
    lower.contains("_tmp") || lower.contains("_temp") || lower.starts_with("syncdb.")
}

/// Detect orphan outputs: tables written but never read by any downstream.
pub fn detect_orphan_outputs(
    written_tables: &[String],
    read_tables: &[String],
) -> Vec<ContractViolation> {
    let read_set: std::collections::HashSet<&str> =
        read_tables.iter().map(|s| s.as_str()).collect();

    let orphans: Vec<&str> = written_tables
        .iter()
        .map(|s| s.as_str())
        .filter(|t| !read_set.contains(*t))
        .collect();

    let mut violations = Vec::new();
    if !orphans.is_empty() {
        violations.push(ContractViolation {
            contract_id: "auto".to_string(),
            contract_name: "auto".to_string(),
            rule_id: "no_orphan_output".to_string(),
            rule_section: "lineage_rules".to_string(),
            severity: Severity::P2,
            title: format!("孤儿产出检测: {} 个表无下游消费", orphans.len()),
            detail: serde_json::json!({ "orphan_tables": orphans }),
            file_paths: vec![],
        });
    }
    violations
}

/// A group of duplicate/similar scripts.
#[derive(Debug, Clone, serde::Serialize)]
pub struct DuplicateGroup {
    pub group_type: String,
    pub similarity: f64,
    pub scripts: Vec<String>,
    pub normalized_sql: String,
    pub recommendation: String,
}

// Re-export for convenience
impl From<SeverityDef> for Severity {
    fn from(s: SeverityDef) -> Self {
        s.to_severity()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_exact_duplicate_detection() {
        let sql = "INSERT INTO t1 SELECT SUM(a) FROM t2";
        let (hash, norm, tokens) = fingerprint_sql(sql);
        let fps = vec![
            Fingerprint { file_path: "a.sql".into(), canonical_hash: hash.clone(), normalized_sql: norm.clone(), structured_tokens: tokens.clone() },
            Fingerprint { file_path: "b.sql".into(), canonical_hash: hash.clone(), normalized_sql: norm.clone(), structured_tokens: tokens.clone() },
        ];
        let (violations, groups) = detect_duplicates(&fps);
        assert_eq!(violations.len(), 1);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].group_type, "exact_fingerprint");
    }

    #[test]
    fn test_no_duplicate() {
        let (h1, n1, t1) = fingerprint_sql("SELECT a FROM t");
        let (h2, n2, t2) = fingerprint_sql("DELETE FROM t WHERE x = 1");
        let fps = vec![
            Fingerprint { file_path: "a.sql".into(), canonical_hash: h1, normalized_sql: n1, structured_tokens: t1 },
            Fingerprint { file_path: "b.sql".into(), canonical_hash: h2, normalized_sql: n2, structured_tokens: t2 },
        ];
        let (violations, _) = detect_duplicates(&fps);
        assert_eq!(violations.len(), 0);
    }

    #[test]
    fn test_write_conflict() {
        let writes = vec![
            ("a.sql".to_string(), "dws_gmv".to_string()),
            ("b.sql".to_string(), "dws_gmv".to_string()),
        ];
        let vs = detect_write_conflicts(&writes);
        assert_eq!(vs.len(), 1);
    }

    #[test]
    fn test_write_conflict_skips_temp() {
        let writes = vec![
            ("a.sql".to_string(), "dws_gmv_tmp".to_string()),
            ("b.sql".to_string(), "dws_gmv_tmp".to_string()),
            ("c.sql".to_string(), "syncdb.data_temp".to_string()),
            ("d.sql".to_string(), "syncdb.data_temp".to_string()),
        ];
        let vs = detect_write_conflicts(&writes);
        assert_eq!(vs.len(), 0, "Temp tables should be skipped");
    }

    #[test]
    fn test_orphan_output() {
        let written = vec!["table_a".to_string(), "table_b".to_string()];
        let read = vec!["table_a".to_string()];
        let vs = detect_orphan_outputs(&written, &read);
        assert_eq!(vs.len(), 1);
    }
}
