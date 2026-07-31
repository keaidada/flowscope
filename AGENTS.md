# AGENTS.md

## Scope

This file applies to the entire Capybara monorepo.

## Critical Rules (DO NOT VIOLATE)

### Database Operations Require Explicit User Authorization

**ANY operation that modifies, deletes, overwrites, or resets a database file
or its data MUST be explicitly authorized by the user first.** This includes
but is not limited to:

- `rm`, `mv`, `cp`, `truncate` on any `*.db`, `*.sqlite`, `*.db-bak`,
  `*.db-wal`, `*.db-shm`, or backup files.
- `DROP TABLE`, `DELETE FROM`, `TRUNCATE`, `UPDATE ... ` bulk operations
  inside any project database (dev or production).
- Replacing a database file with a backup, a fresh empty DB, or a test fixture.
- Running a migration that drops/rebuilds tables and resets data.
- Bulk `INSERT`/`UPDATE` that overwrites existing rows.
- Schema migrations that change column types and may discard values.

**Always ask first**, even when:
- The operation is "just a backup" (the user may not want any file movement).
- You believe the DB is "empty" or "expendable" (the user may have data you
  don't know about).
- The operation is reversible (restoring still disrupts the running service).
- You think it's "obvious" or "standard practice".

**Acceptable without authorization** (read-only or trivially safe):
- `SELECT`, `PRAGMA`, `EXPLAIN` queries.
- `ls`, `stat`, `file`, `sqlite3 ".schema"` / `.tables` / `COUNT(*)` on DB files.
- Writing to a brand-new DB file you just created in `/tmp/` for testing.

When in doubt, **ask**. A 10-second confirmation beats an irreversible data loss.

### Other Critical Rules

- **Never push to remote without explicit authorization.** `git push` and `git push --force` MUST only be executed when the user explicitly says "推送"、"提交到远程"、or "push". Local commits are fine. Force-push is an even higher bar — ask first.

- Never commit secrets/credentials to the repository.
- Never force-push, rewrite git history, or amend pushed commits without
  explicit user authorization.

## Repo Overview

Capybara is a Rust + TypeScript monorepo.
Key areas:
- `crates/` Rust workspace (core engine, wasm, CLI, export).
- `packages/` TypeScript packages (`@pondpilot/capybara-core`, `@pondpilot/capybara-react`).
- `app/` demo web app (Vite + React).
- `vscode/` VS Code extension + `vscode/webview-ui`.


## Cursor/Copilot Rules

- No `.cursor/rules/`, `.cursorrules`, or `.github/copilot-instructions.md` found.

## Tooling Defaults

- Use `just` as the task runner (see `justfile`).
- Use `yarn` for Node workspaces.
- Use `cargo` for Rust workspace.
- Node.js 18+ and Rust 1.82+ expected (see `README.md`).

## Build Commands

- `just build` (WASM + TypeScript packages).
- `just build-rust` (Rust workspace debug build).
- `just build-rust-release` (Rust workspace release build).
- `just build-cli` (CLI release build).
- `just build-cli-serve` (CLI with embedded web UI, release build).
- `just build-cli-serve-debug` (CLI with embedded web UI, debug build).
- `just build-wasm` (runs `./scripts/build-rust.sh`).
- `just build-ts` (runs `yarn build:ts`).
- `just run` (build + dev server).

### CLI Serve Mode Build Order

The CLI serve feature embeds the web app using rust-embed at compile time. This requires the app to be built first:

1. `cd app && yarn build` - Build frontend assets to `app/dist/`
2. `cargo build -p capybara-cli --features serve` - Compile CLI with embedded assets

The `just build-cli-serve` target handles this dependency automatically.

## Dev Commands

- `just dev` (Vite dev server at `http://localhost:5173`).
- `yarn dev` (from `app/` if you want direct Vite usage).
- `just cli -- <args>` (run CLI in debug mode).
- `just cli-release -- <args>` (run CLI in release mode).

## Full Dev Environment (Frontend + Backend)

Standard procedure to bring up a complete dev environment. All steps are mandatory for a working setup. Run from the repo root.

### Prerequisites (first time only, or after Rust source changes)

1. Build WASM module (dev mode skips `wasm-opt` for speed):
   ```bash
   just build-wasm-dev
   ```
   Output: `packages/core/wasm/capybara_wasm_bg.wasm` and auto-symlinked into `app/node_modules`.

2. Build TypeScript packages:
   ```bash
   just build-ts
   ```
   Builds `@pondpilot/capybara-core`, `@pondpilot/capybara-react`, and vscode webview.

### Service 1: Frontend dev server (Vite)

```bash
nohup just dev > /tmp/capybara-logs/dev.log 2>&1 &
```
- URL: http://localhost:5173/
- Healthcheck: `curl -o /dev/null -w "%{http_code}\n" http://localhost:5173/` → `200`
- Log: `/tmp/capybara-logs/dev.log`
- Stop: `pkill -f "vite"`
- Requires: WASM + TS build steps above completed once.

### Service 2: Backend CLI serve mode (embedded web UI + REST API)

```bash
# Build CLI with serve feature (debug, fast). Only needed once or after CLI/embedded-app changes.
cargo build -p capybara-cli --features serve

# Run server (watches ./app for SQL changes, port 3000)
nohup ./target/debug/capybara --serve --port 3000 --watch ./app > /tmp/capybara-logs/serve.log 2>&1 &
```
- URL: http://127.0.0.1:3000
- Healthcheck: `curl http://127.0.0.1:3000/api/health` → `{"status":"ok","version":"1.0.0"}`
- Config: `curl http://127.0.0.1:3000/api/config`
- Log: `/tmp/capybara-logs/serve.log`
- Stop: `pkill -f "capybara --serve"`
- Requires: `embedded-app/` populated (run `just sync-cli-serve-assets` after frontend changes).

### REST API endpoints (serve mode)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | Health check with version |
| `/api/config` | GET | Server configuration |
| `/api/analyze` | POST | Run lineage analysis |
| `/api/lint-fix` | POST | Apply lint auto-fixes |
| `/api/completion` | POST | Get code completion items |
| `/api/split` | POST | Split SQL into statements |
| `/api/files` | GET | List watched files with content |
| `/api/schema` | GET | Get schema metadata |
| `/api/export/:format` | POST | Export to json/mermaid/html/csv/xlsx |

### Verification

After starting both services, verify they are up:

```bash
curl -o /dev/null -w "5173: %{http_code}\n" http://localhost:5173/
curl -o /dev/null -w "3000: %{http_code}\n" http://127.0.0.1:3000/api/health
```
Both should return `200`.

## Lint, Format, Typecheck

- `just lint` (Rust + TypeScript lint).
- `just lint-rust` (`cargo clippy --workspace -- -D warnings`).
- `just lint-ts` (`yarn workspaces run lint`).
- `just lint-fix` (`yarn workspaces run lint:fix`).
- `just fmt` (Rust + TS formatting).
- `just fmt-rust` (`cargo fmt --all`).
- `just fmt-check-rust` (`cargo fmt --all -- --check`).
- `just fmt-ts` (runs Prettier across workspaces).
- `just typecheck` (`yarn workspaces run typecheck`).

## Test Commands

- `just test` (Rust + TS tests).
- `just test-rust` (`cargo test --workspace`).
- `just test-rust-release` (`cargo test --workspace --release`).
- `just test-ts` (`yarn workspaces run test`).
- `just test-core` (`cargo test -p capybara-core`).
- `just test-cli` (`cargo test -p capybara-cli`).
- `just test-cli-serve` (CLI tests with serve feature, builds app first).
- `just test-lineage` (`cargo test -p capybara-core --test lineage_engine`).
- `just test-lineage-verbose` (same test with `--nocapture`).
- `just check-schema` (Rust schema guard + TS schema compatibility).
- `just coverage` (generate HTML coverage report in `coverage/`, requires `cargo-llvm-cov`).
- `just coverage-lcov` (generate LCOV file at `lcov.info` for CI/Codecov).
- `just coverage-summary` (print coverage summary to stdout).

## Workspace Utilities

- `just install` (install Node dependencies).
- `just setup` (install deps + tools + hooks + build).
- `just install-rust-tools` (installs `wasm-pack` and `cargo-watch`).
- `just install-hooks` (install `prek` hooks).
- `just clean` (cargo clean + remove node_modules).
- `just update-schema` (regenerate API schema snapshot).
- `just check` (fmt check + lint + typecheck + schema checks).
- `just check-all` (Rust + TS + schema compatibility).
- `just watch` (rebuild Rust workspace on changes).
- `just watch-test` (run Rust tests on changes).
- `just watch-lineage` (run lineage tests on changes).

## Package-Level Scripts

- `packages/core`: `yarn test`, `yarn test:watch`, `yarn lint`, `yarn typecheck`.
- `packages/react`: `yarn test`, `yarn test:watch`, `yarn lint`, `yarn typecheck`.
- `app`: `yarn dev`, `yarn build`, `yarn preview`, `yarn lint`, `yarn typecheck`.
- `vscode`: `npm run build`, `npm run build:webview`, `npm run watch`, `npm run typecheck`.
- `vscode/webview-ui`: `yarn build`, `yarn dev`, `yarn lint`, `yarn typecheck`.

## Single Test Tips

- Rust lineage tests: `just test-lineage-filter PATTERN`.
- Rust lineage tests (manual): `cargo test -p capybara-core --test lineage_engine PATTERN`.
- Schema compatibility: `yarn workspace @pondpilot/capybara-core test schema-compat.test.ts --silent`.
- For other Rust crates, use `cargo test -p <crate>` then filter with a test name if needed.

## Code Style (Rust)

- Follow standard Rust conventions (see `CONTRIBUTING.md`).
- Format with `cargo fmt` before committing.
- Lint with `cargo clippy` and fix warnings.
- Workspace uses Rust 2021 edition (see `Cargo.toml`).
- Avoid unused variables; if intentionally unused, prefix with `_`.
- Keep modules small and focused; `capybara-core` uses a layered analyzer.

## Error Handling (Rust)

- Use `ParseError` for fatal parsing failures returned via `Result<T, ParseError>`.
- Use `Issue` for non-fatal analysis problems (collected and returned alongside results).
- `capybara-cli` uses `anyhow::Result` with `Context` for CLI errors.
- `capybara-export` and analyzer input use `thiserror::Error` for structured errors.

## Code Style (TypeScript)

- TypeScript is strict (see `CONTRIBUTING.md`).
- ESM modules are used (`"type": "module"`).
- Use single quotes and trailing commas in multiline structures.
- Prettier config:
  - `printWidth`: 100
  - `tabWidth`: 2
  - `semi`: true
  - `singleQuote`: true
  - `trailingComma`: `es5`
  - `arrowParens`: `always`
- ESLint config highlights:
  - `@typescript-eslint/no-unused-vars`: error, allow unused args with `_` prefix.
  - `@typescript-eslint/explicit-module-boundary-types`: off.

## Testing Expectations

- Add unit tests for new functionality (`CONTRIBUTING.md`).
- Add integration tests for complex features.
- Use fixtures under `crates/capybara-core/tests/fixtures/` when needed.
- Keep test output clean; avoid noisy logs unless `--nocapture` is intended.

## Docs and Updates

- Update documentation and `CHANGELOG.md` if a change requires it (see `CONTRIBUTING.md`).
- Docs index and specs live in `docs/README.md`.
- Usage guides live in `docs/guides/`.
- The CLI usage details live in `crates/capybara-cli/README.md`.
- Core engine overview lives in `crates/capybara-core/README.md`.

## Releases (Single Tag)

Use a single repo tag for each release (`vX.Y.Z`) and align Rust workspace + npm package versions.

1. Update versions:
   - `Cargo.toml` workspace version + workspace dependencies
   - `packages/core/package.json`, `packages/react/package.json`, `packages/core/wasm/package.json`
   - Update peer dependency on `@pondpilot/capybara-core` in `packages/react`
2. Update `CHANGELOG.md`:
   - Move Unreleased entries to `## [X.Y.Z] - YYYY-MM-DD`
   - Summarize changes per crate/package
3. Validate:
   - `just fmt-rust`
   - `just test-core`
   - `yarn workspace @pondpilot/capybara-react build`
   - `yarn workspace @pondpilot/capybara-core build`
4. Publish crates (order matters):
   - `cargo publish -p capybara-core`
   - `cargo publish -p capybara-export`
   - `cargo publish -p capybara-cli`
5. Publish npm packages:
   - `yarn workspace @pondpilot/capybara-core publish --access public`
   - `yarn workspace @pondpilot/capybara-react publish --access public`
6. Tag + release:
   - `git tag vX.Y.Z`
   - `git push origin vX.Y.Z`
   - `gh release create vX.Y.Z --title "vX.Y.Z" --notes-file <notes>` (use CHANGELOG notes)

## Notes

- The demo app (`app/`) and VS Code webview (`vscode/webview-ui/`) currently define no tests.
- For full CI parity, `just check` runs formatting checks, lint, typecheck, and schema checks.

## Matrix View (分层流程图)

### Architecture
- **Component**: `LayeredFlowDiagram.tsx` (app-local) — replaces old TaskLayerMatrix
- **Algorithm**: `layered-layout.ts` — pure module: `buildScriptGraph`, `findSCCs`, `pickBreakEdges`, `longestPathLayers`, `enforceFlowDirection`, `computeLayeredLayout`
- **Data source**: `usePipelineData.ts` — reads `table_level_edges` from DB as sole source. Auto-populates from `AnalyzeResult.globalLineage` when DB is empty. No per-statement heuristic, no globalLineage supplementation.
- **Integration**: `GlobalLineageView.tsx` mode='matrix' → `<LayeredFlowDiagram tasks={pipelineTasks} />`

### Key Decisions
- **`table_level_edges` only**: `[from_table, to_table, script]` format. from=read, to=write. Authoritative direction, no heuristic guessing.
- **Full qualified name matching**: exact normalized match only (lowercase+trim). No short-name fallback — different schemas with same table name are different tables.
- **Iterative cycle breaking**: find SCCs → break 1 edge per SCC → repeat until acyclic. `pickBreakEdges` skips already-broken edges. `enforceFlowDirection` capped at node count.
- **Layer layout**: L0=isolated (no edges), L1..N-1=pipeline (topological), LN=sink (no downstream).
- **Arrow visibility = card visibility**: `recomputeArrows` checks `isVisibleDueToFocus` + `highlightSet` before computing paths. No phantom arrows.
- **Agile mode**: ON=hide non-chain cards on click; OFF=all visible, chain highlighted.
- **Scroll optimization**: arrows fade out during scroll (150ms debounce), 9511 SVG paths skipped during scroll.
- **Empty files**: whitespace-only files filtered before analysis, no parse error.

### Interaction Model
- **Hover**: preview upstream/downstream chain, show impact stats (↑N ↓M · T 表)
- **Single click**: select card, highlight chain (agile=hide others, full-view=dim others)
- **Double click**: open right-side detail panel
- **Per-layer filter (funnel icon)**: multi-select within layer, auto-clears previous layer
- **Global focused dropdown**: searchable all-scripts selector with checkboxes

### Architecture
- **独立 store**: `InsightsGraphView` uses `createLineageStore()` + `<LineageStoreProvider>` to isolate state from relationship graph
- **自定义 ScriptNode**: `InsightsScriptNode.tsx` (app-local) injected via `customNodeTypes` prop on GraphView
- **自定义 Edge**: `TableEdge.tsx` bypasses React Flow Handle system, uses `useInternalNode` for position calculation
- **搜索**: `searchLineageForInsights(projectId, term, upstreamDepth, downstreamDepth)` — queries `lineage_nodes` + `table_level_edges` directly
- **高亮**: `highlightState.ts` shared module — directional highlighting (read row click → highlight upstream writer; write row click → highlight downstream readers)

### Key Decisions
- **不要修改 `packages/react/` 来影响数据洞察** — use `customNodeTypes`/`customEdgeTypes` props on GraphView
- **表级连线**: React Flow v12 Handle system cannot support multiple handles per side per node. TableEdge component calculates positions manually from `useInternalNode().positionAbsolute` + node data.
- **`table_level_edges`**: maintained by `writeTableLevelEdges(projectId)` — pure table-level, from=data_flow edge's from→read, to→write
- **全局血缘加速**: `buildGlobalLineageFromNodes` queries only `lineage_nodes` (1.1MB) instead of full 19.8MB AnalyzeResult
- **DB schema v3**: `file_name` + `dir_path` on all file_path-bearing tables; `script_name` + `dir_path` on `table_level_edges`
- **@xyflow/react 12.11.2**

### Layout Tuning
- Row height (ROW): 22px = 3px padding + 16px text + 3px padding
- readY: 94 + i*22, writeY: 128 + max(reads,1)*22 + i*22
- Collapsed height: 50px (via `_expandedTables: false`)
- Expanded height: 55 + reads_section + gap(13) + writes_section
- Adaptive spacing: collapsed ELK 80/40 Dagre 60/80; expanded ELK 200/100 Dagre 100/150

### Global Lineage View
- Uses `buildGlobalLineageFromNodes` (fast, 1.1MB) instead of loading full 19.8MB AnalyzeResult
- `repopulateTableLevelEdges` triggered on first open for sparse data

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **capybara** (11078 symbols, 30744 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## When Debugging

1. `gitnexus_query({query: "<error or symptom>"})` — find execution flows related to the issue
2. `gitnexus_context({name: "<suspect function>"})` — see all callers, callees, and process participation
3. `READ gitnexus://repo/capybara/process/{processName}` — trace the full execution flow step by step
4. For regressions: `gitnexus_detect_changes({scope: "compare", base_ref: "main"})` — see what your branch changed

## When Refactoring

- **Renaming**: MUST use `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` first. Review the preview — graph edits are safe, text_search edits need manual review. Then run with `dry_run: false`.
- **Extracting/Splitting**: MUST run `gitnexus_context({name: "target"})` to see all incoming/outgoing refs, then `gitnexus_impact({target: "target", direction: "upstream"})` to find all external callers before moving code.
- After any refactor: run `gitnexus_detect_changes({scope: "all"})` to verify only expected files changed.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Tools Quick Reference

| Tool | When to use | Command |
|------|-------------|---------|
| `query` | Find code by concept | `gitnexus_query({query: "auth validation"})` |
| `context` | 360-degree view of one symbol | `gitnexus_context({name: "validateUser"})` |
| `impact` | Blast radius before editing | `gitnexus_impact({target: "X", direction: "upstream"})` |
| `detect_changes` | Pre-commit scope check | `gitnexus_detect_changes({scope: "staged"})` |
| `rename` | Safe multi-file rename | `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` |
| `cypher` | Custom graph queries | `gitnexus_cypher({query: "MATCH ..."})` |

## Impact Risk Levels

| Depth | Meaning | Action |
|-------|---------|--------|
| d=1 | WILL BREAK — direct callers/importers | MUST update these |
| d=2 | LIKELY AFFECTED — indirect deps | Should test |
| d=3 | MAY NEED TESTING — transitive | Test if critical path |

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/capybara/context` | Codebase overview, check index freshness |
| `gitnexus://repo/capybara/clusters` | All functional areas |
| `gitnexus://repo/capybara/processes` | All execution flows |
| `gitnexus://repo/capybara/process/{name}` | Step-by-step execution trace |

## Self-Check Before Finishing

Before completing any code modification task, verify:
1. `gitnexus_impact` was run for all modified symbols
2. No HIGH/CRITICAL risk warnings were ignored
3. `gitnexus_detect_changes()` confirms changes match expected scope
4. All d=1 (WILL BREAK) dependents were updated

## Keeping the Index Fresh

After committing code changes, the GitNexus index becomes stale. Re-run analyze to update it:

```bash
npx gitnexus analyze
```

If the index previously included embeddings, preserve them by adding `--embeddings`:

```bash
npx gitnexus analyze --embeddings
```

To check whether embeddings exist, inspect `.gitnexus/meta.json` — the `stats.embeddings` field shows the count (0 means no embeddings). **Running analyze without `--embeddings` will delete any previously generated embeddings.**

> Claude Code users: A PostToolUse hook handles this automatically after `git commit` and `git merge`.

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->

## Known Issues / TODOs

- **closeAllTabs + refresh**: After clicking "全部" to close all tabs and refreshing,
  the editor still shows the previous script content instead of the empty state.
  In backend mode, the server reloads `active_file_id` on refresh, overriding the
  frontend's `activeFileId: null`. The sync via `scheduleBackendProjectSync` is
  debounced (500ms) and may not complete before refresh. Fix: on backend project
  load, prefer localStorage `activeFileId` when it's newer/different from server.

- **AI 对话功能**: 后续需要添加 AI 对话 (chat) 功能，让用户可以通过对话方式
  查询和理解 SQL 血缘关系。可能的方向：基于当前选中脚本/表/字段上下文，
  回答血缘相关问题；自然语言转 SQL；SQL 解释与优化建议。

- **存储过程大样本调教转换逻辑**：当前 `extractBqDml` 行级过滤经过少量
  样本验证。需要收集更多 BigQuery 存储过程样本（100+），系统化对比转换
  结果与预期输出，修复遗漏的边界情况（嵌套 EXECUTE IMMEDIATE、多语句
  BEGIN/END、复杂 FORMAT 占位符）。

- **dbt 数据建模支持**：当前仅支持基础 dbt/Jinja 宏（`ref()`、`source()`、
  `var()`）。需要完整支持 dbt 模型解析、`config()` 宏、`{{ this }}` 引用、
  snapshots、seeds、tests 等，提供 dbt 项目级别的血缘分析。
