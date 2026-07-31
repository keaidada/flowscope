//! Health score calculation from contract violations.

use std::collections::BTreeMap;

use super::{ContractViolation, GovernanceReport, GovernanceSummary, Severity};

/// Calculate health score from violations.
///
/// Score starts at 100 and is reduced by violation penalties:
///   P0 = 10 points each
///   P1 = 5 points each
///   P2 = 2 points each
/// Minimum score is 0.
pub fn calculate_health_score(violations: &[ContractViolation]) -> u32 {
    let penalty: u32 = violations.iter().map(|v| v.severity.penalty()).sum();
    100u32.saturating_sub(penalty)
}

/// Calculate per-dimension scores from violations.
///
/// Dimensions are derived from `rule_section`:
///   schema / lineage_rules → storage & compute dimensions
///   sql_rules → dev dimension
///   security_rules → security dimension
///   modeling_rules → modeling dimension
pub fn calculate_dimension_scores(violations: &[ContractViolation]) -> BTreeMap<String, u32> {
    // Group violations by dimension
    let mut dim_violations: BTreeMap<&str, Vec<&ContractViolation>> = BTreeMap::new();
    for v in violations {
        let dim = section_to_dimension(&v.rule_section);
        dim_violations.entry(dim).or_default().push(v);
    }

    let mut scores = BTreeMap::new();
    for dim in &["storage", "compute", "dev", "security", "modeling"] {
        let viols = dim_violations.get(dim).map(|v| v.as_slice()).unwrap_or(&[]);
        let penalty: u32 = viols.iter().map(|v| v.severity.penalty()).sum();
        scores.insert(dim.to_string(), 100u32.saturating_sub(penalty));
    }
    scores
}

fn section_to_dimension(section: &str) -> &'static str {
    match section {
        "schema" => "storage",
        "lineage_rules" => "compute",
        "metric_rules" => "compute",
        "sql_rules" => "dev",
        "security_rules" => "security",
        "modeling_rules" => "modeling",
        "semantics" => "modeling",
        _ => "dev",
    }
}

/// Build a complete GovernanceReport from raw evaluation data.
pub fn build_report(
    project_id: &str,
    violations: Vec<ContractViolation>,
    pending_runtime: Vec<super::PendingRuntimeCheck>,
    total_files: usize,
    created_at: &str,
) -> GovernanceReport {
    let health_score = calculate_health_score(&violations);
    let dimension_scores = calculate_dimension_scores(&violations);

    let (p0, p1, p2) = count_by_severity(&violations);

    let summary = GovernanceSummary {
        total_files,
        total_violations: violations.len(),
        p0_count: p0,
        p1_count: p1,
        p2_count: p2,
        pending_runtime_count: pending_runtime.len(),
    };

    GovernanceReport {
        project_id: project_id.to_string(),
        health_score,
        dimension_scores,
        violations,
        pending_runtime,
        summary,
        created_at: created_at.to_string(),
    }
}

fn count_by_severity(violations: &[ContractViolation]) -> (usize, usize, usize) {
    let p0 = violations
        .iter()
        .filter(|v| v.severity == Severity::P0)
        .count();
    let p1 = violations
        .iter()
        .filter(|v| v.severity == Severity::P1)
        .count();
    let p2 = violations
        .iter()
        .filter(|v| v.severity == Severity::P2)
        .count();
    (p0, p1, p2)
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::Severity;

    fn make_violation(section: &str, severity: Severity) -> ContractViolation {
        ContractViolation {
            contract_id: "test".to_string(),
            contract_name: "test".to_string(),
            rule_id: "test_rule".to_string(),
            rule_section: section.to_string(),
            severity,
            title: "test".to_string(),
            detail: serde_json::Value::Null,
            file_paths: vec![],
        }
    }

    #[test]
    fn test_score_no_violations() {
        assert_eq!(calculate_health_score(&[]), 100);
    }

    #[test]
    fn test_score_with_p0() {
        let v = vec![make_violation("sql_rules", Severity::P0)];
        assert_eq!(calculate_health_score(&v), 90);
    }

    #[test]
    fn test_score_floor_at_zero() {
        let v = vec![make_violation("sql_rules", Severity::P0); 20];
        assert_eq!(calculate_health_score(&v), 0);
    }

    #[test]
    fn test_dimension_scores() {
        let v = vec![
            make_violation("sql_rules", Severity::P0),
            make_violation("security_rules", Severity::P1),
        ];
        let scores = calculate_dimension_scores(&v);
        assert_eq!(*scores.get("dev").unwrap(), 90);
        assert_eq!(*scores.get("security").unwrap(), 95);
        assert_eq!(*scores.get("storage").unwrap(), 100);
    }
}
