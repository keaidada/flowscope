# 数据治理（Data Governance）功能方案

> **状态**：Draft v2.1
> **作者**：需求对齐阶段
> **更新**：2026-07-31
> **变更**：
> - v1.0 — 三层渐进式数据治理平台：SQL指纹+重复检测+健康分 / 指标注册+口径管理 / 外部采集+LLM助手
> - v1.1 — 治理数据独立为 `governance.db`，不修改主库 `flowscope.db` 的 schema version
> - v1.2 — 新增数据建模模块（Tier 2 主体 + Tier 3 可视化建模工具）
> - **v2.0 — 架构重构：从硬编码规则引擎升级为 ODCS 契约驱动评估引擎**
> - **v2.1 — 补齐模型管理/指标管理完整功能 + 契约增强 + 健康报告增强 + 基础设施 + 治理工作台 UI**

## 1. 背景与目标

### 1.1 背景

FlowScope 已具备完整的 SQL 血缘解析能力（多方言、表级+字段级、跨语句全局血缘）。现有资产：
- ✅ 多方言 SQL 解析（PostgreSQL/Snowflake/BigQuery/ClickHouse/Redshift 等）
- ✅ 72 条 lint 规则的可扩展框架（AST 驱动）
- ✅ GlobalLineage 跨语句血缘追踪 + table_level_edges
- ✅ AnalyzeResult 含 Summary（complexity_score、issue_count）
- ✅ Node/Edge 上的 `metadata: HashMap` 扩展字段
- ✅ CLI serve 模式 + 50+ REST API + SQLite 存储（schema v5）

**完全缺失**：治理协议、数据建模、模型管理、契约评估、健康分。

### 1.2 产品定位

**数据资产治理的自动驾驶系统** — 基于 ODCS 契约，自动评估 SQL/血缘的治理合规性。

治理功能四层架构（自底向上）：

```
┌─────────────────────────────────────────────────┐
│ Tier 3: 外部采集 + LLM 助手 [Tier 3]             │
│   ODCS quality执行 / 元数据采集 / RAG建议        │
├─────────────────────────────────────────────────┤
│ Tier 2: 可视化建模 + 指标注册 + 数据建模          │
│   拖拽设计/DDL生成 + 指标从ODCS定义 + 模型管理     │
├─────────────────────────────────────────────────┤
│ Tier 1: 契约评估 + 健康度巡检 [Tier 1]           │
│   ODCS 契约 → 评估引擎 → 违规报告 + 健康分        │
├─────────────────────────────────────────────────┤
│ 基础: 现有血缘引擎（table_level_edges 等）        │
└─────────────────────────────────────────────────┘
```

**核心理念**：治理规则不在代码里硬编码，而是声明在 ODCS 契约文件中。
用户自定义契约（YAML），FlowScope 评估 SQL/血缘是否满足契约。

### 1.3 目标

在 FlowScope CLI serve 层新增 **governance 模块**：
1. 解析 ODCS 契约（标准部分 + `custom.flowscope` 扩展）
2. 评估现有分析结果是否符合契约
3. 输出违规报告 + 健康分
4. 不修改 capybara-core

## 2. 本期范围

### Tier 1: ODCS 契约评估 + 健康分（MVP，1-2周）

| 范围 | 在/不在 |
|------|---------|
| ODCS v3.1 YAML 契约解析（标准 + custom.flowscope 扩展） | ✅ 在 |
| 契约评估引擎（血缘/SQL/指标/安全/建模 5 类规则） | ✅ 在 |
| 内置默认契约（`_default.odcs.yaml`，首次启动自动生成） | ✅ 在 |
| SQL 指纹算法（归一化哈希，被评估器调用） | ✅ 在 |
| 跨文件重复计算检测 | ✅ 在 |
| 健康分（从契约违规计算，不再硬编码维度） | ✅ 在 |
| 治理 Dashboard UI（健康分卡片 + 违规清单 + 契约管理） | ✅ 在 |
| REST API（scan/report/health/contracts CRUD） | ✅ 在 |
| 治理报告导出（HTML/JSON） | ✅ 在 |
| 独立 governance.db + contracts/ 文件持久化 | ✅ 在 |
| 外部数据库元数据采集 | ❌ 不做 |
| LLM 治理助手 | ❌ 不做 |
| 实时 MQ 更新 | ❌ 不做 |

### Tier 2: 数据建模 + 指标注册 + 可视化建模（3-5周）

| 范围 | 在/不在 |
|------|---------|
| 数据建模：ODCS schema 导入模型定义 | ✅ 在 |
| 数据建模：血缘自动推导 + ODCS 导入双通道 | ✅ 在 |
| 数据建模：建模规范校验（由契约 `modeling_rules` 驱动） | ✅ 在 |
| 数据建模：GlobalLineageView 层级颜色编码 | ✅ 在 |
| 指标注册：从 ODCS `schema.metric` 定义指标 | ✅ 在 |
| 指标注册：口径冲突检测 | ✅ 在 |
| 指标注册：MetricRegistryPanel + ConflictReport UI | ✅ 在 |
| ModelRegistryPanel + 建模校验报告 UI | ✅ 在 |
| 治理趋势追踪（历史健康分对比） | ✅ 在 |
| 可视化建模画布（React Flow 拖拽设计表关系） | ✅ 在 |
| DDL 自动生成（从模型定义生成建表语句） | ✅ 在 |
| 逆向工程（解析 SQL → 生成模型图） | ✅ 在 |

### Tier 3: 外部采集 + LLM 助手（1-2个月+）

| 范围 | 在/不在 |
|------|---------|
| 外部元数据采集（MySQL/PG/ClickHouse） | ✅ 在 |
| ODCS quality 断言运行时执行 | ✅ 在 |
| LLM 治理建议（RAG 架构） | ✅ 在 |
| 实时血缘更新（MQ） | ✅ 在 |
| CI/CD 集成插件 | ✅ 在 |
| SaaS 多租户 | ✅ 在 |

## 3. 总体架构

```
┌─────────────────────────────────────────────────────────────┐
│  React Frontend (app/)                                       │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ GovernanceDashboard（新视图，ActivityBar 切换）         │  │
│  │  ├─ HealthScoreCard（健康分 + 维度分布 + 趋势）         │  │
│  │  ├─ ContractManager（契约文件管理 + 编辑）             │  │
│  │  ├─ ViolationList（契约违规清单 P0/P1/P2）            │  │
│  │  ├─ DuplicatePanel（重复计算检测面板）                │  │
│  │  ├─ ModelRegistryPanel（模型注册管理）[Tier 2]        │  │
│  │  ├─ MetricRegistryPanel（指标注册管理）[Tier 2]       │  │
│  │  ├─ ConflictReport（口径冲突报告）[Tier 2]            │  │
│  │  └─ VisualModelDesigner（可视化建模画布）[Tier 2]     │  │
│  └───────────────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────────────┤
│  REST API (capybara-cli/src/server/)                         │
│  ├─ GET/POST /api/governance/contracts   契约CRUD           │
│  ├─ GET/PUT/DELETE /api/governance/contracts/:name 契约操作 │
│  ├─ POST /api/governance/scan            全量契约评估        │
│  ├─ GET  /api/governance/report          最新评估报告        │
│  ├─ GET  /api/governance/health          健康分明细          │
│  ├─ GET/POST /api/governance/models      模型CRUD [Tier 2]  │
│  ├─ GET/POST /api/governance/metrics     指标CRUD [Tier 2]  │
│  ├─ POST /api/governance/collect         元数据采集 [Tier 3] │
│  ├─ POST /api/governance/gen-ddl         DDL生成 [Tier 3]   │
│  └─ POST /api/governance/export/:fmt     报告导出            │
├─────────────────────────────────────────────────────────────┤
│  Governance Engine (server/governance/)                      │
│  ├─ mod.rs          模块入口，GovernanceReport              │
│  ├─ contract.rs     ★ ODCS YAML 解析 + custom.flowscope     │
│  ├─ evaluator.rs    ★ 契约评估引擎（5类规则评估）            │
│  ├─ fingerprint.rs  SQL指纹（归一化哈希，被 evaluator 调用） │
│  ├─ duplicate.rs    重复检测（被 evaluator 调用）            │
│  ├─ health.rs       健康分（从契约违规计算）                 │
│  ├─ model.rs        数据建模（ODCS导入 + 血缘推导）[Tier 2] │
│  ├─ metric.rs       指标注册（ODCS metric定义）[Tier 2]     │
│  ├─ designer.rs     可视化建模（DDL生成/逆向/diff）[Tier 2] │
│  ├─ collector.rs    外部元数据采集 [Tier 3]                 │
│  └─ report.rs       报告生成与导出                           │
├─────────────────────────────────────────────────────────────┤
│  Persistence                                                 │
│  ┌────────────────┐  ┌──────────────┐  ┌─────────────────┐  │
│  │ contracts/     │  │flowscope.db  │  │governance.db    │  │
│  │ (YAML 文件)    │  │(主库,不动)    │  │(治理独立库)      │  │
│  │ ├─_default.yaml│  │project_files │  │├─contract_reg   │  │
│  │ ├─orders.yaml  │  │table_level_  │  │├─gov_reports    │  │
│  │ └─payment.yaml │  │  edges       │  │├─gov_violations │  │
│  │                │  │lineage_nodes │  │├─model_registry │  │
│  │ Git 可追踪     │  │table_metadata│  │└─metrics_reg    │  │
│  └────────────────┘  └──────────────┘  └─────────────────┘  │
│           ↑ source of truth    ↑ 只读输入      ↑ 评估结果    │
├─────────────────────────────────────────────────────────────┤
│  contracts/ 目录在 watch_dirs 监控范围内，文件变更触发重评估  │
└─────────────────────────────────────────────────────────────┘
```

## 4. ODCS 契约规范

### 4.1 契约文件格式

采用 **Open Data Contract Standard (ODCS) v3.1** 作为治理协议。
所有治理规则声明在 YAML 契约文件中，不硬编码在 Rust 代码里。

**文件位置**：`<project_dir>/contracts/*.odcs.yaml`

### 4.2 ODCS 标准部分（FlowScope 可评估）

```yaml
apiVersion: v3.1.0
kind: DataContract
id: orders_pipeline
name: Orders Pipeline Governance
version: 1.0.0
status: active

# Schema 契约 —— 定义期望的数据模型形状
schema:
  - name: dws_order_gmv
    description: "订单GMV汇总表"
    physicalType: TABLE
    properties:
      - name: order_id
        logicalType: string
        primaryKey: true
        description: "订单ID"
      - name: gmv
        logicalType: number
        description: "GMV金额"
      - name: dt
        logicalType: date
        description: "业务日期"

# Semantics —— 业务语义要求
semantics:
  - name: must_have_owner
    description: "模型必须有负责人"
    rule: '{"some":[{"var":"owners"},{"!=":[{"var":"name"},null]}]}'

# References —— 跨表依赖（可被 FlowScope 血缘校验）
references:
  - name: depends_on_orders
    description: "依赖订单明细表"
    columns: [dwd_orders]

# Quality —— 数据质量断言（需运行时执行，Tier 3）
quality:
  - type: sql
    description: "GMV不能为负"
    query: select count(*) from dws_order_gmv where gmv < 0
    mustBe: 0

# SLA —— 服务等级（需调度系统集成，Tier 3）
sla:
  refreshFrequency: daily
  maxLatency: 4h

owners:
  - name: alice
    role: data_engineer
```

### 4.3 custom.flowscope 扩展（FlowScope 专有规则）

ODCS v3.1 允许 `custom` 字段扩展。FlowScope 的专有治理规则放在 `custom.flowscope` 下：

```yaml
custom:
  flowscope:
    # =========================================================
    # 血缘规则 —— 基于 table_level_edges 检测
    # =========================================================
    lineage_rules:
      - id: no_cross_layer
        description: "禁止跨层依赖（DWS不能直接读ODS）"
        forbidden_edges:
          - [ODS, DWS]
          - [ODS, ADS]
          - [DWD, ADS]
        severity: P1

      - id: no_orphan_output
        description: "产出表必须有下游消费"
        severity: P2

      - id: lineage_completeness
        description: "核心链路不能有血缘断裂"
        severity: P0

    # =========================================================
    # SQL 结构规则 —— 基于 AST 检测
    # =========================================================
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

    # =========================================================
    # 指标规则 —— 基于 SQL 指纹检测
    # =========================================================
    metric_rules:
      - id: no_duplicate_computation
        description: "禁止重复计算（相同指纹的脚本）"
        similarity_threshold: 0.85
        severity: P1

      - id: no_write_conflict
        description: "禁止多个脚本写入同一物理表"
        severity: P1

    # =========================================================
    # 安全规则 —— 基于启发式检测
    # =========================================================
    security_rules:
      - id: no_hardcoded_secrets
        description: "SQL 中禁止硬编码密码/令牌"
        patterns: ["password", "token", "secret", "api_key"]
        severity: P0

      - id: sensitive_column_exposure
        description: "敏感字段未脱敏"
        column_patterns: ["phone", "email", "id_card", "credit"]
        severity: P1

    # =========================================================
    # 建模规则 —— 基于 model_registry 检测
    # =========================================================
    modeling_rules:
      - id: naming_must_match_layer
        description: "表名前缀必须与层级匹配"
        patterns:
          ODS: "^ods_"
          DWD: "^dwd_"
          DWS: "^dws_"
          ADS: "^(ads_|app_)"
          DIM: "^dim_"
        severity: P2

      - id: layer_must_be_assigned
        description: "所有表必须有层级标注"
        severity: P2
```

### 4.4 默认契约模板

首次启动时自动生成 `contracts/_default.odcs.yaml`，包含基础治理规则：

```yaml
apiVersion: v3.1.0
kind: DataContract
id: flowscope_default_governance
name: FlowScope Default Governance
version: 1.0.0
status: active

custom:
  flowscope:
    lineage_rules:
      - { id: no_orphan_output, severity: P2 }
      - { id: lineage_completeness, severity: P0 }

    sql_rules:
      - { id: no_select_star, severity: P2 }
      - { id: no_update_without_where, severity: P0 }
      - { id: max_complexity, threshold: 80, severity: P2 }

    metric_rules:
      - { id: no_duplicate_computation, similarity_threshold: 0.85, severity: P1 }
      - { id: no_write_conflict, severity: P1 }

    security_rules:
      - { id: no_hardcoded_secrets,
          patterns: ["password", "token", "secret", "api_key"],
          severity: P0 }

    modeling_rules:
      - { id: naming_must_match_layer, severity: P2,
          patterns: {ODS: "^ods_", DWD: "^dwd_", DWS: "^dws_", ADS: "^(ads_|app_)", DIM: "^dim_"} }
      - { id: layer_must_be_assigned, severity: P2 }
```

用户可修改此文件，也可添加新的 `.odcs.yaml` 文件定义额外规则。

## 5. 契约评估引擎

### 5.1 评估流程

```
1. 扫描 contracts/ 目录，读取所有 .odcs.yaml 文件
2. 解析 YAML → ODCS Contract 对象（标准部分 + custom.flowscope）
3. 计算 SHA256，与 governance.db 中 contract_hash 对比
4. 变更的契约标记为"需要重新评估"
5. 用户请求 POST /api/governance/scan
6. 评估引擎执行：
   ┌─────────────────────────────────────────────────────┐
   │ 对每个活跃契约：                                      │
   │                                                      │
   │ ① schema 评估                                        │
   │    FlowScope 解析 SQL 输出列 → 对比契约期望列          │
   │    违规：列缺失/类型不匹配/约束不满足                   │
   │                                                      │
   │ ② custom.flowscope.lineage_rules 评估                │
   │    遍历 table_level_edges → 检查 forbidden_edges      │
   │    检查孤儿产出（to_table 无下游）                     │
   │    检查血缘断裂（核心链路缺失）                         │
   │                                                      │
   │ ③ custom.flowscope.sql_rules 评估                    │
   │    遍历 AnalyzeResult → 检查 SELECT * / 无 WHERE      │
   │    检查 complexity_score > threshold                  │
   │                                                      │
   │ ④ custom.flowscope.metric_rules 评估                 │
   │    计算 SQL 指纹 → 分组比较 → 检测重复                 │
   │    检查写入冲突（多脚本写同一表）                       │
   │                                                      │
   │ ⑤ custom.flowscope.security_rules 评估               │
   │    检查 SQL 文本中的敏感模式                           │
   │    检查敏感列名暴露                                    │
   │                                                      │
   │ ⑥ custom.flowscope.modeling_rules 评估 [Tier 2]     │
   │    检查 model_registry 命名/层级                       │
   │                                                      │
   │ ⑦ semantics 评估                                     │
   │    检查模型是否有 owner/description                    │
   │                                                      │
   │ ⑧ quality 评估                                       │
   │    标记为"需运行时验证"（无法静态执行 SQL）              │
   │                                                      │
   │ ⑨ sla 评估                                           │
   │    标记为"需调度系统集成"                              │
   └─────────────────────────────────────────────────────┘
7. 汇总所有违规 → ContractViolation 列表
8. 计算健康分 → GovernanceReport
9. 写入 governance.db
10. 更新 contract_registry（status/violation_count/last_evaluated）
```

### 5.2 契约解析（contract.rs）

```rust
/// 解析 ODCS YAML 文件为 Contract 对象
pub fn parse_contract(yaml: &str) -> Result<Contract>;

/// ODCS 契约完整结构
pub struct Contract {
    pub api_version: String,
    pub kind: String,
    pub id: String,
    pub name: String,
    pub version: String,
    pub status: ContractStatus,           // draft/active/violated/archived

    // ODCS 标准部分
    pub schema: Vec<SchemaDefinition>,     // 期望的数据模型
    pub semantics: Vec<SemanticRule>,      // 业务语义规则
    pub references: Vec<Reference>,        // 跨表依赖
    pub quality: Vec<QualityRule>,         // 质量断言（运行时）
    pub sla: Option<Sla>,                  // SLA（运行时）
    pub owners: Vec<Owner>,

    // FlowScope 扩展
    pub flowscope: Option<FlowScopeRules>,
}

/// FlowScope 专有规则集合
pub struct FlowScopeRules {
    pub lineage_rules: Vec<LineageRule>,
    pub sql_rules: Vec<SqlRule>,
    pub metric_rules: Vec<MetricRule>,
    pub security_rules: Vec<SecurityRule>,
    pub modeling_rules: Vec<ModelingRule>,
}

/// 扫描 contracts/ 目录，返回所有 .odcs.yaml 文件路径
pub fn scan_contract_files(dir: &Path) -> Vec<PathBuf>;
```

### 5.3 评估器（evaluator.rs）

```rust
/// 契约评估结果
pub struct EvaluationResult {
    pub contract_id: String,
    pub contract_name: String,
    pub violations: Vec<ContractViolation>,
    pub evaluated_at: String,
}

/// 单个契约违规
pub struct ContractViolation {
    pub contract_id: String,
    pub rule_id: String,              // "no_cross_layer"
    pub rule_section: String,         // "lineage_rules" / "sql_rules" / ...
    pub severity: Severity,           // P0 / P1 / P2
    pub title: String,
    pub detail: serde_json::Value,
    pub file_paths: Vec<String>,
}

/// 评估单个契约
pub fn evaluate_contract(
    contract: &Contract,
    ctx: &GovernanceContext,
) -> EvaluationResult;

/// 评估所有活跃契约
pub fn evaluate_all_contracts(
    contracts: &[Contract],
    ctx: &GovernanceContext,
) -> Vec<EvaluationResult>;

/// GovernanceContext 包含评估所需的全部输入
pub struct GovernanceContext<'a> {
    pub project_id: &'a str,
    pub file_results: &'a [(String, AnalyzeResult)],
    pub table_edges: &'a [TableLevelEdge],
    pub table_metadata: &'a [TableMetadata],
    pub fingerprints: &'a [Fingerprint],
    pub model_registry: &'a [ModelEntry],     // [Tier 2]
}
```

### 5.4 评估能力矩阵

| 契约 section | 评估方式 | 静态分析能力 | 说明 |
|---|---|---|---|
| `schema` | SQL 输出列对比契约期望 | ✅ 完全可静态评估 | FlowScope 核心能力 |
| `semantics` | 检查 model_registry 元数据 | ✅ 完全可静态评估 | Tier 2 建模后完整 |
| `references` | 血缘图验证依赖关系 | ✅ 完全可静态评估 | table_level_edges |
| `custom.flowscope.lineage_rules` | 血缘图结构检测 | ✅ 完全可静态评估 | FlowScope 核心能力 |
| `custom.flowscope.sql_rules` | SQL AST 分析 | ✅ 完全可静态评估 | 复用 lint 引擎 |
| `custom.flowscope.metric_rules` | SQL 指纹比较 | ✅ 完全可静态评估 | 指纹算法 |
| `custom.flowscope.security_rules` | 启发式模式匹配 | ✅ 完全可静态评估 | 列名/文本模式 |
| `custom.flowscope.modeling_rules` | model_registry 检查 | ✅ 完全可静态评估 | Tier 2 |
| `quality` | **需要执行 SQL** | ❌ 标记"待运行时验证" | Tier 3 采集器 |
| `sla` | **需要调度系统数据** | ❌ 标记"不适用" | Tier 3 集成 |

## 6. Tier 1 功能需求

### 6.1 SQL 指纹算法

**输入**：从 `project_file_results.result_json` 读取的 `AnalyzeResult`

**处理流程**：
1. 遍历所有 `data_flow` edges，提取 `expression` 字段
2. 归一化变换：
   - 小写化所有标识符
   - 表名/别名 → `<T>` 占位符
   - 列名 → `<COL>` 占位符（保留聚合函数名：SUM/COUNT/AVG/MIN/MAX）
   - 字面量 → `<LITERAL>` 占位符
   - 保留 SQL 结构（JOIN/WHERE/GROUP BY/HAVING 顺序）
3. SHA256 哈希 → `canonical_fingerprint`
4. 同时保留 `structured_signature`（操作符+函数序列）用于相似度计算

**归一化示例**：
```sql
-- 原始A
INSERT INTO dws_gmv SELECT SUM(amount) FROM orders WHERE dt='2024-01-01'
-- 归一化
INSERT INTO <T> SELECT SUM(<COL>) FROM <T> WHERE <COL>=<LITERAL>

-- 原始B
INSERT INTO dws_revenue SELECT SUM(pay_amount) FROM payments WHERE dt='2024-01-01'
-- 归一化后相同 → 指纹相同 → 触发 no_duplicate_computation 违规
```

### 6.2 重复检测

由 `evaluator.rs` 在评估 `metric_rules` 时调用：

| 违规类型 | 检测逻辑 | 对应契约规则 |
|----------|----------|-------------|
| 完全重复 | `canonical_fingerprint` 相同 | `no_duplicate_computation` |
| 写入冲突 | 多脚本写同一物理表 | `no_write_conflict` |
| 逻辑相似 | `structured_signature` Jaccard > 阈值 | `no_duplicate_computation` |
| 孤儿产出 | 写入表无下游引用 | `no_orphan_output` |

### 6.3 健康分（从契约违规计算）

不再硬编码五维模型，健康分直接从契约违规计算：

```rust
/// 计算健康分
fn calculate_health_score(violations: &[ContractViolation]) -> u32 {
    let penalty: u32 = violations.iter().map(|v| match v.severity {
        Severity::P0 => 10,
        Severity::P1 => 5,
        Severity::P2 => 2,
    }).sum();
    100u32.saturating_sub(penalty)
}
```

**维度展示**（给用户看的分类，从 `rule_section` 推导）：

| rule_section | 展示维度 | 说明 |
|---|---|---|
| `schema` | 存储健康 | 列/类型/约束不匹配 |
| `lineage_rules` | 计算健康 | 血缘结构问题 |
| `sql_rules` | 研发健康 | SQL 质量问题 |
| `metric_rules` | 计算健康 | 重复/冲突 |
| `security_rules` | 安全健康 | 敏感信息暴露 |
| `modeling_rules` | 建模健康 | 命名/分层违规 |
| `semantics` | 建模健康 | 元数据缺失 |

### 6.4 API 端点

```
# === 契约管理 ===
GET    /api/governance/contracts                     契约列表
POST   /api/governance/contracts                     创建/上传契约
GET    /api/governance/contracts/:name              契约详情
PUT    /api/governance/contracts/:name              更新契约
DELETE /api/governance/contracts/:name              删除契约
POST   /api/governance/contracts/:name/validate     YAML 格式校验
GET    /api/governance/contracts/:name/diff?v1=1.0&v2=1.1  契约版本对比
GET    /api/governance/contracts/templates          契约模板库
POST   /api/governance/contracts/from-template      从模板创建契约

# === 评估 ===
POST   /api/governance/scan                          全量契约评估
  Body: { "project_id": "xxx" }
  Response: { "report_id": 1, "health_score": 78, "violation_count": 12 }

GET    /api/governance/report?project_id=xxx&limit=5
  Response: [{ "report_id": 1, "health_score": 78, "dimension_scores": {...}, "created_at": "..." }]

GET    /api/governance/health?project_id=xxx
  Response: { "total_score": 78, "dimension_scores": {...}, "trend": [...] }

# === 违规管理 ===
GET    /api/governance/violations?project_id=xxx     违规列表（支持筛选）
POST   /api/governance/violations/:id/assign         指派违规
POST   /api/governance/violations/:id/resolve        解决违规
POST   /api/governance/violations/:id/comment        违规评论
GET    /api/governance/violations/:id/comments       评论列表

# === 违规抑制规则 ===
GET    /api/governance/suppressions                  抑制规则列表
POST   /api/governance/suppressions                  创建抑制规则
DELETE /api/governance/suppressions/:id              删除抑制规则

# === 治理配置 ===
GET    /api/governance/settings                      获取配置
PUT    /api/governance/settings                      更新配置
POST   /api/governance/settings/test-webhook         测试 Webhook

# === 业务域管理 ===
GET    /api/governance/domains                       域列表
POST   /api/governance/domains                       创建域
PUT    /api/governance/domains/:name                 更新域

# === 敏感度分类 ===
GET    /api/governance/classifications               分类列表
POST   /api/governance/classifications               创建分类
PUT    /api/governance/classifications/:name         更新分类

# === 数据源管理 (Tier 3) ===
GET    /api/governance/data-sources                  数据源列表
POST   /api/governance/data-sources                  添加数据源
POST   /api/governance/data-sources/:name/test       测试连接

# === 导出 ===
POST   /api/governance/export/:format
  Body: { "project_id": "xxx", "format": "html|json|datahub|openmetadata" }
  Response: 文件下载
```

### 6.5 前端治理工作台（GovernanceWorkspace）

#### 入口设计

EditorToolbar 新增"数据治理"按钮（与"全局血缘"并列）。点击后主内容区从 EditorArea/GlobalLineageView 切换为 GovernanceWorkspace。

```
┌────────┬──────────────┬──────────────────────────────────┐
│Activity│ Sidebar       │ GovernanceWorkspace               │
│Bar     │ (Files/      │                                    │
│ 📁     │ Search/      │ [📊仪表盘] [📦模型] [📈指标]      │
│ 🔍     │ Schema)      │ [📋契约] [🎨可视化建模] [⚙️设置]  │
│ 🗄️     │              │ ┌──────────────────────────────┐  │
│        │              │ │                              │  │
│        │              │ │  当前 Tab 内容                │  │
│        │              │ │                              │  │
│        │              │ └──────────────────────────────┘  │
├────────┴──────────────┴──────────────────────────────────┤
│ EditorToolbar: [Editor] [全局血缘] [数据治理 ←active] ... │
└──────────────────────────────────────────────────────────┘
```

主内容区三态切换：
- `globalLineageOpen = true` → GlobalLineageView
- `governanceOpen = true` → GovernanceWorkspace
- 两者都 false → EditorArea

#### 状态管理

```typescript
// Workspace.tsx 新增状态
const [governanceOpen, setGovernanceOpen] = useState(false);
const [governanceTab, setGovernanceTab] = useState<GovernanceTab>('dashboard');
// type GovernanceTab = 'dashboard' | 'models' | 'metrics' | 'contracts' | 'designer' | 'settings';
```

#### 6 个 Tab 内容

**Tab 1: 📊 仪表盘**

```
┌──────────────────────────────────────────────────────────┐
│  📊 数据资产健康分: 78/100 (良好)          [🔄 重新扫描]  │
│  ┌─────────────┐  ┌──────────────────────────────────┐  │
│  │  维度分布图  │  │ 趋势图: 75→78→76→78 (近4次)      │  │
│  └─────────────┘  └──────────────────────────────────┘  │
├──────────────────────────────────────────────────────────┤
│  ⚠️ 违规清单 (15)          [P0:2] [P1:5] [P2:8]          │
│  ├─ 🔴 P0 no_update_without_where: etl_sync.sql 无WHERE  │
│  │    负责人: —  [📋详情] [指派] [忽略] [评论(2)]         │
│  ├─ 🔴 P0 no_hardcoded_secrets: auth.sql 含硬编码密码     │
│  ├─ 🟡 P1 no_duplicate_computation: 2个脚本计算逻辑相同   │
│  │         [🔍 差异对比] [⚡ 查看脚本]                    │
│  └─ 🟢 P2 no_select_star: 8处 SELECT *                   │
├──────────────────────────────────────────────────────────┤
│  ℹ️ 待运行时验证 (3)                                      │
│  ├─ quality: "GMV不能为负" — 需数据库连接 [Tier 3]       │
│  └─ sla: "daily刷新" — 需调度系统集成 [Tier 3]           │
└──────────────────────────────────────────────────────────┘
```

组件：`HealthScoreCard` + `ViolationList` + `ViolationDetailDialog` + `GovernanceTrendChart` + `DuplicatePanel`

**Tab 2: 📦 模型管理** — 见 Section 7.1

**Tab 3: 📈 指标管理** — 见 Section 7.2

**Tab 4: 📋 契约管理**

```
┌──────────────────────────────────────────────────────────┐
│  📋 契约管理                          [+ 新建] [导入模板]  │
├──────────────────────────────────────────────────────────┤
│  契约文件列表                                             │
│  ├─ _default.odcs.yaml      [active]  12 violations [编辑]│
│  ├─ orders_pipeline.yaml    [active]   3 violations [编辑]│
│  ├─ payment_domain.yaml     [draft]    — violations [编辑]│
│  └─ user_analytics.yaml     [violated] 8 violations [编辑]│
├──────────────────────────────────────────────────────────┤
│  [选中契约的 YAML 编辑器]                                 │
│  ┌────────────────────────────────────────────────────┐  │
│  │ apiVersion: v3.1.0                                │  │
│  │ kind: DataContract                                │  │
│  │ ...                              [校验✓] [保存]     │  │
│  └────────────────────────────────────────────────────┘  │
├──────────────────────────────────────────────────────────┤
│  契约模板库                                               │
│  ├─ 电商数仓通用模板                                      │
│  ├─ 金融风控通用模板                                      │
│  └─ 空白模板                                              │
└──────────────────────────────────────────────────────────┘
```

组件：`ContractManager` + `ContractEditor`（YAML 编辑器+校验） + `ContractTemplateLibrary` + `ContractDiffView`

**Tab 5: 🎨 可视化建模** — 见 Section 7.3

**Tab 6: ⚙️ 设置**

```
┌──────────────────────────────────────────────────────────┐
│  ⚙️ 治理设置                                              │
├──────────────────────────────────────────────────────────┤
│  扫描配置                                                 │
│    定时扫描: [✅ 启用]  Cron: [0 9 * * *]  (每天9点)      │
│    告警阈值: 健康分 < [60] 时告警                         │
│                                                           │
│  通知配置                                                 │
│    Webhook: [https://hooks.slack.com/...]                │
│    邮件通知: [data-team@company.com]                     │
│                                                           │
│  数据源配置 (Tier 3)                                      │
│    ├─ MySQL - production  [已连接]  [测试] [编辑]        │
│    └─ [+ 添加数据源]                                      │
│                                                           │
│  违规抑制规则                                             │
│    ├─ 忽略 test_ 前缀脚本的 SELECT * 违规                │
│    └─ [+ 添加抑制规则]                                    │
└──────────────────────────────────────────────────────────┘
```

组件：`GovernanceSettings` + `DataSourceConfig` + `SuppressionRules`

#### 完整前端组件清单

```
app/src/components/governance/
├── GovernanceWorkspace.tsx              工作台主容器（Tab 管理）
├── dashboard/
│   ├── HealthScoreCard.tsx              健康分 + 维度分布
│   ├── ViolationList.tsx                违规清单（P0/P1/P2 分组）
│   ├── ViolationDetailDialog.tsx        违规详情（评论/指派/状态）
│   ├── ViolationCommentList.tsx         违规评论列表
│   ├── DuplicatePanel.tsx              重复检测面板
│   └── GovernanceTrendChart.tsx        历史趋势折线图
├── model/
│   ├── ModelManager.tsx                 模型管理主容器
│   ├── ModelListPanel.tsx              列表 + 搜索 + 筛选 + 排序 + 分页
│   ├── ModelDetailPanel.tsx            详情页（多 Tab）
│   ├── ModelColumnTable.tsx            字段管理表格
│   ├── ModelRelationGraph.tsx          关联关系图
│   ├── ModelLifecycleBadge.tsx         生命周期徽章
│   ├── ModelBatchDialog.tsx            批量操作对话框
│   ├── ModelStatsPanel.tsx             统计仪表盘
│   ├── ModelCompareView.tsx            模型对比视图
│   └── ModelAuditLog.tsx               变更审计日志
├── metric/
│   ├── MetricManager.tsx               指标管理主容器
│   ├── MetricListPanel.tsx             列表 + 搜索 + 筛选
│   ├── MetricDetailPanel.tsx           详情页（定义/计算/绑定/冲突/审计）
│   ├── MetricConflictReport.tsx        口径冲突对比
│   ├── MetricBatchDialog.tsx           批量操作
│   ├── MetricStatsPanel.tsx            统计
│   └── MetricAuditLog.tsx              变更审计
├── contract/
│   ├── ContractManager.tsx             契约列表 + 管理
│   ├── ContractEditor.tsx              YAML 编辑器 + 校验
│   ├── ContractTemplateLibrary.tsx     模板库
│   └── ContractDiffView.tsx            契约版本对比
├── designer/
│   └── VisualModelDesigner.tsx         可视化建模画布
├── settings/
│   ├── GovernanceSettings.tsx          全局设置
│   ├── DataSourceConfig.tsx            数据源配置
│   └── SuppressionRules.tsx            违规抑制规则
└── NotificationCenter.tsx              通知中心（新违规/已解决）
```

### 6.6 持久化

#### 文件层（source of truth）

```
<project_dir>/contracts/
├── _default.odcs.yaml           ← 内置默认契约（首次启动自动生成）
├── orders_pipeline.odcs.yaml    ← 用户定义的业务管道契约
├── user_analytics.odcs.yaml
└── payment_domain.odcs.yaml
```

- YAML 文件是 Git 可追踪的，团队可 review
- 用户直接编辑文件，或通过 API/UI 编辑
- `contracts/` 目录在 watch_dirs 监控范围内，文件变更触发自动重新评估

#### governance.db

> **表设计规范**：所有表必须包含 `status INTEGER NOT NULL DEFAULT 1`（0=禁用/删除，1=启用）、`created_at TEXT`、`updated_at TEXT` 三个字段。

```sql
-- 契约注册表（文件元数据）
CREATE TABLE IF NOT EXISTS contract_registry (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id      TEXT    NOT NULL,
    contract_name   TEXT    NOT NULL,
    file_path       TEXT    NOT NULL,
    version         TEXT    NOT NULL DEFAULT '1.0.0',
    status          INTEGER NOT NULL DEFAULT 1,
    contract_hash   TEXT    NOT NULL DEFAULT '',
    last_evaluated  TEXT    NOT NULL DEFAULT '',
    violation_count INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT    NOT NULL DEFAULT '',
    updated_at      TEXT    NOT NULL DEFAULT '',
    UNIQUE(project_id, contract_name)
);

-- 治理评估报告
CREATE TABLE IF NOT EXISTS governance_reports (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id             TEXT    NOT NULL,
    report_json            TEXT    NOT NULL,
    health_score           INTEGER NOT NULL DEFAULT 0,
    dimension_scores_json  TEXT    NOT NULL DEFAULT '{}',
    file_count             INTEGER NOT NULL DEFAULT 0,
    violation_count        INTEGER NOT NULL DEFAULT 0,
    status                 INTEGER NOT NULL DEFAULT 1,
    created_at             TEXT    NOT NULL DEFAULT '',
    updated_at             TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_gov_reports_project ON governance_reports(project_id);

-- 契约违规记录
CREATE TABLE IF NOT EXISTS governance_violations (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id      TEXT    NOT NULL,
    report_id       INTEGER NOT NULL,
    contract_id     TEXT    NOT NULL,
    rule_id         TEXT    NOT NULL,
    rule_section    TEXT    NOT NULL,
    severity        TEXT    NOT NULL,
    title           TEXT    NOT NULL,
    detail_json     TEXT    NOT NULL,
    file_paths      TEXT    NOT NULL DEFAULT '',
    assignee        TEXT    NOT NULL DEFAULT '',
    status          INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT    NOT NULL DEFAULT '',
    updated_at      TEXT    NOT NULL DEFAULT '',
    FOREIGN KEY(report_id) REFERENCES governance_reports(id)
);
CREATE INDEX IF NOT EXISTS idx_gov_violations_project ON governance_violations(project_id);
CREATE INDEX IF NOT EXISTS idx_gov_violations_severity ON governance_violations(project_id, severity);
CREATE INDEX IF NOT EXISTS idx_gov_violations_assignee ON governance_violations(project_id, assignee);

-- 违规评论
CREATE TABLE IF NOT EXISTS violation_comments (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id      TEXT    NOT NULL,
    violation_id    INTEGER NOT NULL,
    author          TEXT    NOT NULL DEFAULT '',
    content         TEXT    NOT NULL,
    status          INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT    NOT NULL DEFAULT '',
    updated_at      TEXT    NOT NULL DEFAULT '',
    FOREIGN KEY(violation_id) REFERENCES governance_violations(id)
);
CREATE INDEX IF NOT EXISTS idx_violation_comments_violation ON violation_comments(violation_id);

-- 违规抑制规则
CREATE TABLE IF NOT EXISTS violation_suppressions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id      TEXT    NOT NULL,
    rule_id         TEXT    NOT NULL,
    pattern         TEXT    NOT NULL DEFAULT '',
    file_pattern    TEXT    NOT NULL DEFAULT '',
    reason          TEXT    NOT NULL DEFAULT '',
    expires_at      TEXT    NOT NULL DEFAULT '',
    status          INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT    NOT NULL DEFAULT '',
    updated_at      TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_violation_suppressions_project ON violation_suppressions(project_id);

-- 业务域管理
CREATE TABLE IF NOT EXISTS domain_registry (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id      TEXT    NOT NULL,
    domain_name     TEXT    NOT NULL,
    description     TEXT    NOT NULL DEFAULT '',
    owner           TEXT    NOT NULL DEFAULT '',
    status          INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT    NOT NULL DEFAULT '',
    updated_at      TEXT    NOT NULL DEFAULT '',
    UNIQUE(project_id, domain_name)
);

-- 敏感度分类目录
CREATE TABLE IF NOT EXISTS classification_catalog (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id      TEXT    NOT NULL,
    classification  TEXT    NOT NULL,
    severity        TEXT    NOT NULL DEFAULT 'low',
    column_patterns TEXT    NOT NULL DEFAULT '[]',
    description     TEXT    NOT NULL DEFAULT '',
    status          INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT    NOT NULL DEFAULT '',
    updated_at      TEXT    NOT NULL DEFAULT '',
    UNIQUE(project_id, classification)
);

-- 全局治理配置
CREATE TABLE IF NOT EXISTS governance_settings (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id      TEXT    NOT NULL UNIQUE,
    scan_cron       TEXT    NOT NULL DEFAULT '',
    alert_threshold INTEGER NOT NULL DEFAULT 60,
    webhook_url     TEXT    NOT NULL DEFAULT '',
    notify_emails   TEXT    NOT NULL DEFAULT '[]',
    settings_json   TEXT    NOT NULL DEFAULT '{}',
    status          INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT    NOT NULL DEFAULT '',
    updated_at      TEXT    NOT NULL DEFAULT ''
);

-- 外部数据源连接配置（Tier 3）
CREATE TABLE IF NOT EXISTS governance_data_sources (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id      TEXT    NOT NULL,
    source_name     TEXT    NOT NULL,
    source_type     TEXT    NOT NULL,
    connection_json TEXT    NOT NULL DEFAULT '{}',
    description     TEXT    NOT NULL DEFAULT '',
    status          INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT    NOT NULL DEFAULT '',
    updated_at      TEXT    NOT NULL DEFAULT '',
    UNIQUE(project_id, source_name)
);

-- ODCS quality 运行时检查结果（Tier 3）
CREATE TABLE IF NOT EXISTS quality_check_results (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id      TEXT    NOT NULL,
    contract_id     TEXT    NOT NULL,
    quality_rule_id TEXT    NOT NULL,
    passed          INTEGER NOT NULL DEFAULT 0,
    actual_value    TEXT    NOT NULL DEFAULT '',
    expected_value  TEXT    NOT NULL DEFAULT '',
    error_message   TEXT    NOT NULL DEFAULT '',
    status          INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT    NOT NULL DEFAULT '',
    updated_at      TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_quality_results_contract ON quality_check_results(project_id, contract_id);
```

#### 变更检测机制

```
启动时 / 文件变更时：
  1. 扫描 contracts/ 目录
  2. 每个文件计算 SHA256
  3. 与 contract_registry.contract_hash 对比
  4. hash 变化 → 标记"需要重新评估"
  5. 下次 scan 时重新解析 + 评估
```

## 7. Tier 2 功能需求

### 7.1 模型管理（ODCS 驱动）

#### 7.1.1 定位

模型管理是血缘的**业务封装层**——给血缘节点（表）打上业务语义（层级、域、负责人、生命周期）。模型定义来源于两个通道：

```
通道1: ODCS 契约导入               通道2: 血缘自动推导
contracts/*.odcs.yaml              table_level_edges + table_metadata
  schema:                            ↓
    - name: dws_order_gmv           命名前缀推断层级
      properties: [...]             血缘特征推断模型类型
  ↓                                 ↓
  导入 model_registry               合并到 model_registry
```

#### 7.1.2 模型自动推导逻辑

按命名规则推断分层：

| 命名前缀 | 推断层级 |
|----------|----------|
| `ods_` | ODS |
| `dwd_` | DWD |
| `dws_` | DWS |
| `ads_` / `app_` | ADS |
| `dim_` | DIM |
| 无匹配 | unknown（需手动或 ODCS 指定） |

按血缘特征推断模型类型：

| 血缘特征 | 推断模型类型 |
|----------|-------------|
| `to_table` 出现且有下游引用 | fact / aggregate |
| 只出现在 `from_table`（只读） | dimension / source |
| `table_metadata.table_type = 'view'` | view |
| `table_metadata.temporary = true` | temp |

#### 7.1.3 数据表（governance.db）

```sql
-- 模型注册表
CREATE TABLE IF NOT EXISTS model_registry (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id      TEXT    NOT NULL,
    table_name      TEXT    NOT NULL,
    model_layer     TEXT    NOT NULL DEFAULT '',
    model_type      TEXT    NOT NULL DEFAULT '',
    business_domain TEXT    NOT NULL DEFAULT '',
    owner           TEXT    NOT NULL DEFAULT '',
    lifecycle       TEXT    NOT NULL DEFAULT 'active',
    description     TEXT    NOT NULL DEFAULT '',
    tags            TEXT    NOT NULL DEFAULT '[]',
    source          TEXT    NOT NULL DEFAULT 'auto',
    contract_id     TEXT    NOT NULL DEFAULT '',
    status          INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT    NOT NULL DEFAULT '',
    updated_at      TEXT    NOT NULL DEFAULT '',
    UNIQUE(project_id, table_name)
);
CREATE INDEX IF NOT EXISTS idx_model_registry_layer ON model_registry(project_id, model_layer);
CREATE INDEX IF NOT EXISTS idx_model_registry_domain ON model_registry(project_id, business_domain);
CREATE INDEX IF NOT EXISTS idx_model_registry_owner ON model_registry(project_id, owner);

-- 模型字段管理（列级注释/分类/敏感标记/指标绑定）
CREATE TABLE IF NOT EXISTS model_columns (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id      TEXT    NOT NULL,
    model_id        INTEGER NOT NULL,
    column_name     TEXT    NOT NULL,
    data_type       TEXT    NOT NULL DEFAULT '',
    description     TEXT    NOT NULL DEFAULT '',
    sensitivity     TEXT    NOT NULL DEFAULT '',
    category        TEXT    NOT NULL DEFAULT '',
    bound_metric    TEXT    NOT NULL DEFAULT '',
    status          INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT    NOT NULL DEFAULT '',
    updated_at      TEXT    NOT NULL DEFAULT '',
    UNIQUE(project_id, model_id, column_name),
    FOREIGN KEY(model_id) REFERENCES model_registry(id)
);
CREATE INDEX IF NOT EXISTS idx_model_columns_model ON model_columns(model_id);

-- 模型变更审计日志
CREATE TABLE IF NOT EXISTS model_audit_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id      TEXT    NOT NULL,
    model_id        INTEGER NOT NULL,
    action          TEXT    NOT NULL,
    field_name      TEXT    NOT NULL DEFAULT '',
    old_value       TEXT    NOT NULL DEFAULT '',
    new_value       TEXT    NOT NULL DEFAULT '',
    operator        TEXT    NOT NULL DEFAULT '',
    status          INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT    NOT NULL DEFAULT '',
    updated_at      TEXT    NOT NULL DEFAULT '',
    FOREIGN KEY(model_id) REFERENCES model_registry(id)
);
CREATE INDEX IF NOT EXISTS idx_model_audit_model ON model_audit_log(model_id);
```

#### 7.1.4 完整 API 端点

```
# === 模型注册 ===
POST   /api/governance/models/auto               自动发现 + ODCS导入
POST   /api/governance/models                     手动创建模型
GET    /api/governance/models                     列表（支持搜索/筛选/排序/分页）
  Query: project_id, layer, domain, type, owner, lifecycle, q(搜索), page, page_size, sort
GET    /api/governance/models/:name              模型详情
PUT    /api/governance/models/:name              更新模型
DELETE /api/governance/models/:name              删除模型
POST   /api/governance/models/:name/clone        克隆模型

# === 模型字段管理 ===
GET    /api/governance/models/:name/columns      字段列表
PUT    /api/governance/models/:name/columns/:col 更新字段（注释/分类/敏感标记/绑定指标）

# === 模型生命周期 ===
POST   /api/governance/models/:name/lifecycle    状态流转（draft→active→deprecated→archived）
GET    /api/governance/models/:name/lifecycle    生命周期历史

# === 模型批量操作 ===
POST   /api/governance/models/batch
  Body: { "action": "assign_layer|assign_domain|assign_owner|delete",
          "model_names": [...], "value": "DWS" }

# === 模型搜索 ===
GET    /api/governance/models/search?q=keyword   模糊搜索

# === 模型统计 ===
GET    /api/governance/models/stats
  Response: {
    "total": 120,
    "by_layer": { "ODS": 30, "DWD": 45, "DWS": 35, "ADS": 10 },
    "by_type": { "fact": 40, "dimension": 25, "aggregate": 30 },
    "by_domain": { "orders": 50, "users": 30, "payments": 40 },
    "by_lifecycle": { "draft": 5, "active": 100, "deprecated": 10, "archived": 5 }
  }

# === 模型变更审计 ===
GET    /api/governance/models/:name/audit        变更历史

# === 模型关联视图 ===
GET    /api/governance/models/:name/relations
  Response: {
    "upstream": ["dwd_orders", "dim_date"],
    "downstream": ["ads_daily_report"],
    "bound_metrics": ["gross_merchandise_value"],
    "related_scripts": ["etl_dws_gmv.sql"],
    "related_contracts": ["orders_pipeline"]
  }

# === 模型对比 ===
GET    /api/governance/models/compare?m1=dws_a&m2=dws_b
  Response: { "added": [...], "removed": [...], "modified": [...] }

# === 模型导入导出 ===
POST   /api/governance/models/export              导出（DDL/dbt/ODCS/Excel）
POST   /api/governance/models/import              导入
```

#### 7.1.5 模型详情页

```
┌──────────────────────────────────────────────────────────┐
│  ◄ 返回列表    dws_order_gmv              [编辑] [克隆]   │
│  层级: DWS  类型: aggregate  域: orders  负责人: alice     │
│  生命周期: [draft] → [active ✓] → [deprecated] → [archived]│
│  标签: [core] [production]                                │
├──────────────────────────────────────────────────────────┤
│  [基础信息] [字段] [血缘关系] [关联] [变更历史]           │
├──────────────────────────────────────────────────────────┤
│  ── 字段 Tab ──                                          │
│  ┌──────────┬──────────┬────────┬──────┬──────────────┐ │
│  │ column   │ type     │ 分类   │ 敏感 │ 绑定指标     │ │
│  ├──────────┼──────────┼────────┼──────┼──────────────┤ │
│  │ order_id │ string   │ key    │ none │              │ │
│  │ gmv      │ number   │ measure│ none │ GMV总额      │ │
│  └──────────┴──────────┴────────┴──────┴──────────────┘ │
│                                                          │
│  ── 血缘关系 Tab ──                                      │
│  上游: dwd_orders → [dws_order_gmv] → ads_daily_report   │
│                                                        │ │
│  ── 关联 Tab ──                                          │
│  关联指标: gross_merchandise_value                       │
│  关联脚本: etl_dws_gmv.sql (写入) / etl_ads.sql (读取)   │
│  关联契约: orders_pipeline.odcs.yaml                     │
│                                                          │
│  ── 变更历史 Tab ──                                      │
│  2026-07-31 alice 将 lifecycle draft→active              │
│  2026-07-30 bob   创建模型                               │
└──────────────────────────────────────────────────────────┘
```

#### 7.1.6 前端组件

- `ModelManager.tsx` — 主容器（列表/统计/批量 Tab 切换）
- `ModelListPanel.tsx` — 列表 + 搜索 + 筛选（层级/域/类型/状态/负责人）+ 排序 + 分页
- `ModelDetailPanel.tsx` — 详情页（基础信息/字段/血缘/关联/审计 Tab）
- `ModelColumnTable.tsx` — 字段管理（可编辑注释/分类/敏感标记/绑定指标）
- `ModelRelationGraph.tsx` — 关联关系图（复用 React Flow）
- `ModelLifecycleBadge.tsx` — 生命周期徽章 + 流转操作
- `ModelBatchDialog.tsx` — 批量操作（分配层级/域/负责人）
- `ModelStatsPanel.tsx` — 统计仪表盘（分布饼图/柱状图）
- `ModelCompareView.tsx` — 模型对比（side-by-side 字段差异）
- `ModelAuditLog.tsx` — 变更审计日志列表
- GlobalLineageView 增强 — 节点颜色按层级着色，按业务域过滤

### 7.2 指标管理（ODCS 驱动）

#### 7.2.1 定位

指标定义来自 ODCS 契约的 `schema.properties[].metric` 字段，也可手动创建。指标管理对标模型管理，提供完整的 CRUD + 搜索 + 生命周期 + 冲突追踪 + 审计。

```yaml
schema:
  - name: dws_order_gmv
    properties:
      - name: gmv
        logicalType: number
        metric:
          name: gross_merchandise_value
          aggregation: sum
          description: "GMV总额"
          expression: "SUM(order_amount)"
```

#### 7.2.2 数据表（governance.db）

```sql
-- 指标注册表
CREATE TABLE IF NOT EXISTS metrics_registry (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id      TEXT    NOT NULL,
    metric_name     TEXT    NOT NULL,
    definition      TEXT    NOT NULL,
    sql_signature   TEXT    NOT NULL,
    expression      TEXT    NOT NULL DEFAULT '',
    aggregation     TEXT    NOT NULL DEFAULT '',
    source_tables   TEXT    NOT NULL DEFAULT '',
    dimensions      TEXT    NOT NULL DEFAULT '[]',
    owner           TEXT    NOT NULL DEFAULT '',
    layer           TEXT    NOT NULL DEFAULT '',
    lifecycle       TEXT    NOT NULL DEFAULT 'active',
    contract_id     TEXT    NOT NULL DEFAULT '',
    bound_model     TEXT    NOT NULL DEFAULT '',
    bound_column    TEXT    NOT NULL DEFAULT '',
    status          INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT    NOT NULL DEFAULT '',
    updated_at      TEXT    NOT NULL DEFAULT '',
    UNIQUE(project_id, metric_name)
);
CREATE INDEX IF NOT EXISTS idx_metrics_registry_layer ON metrics_registry(project_id, layer);
CREATE INDEX IF NOT EXISTS idx_metrics_registry_owner ON metrics_registry(project_id, owner);

-- 指标口径冲突追踪
CREATE TABLE IF NOT EXISTS metric_conflicts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id      TEXT    NOT NULL,
    conflict_type   TEXT    NOT NULL,
    metric_ids      TEXT    NOT NULL DEFAULT '[]',
    detail_json     TEXT    NOT NULL DEFAULT '{}',
    resolution      TEXT    NOT NULL DEFAULT '',
    resolved        INTEGER NOT NULL DEFAULT 0,
    status          INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT    NOT NULL DEFAULT '',
    updated_at      TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_metric_conflicts_project ON metric_conflicts(project_id);

-- 指标变更审计日志
CREATE TABLE IF NOT EXISTS metric_audit_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id      TEXT    NOT NULL,
    metric_id       INTEGER NOT NULL,
    action          TEXT    NOT NULL,
    field_name      TEXT    NOT NULL DEFAULT '',
    old_value       TEXT    NOT NULL DEFAULT '',
    new_value       TEXT    NOT NULL DEFAULT '',
    operator        TEXT    NOT NULL DEFAULT '',
    status          INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT    NOT NULL DEFAULT '',
    updated_at      TEXT    NOT NULL DEFAULT '',
    FOREIGN KEY(metric_id) REFERENCES metrics_registry(id)
);
CREATE INDEX IF NOT EXISTS idx_metric_audit_metric ON metric_audit_log(metric_id);
```

#### 7.2.3 口径冲突检测

| 冲突类型 | 检测逻辑 |
|----------|----------|
| 同名异义 | `metric_name` 相同，`sql_signature` 不同 |
| 异名同义 | `metric_name` 不同，`sql_signature` 相同 |
| 层级违规 | 同一指标在多个 `layer` 出现 |
| 表达式漂移 | 同一指标 `expression` 发生变化（版本对比） |

#### 7.2.4 完整 API 端点

```
# === 指标 CRUD ===
POST   /api/governance/metrics                    创建指标
GET    /api/governance/metrics                    列表（搜索/筛选/排序/分页）
  Query: project_id, layer, owner, lifecycle, q, page, page_size
GET    /api/governance/metrics/:name             指标详情
PUT    /api/governance/metrics/:name             更新指标
DELETE /api/governance/metrics/:name             删除指标

# === 指标生命周期 ===
POST   /api/governance/metrics/:name/lifecycle   状态流转
GET    /api/governance/metrics/:name/lifecycle   生命周期历史

# === 口径冲突 ===
GET    /api/governance/metrics/conflicts         冲突列表
POST   /api/governance/metrics/conflicts/:id/resolve  解决冲突

# === 指标搜索 ===
GET    /api/governance/metrics/search?q=keyword  模糊搜索

# === 指标批量操作 ===
POST   /api/governance/metrics/batch
  Body: { "action": "assign_owner|assign_layer|delete", "metric_names": [...] }

# === 指标统计 ===
GET    /api/governance/metrics/stats
  Response: {
    "total": 85,
    "by_layer": { "DWS": 50, "ADS": 35 },
    "by_owner": { "alice": 40, "bob": 45 },
    "by_lifecycle": { "draft": 3, "active": 70, "deprecated": 12 },
    "conflict_count": 5
  }

# === 指标变更审计 ===
GET    /api/governance/metrics/:name/audit       变更历史
```

#### 7.2.5 指标详情页

```
┌──────────────────────────────────────────────────────────┐
│  ◄ 返回列表    gross_merchandise_value    [编辑]          │
│  层级: DWS  负责人: alice  生命周期: [active]             │
│  定义: GMV总额                                            │
├──────────────────────────────────────────────────────────┤
│  [基础信息] [计算逻辑] [绑定模型] [冲突] [变更历史]       │
├──────────────────────────────────────────────────────────┤
│  ── 计算逻辑 Tab ──                                      │
│  聚合方式: SUM                                           │
│  表达式: SUM(order_amount)                               │
│  来源表: dwd_orders                                      │
│  维度: dt, region, channel                               │
│  SQL签名: a3f8b2c1...                                    │
│                                                          │
│  ── 绑定模型 Tab ──                                      │
│  绑定到: dws_order_gmv.gmv                               │
│                                                          │
│  ── 冲突 Tab ──                                          │
│  ⚠️ 异名同义: net_revenue 有相同 SQL签名                 │
│     [对比详情] [解决]                                     │
│                                                          │
│  ── 变更历史 Tab ──                                      │
│  2026-07-31 alice 修改 expression: SUM(amount)→SUM(order_amount) │
│  2026-07-25 bob   创建指标                               │
└──────────────────────────────────────────────────────────┘
```

#### 7.2.6 前端组件

- `MetricManager.tsx` — 主容器（列表/统计/批量 Tab 切换）
- `MetricListPanel.tsx` — 列表 + 搜索 + 筛选 + 排序 + 分页
- `MetricDetailPanel.tsx` — 详情页（基础信息/计算逻辑/绑定模型/冲突/审计 Tab）
- `MetricConflictReport.tsx` — 口径冲突对比视图（side-by-side 表达式 diff）
- `MetricBatchDialog.tsx` — 批量操作
- `MetricStatsPanel.tsx` — 统计仪表盘
- `MetricAuditLog.tsx` — 变更审计日志

### 7.3 可视化建模工具

复用 React Flow，新增画布式模型设计器：

| 功能 | 描述 |
|------|------|
| 拖拽设计 | 在画布上拖拽表节点，连线定义表关系（外键/血缘） |
| DDL 生成 | 从模型定义（字段+类型+约束）自动生成 `CREATE TABLE` 语句 |
| 逆向工程 | 解析现有 SQL 文件 → 自动生成模型关系图 |
| 模型 diff | 两个版本的模型定义对比（新增/删除/修改字段） |
| 导出 | ER 图图片 / Mermaid / dbt schema.yml / ODCS YAML |

**核心模块**：`server/governance/designer.rs`

```rust
pub fn generate_ddl(model: &ModelDefinition, dialect: Dialect) -> String;
pub fn reverse_engineer(sql: &str, dialect: Dialect) -> Vec<ModelDefinition>;
pub fn diff_models(old: &ModelDefinition, new: &ModelDefinition) -> ModelDiff;
```

**API 端点**：

```
POST /api/governance/gen-ddl
  Body: { "model": {...}, "dialect": "postgresql" }
  Response: { "ddl": "CREATE TABLE dws_order_gmv (...)" }

POST /api/governance/reverse-engineer
  Body: { "sql": "...", "dialect": "snowflake" }
  Response: [{ "table_name": "...", "columns": [...] }]

GET /api/governance/model-diff?model=dws_order_gmv&v1=1.0&v2=1.1
  Response: { "added": [...], "removed": [...], "modified": [...] }
```

### 7.4 契约管理增强

#### YAML 校验

上传/编辑契约时实时校验 ODCS 格式合法性：
- 必填字段检查（apiVersion/kind/id/name）
- `custom.flowscope` 规则格式校验（severity 必须是 P0/P1/P2）
- 规则参数类型检查（threshold 必须是数字，patterns 必须是 map）
- 返回行号 + 错误描述

#### 契约模板库

预置常见场景模板：
| 模板 | 适用场景 |
|------|----------|
| 电商数仓通用 | ODS/DWD/DWS/ADS 全链路命名+分层+跨层规则 |
| 金融风控 | 敏感字段强制脱敏 + 审计日志要求 |
| 通用数仓 | 基础命名规范 + 重复检测 + 孤儿检测 |
| 空白模板 | 仅框架，用户自定义 |

#### 契约版本对比

对比两个版本的契约 YAML，高亮差异：
```yaml
# v1.0 → v1.1 diff
  custom:
    flowscope:
      sql_rules:
-       - id: no_select_star
-         severity: P2
+       - id: no_select_star
+         severity: P1    # ← 升级严重度
+       - id: no_cte_without_materialized  # ← 新增规则
+         severity: P2
```

### 7.5 健康报告增强

#### 维度分数持久化

`governance_reports.dimension_scores_json` 存储每次评估的各维度分数，支持历史趋势查询：
```json
{"storage": 82, "compute": 76, "dev": 80, "security": 85, "modeling": 71}
```

#### 定时扫描

通过 `governance_settings.scan_cron` 配置定时评估：
- 支持标准 cron 表达式（如 `0 9 * * *` 每天9点）
- 后台定时任务自动触发 `POST /api/governance/scan`
- 扫描完成后检查告警阈值

#### 告警通知

健康分低于 `governance_settings.alert_threshold` 时触发通知：
- **Webhook**：POST 到 `webhook_url`，发送 JSON 格式告警
- **邮件**：发送到 `notify_emails` 列表
- **前端通知**：NotificationCenter 组件显示告警

#### 违规工作流

```
违规生命周期: open → assigned → in_progress → resolved → closed
                                                      ↘ ignored
```

- **指派**：将违规指派给负责人（`governance_violations.assignee`）
- **评论**：在违规下讨论处理方案（`violation_comments` 表）
- **解决**：标记为已解决
- **忽略**：已知/可接受的违规标记为忽略
- **抑制**：通过 `violation_suppressions` 规则自动忽略匹配的违规

#### 违规抑制规则

```yaml
# 抑制规则示例：忽略 test_ 前缀脚本的 SELECT * 违规
rule_id: no_select_star
file_pattern: "^test_.*\\.sql$"
reason: "测试脚本豁免"
expires_at: "2026-12-31"
```

评估引擎在生成违规前，先检查抑制规则，匹配的违规不生成。

### 7.6 基础设施

#### Webhook 通知

扫描完成后，如果配置了 webhook，POST 事件通知：
```json
{
  "event": "governance.scan.completed",
  "project_id": "xxx",
  "health_score": 78,
  "violation_count": 12,
  "p0_count": 2,
  "report_id": 1,
  "timestamp": "2026-07-31T09:00:00Z"
}
```

#### 指纹缓存

大项目（>500 文件）下缓存 SQL 指纹提升性能：
- 文件内容 hash 不变时复用缓存的指纹
- 仅 hash 变化的文件重新计算
- 缓存存储在内存中（不持久化），进程重启时重建

#### 外部平台导出

将 FlowScope 治理数据导出为外部平台格式：
| 目标平台 | 格式 | 用途 |
|----------|------|------|
| DataHub | metadata aspect JSON | 导入 DataHub 元数据管理 |
| OpenMetadata | entity JSON | 导入 OpenMetadata 治理 |
| dbt | schema.yml | 生成 dbt 模型+测试定义 |

## 8. Tier 3 功能需求（概要）

### 8.1 ODCS Quality 运行时执行

Tier 1 将 quality 断言标记为"待运行时验证"。Tier 3 通过外部数据库连接实际执行：

```rust
// Tier 3: 执行 ODCS quality 断言
pub async fn execute_quality_check(
    quality_rule: &QualityRule,
    db_connection: &DbConnection,
) -> Result<QualityResult>;
```

### 8.2 外部元数据采集

```rust
pub trait MetadataCollector: Send + Sync {
    fn name(&self) -> &str;
    fn collect_tables(&self) -> Result<Vec<TableMetadata>>;
    fn collect_columns(&self, table: &str) -> Result<Vec<ColumnMetadata>>;
}
```

实现顺序：MySQL → PostgreSQL → ClickHouse → Hive → Doris

### 8.3 LLM 治理助手

- RAG 架构：治理知识库 + GovernanceReport 上下文
- 输出：自然语言修复建议 + 可执行 SQL
- 接口：`POST /api/governance/ai-suggest { violation_id }`

### 8.4 实时更新

- 监听调度平台任务变更事件
- 增量更新 lineage + governance 数据

## 9. 技术设计

### 9.1 模块结构

```
crates/capybara-cli/src/server/governance/
├── mod.rs          模块入口，核心类型定义
├── contract.rs     ODCS YAML 解析 + custom.flowscope 扩展 + 校验 + 模板
├── evaluator.rs    契约评估引擎（含违规抑制过滤）
├── fingerprint.rs  SQL 指纹算法（归一化哈希 + 缓存）
├── duplicate.rs    重复检测（被 evaluator 调用）
├── health.rs       健康分（从违规计算 + 维度分数持久化）
├── db.rs           governance.db 管理（16 张表）
├── model.rs        模型管理（ODCS导入 + 血缘推导 + 字段 + 审计 + 关联）[Tier 2]
├── metric.rs       指标管理（ODCS metric定义 + 冲突 + 审计）[Tier 2]
├── designer.rs     可视化建模（DDL/逆向/diff）[Tier 2]
├── notify.rs       通知（Webhook + 邮件 + 告警）[Tier 2]
├── scheduler.rs    定时扫描（Cron 调度）[Tier 2]
├── collector.rs    外部元数据采集 [Tier 3]
└── report.rs       报告生成与导出（HTML/JSON/DataHub/OpenMetadata）
```

### 9.2 核心数据结构

```rust
#[derive(Serialize, ToSchema)]
pub struct GovernanceReport {
    pub project_id: String,
    pub health_score: u32,
    pub dimension_scores: BTreeMap<String, u32>,
    pub violations: Vec<ContractViolation>,
    pub pending_runtime: Vec<ContractViolation>,  // quality/sla 待运行时
    pub summary: GovernanceSummary,
    pub created_at: String,
}

#[derive(Serialize, ToSchema)]
pub struct ContractViolation {
    pub contract_id: String,
    pub contract_name: String,
    pub rule_id: String,
    pub rule_section: String,     // lineage_rules / sql_rules / ...
    pub severity: Severity,       // P0 / P1 / P2
    pub title: String,
    pub detail: serde_json::Value,
    pub file_paths: Vec<String>,
    pub status: String,           // open / resolved / ignored
}

#[derive(Serialize, ToSchema)]
pub enum Severity { P0, P1, P2 }
```

### 9.3 数据流

```
1. 启动时扫描 contracts/ 目录 → 解析 ODCS YAML → 计算 hash
2. hash 变化的契约标记"需要重新评估"
3. 前端调用 POST /api/governance/scan
4. 后端从 flowscope.db 只读 project_file_results + table_level_edges
5. 计算 SQL 指纹（fingerprint.rs）
6. evaluator.rs 逐个评估活跃契约的所有规则
7. 汇总违规 → health.rs 计算健康分
8. 组装 GovernanceReport → 写入 governance.db
9. 更新 contract_registry（violation_count / last_evaluated / status）
10. 返回报告 → 前端渲染 Dashboard
```

### 9.4 文件变更与重评估

```
contracts/ 在 watch_dirs 监控范围内
  ↓ 文件变更
watcher 检测到 .yaml 变更
  ↓
重新扫描 contracts/，计算 hash
  ↓
hash 变化 → 标记"需要重新评估"
  ↓
前端 Dashboard 显示"契约已更新，建议重新扫描"
  ↓
用户点击"重新扫描" → POST /api/governance/scan
```

### 9.5 前端依赖

- `recharts` — 维度分布图 + 趋势图（需确认是否已有）
- `lucide-react` — Shield 图标（已有）
- `@monaco-editor/react` 或简单 textarea — 契约 YAML 编辑器

## 10. 实施计划

### Tier 1（2周）

| 阶段 | 天数 | 任务 |
|------|------|------|
| 契约解析 | Day 1-2 | contract.rs：ODCS YAML 解析 + custom.flowscope 扩展 + YAML 校验 |
| 指纹算法 | Day 2-3 | fingerprint.rs：SQL 归一化 + SHA256 + 缓存 |
| 评估引擎 | Day 3-5 | evaluator.rs：5 类规则评估 + 违规抑制过滤 |
| 数据库 | Day 5 | db.rs：governance.db（6 张核心表）+ 默认契约生成 |
| 健康分 | Day 5 | health.rs：从违规计算分数 + 维度分数持久化 |
| API | Day 6 | contracts CRUD + scan/report/health + 违规管理端点 |
| 报告 | Day 6 | report.rs：HTML/JSON 导出 |
| 前端 | Day 7-9 | GovernanceWorkspace + 仪表盘 Tab + ViolationList + HealthScoreCard |
| 前端 | Day 9-10 | ContractManager Tab + YAML 编辑器 + 契约校验 |
| 前端 | Day 10-11 | DuplicatePanel + ViolationDetailDialog（评论/指派） |
| 测试 | Day 12-13 | 单元测试 + 集成测试 |
| 集成 | Day 14 | Toolbar 集成 + 文件监听 + e2e 验证 |

### Tier 2（Week 3-6）

| 阶段 | 天数 | 任务 |
|------|------|------|
| 模型管理后端 | Week 3 Day 1-3 | model.rs：ODCS导入 + 血缘推导 + 字段 + 审计 + 关联 + 搜索 + 统计 |
| 模型管理 API | Week 3 Day 4 | models 完整 API（~20 端点）+ batch + compare |
| 模型管理前端 | Week 3 Day 5 - Week 4 Day 2 | ModelManager + ListPanel + DetailPanel + ColumnTable + RelationGraph |
| 模型管理前端 | Week 4 Day 3-4 | ModelBatchDialog + StatsPanel + CompareView + AuditLog + LifecycleBadge |
| 指标管理后端 | Week 4 Day 5 | metric.rs：ODCS定义导入 + 冲突检测 + 审计 + 搜索 + 统计 |
| 指标管理 API | Week 5 Day 1 | metrics 完整 API（~15 端点）+ conflicts |
| 指标管理前端 | Week 5 Day 2-3 | MetricManager + ListPanel + DetailPanel + ConflictReport + Stats |
| 可视化建模 | Week 5 Day 4 - Week 6 Day 2 | designer.rs + VisualModelDesigner + DDL 生成 + 逆向工程 |
| 可视化建模前端 | Week 6 Day 3-4 | VisualModelDesigner 画布 + 模型 diff 视图 |
| 契约增强 | Week 6 Day 5 | 模板库 + 契约 diff |
| 通知/告警 | Week 6 Day 5 | notify.rs + scheduler.rs（定时扫描 + Webhook + 告警） |
| 设置页 | Week 6 Day 5 | GovernanceSettings + DataSourceConfig + SuppressionRules |

### Tier 3（Week 7+）

| 阶段 | 任务 |
|------|------|
| Quality 执行 | ODCS quality 断言运行时执行（需 DB 连接） |
| 外部采集 | collector.rs（MySQL → PG → ClickHouse） |
| LLM 助手 | RAG 架构 + 治理建议生成 |
| 实时更新 | MQ 接入 + 增量血缘更新 |
| 外部导出 | DataHub / OpenMetadata / dbt schema.yml |

## 11. 测试策略

- **单元测试**：
  - ODCS YAML 解析（标准 + 扩展 + 校验）
  - fingerprint 归一化 + 缓存
  - 每类规则评估器独立测试
  - 健康分计算 + 维度分数
  - 违规抑制规则匹配
  - 模型/指标 CRUD + 搜索 + 批量
  - 冲突检测算法
- **集成测试**：
  - 完整 scan → report → health 流程
  - 契约文件变更 → 重评估
  - 默认契约自动生成
  - 定时扫描触发
  - Webhook 通知发送
  - 模型生命周期流转 + 审计记录
- **API 测试**：所有 governance 端点
- **契约兼容性**：验证 ODCS 标准 section 被正确解析

## 12. 非目标

- 不修改 capybara-core（治理逻辑完全在 CLI serve 层）
- 不引入外部依赖（Neo4j/MQ/LLM）—— Tier 3 才考虑
- 不做 WASM 端治理（保持 WASM 包体积不变）
- 不做权限管理/多租户（Tier 3 SaaS 阶段）
- 不执行 ODCS quality 断言（需要 DB 连接，Tier 3）
- 不做 ODCS 标准的 SLA 监控（需要调度系统集成，Tier 3）
