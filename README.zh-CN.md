# FlowScope

[![CI](https://github.com/pondpilot/flowscope/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/pondpilot/flowscope/actions/workflows/ci.yml)
[![Docs](https://img.shields.io/badge/docs-available-brightgreen.svg)](docs/README.md)
[![codecov](https://codecov.io/gh/pondpilot/flowscope/graph/badge.svg)](https://codecov.io/gh/pondpilot/flowscope)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Rust](https://img.shields.io/badge/rust-1.82+-orange.svg)](https://www.rust-lang.org)
[![TypeScript](https://img.shields.io/badge/typescript-5.0+-blue.svg)](https://www.typescriptlang.org)
[![WebAssembly](https://img.shields.io/badge/wasm-ready-purple.svg)](https://webassembly.org)
[![Crates.io](https://img.shields.io/crates/v/flowscope-core.svg)](https://crates.io/crates/flowscope-core)
[![Crates.io](https://img.shields.io/crates/v/flowscope-export.svg)](https://crates.io/crates/flowscope-export)
[![Crates.io](https://img.shields.io/crates/v/flowscope-cli.svg)](https://crates.io/crates/flowscope-cli)
[![npm](https://img.shields.io/npm/v/@pondpilot/flowscope-core.svg)](https://www.npmjs.com/package/@pondpilot/flowscope-core)

FlowScope 提供了一个完整的 Web 应用，访问 [flowscope.pondpilot.io](https://flowscope.pondpilot.io) 即可进行交互式、多文件的 SQL 血缘分析。

FlowScope 是一个隐私优先的 SQL 血缘分析引擎，完全在浏览器端运行。基于 Rust 和 WebAssembly 构建，它能够分析 SQL 查询并生成血缘图，描述表、CTE 和列在数据转换过程中的流向。

该引擎专为嵌入 Web 应用、浏览器扩展和开发者工具而设计，无需将 SQL 发送到服务器即可实现即时血缘分析。

## 快速开始

### Web 应用

使用 FlowScope 最简单的方式是通过托管的 Web 应用 —— 无需安装：

**[flowscope.pondpilot.io](https://flowscope.pondpilot.io)**

功能特性：
- 拖拽 SQL 文件或直接粘贴查询语句
- 交互式血缘图，支持表级和列级视图
- 多文件项目支持，含 Schema DDL
- dbt/Jinja 模板预处理，适用于 dbt 模型
- 导出为 Mermaid、JSON、CSV、Excel 或 HTML 报告
- 所有处理均在浏览器中完成 —— 你的 SQL 绝不会离开你的设备

### 命令行工具

用于脚本化和 CI/CD 集成，安装 CLI 工具：

```bash
cargo install flowscope-cli
```

基本用法：

```bash
# 分析一个 SQL 文件
flowscope query.sql

# 指定方言进行分析
flowscope -d snowflake etl/*.sql

# 生成 Mermaid 图
flowscope -f mermaid -v column query.sql > lineage.mmd

# 导出为 Excel（带 Schema 感知）
flowscope -s schema.sql -f xlsx -o report.xlsx queries/*.sql

# 通过标准输入传入
cat query.sql | flowscope -d postgres
```

输出格式：`table`（默认）、`json`、`mermaid`、`html`、`sql`、`csv`、`xlsx`、`duckdb`

### SQL 检查（Lint）

FlowScope 内置了一个 SQL 检查器，包含 72 条规则，覆盖别名、布局、约定、结构等方面：

```bash
# 检查 SQL 文件
flowscope --lint queries/*.sql

# 检查并自动修复
flowscope --lint --fix queries/*.sql

# JSON 输出，便于 CI 集成
flowscope --lint -f json queries/*.sql
```

详见 [CLI 文档](crates/flowscope-cli/README.md) 了解所有检查选项和规则配置。

### Serve 模式（本地 Web UI）

将 FlowScope 作为本地 HTTP 服务器运行，完整的 Web UI 嵌入在单个二进制文件中：

```bash
# 启动服务器并监控 SQL 目录
flowscope --serve --watch ./sql

# 指定数据库 Schema 和自定义端口
flowscope --serve --watch ./models -d postgres --metadata-url postgres://user@localhost/db --port 8080

# 自动打开浏览器
flowscope --serve --watch ./sql --open
```

Serve 模式会监控目录中 `.sql` 文件的变更，提供与托管 Web 应用相同的交互体验，所有处理均在本地完成。需使用 `serve` 特性进行编译。

详见 [CLI 文档](crates/flowscope-cli/README.md) 了解所有选项。

## 核心特性

- 客户端分析，零数据外泄
- 多方言支持（PostgreSQL、Snowflake、BigQuery、DuckDB、Redshift 等）
- dbt 和 Jinja 模板支持，内置宏桩函数（`ref()`、`source()`、`var()`）
- 表级和列级血缘追踪，支持 Schema 感知的通配符展开
- SQL 检查，72 条规则覆盖 9 大类别（别名、布局、约定、结构等）
- 自动修复引擎，支持安全和非安全修复模式
- 结构化诊断信息，精确的 Span 高亮定位
- 自动补全 API，适用于 SQL 编辑工作流
- TypeScript API 和可选的 React 可视化组件

## 项目组成

- `app/` — 托管的 Web 应用，部署在 [flowscope.pondpilot.io](https://flowscope.pondpilot.io)
- `crates/` — Rust 引擎、WASM 绑定和 CLI 工具
- `packages/` — TypeScript API 和 React 可视化组件

## TypeScript API

安装核心包：

```bash
npm install @pondpilot/flowscope-core
```

分析查询：

```typescript
import { initWasm, analyzeSql } from '@pondpilot/flowscope-core';

await initWasm();

const result = await analyzeSql({
  sql: 'SELECT * FROM analytics.orders',
  dialect: 'postgres',
});

console.log(result.statements[0]);
```

## 自动补全 API

使用自动补全 API 在光标位置提供 SQL 编写提示。详见 [docs/guides/schema-metadata.md](docs/guides/schema-metadata.md) 了解 Schema 配置。

```typescript
import {
  charOffsetToByteOffset,
  completionItems,
  initWasm,
} from '@pondpilot/flowscope-core';

await initWasm();

const sql = 'SELECT * FROM analytics.';
const cursorOffset = charOffsetToByteOffset(sql, sql.length);

const result = await completionItems({
  sql,
  dialect: 'postgres',
  cursorOffset,
  schema: {
    defaultSchema: 'analytics',
    tables: [{ name: 'orders', columns: [{ name: 'order_id' }, { name: 'total' }] }],
  },
});

console.log(result.items.slice(0, 5));
```

## 可视化

要使用交互式血缘图，添加 React 包并渲染 `LineageExplorer` 组件。详见 [docs/guides/quickstart.md](docs/guides/quickstart.md) 获取完整教程。

```bash
npm install @pondpilot/flowscope-react
```

## 文档

- [docs/README.md](docs/README.md) — 文档地图和参考索引
- [docs/guides/quickstart.md](docs/guides/quickstart.md) — TypeScript 快速入门指南
- [docs/guides/schema-metadata.md](docs/guides/schema-metadata.md) — Schema 元数据配置
- [docs/dialect-coverage.md](docs/dialect-coverage.md) — 方言和语句覆盖范围
- [crates/flowscope-cli/README.md](crates/flowscope-cli/README.md) — CLI 用法和示例
- [docs/linter-architecture.md](docs/linter-architecture.md) — 检查引擎设计和规则族
- [docs/workspace-structure.md](docs/workspace-structure.md) — Monorepo 布局和构建入口

## 开发

FlowScope 使用 `just` 作为任务运行器。运行 `just build`、`just test` 或 `just dev`，详见 [docs/workspace-structure.md](docs/workspace-structure.md) 获取完整命令列表。

## 贡献

请参阅 [CONTRIBUTING.md](CONTRIBUTING.md) 了解环境搭建、测试要求和贡献指南。

## 许可证

核心引擎和包以 Apache-2.0 许可证发布。详见 [LICENSE](LICENSE)。`app/` 目录使用 O'Saasy 许可证，详见 [app/LICENSE](app/LICENSE)。

---

[PondPilot](https://github.com/pondpilot/pondpilot) 项目的一部分。
