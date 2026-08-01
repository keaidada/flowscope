# ODCS（Open Data Contract Standard）使用指南 v3.1.0

**ODCS** 是 Open Data Contract Standard 的缩写，由 Bitol 社区维护，属于 LF AI & Data Foundation（Linux 基金会）旗下的开放标准。它定义了一套 YAML 格式的数据契约规范，用于让**数据生产者**和**数据消费者**之间建立可信的数据交换约定。可以把数据契约理解为"面向数据的 API 文档"。

> 官方规范：https://bitol-io.github.io/open-data-contract-standard/v3.1.0/
> GitHub：https://github.com/bitol-io/open-data-contract-standard

---

## 目录

- [数据契约是什么](#数据契约是什么)
- [ODCS 文件概览](#odcs-文件概览)
- [1. 基本信息（Fundamentals）](#1-基本信息fundamentals)
- [2. 数据模式（Schema）](#2-数据模式schema)
- [3. 数据质量（Data Quality）](#3-数据质量data-quality)
- [4. 团队（Team）](#4-团队team)
- [5. 角色（Roles）](#5-角色roles)
- [6. 定价（Pricing）](#6-定价pricing)
- [7. 服务等级协议（SLA）](#7-服务等级协议sla)
- [8. 基础设施与服务器（Servers）](#8-基础设施与服务器servers)
- [9. 支持渠道（Support）](#9-支持渠道support)
- [10. 自定义属性（Custom Properties）](#10-自定义属性custom-properties)
- [11. FlowScope 中的 ODCS 用法](#11-flowscope-中的-odcs-用法)
- [附录 A：完整示例](#附录-a完整示例)
- [附录 B：数据质量运算符速查](#附录-b数据质量运算符速查)
- [附录 C：数据质量维度速查](#附录-c数据质量维度速查)

---

## 数据契约是什么

数据契约是一个文档，它定义了一组数据的：

- **结构**（Schema）—— 有哪些表/字段、什么类型
- **质量**（Quality）—— 数据必须满足什么条件（行数、空值率、唯一性等）
- **所有权**（Team）—— 谁负责维护这条数据
- **使用条款**（Terms）—— 什么目的可以用、有什么限制
- **服务水平**（SLA）—— 更新频率、可用性承诺
- **物理位置**（Servers）—— 数据存在哪个服务器、什么数据库

举个例子，一个订单表的数据契约大概是这样的：

```yaml
apiVersion: v3.1.0
kind: DataContract
id: orders
name: 订单表
version: 1.0.0
status: active
schema:
  - name: orders
    physicalType: TABLE
    description: 2020年至今的全部订单
    properties:
      - name: order_id
        logicalType: string
        primaryKey: true
      - name: order_status
        logicalType: string
        quality:
          - metric: invalidValues
            arguments:
              validValues: [pending, shipped, cancelled]
            mustBe: 0
```

这样，数据消费方就能清楚地知道这套数据的结构、质量承诺和使用限制。

---

## ODCS 文件概览

每个 ODCS 契约是一个 `.odcs.yaml` 文件，顶层包含 11 个 Section：

| Section | 说明 | 是否必填 |
|---------|------|---------|
| `apiVersion` | 标准版本号 | **必填** |
| `kind` | 文件类型，固定 `DataContract` | **必填** |
| `id` | 唯一标识符（建议用 UUID） | **必填** |
| `name` | 名称 | 建议 |
| `version` | 契约版本（语义化版本） | **必填** |
| `status` | 状态：proposed/draft/active/deprecated/retired | **必填** |
| ~~`dataProduct`~~ | 所属数据产品 | v3.1.0 起已弃用 |
| `schema` | 数据结构和字段定义 | 可选 |
| `quality` | 数据质量规则 | 可选 |
| `team` | 团队和成员信息 | 可选 |
| `roles` | 数据访问角色 | 可选 |
| `pricing` | 计费信息 | 可选 |
| `serviceLevelAgreements` | SLA 承诺 | 可选 |
| `servers` | 物理数据源连接信息 | 可选 |
| `supportChannels` | 支持渠道 | 可选 |
| `customProperties` | 自定义扩展属性 | 可选 |

---

## 1. 基本信息（Fundamentals）

合同的身份信息，最简写法只需 5 个字段：

```yaml
apiVersion: v3.1.0
kind: DataContract
id: 53581432-6c55-4ba2-a65f-72344a91553a
name: seller_payments_v1
version: 1.1.0
status: active
```

### 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `apiVersion` | string | 是 | 标准版本，当前为 `v3.1.0` |
| `kind` | string | 是 | 固定值 `DataContract` |
| `id` | string | 是 | 唯一 ID，建议用 UUID，避免名称冲突 |
| `name` | string | 建议 | 名称，如 `orders_v1` |
| `version` | string | 是 | 语义化版本号，如 `1.0.0` |
| `status` | string | 是 | `proposed`, `draft`, `active`, `deprecated`, `retired` |
| `tenant` | string | 否 | 租户/组织名（大小写不敏感） |
| `domain` | string | 否 | 逻辑数据域，如 `sales`, `finance` |
| `tags` | array | 否 | 标签，如 `[finance, pii]` |
| `description.purpose` | string | 否 | 数据用途说明 |
| `description.limitations` | string | 否 | 使用限制（技术/合规/法律） |
| `description.usage` | string | 否 | 推荐使用方式 |
| `description.authoritativeDefinitions` | array | 否 | 外部权威定义链接 |
| `authoritativeDefinitions` | array | 否 | 根级别的权威定义链接 |

### 完整 Fundamentals 示例

```yaml
apiVersion: v3.1.0
kind: DataContract
id: 53581432-6c55-4ba2-a65f-72344a91553a
name: seller_payments_v1
version: 1.1.0
status: active
domain: seller
tenant: ClimateQuantumInc
description:
  purpose: 基于卖家表的分析视图
  limitations: 不得用于金融合规报告
  usage: 每日两次，由 ETL 调度触发
tags: [finance, sales]
```

---

## 2. 数据模式（Schema）

Schema 定义数据的结构。

### 核心概念

ODCS v3 引入了一套与物理实现解耦的术语：

| 术语 | 含义 | 对应关系型数据库 |
|------|------|----------------|
| **Object** | 数据的容器 | 表（Table）或视图（View） |
| **Property** | Object 的属性 | 列（Column）或字段（Field） |
| **Element** | Object 或 Property 的统称 | — |

### Schema 对象（Object）完整示例

```yaml
schema:
  - name: orders
    logicalType: object     # 固定值
    physicalType: TABLE     # TABLE / VIEW / TOPIC / FILE
    physicalName: ods_orders
    description: 2020年至今的全部成功和取消订单
    dataGranularityDescription: 每行代表一个订单
    tags: [e-commerce, pii]
    properties:
      - name: order_id
        logicalType: string
        physicalType: UUID
        primaryKey: true
        primaryKeyPosition: 1
        required: true
        unique: true
        description: 内部订单ID（请勿展示给客户）
        criticalDataElement: true
        classification: restricted
        examples: [99e8bb10-3785-4634-9664-8dc79eb69d43]

      - name: order_status
        businessName: 订单状态
        logicalType: string
        physicalType: TEXT
        required: true
        quality:                          # 字段级质量规则
          - metric: invalidValues
            arguments:
              validValues: [pending, shipped, cancelled, refunded]
            mustBe: 0
            description: 只允许这 4 种状态

      - name: order_total
        businessName: 订单金额
        logicalType: integer
        physicalType: INTEGER
        required: true
        description: 订单总金额（分），含税含运费
        examples: [9999, 12500]

      - name: order_timestamp
        businessName: 下单时间
        logicalType: timestamp
        physicalType: TIMESTAMPTZ
        logicalTypeOptions:
          format: "yyyy-MM-ddTHH:mm:ssZ"
          timezone: true
        examples: ["2025-03-01T14:30:00+08:00"]

    # Object 级（表级）质量规则
    quality:
      - type: sql
        query: SELECT COUNT(*) FROM {object}
        mustBeGreaterThan: 1000
        description: 每天至少有 1000 条订单
```

### Schema Object 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | string | 否 | 唯一标识符，用于跨引用 |
| `name` | string | 是 | 逻辑名称 |
| `physicalName` | string | 否 | 物理表名/视图名 |
| `logicalType` | string | 否 | 固定 `object` |
| `physicalType` | string | 否 | `TABLE`, `VIEW`, `TOPIC`, `FILE` |
| `description` | string | 否 | 说明 |
| `dataGranularityDescription` | string | 否 | 数据粒度（如"按国家汇总"） |
| `properties` | array | 否 | 字段列表 |

### Schema Property（字段）主要字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | 是 | 字段名 |
| `businessName` | string | 否 | 业务名称 |
| `logicalType` | string | 否 | `string`, `number`, `integer`, `boolean`, `date`, `timestamp`, `time`, `object`, `array` |
| `physicalType` | string | 否 | 物理类型，如 `VARCHAR(40)`, `INT`, `UUID` |
| `primaryKey` | boolean | 否 | 是否主键 |
| `primaryKeyPosition` | integer | 否 | 主键位置（1 起始） |
| `required` | boolean | 否 | 是否非空 |
| `unique` | boolean | 否 | 是否唯一 |
| `description` | string | 否 | 描述 |
| `classification` | string | 否 | 分类，如 `public`, `restricted`, `confidential` |
| `criticalDataElement` | boolean | 否 | 是否关键数据元素 |
| `tags` | array | 否 | 标签 |
| `examples` | array | 否 | 示例值 |
| `quality` | array | 否 | 字段级质量规则 |
| `transformSourceObjects` | array | 否 | 转换来源表 |
| `transformLogic` | string | 否 | 转换 SQL 逻辑 |
| `transformDescription` | string | 否 | 转换逻辑的描述 |

### 逻辑类型（logicalType）的可选项

| logicalType | JSON Schema 等价 | 说明 |
|-------------|-----------------|------|
| `string` | `"type": "string"` | 文本 |
| `number` | `"type": "number"` | 浮点数 |
| `integer` | `"type": "integer"` | 整数 |
| `boolean` | `"type": "boolean"` | 布尔 |
| `date` | `"type": "string", "format": "date"` | 日期 |
| `timestamp` | `"type": "string", "format": "date-time"` | 日期时间 |
| `time` | `"type": "string", "format": "time"` | 时间 |
| `object` | `"type": "object"` | 嵌套对象（用于 NoSQL） |
| `array` | `"type": "array"` | 数组 |

---

## 3. 数据质量（Data Quality）

数据质量规则是 ODCS 最重要的部分之一。它支持 **4 种类型**：

| 类型 | 说明 | 适用场景 |
|------|------|---------|
| **text** | 纯文本描述 | 人类可读的质量说明 |
| **library** | 预定义的常用指标 | 不需要写 SQL（如 nullValues, rowCount） |
| **sql** | 自定义 SQL 查询 | 复杂质量逻辑 |
| **custom** | 第三方引擎 | Soda, Great Expectations, dbt 等 |

### Library 指标列表

| 指标 | 级别 | 说明 | 参数 |
|------|------|------|------|
| `nullValues` | 字段 | 空值计数 | 无 |
| `missingValues` | 字段 | 缺失值计数 | `missingValues`: 视为缺失的值列表 |
| `invalidValues` | 字段 | 不合规值计数 | `validValues`（有效值列表）或 `pattern`（正则） |
| `duplicateValues` | 字段 | 重复值计数 | 无 |
| `duplicateValues` | 表 | 多字段联合重复 | `properties`: 字段名列表 |
| `rowCount` | 表 | 行数 | 无 |

### 质量规则示例

#### Text 类型

```yaml
quality:
  - type: text
    description: 邮箱地址已通过系统验证
```

#### Library 类型 — 空值检查

```yaml
properties:
  - name: customer_id
    quality:
      - metric: nullValues
        mustBe: 0
        description: 不允许有空值

  - name: order_status
    quality:
      - metric: nullValues
        mustBeLessThan: 1
        unit: percent
        description: 空值率必须小于 1%
```

#### Library 类型 — 有效值校验

```yaml
properties:
  - name: unit
    quality:
      - metric: invalidValues
        arguments:
          validValues: [pounds, kg]
        mustBeLessThan: 5
        unit: rows
```

#### Library 类型 — 正则校验

```yaml
properties:
  - name: iban
    quality:
      - metric: invalidValues
        mustBe: 0
        arguments:
          pattern: '^[A-Z]{2}[0-9]{2}[A-Z0-9]{4}[0-9]{7}([A-Z0-9]?){0,16}$'
```

#### Library 类型 — 表级行数检查

```yaml
schema:
  - name: orders
    quality:
      - metric: rowCount
        mustBeBetween: [100, 1000000]
```

#### Library 类型 — 联合去重检查

```yaml
schema:
  - name: orders
    quality:
      - metric: duplicateValues
        mustBe: 0
        arguments:
          properties: [tenant_id, order_id]
        description: tenant_id + order_id 组合必须唯一
```

#### SQL 类型

```yaml
quality:
  - type: sql
    query: |
      SELECT COUNT(*) FROM orders WHERE order_total <= 0
    mustBe: 0
    description: 不允许存在金额为 0 或负数的订单
```

> 提示：`{object}` 和 `{property}` 占位符会被自动替换为当前的表名和字段名。

#### Custom 类型（第三方引擎）

```yaml
quality:
  - type: custom
    engine: soda
    implementation: |
      type: duplicate_percent
      columns:
        - carrier
        - shipment_number
      must_be_less_than: 1.0

  - type: custom
    engine: greatExpectations
    implementation: |
      type: expect_table_row_count_to_be_between
      kwargs:
        minValue: 10000
        maxValue: 50000
```

### 定时执行

```yaml
quality:
  - type: sql
    query: SELECT COUNT(*) FROM orders WHERE order_total IS NULL
    mustBe: 0
    scheduler: cron
    schedule: "0 8 * * *"     # 每天早上 8 点执行
```

---

## 4. 团队（Team）

记录数据的所有者和联系方式。

```yaml
team:
  name: 销售数据团队
  description: 负责所有销售域数据产品
  members:
    - email: alice@example.com
      name: Alice Wang
      role: Owner
    - email: bob@example.com
      name: Bob Li
      role: Maintainer
```

---

## 5. 角色（Roles）

定义消费者访问数据所需要的角色。

```yaml
roles:
  - name: analyst_us
    description: 美国数据分析师（可以查看全部数据）
  - name: analyst_eu
    description: 欧盟数据分析师（仅查看脱敏数据）
```

---

## 6. 定价（Pricing）

当数据产品需要计费时使用。

```yaml
pricing:
  priceAmount: 0
  priceCurrency: USD
  priceUnit: monthly
  description: 内部使用免费
```

---

## 7. 服务等级协议（SLA）

非功能性承诺。

```yaml
serviceLevelAgreements:
  - property: availability
    value: 99.9%
    description: 数据平台正常运行时间保障

  - property: freshness
    value: 24
    unit: hours
    description: T+24 小时内完成数据更新

  - property: retention
    value: 1
    unit: year
    description: 数据至少保留 1 年
```

---

## 8. 基础设施与服务器（Servers）

指定数据物理存放的位置和连接方式。

```yaml
servers:
  - type: postgres
    host: prod-db.internal.example.com
    port: 5432
    database: analytics
    schema: dp_orders_v1
    description: 生产环境 PostgreSQL 数据库

  - type: s3
    location: s3://my-bucket/orders/
    format: parquet
    description: S3 数据湖备份
```

---

## 9. 支持渠道（Support）

```yaml
supportChannels:
  - type: slack
    url: https://slack.example.com/channels/data-sales
    description: 销售数据团队 Slack 频道

  - type: email
    url: data-sales@example.com
    description: 销售数据团队邮箱
```

---

## 10. 自定义属性（Custom Properties）

ODCS 允许在多个层级添加自定义属性，用于扩展标准之外的需求。

### customProperties 结构

```yaml
customProperties:
  - property: refRulesetName
    value: gcsc.ruleset.name
    description: REF 规则集名称

  - property: dataprocClusterName
    value: prod-cluster-01
    description: Dataproc 集群名
```

### authoritativeDefinitions 结构

用于连接外部权威数据目录。

```yaml
authoritativeDefinitions:
  - url: https://catalog.data.gov/dataset/air-quality
    type: businessDefinition
    description: 数据集的业务定义
  - url: https://github.com/myorg/myrepo
    type: transformationImplementation
  - url: https://bitol-io.github.io/.../full-example.odcs.yaml
    type: canonicalUrl
    description: 数据契约的最新版本
```

### 根级别 `custom` 字段

ODCS v3.1.0 支持在根级别加 `custom` 字段来放组织自定义的结构化数据：

```yaml
custom:
  myOrg:
    governanceLevel: gold
    dataClassification: internal
    costCenter: CC-12345
```

这就是 FlowScope 用来嵌入治理规则的方式（见下文）。

---

## 11. FlowScope 中的 ODCS 用法

FlowScope 利用 ODCS 的 `custom` 字段来存储治理规则。契约文件存放在 `.flowscope/contracts/` 目录下。

### FlowScope 契约结构

```yaml
apiVersion: v3.1.0
kind: DataContract
id: flowscope_default_governance
name: FlowScope Default Governance
version: 1.0.0
status: active

custom:
  flowscope:
    lineage_rules:           # 血缘规则
      - id: no_orphan_output
        description: "产出表必须有下游消费"
        severity: P2

    sql_rules:               # SQL 规范
      - id: no_select_star
        description: "生产脚本禁止 SELECT *"
        severity: P2

    metric_rules:            # 指标规则
      - id: no_duplicate_computation
        description: "禁止重复计算"
        similarity_threshold: 0.85
        severity: P1

    security_rules:          # 安全规则
      - id: no_hardcoded_secrets
        description: "SQL 中禁止硬编码密码"
        severity: P0

    modeling_rules:          # 建模规则
      - id: naming_must_match_layer
        description: "表名前缀必须与层级匹配"
        severity: P2
        patterns:
          ODS: "^ods_"
          DWD: "^dwd_"
          DWS: "^dws_"
          ADS: "^(ads_|app_)"
          DIM: "^dim_"
```

### 治理扫描工作流

```
POST /api/governance/scan
  ↓
1. 读取项目 lineage 数据
2. 生成模型结构
3. 生成/更新契约文件（写入 .flowscope/contracts/）
4. 逐条评估契约规则 vs 实际数据
5. 输出违规清单 + 健康分（0–100）
```

### 严重级别

| 级别 | 扣分 | 含义 |
|------|------|------|
| P0 | -10 | 严重：必须立即修复 |
| P1 | -5 | 重要：建议近期处理 |
| P2 | -2 | 建议：代码规范问题 |

### FlowScope API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/governance/scan` | POST | 执行完整扫描 |
| `/api/governance/health` | GET | 获取健康分 |
| `/api/governance/report` | GET | 获取报告列表 |
| `/api/governance/contracts` | GET | 列出契约文件 |
| `/api/governance/contracts` | POST | 创建新契约 |
| `/api/governance/contracts/{name}` | GET/PUT/DELETE | 查看/修改/删除契约 |
| `/api/governance/contracts/{name}/validate` | GET | 验证 YAML 格式 |
| `/api/governance/export/{format}` | POST | 导出报告（json/mermaid/html/csv/xlsx） |

---

## 附录 A：完整示例

以下是一个完整的 ODCS v3.1.0 契约文件，包含所有常用字段：

```yaml
# ── 基本信息 ──
apiVersion: v3.1.0
kind: DataContract
id: e3b0c442-98fc-4c19-a65f-72344a91553a
name: orders_v1
version: 1.0.0
status: active
domain: sales
tenant: MyCorp
description:
  purpose: 为 BI 报表和实时大屏提供订单数据
  limitations: 不得用于财务审计
  usage: 每小时增量更新
tags: [e-commerce, pii]

# ── 团队 ──
team:
  name: 销售数据团队
  members:
    - email: owner@example.com
      name: 张三
      role: Owner

# ── 角色 ──
roles:
  - name: analyst_full
    description: 可查看全部字段
  - name: analyst_masked
    description: 仅查看脱敏数据

# ── SLA ──
serviceLevelAgreements:
  - property: freshness
    value: 1
    unit: hours
    description: 下单后 1 小时内数据可用
  - property: retention
    value: 2
    unit: years
    description: 保留 2 年

# ── 服务器 ──
servers:
  - type: postgres
    host: prod-db.example.com
    port: 5432
    database: sales
    schema: dp_orders_v1

# ── Schema ──
schema:
  - name: orders
    physicalType: TABLE
    physicalName: ods_orders
    description: 全部订单记录
    properties:

      - name: order_id
        logicalType: string
        physicalType: UUID
        primaryKey: true
        required: true
        description: 订单唯一标识
        classification: internal

      - name: customer_id
        logicalType: string
        physicalType: TEXT
        required: true
        classification: restricted
        quality:
          - metric: nullValues
            mustBe: 0

      - name: order_status
        logicalType: string
        physicalType: TEXT
        required: true
        quality:
          - metric: invalidValues
            arguments:
              validValues: [pending, confirmed, shipped, cancelled]
            mustBe: 0

      - name: order_total
        logicalType: integer
        physicalType: INTEGER
        required: true
        description: 金额（分）

      - name: order_timestamp
        logicalType: timestamp
        physicalType: TIMESTAMPTZ
        logicalTypeOptions:
          format: "yyyy-MM-ddTHH:mm:ssZ"
          timezone: true

    # 表级检查
    quality:
      - metric: rowCount
        mustBeGreaterThan: 1000
        description: 至少 1000 行

# ── 支持渠道 ──
supportChannels:
  - type: slack
    url: https://slack.example.com/data-sales
```

---

## 附录 B：数据质量运算符速查

| 运算符 | 类型 | 含义 | 示例 |
|--------|------|------|------|
| `mustBe` | number | `=` | `mustBe: 0` |
| `mustNotBe` | number | `≠` | `mustNotBe: 3.14` |
| `mustBeGreaterThan` | number | `>` | `mustBeGreaterThan: 59` |
| `mustBeGreaterOrEqualTo` | number | `≥` | `mustBeGreaterOrEqualTo: 60` |
| `mustBeLessThan` | number | `<` | `mustBeLessThan: 1000` |
| `mustBeLessOrEqualTo` | number | `≤` | `mustBeLessOrEqualTo: 999` |
| `mustBeBetween` | [min, max] | `∈ [min, max]` | `mustBeBetween: [0, 100]` |
| `mustNotBeBetween` | [min, max] | `∉ [min, max]` | `mustNotBeBetween: [0, 100]` |

`unit` 可选 `rows` 或 `percent`，默认为 `rows`。

---

## 附录 C：数据质量维度速查

| 维度 | 英文 | 说明 |
|------|------|------|
| 准确性 | accuracy | 数据是否正确 |
| 完整性 | completeness | 是否缺失关键字段 |
| 合规性 | conformity | 是否匹配预设格式/枚举 |
| 一致性 | consistency | 跨表数据是否一致 |
| 覆盖率 | coverage | 数据覆盖范围是否足够 |
| 时效性 | timeliness | 数据是否在承诺时间内更新 |
| 唯一性 | uniqueness | 是否有重复值 |

---

## 参考资源

- 官方规范：https://bitol-io.github.io/open-data-contract-standard/v3.1.0/
- GitHub 仓库：https://github.com/bitol-io/open-data-contract-standard
- 在线编辑器：https://editor.datacontract.com/
- Data Contract CLI：https://github.com/datacontract/datacontract-cli
- FlowScope 契约模板：`.flowscope/contracts/template.odcs.yaml`
