//! Data governance engine for FlowScope.
//!
//! ODCS contract-driven governance: parse YAML contracts, evaluate
//! SQL/lineage against contract rules, produce violation reports
//! and health scores.

pub mod contract;
pub mod contract_generator;
pub mod db;
pub mod dbt;
pub mod dbt_fusion;
pub mod designer;
pub mod dimension;
pub mod duplicate;
pub mod evaluator;
pub mod fingerprint;
pub mod health;
pub mod metric;
pub mod model;
pub mod modeling;
pub mod report;
pub mod semantic_yaml;

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// Initialize contracts directory: create dir + write default contract if not exists.
pub fn init_contracts(dir: &Path) {
    if let Err(e) = std::fs::create_dir_all(dir) {
        eprintln!("flowscope: warning: failed to create contracts dir: {e}");
        return;
    }
    let default_path = dir.join("_default.odcs.yaml");
    if !default_path.exists() {
        if let Err(e) = std::fs::write(&default_path, contract::DEFAULT_CONTRACT_YAML) {
            eprintln!("flowscope: warning: failed to write default contract: {e}");
        } else {
            println!("flowscope: created default governance contract at {}", default_path.display());
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, ToSchema)]
pub enum Severity {
    P0,
    P1,
    P2,
}

impl Severity {
    pub fn penalty(self) -> u32 {
        match self {
            Severity::P0 => 10,
            Severity::P1 => 5,
            Severity::P2 => 2,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Severity::P0 => "P0",
            Severity::P1 => "P1",
            Severity::P2 => "P2",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ContractViolation {
    pub contract_id: String,
    pub contract_name: String,
    pub rule_id: String,
    pub rule_section: String,
    pub severity: Severity,
    pub title: String,
    pub detail: serde_json::Value,
    pub file_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct PendingRuntimeCheck {
    pub contract_id: String,
    pub check_type: String,
    pub description: String,
    pub query: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct GovernanceSummary {
    pub total_files: usize,
    pub total_violations: usize,
    pub p0_count: usize,
    pub p1_count: usize,
    pub p2_count: usize,
    pub pending_runtime_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct GovernanceReport {
    pub project_id: String,
    pub health_score: u32,
    pub dimension_scores: BTreeMap<String, u32>,
    pub violations: Vec<ContractViolation>,
    pub pending_runtime: Vec<PendingRuntimeCheck>,
    pub summary: GovernanceSummary,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ScanRequest {
    pub project_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ScanResponse {
    pub report_id: i64,
    pub health_score: u32,
    pub violation_count: usize,
}

impl GovernanceReport {
    pub fn count_by_section(&self, section: &str) -> usize {
        self.violations
            .iter()
            .filter(|v| v.rule_section == section)
            .count()
    }
}
