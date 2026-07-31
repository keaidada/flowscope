//! ODCS (Open Data Contract Standard) v3.1 YAML parsing.
//!
//! Parses standard ODCS sections (schema, semantics, quality, sla)
//! plus the `custom.flowscope` extension (lineage/sql/metric/security/modeling rules).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::Severity;

// ============================================================
// ODCS Contract (top-level)
// ============================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Contract {
    #[serde(rename = "apiVersion")]
    pub api_version: String,
    pub kind: String,
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub version: String,
    #[serde(default = "default_active")]
    pub status: String,
    #[serde(default)]
    pub schema: Vec<SchemaDefinition>,
    #[serde(default)]
    pub semantics: Vec<SemanticRule>,
    #[serde(default)]
    pub references: Vec<Reference>,
    #[serde(default)]
    pub quality: Vec<QualityRule>,
    #[serde(default)]
    pub sla: Option<Sla>,
    #[serde(default)]
    pub owners: Vec<Owner>,
    #[serde(default)]
    pub custom: Option<CustomFields>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomFields {
    #[serde(default)]
    pub flowscope: Option<FlowScopeRules>,
}

fn default_active() -> String {
    "active".to_string()
}

// ============================================================
// Standard ODCS sections
// ============================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchemaDefinition {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default, rename = "physicalType")]
    pub physical_type: String,
    #[serde(default)]
    pub properties: Vec<PropertyDefinition>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PropertyDefinition {
    pub name: String,
    #[serde(default, rename = "logicalType")]
    pub logical_type: String,
    #[serde(default, rename = "primaryKey")]
    pub primary_key: bool,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub metric: Option<MetricDefinition>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MetricDefinition {
    pub name: String,
    #[serde(default)]
    pub aggregation: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub expression: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SemanticRule {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub rule: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Reference {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub columns: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QualityRule {
    #[serde(default, rename = "type")]
    pub rule_type: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub query: String,
    #[serde(default, rename = "mustBe")]
    pub must_be: Option<i64>,
    #[serde(default, rename = "mustBeGreaterThan")]
    pub must_be_greater_than: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Sla {
    #[serde(default, rename = "refreshFrequency")]
    pub refresh_frequency: String,
    #[serde(default, rename = "maxLatency")]
    pub max_latency: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Owner {
    pub name: String,
    #[serde(default)]
    pub role: String,
}

// ============================================================
// custom.flowscope rules
// ============================================================

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct FlowScopeRules {
    #[serde(default)]
    pub lineage_rules: Vec<LineageRule>,
    #[serde(default)]
    pub sql_rules: Vec<SqlRule>,
    #[serde(default)]
    pub metric_rules: Vec<MetricRule>,
    #[serde(default)]
    pub security_rules: Vec<SecurityRule>,
    #[serde(default)]
    pub modeling_rules: Vec<ModelingRule>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LineageRule {
    pub id: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub forbidden_edges: Vec<(String, String)>,
    #[serde(default = "default_p2")]
    pub severity: SeverityDef,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SqlRule {
    pub id: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub threshold: Option<u32>,
    #[serde(default = "default_p2")]
    pub severity: SeverityDef,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MetricRule {
    pub id: String,
    #[serde(default)]
    pub description: String,
    #[serde(default = "default_similarity")]
    pub similarity_threshold: f64,
    #[serde(default = "default_p1")]
    pub severity: SeverityDef,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SecurityRule {
    pub id: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub patterns: Vec<String>,
    #[serde(default)]
    pub column_patterns: Vec<String>,
    #[serde(default = "default_p1")]
    pub severity: SeverityDef,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelingRule {
    pub id: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub patterns: HashMap<String, String>,
    #[serde(default)]
    pub forbidden_edges: Vec<(String, String)>,
    #[serde(default = "default_p2")]
    pub severity: SeverityDef,
}

// ============================================================
// Helpers
// ============================================================

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub enum SeverityDef {
    P0,
    P1,
    P2,
}

impl SeverityDef {
    pub fn to_severity(self) -> Severity {
        match self {
            SeverityDef::P0 => Severity::P0,
            SeverityDef::P1 => Severity::P1,
            SeverityDef::P2 => Severity::P2,
        }
    }
}

fn default_p1() -> SeverityDef {
    SeverityDef::P1
}

fn default_p2() -> SeverityDef {
    SeverityDef::P2
}

fn default_similarity() -> f64 {
    0.85
}

// ============================================================
// Parsing functions
// ============================================================

/// Parse ODCS YAML content into a Contract object.
pub fn parse_contract(yaml: &str) -> Result<Contract, serde_yaml::Error> {
    serde_yaml::from_str(yaml)
}

/// Validate an ODCS YAML string. Returns Ok(()) if valid, or a list of errors.
pub fn validate_contract(yaml: &str) -> Result<(), Vec<String>> {
    let mut errors = Vec::new();

    match serde_yaml::from_str::<serde_yaml::Value>(yaml) {
        Ok(val) => {
            if val.get("apiVersion").is_none() {
                errors.push("Missing required field: apiVersion".to_string());
            }
            if val.get("kind").is_none() {
                errors.push("Missing required field: kind".to_string());
            }
            if val.get("id").is_none() {
                errors.push("Missing required field: id".to_string());
            }
            if val.get("name").is_none() {
                errors.push("Missing required field: name".to_string());
            }

            // Try full parse for deeper validation
            if errors.is_empty() {
                if let Err(e) = parse_contract(yaml) {
                    errors.push(format!("Parse error: {e}"));
                }
            }
        }
        Err(e) => {
            errors.push(format!("YAML syntax error: {e}"));
        }
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors)
    }
}

/// Scan a directory for .odcs.yaml / .yaml files, returning paths.
pub fn scan_contract_files(dir: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    if !dir.is_dir() {
        return files;
    }
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                if let Some(ext) = path.extension() {
                    if ext == "yaml" || ext == "yml" {
                        let name = path
                            .file_name()
                            .map(|n| n.to_string_lossy().to_string())
                            .unwrap_or_default();
                        if name.ends_with(".odcs.yaml")
                            || name.ends_with(".odcs.yml")
                            || name.ends_with(".yaml")
                            || name.ends_with(".yml")
                        {
                            files.push(path);
                        }
                    }
                }
            }
        }
    }
    files.sort();
    files
}

/// Compute SHA256 hash of file content for change detection.
pub fn compute_file_hash(content: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// The built-in default contract YAML.
pub const DEFAULT_CONTRACT_YAML: &str = r#"apiVersion: v3.1.0
kind: DataContract
id: flowscope_default_governance
name: FlowScope Default Governance
version: 1.0.0
status: active

custom:
  flowscope:
    lineage_rules:
      - id: no_orphan_output
        description: "产出表必须有下游消费"
        severity: P2
      - id: lineage_completeness
        description: "核心链路不能有血缘断裂"
        severity: P0

    sql_rules:
      - id: no_select_star
        description: "生产脚本禁止 SELECT *"
        severity: P2
      - id: no_update_without_where
        description: "UPDATE/DELETE 必须有 WHERE"
        severity: P0
      - id: max_complexity
        description: "单脚本复杂度不超过阈值"
        threshold: 80
        severity: P2

    metric_rules:
      - id: no_duplicate_computation
        description: "禁止重复计算（相同指纹的脚本）"
        similarity_threshold: 0.85
        severity: P1
      - id: no_write_conflict
        description: "禁止多个脚本写入同一物理表"
        severity: P1

    security_rules:
      - id: no_hardcoded_secrets
        description: "SQL 中禁止硬编码密码/令牌"
        patterns: ["password", "token", "secret", "api_key"]
        severity: P0

    modeling_rules:
      - id: naming_must_match_layer
        description: "表名前缀必须与层级匹配"
        severity: P2
        patterns:
          ODS: "^ods_"
          DWD: "^dwd_"
          DWS: "^dws_"
          ADS: "^(ads_|app_)"
          DIM: "^dim_"
      - id: layer_must_be_assigned
        description: "所有表必须有层级标注"
        severity: P2
"#;
