//! Contract generator: produces ODCS contracts from lineage data.
//!
//! Before evaluation, we first understand the model structure by generating
//! contracts from the actual data. The contract captures:
//!   - Which tables exist and their structure
//!   - Which scripts produce/consume each table
//!   - The layer and type of each table
//!   - The data flow relationships between tables
//!
//! The evaluator then compares actual state against the contract.

use std::collections::{HashMap, HashSet};

use super::contract::{
    Contract, CustomFields, FlowScopeRules, LineageRule, MetricRule, ModelingRule, SecurityRule,
    SqlRule, SeverityDef,
};
use super::model;

/// Input data for contract generation.
pub struct GenerationInput {
    pub project_id: String,
    pub table_edges: Vec<(String, String, String)>, // (from, to, script)
}

/// Generated model information for one table.
#[derive(Debug, Clone)]
pub struct TableModel {
    pub table_name: String,
    pub layer: String,
    pub model_type: String,
    pub producers: Vec<String>,   // scripts that write to this table
    pub consumers: Vec<String>,   // scripts that read from this table
    pub upstream_tables: Vec<String>,
    pub downstream_tables: Vec<String>,
}

/// Generate model registry from lineage edges.
pub fn generate_models(input: &GenerationInput) -> Vec<TableModel> {
    let mut by_table: HashMap<String, TableModel> = HashMap::new();

    for (from, to, script) in &input.table_edges {
        // Output table (producer)
        if !to.is_empty() {
            let entry = by_table.entry(to.clone()).or_insert_with(|| TableModel {
                table_name: to.clone(),
                layer: model::infer_layer(to).to_string(),
                model_type: String::new(),
                producers: vec![],
                consumers: vec![],
                upstream_tables: vec![],
                downstream_tables: vec![],
            });
            if !script.is_empty() && !entry.producers.contains(script) {
                entry.producers.push(script.clone());
            }
            if !from.is_empty() && !entry.upstream_tables.contains(from) {
                entry.upstream_tables.push(from.clone());
            }
        }

        // Input table (consumer)
        if !from.is_empty() && !script.is_empty() {
            let entry = by_table.entry(from.clone()).or_insert_with(|| TableModel {
                table_name: from.clone(),
                layer: model::infer_layer(from).to_string(),
                model_type: String::new(),
                producers: vec![],
                consumers: vec![],
                upstream_tables: vec![],
                downstream_tables: vec![],
            });
            if !entry.consumers.contains(script) {
                entry.consumers.push(script.clone());
            }
            if !to.is_empty() && !entry.downstream_tables.contains(to) {
                entry.downstream_tables.push(to.clone());
            }
        }
    }

    // Infer model types
    for model in by_table.values_mut() {
        model.model_type = infer_model_type_for_table(model);
    }

    let mut models: Vec<_> = by_table.into_values().collect();
    models.sort_by(|a, b| a.table_name.cmp(&b.table_name));
    models
}

fn infer_model_type_for_table(model: &TableModel) -> String {
    if model.table_name.to_lowercase().contains("dim_") {
        return "dimension".to_string();
    }
    if !model.producers.is_empty() && !model.downstream_tables.is_empty() {
        return "aggregate".to_string();
    }
    if !model.producers.is_empty() {
        return "fact".to_string();
    }
    if !model.consumers.is_empty() {
        return "source".to_string();
    }
    "unknown".to_string()
}

/// Generate a governance contract that captures the expected structure of all models.
/// This becomes the "protocol" — the evaluator compares actual data against this contract.
pub fn generate_governance_contract(project_id: &str, models: &[TableModel]) -> Contract {
    // Collect all layer violation rules from cross-layer edges
    let forbidden_edges = vec![
        ("ODS".to_string(), "DWS".to_string()),
        ("ODS".to_string(), "ADS".to_string()),
        ("DWD".to_string(), "ADS".to_string()),
    ];

    // For each model, define expected producers and layers
    let mut modeling_patterns: HashMap<String, String> = HashMap::new();
    modeling_patterns.insert("ODS".to_string(), "^ods_".to_string());
    modeling_patterns.insert("DWD".to_string(), "^dwd_".to_string());
    modeling_patterns.insert("DWS".to_string(), "^dws_".to_string());
    modeling_patterns.insert("ADS".to_string(), "^(ads_|app_)".to_string());
    modeling_patterns.insert("DIM".to_string(), "^dim_".to_string());

    // Build the contract
    let contract_id = format!("{project_id}_governance");
    let name = format!("{project_id} Governance");

    let flowscope = FlowScopeRules {
        lineage_rules: vec![
            LineageRule {
                id: "no_cross_layer".to_string(),
                description: "禁止跨层依赖".to_string(),
                forbidden_edges,
                severity: SeverityDef::P1,
            },
            LineageRule {
                id: "no_orphan_output".to_string(),
                description: "产出表必须有下游消费".to_string(),
                forbidden_edges: vec![],
                severity: SeverityDef::P2,
            },
            LineageRule {
                id: "lineage_completeness".to_string(),
                description: "核心链路不能有血缘断裂".to_string(),
                forbidden_edges: vec![],
                severity: SeverityDef::P0,
            },
        ],
        sql_rules: vec![
            SqlRule {
                id: "no_select_star".to_string(),
                description: "生产脚本禁止 SELECT *".to_string(),
                threshold: None,
                severity: SeverityDef::P2,
            },
            SqlRule {
                id: "no_update_without_where".to_string(),
                description: "UPDATE/DELETE 必须有 WHERE".to_string(),
                threshold: None,
                severity: SeverityDef::P0,
            },
            SqlRule {
                id: "max_complexity".to_string(),
                description: "单脚本复杂度不超过阈值".to_string(),
                threshold: Some(80),
                severity: SeverityDef::P2,
            },
        ],
        metric_rules: vec![
            MetricRule {
                id: "no_duplicate_computation".to_string(),
                description: "禁止重复计算".to_string(),
                similarity_threshold: 0.85,
                severity: SeverityDef::P1,
            },
            MetricRule {
                id: "no_write_conflict".to_string(),
                description: "禁止多个脚本写入同一物理表".to_string(),
                similarity_threshold: 0.0,
                severity: SeverityDef::P2,
            },
        ],
        security_rules: vec![
            SecurityRule {
                id: "no_hardcoded_secrets".to_string(),
                description: "SQL 中禁止硬编码密码/令牌".to_string(),
                patterns: vec![
                    "password".to_string(),
                    "token".to_string(),
                    "secret".to_string(),
                    "api_key".to_string(),
                ],
                column_patterns: vec![],
                severity: SeverityDef::P0,
            },
        ],
        modeling_rules: vec![
            ModelingRule {
                id: "naming_must_match_layer".to_string(),
                description: "表名前缀必须与层级匹配".to_string(),
                patterns: modeling_patterns,
                forbidden_edges: vec![],
                severity: SeverityDef::P2,
            },
            ModelingRule {
                id: "layer_must_be_assigned".to_string(),
                description: "所有表必须有层级标注".to_string(),
                patterns: HashMap::new(),
                forbidden_edges: vec![],
                severity: SeverityDef::P2,
            },
        ],
    };

    Contract {
        api_version: "v3.1.0".to_string(),
        kind: "DataContract".to_string(),
        id: contract_id,
        name,
        version: "1.0.0".to_string(),
        status: "active".to_string(),
        schema: vec![],
        semantics: vec![],
        references: vec![],
        quality: vec![],
        sla: None,
        owners: vec![],
        custom: Some(CustomFields {
            flowscope: Some(flowscope),
        }),
    }
}

/// Generate YAML string for a contract.
pub fn contract_to_yaml(contract: &Contract) -> String {
    serde_yaml::to_string(contract).unwrap_or_else(|_| String::new())
}

/// Save generated contract to contracts/ directory.
pub fn save_contract(dir: &std::path::Path, project_id: &str, contract: &Contract) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let yaml = contract_to_yaml(contract);
    let path = dir.join(format!("{project_id}.odcs.yaml"));
    std::fs::write(&path, yaml)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_models() {
        let input = GenerationInput {
            project_id: "test".to_string(),
            table_edges: vec![
                ("ods_orders".to_string(), "dwd_orders".to_string(), "etl_dwd.sql".to_string()),
                ("dwd_orders".to_string(), "dws_gmv".to_string(), "etl_dws.sql".to_string()),
                ("dws_gmv".to_string(), "ads_report".to_string(), "etl_ads.sql".to_string()),
                ("dwd_orders".to_string(), "dws_gmv".to_string(), "etl_dws_dup.sql".to_string()),
            ],
        };
        let models = generate_models(&input);
        assert!(!models.is_empty());

        // Check dws_gmv
        let gmv = models.iter().find(|m| m.table_name == "dws_gmv").unwrap();
        assert_eq!(gmv.layer, "DWS");
        assert_eq!(gmv.producers.len(), 2); // etl_dws.sql + etl_dws_dup.sql
        assert_eq!(gmv.consumers.len(), 1); // etl_ads.sql
        assert_eq!(gmv.upstream_tables, vec!["dwd_orders"]);
        assert_eq!(gmv.downstream_tables, vec!["ads_report"]);
    }

    #[test]
    fn test_generate_contract() {
        let models = vec![];
        let contract = generate_governance_contract("test", &models);
        assert_eq!(contract.id, "test_governance");
        assert!(contract.custom.unwrap().flowscope.unwrap().lineage_rules.len() >= 3);
    }

    #[test]
    fn test_contract_to_yaml() {
        let models = vec![];
        let contract = generate_governance_contract("test", &models);
        let yaml = contract_to_yaml(&contract);
        assert!(yaml.contains("apiVersion: v3.1.0"));
        assert!(yaml.contains("no_cross_layer"));
        assert!(yaml.contains("no_duplicate_computation"));
    }
}
