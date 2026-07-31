# 2026-07-19 — Database & Lineage Data-Quality Fixes

A chain of related fixes addressing schema, lineage, and metadata quality
issues discovered during a full end-to-end audit of the SQLite store behind
serve mode. Each section covers root cause + fix + verification.

## Summary

| # | Issue | Layer |
|---|-------|-------|
| 1 | Time fields stored as Unix-ms `INTEGER` | SQLite schema + Rust structs |
| 2 | `CREATE TEMPORARY TABLE` targets surfaced as `NodeType::Table` | analyzer (Rust) |
| 3 | `qualified_name` lacked schema prefix after `USE <db>;` | analyzer (Rust) |
| 4 | Orphan `lineage_edges` / `lineage_columns.parent_node_id` | analyzer + write path |
| 5 | Temp tables polluted `table_metadata` | analyzer + frontend write path |
| 6 | `save_table_metadata` upsert semantics left stale rows | CLI store |

---

## 1. Time fields: `INTEGER` (Unix ms) → `TEXT` (RFC3339)

### Symptom
`created_at` / `updated_at` / `last_accessed_at` stored as 13-digit Unix-ms
integers (e.g. `1700000000000`), unreadable in DB viewers.

### Root cause
Original schema in `crates/capybara-cli/src/server/store.rs` declared every
time column as `INTEGER NOT NULL DEFAULT 0`, populated via
`chrono::Utc::now().timestamp_millis()`.

### Fix
- **Schema migration framework**: introduced `PRAGMA user_version` based
  `migrate()` in `store.rs`. v0 → v1 rebuilds all 12 affected tables via the
  SQLite-recommended `CREATE TABLE _new` + `INSERT … SELECT` + `DROP` +
  `RENAME` pattern. Time columns become `TEXT NOT NULL DEFAULT ''`. Time
  values are discarded per design decision (non-time data is preserved).
  Idempotent: tables whose time columns are already `TEXT` are skipped.
- **Rust structs**: `ProjectFileRow`, `SchemaFileRow`, `ProjectRow`,
  `TableMetadataRow`, `ColumnMetadataRow` — all `i64` time fields → `String`.
- **Write paths**: all 5 `timestamp_millis()` call-sites → `to_rfc3339()`.
  `save_view_state` hardcoded `0, 0` → RFC3339 strings.
- **api.rs**: `extract_and_save_ddl_metadata`'s `now` changed from `i64` to
  a closure returning RFC3339 (avoids `String::clone` per row).
- **TS**: `server-db.ts` types + 5 frontend write-sites switched to
  `new Date().toISOString()` / `''`.

### Verification
13,392 time values across all tables — 100% RFC3339 or empty string.
Migration tested on a synthetic v0 fixture; non-time data preserved.

---

## 2. Temp tables surfaced as `NodeType::Table`

### Symptom
635 of 2332 `node_type='table'` rows had 1–3 char labels (`a`, `b`, `c`,
`d`, `a1`, `b2`, …). They came from Hive's `CREATE TEMPORARY TABLE A AS
SELECT …` pattern and polluted physical-table-level lineage.

### Root cause
`crates/capybara-core/src/analyzer/ddl.rs`'s `analyze_create_table_as` and
`analyze_create_table` unconditionally set `node_type: NodeType::Table`,
ignoring the `is_temporary` flag. The cross-statement tracker had no concept
of "temporary table", so `relation_identity()` always returned `Table`.

### Fix
- **`cross_statement.rs`**: added `produced_temporary_tables: HashSet<String>`
  and `record_temporary_produced()`. Updated `relation_identity()` and
  `relation_instance_identity()` to return `NodeType::Cte` for temporary
  tables **while keeping the `table_`-prefixed node ID** (so cross-statement
  edges still resolve consistently — the temp table is referenced by ID
  across statements within the same script). Updated `remove()` to also
  clean the temporary set.
- **`ddl.rs`**: both `analyze_create_table_as` and `analyze_create_table`
  branch on `is_temporary`: when true, set `NodeType::Cte` and call
  `record_temporary_produced()`.
- **Tests**: updated `ddl_multi_statement_temp_table_pipeline` to assert
  `bronze` and `silver` are surfaced as `Cte`, `raw_events`/`gold` stay
  `Table`, and cross-statement edges still fire (≥3).

### Why `Cte` instead of a new variant
- `is_table_like()` returns true → still participates in full lineage.
- `is_table_or_view()` returns false → excluded from physical table-only
  views (e.g. `load_table_lineage` SQL `WHERE node_type IN ('table','view')`).
- No new enum variant → no exhaustive `match` updates needed across the
  codebase.

### Verification
After re-analysis: `cte: 2246, table: 1513`, zero single-letter labels in
`table` nodes.

---

## 3. `qualified_name` lacked schema prefix after `USE <db>;`

### Symptom
`lineage_nodes.qualified_name = 's02_vplay_statt'` instead of
`'sum_db.s02_vplay_statt'` even when the script began with `use sum_db;`.

### Root cause
DDL entry points (`analyze_create_table_as`, `analyze_create_view`,
`analyze_insert`, `ALTER TABLE`, `RENAME`, `DROP`, `COPY`, `COPY INTO`,
plus DDL pre-collection) called `normalize_table_name(name)` — which only
applies dialect case-folding. They should have called
`canonicalize_table_reference(name).canonical`, which goes through
`resolve_table_name` and supplements the default_schema / default_catalog
prefix even for implied tables not in `known_tables`
(`schema_registry.rs:643-653`).

### Fix
Changed 9 call-sites in `ddl.rs`, `statements.rs`, and `analyzer.rs`
(precollect) from `normalize_table_name` to
`canonicalize_table_reference(...).canonical`.

### Verification
Re-analysis on the user's 2694-file Hive corpus: 1512 / 1512 table nodes
have a schema prefix (`sum_db.*`, `his_db.*`, …).

---

## 4. Orphan edges / columns (`from_id` / `parent_node_id` dangling)

### Symptom
- 20 `lineage_edges` rows whose `from_id` was in neither `lineage_nodes`
  nor `lineage_columns` for the same `file_path`.
- 20 `lineage_columns.parent_node_id` values pointing at non-existent nodes
  in the same file_path.

### Root cause (analyzer side)
In `crates/capybara-core/src/analyzer/query.rs`, `resolve_table_alias` did
a **literal-string** lookup on `ctx.cte_definitions`. Hive is
case-insensitive, so `with A1 as (…) … from a1.x` failed to resolve and
fell back to `canonicalize_table_reference`, producing an owner node ID
with `table_` prefix. The actual CTE node had `cte_` prefix → mismatch.

### Fix (analyzer side)
`resolve_table_alias` now performs a case-insensitive fallback: tries
`self.normalize_identifier(q)` against every `cte_definitions` key, and
returns the matching key's canonical.

### Fix (store side, defense in depth)
`app/src/lib/analysis-cache.ts:writeLineageDataViaServer` now filters
orphan writes at the persistence layer:
- Builds `persistedNodeIds` (only nodes actually written, after dropping
  columns whose parent is missing).
- Drops columns whose `parent_node_id` is non-null and not in
  `persistedNodeIds`.
- Drops edges whose `from` or `to` is not in `persistedNodeIds`.

Two-stage filtering matters: the first pass used `allNodeIds` (which
included filtered columns), so edges pointing at filtered columns still
slipped through. Switched to `persistedNodeIds` to close that gap.

### Verification
0 orphan edges / 0 orphan parent_node_id across 39987 edges and 18712
columns.

---

## 5. Temp tables polluted `table_metadata`

### Symptom
788 rows in `table_metadata`, 220 of them with single-letter / short names
(`a`, `b`, `c`, `d`, `a1`, `b2`, …) — all of which were CTE/temp-table
residue that should never have been cataloged as physical tables.

### Root cause (frontend)
`app/src/lib/analysis-cache.ts:writeTableMetadata` iterated
`result.resolvedSchema.tables` without filtering. The frontend persisted
every CTAS-derived implied schema entry, including temp tables.

### Root cause (analyzer, deeper)
Even after the frontend `if (t.temporary) continue` filter was added,
merged multi-file analysis surfaced ~41 short-named tables with
`t.temporary === undefined` (the CTAS target had lost its temporary flag
somewhere on the merged-analysis path — full root cause not pinned down,
but the symptom is reliable: implied + non-temporary + no catalog/schema).

### Fix
- **Frontend filter (primary)**:
  `writeTableMetadata(projectId, result, dialect?)` —
  - Always skips `t.temporary === true`.
  - For strict-schema dialects (Hive, BigQuery, Snowflake, Databricks,
    Spark, Trino, Presto), also skips entries where
    `!t.temporary && (catalog ?? '') === '' && (schema ?? '') === ''`
    and origin is not imported. These are CTE / derived-table residues
    that lost their temporary flag in merged analysis.
  - For dialects with implicit default schemas (Postgres `public`, SQLite,
    generic) the filter is bypassed because bare names are legitimate.
- **`useAnalysis.ts`**: caller now passes `project.dialect` through.

A more targeted fix in `build_resolved_schema` (Rust) was attempted but
reverted: it broke 7 tests that legitimately create `implied` tables
without catalog/schema (e.g. `CREATE TABLE users (id INT)` in default
schema). Frontend dialect-aware filtering is the safe path.

### Verification
After re-analysis: `table_metadata` count dropped from 788 → 101, all
short-name/temporary rows eliminated.

---

## 6. `save_table_metadata` upsert semantics

### Symptom
After the temp-table filter was deployed, re-analysis still left 119
short-name temp-table rows in `table_metadata`. New code prevented new
writes, but old rows persisted.

### Root cause
`store.rs:save_table_metadata` used `INSERT … ON CONFLICT DO UPDATE`
(upsert). No `DELETE` preceded it, so rows that were no longer in the
incoming set stayed forever.

### Fix
`save_table_metadata` now opens with:
```sql
DELETE FROM column_metadata WHERE project_id = ?1;
DELETE FROM table_metadata WHERE project_id = ?1;
```
before the upsert loop. Replace semantics is correct here because callers
always pass the full resolved-schema table set for one project at a time.

### Verification
After re-analysis: all 28 remaining stale rows cleared. `table_metadata`
now exactly mirrors the (filtered) `resolvedSchema.tables` produced by
the analyzer.

---

## Operational Rules Established

Two safety rules were added to `AGENTS.md` (under "Critical Rules"):

1. **Database operations require explicit user authorization.** Any `rm`,
   `mv`, `cp`, `truncate`, `DROP TABLE`, `DELETE FROM`, `TRUNCATE`, bulk
   `UPDATE`, schema migration that may discard values, or backup
   replacement MUST be confirmed by the user first. Read-only queries
   (`SELECT`, `PRAGMA`, `EXPLAIN`, `.schema`, `COUNT(*)`) and writes to
   brand-new test DBs under `/tmp/` are fine without confirmation.

2. The "Full Dev Environment" startup SOP was documented (frontend Vite +
   backend CLI serve mode, prerequisites, healthchecks, log paths).

These rules now apply to every agent session that touches the repo.

---

## Files Touched

### Rust
- `crates/capybara-cli/src/server/store.rs` — schema migration framework
  + 12 table rebuilds + 6 struct types + 5 write paths + `save_table_metadata`
  DELETE+INSERT.
- `crates/capybara-cli/src/server/api.rs` — `extract_and_save_ddl_metadata`
  RFC3339 `now` closure.
- `crates/capybara-core/src/analyzer/cross_statement.rs` — temp-table
  tracking + `relation_identity` returns `Cte`.
- `crates/capybara-core/src/analyzer/ddl.rs` — DDL branches on
  `is_temporary` + uses `canonicalize_table_reference`.
- `crates/capybara-core/src/analyzer/statements.rs` — INSERT/ALTER/RENAME/
  DROP/COPY call `canonicalize_table_reference`.
- `crates/capybara-core/src/analyzer.rs` — precollect uses
  `canonicalize_table_reference`.
- `crates/capybara-core/src/analyzer/query.rs` —
  `resolve_table_alias` case-insensitive `cte_definitions` fallback.
- `crates/capybara-core/tests/lineage_engine.rs` — updated
  `ddl_multi_statement_temp_table_pipeline` test.

### TypeScript
- `app/src/lib/server-db.ts` — time-field types `number → string` +
  default `0 → ''`.
- `app/src/lib/file-storage.ts`,
  `app/src/lib/schema-storage.ts` — `Date.now() → new Date().toISOString()`.
- `app/src/lib/analysis-cache.ts` — `writeLineageDataViaServer` orphan
  filtering (two-pass); `writeTableMetadata` temporary + dialect-aware
  homeless filtering.
- `app/src/lib/project-store.tsx` — default values 0 → ISO string.
- `app/src/hooks/useAnalysis.ts` — pass `project.dialect` to
  `writeTableMetadata`.

### Docs / Config
- `AGENTS.md` — Critical Rules section (DB ops require authorization) +
  Full Dev Environment SOP.
- `CHANGELOG.md` — Unreleased entry.
- This document.

---

## Verification Stats (final)

| Metric | Before | After |
|--------|--------|-------|
| Time format | mixed INTEGER long | 100% RFC3339 (13392 values) |
| `node_type='table'` w/ single-letter label | 635 | 0 |
| `lineage_nodes.qualified_name` missing schema | 49 | 0 |
| Orphan `lineage_edges` | 20 / 40159 | 0 / 39987 |
| Orphan `lineage_columns.parent_node_id` | 20 / 18872 | 0 / 18712 |
| Temp tables in `table_metadata` | 220 | 0 |
| `table_metadata` total | 788 | 101 |
| `column_metadata` total | 14091 | 775 |
| DB file size | 8.0 GB (incl. WAL) | 40 MB |

All 270 lineage engine tests pass. Frontend typecheck passes. Backend
healthcheck `{"status":"ok","version":"0.6.0"}`.
