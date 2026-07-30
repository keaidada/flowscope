# dbt 数据建模支持 — 实施规划

## 核心思路

dbt 最终产物是 `manifest.json`（编译后的所有模型、依赖、SQL）。FlowScope **不需要自己实现 Jinja 引擎**——直接解析 dbt 运行后生成的 `manifest.json` 即可拿到完整的模型依赖图和编译后的 SQL。

## 分 4 步实施

### Step 1：解析 `dbt_project.yml`

从项目目录读取 `dbt_project.yml`，提取关键配置：

- `name` — 项目名
- `model-paths` — 模型文件路径（默认 `['models']`）
- `seed-paths` — seed 路径
- `snapshot-paths` — snapshot 路径
- `profile` — 连接 profile 名
- `packages` — 依赖的 dbt 包
- 确定 `manifest.json` 路径（默认 `target/manifest.json`）

**数据结构**：
```rust
struct DbtProjectConfig {
    name: String,
    model_paths: Vec<String>,
    seed_paths: Vec<String>,
    snapshot_paths: Vec<String>,
    manifest_path: String,
}
```

### Step 2：解析 `manifest.json`

读取 `manifest.json`，提取模型元数据和编译后的 SQL。

**关键字段**：

```json
{
  "nodes": {
    "model.my_project.stg_orders": {
      "unique_id": "model.my_project.stg_orders",
      "name": "stg_orders",
      "resource_type": "model",
      "package_name": "my_project",
      "path": "staging/stg_orders.sql",
      "original_file_path": "models/staging/stg_orders.sql",
      "database": "analytics",
      "schema": "staging",
      "alias": "stg_orders",
      "depends_on": {
        "nodes": ["source.my_project.raw.orders"],
        "macros": []
      },
      "compiled_sql": "SELECT ... FROM raw.orders ...",
      "config": {
        "materialized": "table"
      }
    }
  },
  "sources": {
    "source.my_project.raw.orders": {
      "unique_id": "source.my_project.raw.orders",
      "source_name": "orders",
      "database": "raw_data",
      "schema": "public",
      "identifier": "orders"
    }
  },
  "parent_map": {
    "model.my_project.fct_orders": [
      "model.my_project.stg_orders",
      "model.my_project.stg_customers"
    ]
  },
  "child_map": {
    "model.my_project.stg_orders": [
      "model.my_project.fct_orders"
    ]
  }
}
```

**提取内容**：

| 来源字段 | 用途 |
|---------|------|
| `nodes[].unique_id` | FlowScope 文件标识 |
| `nodes[].name` | 模型名 |
| `nodes[].original_file_path` | 文件树路径 |
| `nodes[].depends_on.nodes` | 模型依赖（含 `ref()` 和 `source()`） |
| `nodes[].compiled_sql` | 编译后的纯 SQL（Jinja 已解析） |
| `nodes[].database` / `nodes[].schema` | 目标表位置 |
| `sources[]` | `source()` → 真实表名映射 |
| `parent_map` / `child_map` | 模型 DAG 依赖图 |

### Step 3：构建 DAG + 表名映射

**1. 模型依赖图**

从 `parent_map` 直接构建有向无环图（DAG）：
```
raw.orders ──→ stg_orders ──→ fct_orders
raw.customers ──→ stg_customers ──┘
```

**2. 表名映射规则**

| dbt 宏 | 解析方式 |
|--------|---------|
| `{{ ref('model') }}` | `manifest` 的 `depends_on` 已自动解析，无需手动替换 |
| `{{ ref('pkg', 'model') }}` | 同上，`depends_on` 包含跨包引用 |
| `{{ source('src', 'tbl') }}` | `manifest.sources` 提供 `database.schema.identifier` 映射 |
| `{{ config(...) }}` | 从 `nodes[].config` 读取 materialization 等配置 |
| `{{ var('name') }}` | 从 `dbt_project.yml` 的 `vars` 读取 |

**3. 文件注册**

将每个模型作为 FlowScope 项目文件注册：
```rust
FileSource {
    name: node.original_file_path,        // "models/staging/stg_orders.sql"
    content: node.compiled_sql,            // 编译后的纯 SQL
    transformed_content: None,             // 模型不是存储过程
    is_procedure: false,
}
```

### Step 4：血缘分析集成

**1. 单模型分析**

对每个模型的 `compiled_sql` 调用现有分析流程：
```rust
let request = AnalyzeRequest {
    sql: node.compiled_sql,
    files: None,
    dialect: Dialect::Bigquery (or from profile),
    source_name: Some(node.unique_id),
    ...
};
let result = analyze(&request);
```

**2. 跨模型血缘**

利用 Step 3 的模型依赖 DAG，拼接跨模型的数据流：
- 上游模型的 SELECT 输出 → 下游模型的 FROM 引用
- 全局血缘视图展示完整数据链路

**3. 全局视图**

- **模型列表视图**：展示所有模型及其依赖关系
- **表级血缘图**：从 raw → staging → intermediate → mart 的数据流
- **列级血缘**：跟踪每个模型内列的来源

### 数据处理流

```
dbt_project/                    FlowScope
├── dbt_project.yml       →    Step1: 解析项目配置
├── target/
│   └── manifest.json     →    Step2: 解析模型DAG + compiled_sql
├── models/               →    文件树展示模型
│   ├── staging/
│   └── marts/
                             Step3: 构建DAG + 表名映射
                             Step4: 每个模型 compiled_sql → analyze() → lineage

                             全局血缘视图展示 模型间依赖 + 表级/列级血缘
```

### 关键决策

| 问题 | 方案 |
|------|------|
| Jinja 模板解析 | **不需要**——直接使用 manifest 中的 `compiled_sql` |
| `ref()` 解析 | `manifest.nodes[].depends_on` 已包含依赖列表 |
| `source()` 解析 | `manifest.sources` 提供完整映射 |
| 模型 DAG | `parent_map` / `child_map` 直接可用 |
| dbt 版本兼容 | manifest v10-12（dbt Core ≥1.6） |
| 前端展示 | 复用现有 GlobalLineageView + 新增 DAG 视图 |

### 实施顺序 & 工作量

| 步骤 | 内容 | 预估 |
|------|------|------|
| Step 1 | `dbt_project.yml` 解析 | 半天 |
| Step 2 | `manifest.json` 解析 + 模型提取 | 1 天 |
| Step 3 | DAG 构建 + 表名映射 + 文件注册 | 1 天 |
| Step 4 | 血缘分析集成 + 全局视图 | 1 天 |
| **合计** | | **3-4 天** |

### 前端改动

- 新增 dbt 项目导入入口（选择目录 → 读取 manifest.json）
- 文件树展示 dbt 模型结构（staging/marts 等分层）
- DAG 视图展示模型间依赖关系
- 复用现有 GraphView 展示表级血缘

### 测试用例

使用 `jaffle_shop` 标准 dbt 示例项目作为测试 fixture：
- 5 个模型（customers, orders, payments, stg_customers, stg_orders, stg_payments）
- 3 层结构（staging → intermediate → mart）
- 可验证 ref() 依赖解析、跨模型血缘
