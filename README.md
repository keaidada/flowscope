# FlowScope

[![CI](https://github.com/keaidada/flowscope/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/keaidada/flowscope/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/pondpilot/flowscope/graph/badge.svg)](https://codecov.io/gh/pondpilot/flowscope)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Rust](https://img.shields.io/badge/rust-1.82+-orange.svg)](https://www.rust-lang.org)
[![TypeScript](https://img.shields.io/badge/typescript-5.0+-blue.svg)](https://www.typescriptlang.org)
[![WebAssembly](https://img.shields.io/badge/wasm-ready-purple.svg)](https://webassembly.org)
[![Crates.io](https://img.shields.io/crates/v/flowscope-core.svg)](https://crates.io/crates/flowscope-core)
[![npm](https://img.shields.io/npm/v/@pondpilot/flowscope-core.svg)](https://www.npmjs.com/package/@pondpilot/flowscope-core)

FlowScope is a privacy-first SQL lineage engine built with Rust and WebAssembly. It analyzes SQL queries and produces interactive lineage graphs — all in the browser, with zero data egress.

> **中文文档请见 [README.zh-CN.md](README.zh-CN.md)**

## Try It

**[flowscope.pondpilot.io](https://flowscope.pondpilot.io)** — Drag and drop SQL files or paste queries directly. No sign-up, no uploads.

## Quick Start

### CLI

```bash
cargo install flowscope-cli

# Analyze a SQL file
flowscope query.sql

# Analyze with a specific dialect
flowscope -d snowflake etl/*.sql

# Generate a Mermaid diagram
flowscope -f mermaid -v column query.sql > lineage.mmd

# Lint SQL files (72 rules)
flowscope --lint queries/*.sql

# Lint and auto-fix
flowscope --lint --fix queries/*.sql
```

Output formats: `table` (default), `json`, `mermaid`, `html`, `sql`, `csv`, `xlsx`, `duckdb`

### Serve Mode (Local Server)

Run a full-featured local server with an embedded web UI and REST API:

```bash
flowscope --serve --watch ./sql            # Watch SQL directories
flowscope --serve --watch ./sql --open     # Auto-open browser
flowscope --serve --db-only --port 3000    # REST API only (no static files)
```

- **Web UI**: Full FlowScope app at `http://localhost:3000`
- **REST API**: 44+ endpoints at `http://localhost:3000/api`
- **OpenAPI docs**: Interactive docs at `http://localhost:3000/api/docs` (EN/ZH)
- **API spec**: `http://localhost:3000/api/openapi.json`

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

## Features

- **Privacy First** — All analysis runs in the browser. Your SQL never leaves your machine.
- **Multi-Dialect** — PostgreSQL, Snowflake, BigQuery, DuckDB, Redshift, and more.
- **dbt / Jinja** — Built-in macro stubs for `ref()`, `source()`, `var()`.
- **Table & Column Lineage** — Schema-aware wildcard expansion.
- **SQL Linter** — 72 rules across 9 categories with auto-fix.
- **Completion API** — SQL authoring hints at cursor position.
- **Export** — Mermaid, JSON, CSV, Excel, DuckDB SQL, HTML reports.
- **React Components** — Interactive lineage graphs, matrix view, schema view.
- **VS Code Extension** — In-editor lineage and linting.
- **i18n** — English and Simplified Chinese.

## Project Structure

```
├── crates/                  Rust workspace
│   ├── flowscope-core/      Core lineage engine
│   ├── flowscope-wasm/      WASM bindings
│   ├── flowscope-cli/       CLI + serve mode (embedded web UI + REST API)
│   └── flowscope-export/    Export helpers (Mermaid, HTML, CSV, XLSX, DuckDB)
├── packages/                NPM workspace
│   ├── core/                @pondpilot/flowscope-core (TypeScript + WASM)
│   └── react/               @pondpilot/flowscope-react (React components)
├── app/                     Demo web application (Vite + React)
├── vscode/                  VS Code extension
└── docs/                    Documentation
```

## Documentation

- [Quickstart Guide](docs/guides/quickstart.md) — TypeScript setup and first analysis
- [Schema Metadata](docs/guides/schema-metadata.md) — Schema configuration for completion
- [CLI Documentation](crates/flowscope-cli/README.md) — Usage, linting, serve mode
- [Dialect Coverage](docs/dialect-coverage.md) — Supported dialects and statements
- [Workspace Structure](docs/workspace-structure.md) — Build targets and commands

## Development

```bash
# Prerequisites: Rust 1.82+, Node.js 18+, Yarn, wasm-pack

yarn install                       # Install Node dependencies
just build                         # Build everything (WASM + TypeScript)
just dev                           # Start Vite dev server
just test                          # Run all tests
just cli -- <args>                 # Run CLI in debug mode

# Full dev environment
just build-wasm-dev                # Build WASM (fast, no optimization)
just build-ts                      # Build TypeScript packages
cargo build -p flowscope-cli --features serve  # Build CLI with serve

# Lint, format, typecheck
just check
just fmt
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for full setup and guidelines.

## License

- Core engine and packages: [Apache-2.0](LICENSE)
- `app/` directory: [O'Saasy License](app/LICENSE)

---

Part of the [PondPilot](https://github.com/pondpilot/pondpilot) project.
