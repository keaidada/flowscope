//! Contract evaluation engine.
//!
//! Evaluates SQL analysis results and lineage data against ODCS contracts.
//! Produces contract violations for each rule that is not satisfied.

use std::collections::HashSet;

use capybara_core::AnalyzeResult;

use super::contract::{Contract, FlowScopeRules, LineageRule};
use super::contract_generator::{generate_models, GenerationInput, TableModel};
use super::duplicate::{detect_duplicates, detect_orphan_outputs, detect_write_conflicts};
use super::fingerprint::{fingerprint_sql, Fingerprint};
use super::{ContractViolation, PendingRuntimeCheck, Severity};

/// Input data needed for contract evaluation.
pub struct GovernanceContext<'a> {
    pub project_id: &'a str,
    /// (file_path, AnalyzeResult) pairs — from project_file_results
    pub file_results: &'a [(String, AnalyzeResult)],
    /// (file_path, raw_sql_content) pairs — from project_files for fingerprinting
    pub file_contents: &'a [(String, String)],
    /// (from_table, to_table, script) — from table_level_edges
    pub table_edges: &'a [(String, String, String)],
    /// Generated models from lineage data
    pub models: &'a [TableModel],
}

/// Evaluate a single contract against the governance context.
pub fn evaluate_contract(
    contract: &Contract,
    ctx: &GovernanceContext,
) -> (Vec<ContractViolation>, Vec<PendingRuntimeCheck>) {
    let mut violations = Vec::new();
    let mut pending = Vec::new();

    // Evaluate standard ODCS sections
    evaluate_schema(contract, ctx, &mut violations);
    evaluate_quality(contract, &mut pending);
    evaluate_sla(contract, &mut pending);

    // Evaluate custom.flowscope rules
    if let Some(ref fs) = contract.custom {
        if let Some(ref rules) = fs.flowscope {
            evaluate_lineage_rules(contract, rules, ctx, &mut violations);
            evaluate_sql_rules(contract, rules, ctx, &mut violations);
            evaluate_metric_rules(contract, rules, ctx, &mut violations);
            evaluate_security_rules(contract, rules, ctx, &mut violations);
            evaluate_modeling_rules(contract, rules, &mut violations);
        }
    }

    (violations, pending)
}

/// Evaluate all contracts and return combined violations.
pub fn evaluate_all_contracts(
    contracts: &[Contract],
    ctx: &GovernanceContext,
) -> (Vec<ContractViolation>, Vec<PendingRuntimeCheck>) {
    let mut all_violations = Vec::new();
    let mut all_pending = Vec::new();

    for contract in contracts {
        let (vs, ps) = evaluate_contract(contract, ctx);
        all_violations.extend(vs);
        all_pending.extend(ps);
    }

    // Cross-contract checks: duplicates + orphans
    // Write conflicts are now model-aware (skip dimension/source tables)
    let (cross_vs, _) = run_cross_file_checks(ctx);
    for v in cross_vs {
        all_violations.push(ContractViolation {
            contract_id: "auto".to_string(),
            contract_name: "auto".to_string(),
            ..v
        });
    }

    (all_violations, all_pending)
}

// ============================================================
// Standard ODCS evaluation
// ============================================================

fn evaluate_schema(
    contract: &Contract,
    _ctx: &GovernanceContext,
    violations: &mut Vec<ContractViolation>,
) {
    // Schema validation: compare expected properties against actual SQL output.
    // For Tier 1, we only check that schema definitions exist.
    // Full column-level comparison will be added with model_registry in Tier 2.
    for schema_def in &contract.schema {
        if schema_def.properties.is_empty() {
            violations.push(ContractViolation {
                contract_id: contract.id.clone(),
                contract_name: contract.name.clone(),
                rule_id: "schema_completeness".to_string(),
                rule_section: "schema".to_string(),
                severity: Severity::P2,
                title: format!("模型 {} 缺少字段定义", schema_def.name),
                detail: serde_json::json!({
                    "table": schema_def.name,
                    "issue": "Schema has no properties defined"
                }),
                file_paths: vec![],
            });
        }
    }
}

fn evaluate_quality(contract: &Contract, pending: &mut Vec<PendingRuntimeCheck>) {
    for q in &contract.quality {
        pending.push(PendingRuntimeCheck {
            contract_id: contract.id.clone(),
            check_type: "quality".to_string(),
            description: q.description.clone(),
            query: q.query.clone(),
        });
    }
}

fn evaluate_sla(contract: &Contract, pending: &mut Vec<PendingRuntimeCheck>) {
    if let Some(ref sla) = contract.sla {
        if !sla.refresh_frequency.is_empty() {
            pending.push(PendingRuntimeCheck {
                contract_id: contract.id.clone(),
                check_type: "sla".to_string(),
                description: format!("SLA: 刷新频率 {}", sla.refresh_frequency),
                query: String::new(),
            });
        }
    }
}

// ============================================================
// custom.flowscope rule evaluation
// ============================================================

fn evaluate_lineage_rules(
    contract: &Contract,
    rules: &FlowScopeRules,
    ctx: &GovernanceContext,
    violations: &mut Vec<ContractViolation>,
) {
    for rule in &rules.lineage_rules {
        let sev = rule.severity.to_severity();

        match rule.id.as_str() {
            "no_orphan_output" => {
                let (written, read) = extract_table_io(ctx);
                let orphans = detect_orphan_outputs(&written, &read);
                for v in orphans {
                    violations.push(attach_contract(v, contract, &rule.id, "lineage_rules", sev));
                }
            }
            "lineage_completeness" => {
                // Check if any file has no lineage edges at all
                let files_with_edges: HashSet<&str> = ctx
                    .table_edges
                    .iter()
                    .map(|(_, _, s)| s.as_str())
                    .collect();
                for (file, result) in ctx.file_results {
                    if result.summary.table_count > 0 && !files_with_edges.contains(file.as_str()) {
                        violations.push(ContractViolation {
                            contract_id: contract.id.clone(),
                            contract_name: contract.name.clone(),
                            rule_id: rule.id.clone(),
                            rule_section: "lineage_rules".to_string(),
                            severity: sev,
                            title: format!("血缘断裂: {} 有表但无血缘关系", file),
                            detail: serde_json::json!({
                                "file": file,
                                "table_count": result.summary.table_count,
                            }),
                            file_paths: vec![file.clone()],
                        });
                    }
                }
            }
            _ => {
                // Check forbidden edges (cross-layer dependencies)
                if !rule.forbidden_edges.is_empty() {
                    check_forbidden_edges(contract, rule, ctx, violations);
                }
            }
        }
    }
}

fn check_forbidden_edges(
    contract: &Contract,
    rule: &LineageRule,
    ctx: &GovernanceContext,
    violations: &mut Vec<ContractViolation>,
) {
    let sev = rule.severity.to_severity();
    let forbidden: HashSet<(&str, &str)> = rule
        .forbidden_edges
        .iter()
        .map(|(a, b)| (a.as_str(), b.as_str()))
        .collect();

    for (from, to, script) in ctx.table_edges {
        let from_layer = infer_layer(from);
        let to_layer = infer_layer(to);
        if from_layer != to_layer && from_layer != "unknown" && to_layer != "unknown" {
            if forbidden.contains(&(from_layer, to_layer)) {
                violations.push(ContractViolation {
                    contract_id: contract.id.clone(),
                    contract_name: contract.name.clone(),
                    rule_id: rule.id.clone(),
                    rule_section: "lineage_rules".to_string(),
                    severity: sev,
                    title: format!(
                        "跨层依赖: {}({}) → {}({})",
                        from, from_layer, to, to_layer
                    ),
                    detail: serde_json::json!({
                        "from_table": from,
                        "from_layer": from_layer,
                        "to_table": to,
                        "to_layer": to_layer,
                        "script": script,
                    }),
                    file_paths: vec![script.clone()],
                });
            }
        }
    }
}

fn evaluate_sql_rules(
    contract: &Contract,
    rules: &FlowScopeRules,
    ctx: &GovernanceContext,
    violations: &mut Vec<ContractViolation>,
) {
    for rule in &rules.sql_rules {
        let sev = rule.severity.to_severity();

        for (file, result) in ctx.file_results {
            match rule.id.as_str() {
                "no_select_star" => {
                    if has_select_star(result) {
                        violations.push(ContractViolation {
                            contract_id: contract.id.clone(),
                            contract_name: contract.name.clone(),
                            rule_id: rule.id.clone(),
                            rule_section: "sql_rules".to_string(),
                            severity: sev,
                            title: format!("SELECT * 检测: {}", file),
                            detail: serde_json::json!({"file": file}),
                            file_paths: vec![file.clone()],
                        });
                    }
                }
                "no_update_without_where" => {
                    if has_update_without_where(result) {
                        violations.push(ContractViolation {
                            contract_id: contract.id.clone(),
                            contract_name: contract.name.clone(),
                            rule_id: rule.id.clone(),
                            rule_section: "sql_rules".to_string(),
                            severity: sev,
                            title: format!("无 WHERE 的危险操作: {}", file),
                            detail: serde_json::json!({"file": file}),
                            file_paths: vec![file.clone()],
                        });
                    }
                }
                "max_complexity" => {
                    let threshold = rule.threshold.unwrap_or(80) as u8;
                    let score = result.summary.complexity_score;
                    if score > threshold {
                        violations.push(ContractViolation {
                            contract_id: contract.id.clone(),
                            contract_name: contract.name.clone(),
                            rule_id: rule.id.clone(),
                            rule_section: "sql_rules".to_string(),
                            severity: sev,
                            title: format!(
                                "复杂度告警: {} (score={} > {})",
                                file, score, threshold
                            ),
                            detail: serde_json::json!({
                                "file": file,
                                "complexity_score": score,
                                "threshold": threshold,
                            }),
                            file_paths: vec![file.clone()],
                        });
                    }
                }
                _ => {}
            }
        }
    }
}

fn evaluate_metric_rules(
    contract: &Contract,
    rules: &FlowScopeRules,
    ctx: &GovernanceContext,
    violations: &mut Vec<ContractViolation>,
) {
    // Only run if there's a duplicate-related rule
    let has_dup_rule = rules
        .metric_rules
        .iter()
        .any(|r| r.id == "no_duplicate_computation");
    let has_conflict_rule = rules
        .metric_rules
        .iter()
        .any(|r| r.id == "no_write_conflict");

    if !has_dup_rule && !has_conflict_rule {
        return;
    }

    // Compute fingerprints and run cross-file checks
    let (dup_violations, _) = run_cross_file_checks(ctx);

    for v in dup_violations {
        // Attach contract info
        let rule_id = v.rule_id.clone();
        let should_report = rules.metric_rules.iter().any(|r| r.id == rule_id);
        if should_report {
            violations.push(ContractViolation {
                contract_id: contract.id.clone(),
                contract_name: contract.name.clone(),
                ..v
            });
        }
    }
}

fn evaluate_security_rules(
    contract: &Contract,
    rules: &FlowScopeRules,
    ctx: &GovernanceContext,
    violations: &mut Vec<ContractViolation>,
) {
    for rule in &rules.security_rules {
        let sev = rule.severity.to_severity();

        // Check raw SQL content for hardcoded secrets
        if rule.id == "no_hardcoded_secrets" && !rule.patterns.is_empty() {
            for (file, content) in ctx.file_contents {
                let content_lower = content.to_lowercase();
                for pattern in &rule.patterns {
                    let pattern_lower = pattern.to_lowercase();
                    // Look for pattern followed by = or : (e.g. password = 'xxx')
                    if content_lower.contains(&format!("{pattern_lower} ="))
                        || content_lower.contains(&format!("{pattern_lower}="))
                        || content_lower.contains(&format!("{pattern_lower}:"))
                    {
                        violations.push(ContractViolation {
                            contract_id: contract.id.clone(),
                            contract_name: contract.name.clone(),
                            rule_id: rule.id.clone(),
                            rule_section: "security_rules".to_string(),
                            severity: sev,
                            title: format!(
                                "硬编码敏感信息: {} (匹配 {})",
                                file, pattern
                            ),
                            detail: serde_json::json!({
                                "file": file,
                                "pattern": pattern,
                            }),
                            file_paths: vec![file.clone()],
                        });
                        break;
                    }
                }
            }
        }

        // Check for APPROXIMATE_LINEAGE warnings
        if rule.id == "sensitive_column_exposure" {
            for (file, result) in ctx.file_results {
                let has_approx = result
                    .issues
                    .iter()
                    .any(|i| i.code == "APPROXIMATE_LINEAGE");
                if has_approx {
                    violations.push(ContractViolation {
                        contract_id: contract.id.clone(),
                        contract_name: contract.name.clone(),
                        rule_id: rule.id.clone(),
                        rule_section: "security_rules".to_string(),
                        severity: sev,
                        title: format!("近似血缘告警: {}", file),
                        detail: serde_json::json!({"file": file}),
                        file_paths: vec![file.clone()],
                    });
                }
            }
        }
    }
}

fn evaluate_modeling_rules(
    contract: &Contract,
    rules: &FlowScopeRules,
    violations: &mut Vec<ContractViolation>,
) {
    for rule in &rules.modeling_rules {
        let sev = rule.severity.to_severity();

        if rule.id == "layer_must_be_assigned" {
            // This will be fully implemented in Tier 2 with model_registry.
            // For Tier 1, we skip this check.
        }

        if rule.id == "naming_must_match_layer" && !rule.patterns.is_empty() {
            // Check will be done against table names in table_edges.
            // For Tier 1, this is a placeholder — full implementation in Tier 2.
        }
    }
}

// ============================================================
// Cross-file checks (duplicates, write conflicts, orphans)
// ============================================================

fn run_cross_file_checks(ctx: &GovernanceContext) -> (Vec<ContractViolation>, ()) {
    let mut violations = Vec::new();

    // Compute fingerprints from raw SQL content
    let fingerprints: Vec<Fingerprint> = ctx
        .file_contents
        .iter()
        .filter_map(|(file, content)| {
            if content.trim().is_empty() {
                return None;
            }
            let (hash, norm, tokens) = fingerprint_sql(content);
            Some(Fingerprint {
                file_path: file.clone(),
                canonical_hash: hash,
                normalized_sql: norm,
                structured_tokens: tokens,
            })
        })
        .collect();

    // Duplicate detection
    let (dup_vs, _) = detect_duplicates(&fingerprints, ctx.file_contents);
    violations.extend(dup_vs);

    // Write conflict detection — filtered by model type
    // Build a set of tables that should be checked (skip dimension/source/temp)
    let write_check_tables: std::collections::HashSet<&str> = ctx
        .models
        .iter()
        .filter(|m| {
            // Only flag write conflicts for fact/aggregate/unknown tables
            m.model_type == "fact" || m.model_type == "aggregate" || m.model_type == "unknown"
        })
        .map(|m| m.table_name.as_str())
        .collect();

    let table_writes: Vec<(String, String)> = ctx
        .table_edges
        .iter()
        .filter_map(|(from, to, script)| {
            if !to.is_empty() && !script.is_empty() && write_check_tables.contains(to.as_str()) {
                Some((script.clone(), to.clone()))
            } else {
                None
            }
        })
        .collect();
    let conflict_vs = detect_write_conflicts(&table_writes);
    violations.extend(conflict_vs);

    // Orphan output detection
    let (written, read) = extract_table_io(ctx);
    let orphan_vs = detect_orphan_outputs(&written, &read);
    violations.extend(orphan_vs);

    (violations, ())
}

// ============================================================
// Helpers
// ============================================================

fn attach_contract(
    v: ContractViolation,
    contract: &Contract,
    rule_id: &str,
    section: &str,
    sev: Severity,
) -> ContractViolation {
    ContractViolation {
        contract_id: contract.id.clone(),
        contract_name: contract.name.clone(),
        rule_id: rule_id.to_string(),
        rule_section: section.to_string(),
        severity: sev,
        ..v
    }
}

fn extract_table_io(ctx: &GovernanceContext) -> (Vec<String>, Vec<String>) {
    let mut written = Vec::new();
    let mut read = Vec::new();
    for (from, to, _) in ctx.table_edges {
        if !from.is_empty() {
            read.push(from.clone());
        }
        if !to.is_empty() {
            written.push(to.clone());
        }
    }
    (written, read)
}

fn infer_layer(table_name: &str) -> &str {
    let lower = table_name.to_lowercase();
    if lower.starts_with("ods_") {
        "ODS"
    } else if lower.starts_with("dwd_") {
        "DWD"
    } else if lower.starts_with("dws_") {
        "DWS"
    } else if lower.starts_with("ads_") || lower.starts_with("app_") {
        "ADS"
    } else if lower.starts_with("dim_") {
        "DIM"
    } else {
        "unknown"
    }
}

fn has_select_star(result: &AnalyzeResult) -> bool {
    // Check nodes for wildcard patterns
    result
        .global_lineage
        .nodes
        .iter()
        .any(|n| n.label.contains('*'))
}

fn has_update_without_where(result: &AnalyzeResult) -> bool {
    // Check for UPDATE/DELETE statements without WHERE clause
    // Heuristic: check statement types and edge operations
    result
        .statements
        .iter()
        .any(|s| {
            let stmt_type = s.statement_type.to_lowercase();
            (stmt_type.contains("update") || stmt_type.contains("delete"))
                && s.edges.iter().all(|e| {
                    let op = e.operation.as_deref().unwrap_or("");
                    !op.to_lowercase().contains("filter")
                })
        })
}
