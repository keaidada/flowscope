# FlowScope

[![CI](https://github.com/keaidada/flowscope/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/keaidada/flowscope/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/pondpilot/flowscope/graph/badge.svg)](https://codecov.io/gh/pondpilot/flowscope)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Rust](https://img.shields.io/badge/rust-1.82+-orange.svg)](https://www.rust-lang.org)
[![TypeScript](https://img.shields.io/badge/typescript-5.0+-blue.svg)](https://www.typescriptlang.org)
[![WebAssembly](https://img.shields.io/badge/wasm-ready-purple.svg)](https://webassembly.org)
[![Crates.io](https://img.shields.io/crates/v/flowscope-core.svg)](https://crates.io/crates/flowscope-core)
[![npm](https://img.shields.io/npm/v/@pondpilot/flowscope-core.svg)](https://www.npmjs.com/package/@pondpilot/flowscope-core)

FlowScope 是一个隐私优先的 SQL 血缘分析引擎，基于 Rust 和 WebAssembly 构建。它能分析 SQL 查询并生成交互式血缘图——一切都在浏览器中运行，数据零外泄。

> **For English documentation, see [README.md](README.md)**

## 在线体验

**[flowscope.pondpilot.io](https://flowscope.pondpilot.io)** — 拖拽 SQL 文件或直接粘贴查询语句，无需注册，无需上传。

## 快速开始

### 命令行

```bash
cargo install flowscope-cli

# 分析单个 SQL 文件
flowscope query.sql

# 指定方言分析
flowscope -d snowflake etl/*.sql

# 生成 Mermaid 图
flowscope -f mermaid -v column query.sql > lineage.mmd

# SQL 检查（72 条规则）
flowscope --lint queries/*.sql

# 检查并自动修复
flowscope --lint --fix queries/*.sql
```

输出格式: `table`（默认）、`json`、`mermaid`、`html`、`sql`、`csv`、`xlsx`、`duckdb`

### Serve 模式（本地服务）

启动完整功能本地服务器，包含嵌入式 Web UI 和 REST API：

```bash
flowscope --serve --watch ./sql            # 监控 SQL 目录
flowscope --serve --watch ./sql --open     # 自动打开浏览器
flowscope --serve --db-only --port 3000    # 仅 REST API（不提供静态文件）
```

- **Web UI**: 完整的 FlowScope 应用 `http://localhost:3000`
- **REST API**: 44+ 接口 `http://localhost:3000/api`
- **API 文档**: 交互式文档 `http://localhost:3000/api/docs`（中/英文切换）
- **API 规范**: `http://localhost:3000/api/openapi.json`

### TypeScript / NPM

```bash
npm install @pondpilot/flowscope-core @pondpilot/flowscope-react
```

```typescript
import { initWasm, analyzeSql } from '@pondpilot/flowscope-core';

await initWasm();

const result = await analyzeSql({
  sql: 'SELECT * FROM analytics.orders',
  dialect: 'postgres',
});

console.log(result.statements[0]);
```

## 核心特性

- **隐私优先** — 所有分析在浏览器中完成，SQL 不会离开你的设备
- **多方言** — PostgreSQL、Snowflake、BigQuery、DuckDB、Redshift 等
- **dbt / Jinja** — 内置 `ref()`、`source()`、`var()` 等宏桩函数
- **表级与列级血缘** — Schema 感知的通配符展开
- **SQL 检查** — 72 条规则，覆盖 9 大类别，支持自动修复
- **自动补全** — 光标位置 SQL 编写提示
- **多格式导出** — Mermaid、JSON、CSV、Excel、DuckDB SQL、HTML 报告
- **React 组件** — 交互式血缘图、矩阵视图、Schema 视图
- **VS Code 扩展** — 编辑器内血缘分析和代码检查
- **国际化** — 支持英文和简体中文

## 项目组成

```
├── crates/                  Rust 工作区
│   ├── flowscope-core/      核心血缘引擎
│   ├── flowscope-wasm/      WASM 绑定
│   ├── flowscope-cli/       CLI + Serve 模式（嵌入式 Web UI + REST API）
│   └── flowscope-export/    导出工具（Mermaid、HTML、CSV、XLSX、DuckDB）
├── packages/                NPM 工作区
│   ├── core/                @pondpilot/flowscope-core（TypeScript + WASM）
│   └── react/               @pondpilot/flowscope-react（React 组件）
├── app/                     示例 Web 应用（Vite + React）
├── vscode/                  VS Code 扩展
└── docs/                    文档
```

## 文档

- [快速入门](docs/guides/quickstart.md) — TypeScript 环境搭建与首次分析
- [Schema 元数据](docs/guides/schema-metadata.md) — 为自动补全配置 Schema
- [CLI 文档](crates/flowscope-cli/README.md) — 用法、检查、Serve 模式
- [方言覆盖](docs/dialect-coverage.md) — 支持的方言和语句类型
- [工作区结构](docs/workspace-structure.md) — 构建目标和命令

## 开发

```bash
# 前置条件：Rust 1.82+、Node.js 18+、Yarn、wasm-pack

yarn install                       # 安装 Node 依赖
just build                         # 构建全部（WASM + TypeScript）
just dev                           # 启动 Vite 开发服务器
just test                          # 运行全部测试
just cli -- <args>                 # Debug 模式运行 CLI

# 完整开发环境
just build-wasm-dev                # 构建 WASM（快速，未优化）
just build-ts                      # 构建 TypeScript 包
cargo build -p flowscope-cli --features serve  # 构建带 Serve 的 CLI

# 检查、格式化、类型检查
just check
just fmt
```

详见 [CONTRIBUTING.md](CONTRIBUTING.md) 了解完整配置和规范。

## 许可证

- 核心引擎和包：[Apache-2.0](LICENSE)
- `app/` 目录：[O'Saasy License](app/LICENSE)

---

[PondPilot](https://github.com/pondpilot/pondpilot) 项目的一部分。
