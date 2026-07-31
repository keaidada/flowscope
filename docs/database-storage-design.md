# Database Storage Design

**定义文件**：[`crates/capybara-cli/src/server/store.rs`](../crates/capybara-cli/src/server/store.rs)

## 数据库文件

```
capybara.db    # SQLite，journal_mode=DELETE，9 张表
```

## 模式（DDL）

所有表统一样式：
- `id` — **INTEGER PRIMARY KEY AUTOINCREMENT**（统一自增主键）
- `created_at` — **INTEGER NOT NULL DEFAULT 0**（毫秒时间戳）
- `updated_at` — **INTEGER NOT NULL DEFAULT 0**（毫秒时间戳）
- `status` — **INTEGER NOT NULL DEFAULT 1**（0=停用，1=启用）

大小字段：
- 文件/内容表 → `size`
- 缓存/结果表 → `size_bytes`

```sql
CREATE TABLE IF NOT EXISTS project_files (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT    NOT NULL,
    name       TEXT    NOT NULL,
    path       TEXT    NOT NULL,
    content    TEXT    NOT NULL DEFAULT '',
    language   TEXT    NOT NULL DEFAULT 'sql',
    size       INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0,
    status     INTEGER NOT NULL DEFAULT 1,
    UNIQUE(project_id, path)
);

CREATE TABLE IF NOT EXISTS schema_files (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT    NOT NULL,
    name       TEXT    NOT NULL,
    path       TEXT    NOT NULL,
    content    TEXT    NOT NULL DEFAULT '',
    size       INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0,
    status     INTEGER NOT NULL DEFAULT 1,
    UNIQUE(project_id, path)
);

CREATE TABLE IF NOT EXISTS analysis_cache (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    cache_key        TEXT    NOT NULL UNIQUE,
    result_json      TEXT    NOT NULL,
    size_bytes       INTEGER NOT NULL,
    created_at       INTEGER NOT NULL DEFAULT 0,
    updated_at       INTEGER NOT NULL DEFAULT 0,
    last_accessed_at INTEGER NOT NULL DEFAULT 0,
    status           INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS project_file_results (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id   TEXT    NOT NULL,
    file_path    TEXT    NOT NULL,
    result_json  TEXT    NOT NULL,
    content_hash TEXT    NOT NULL,
    size_bytes   INTEGER NOT NULL DEFAULT 0,
    created_at   INTEGER NOT NULL DEFAULT 0,
    updated_at   INTEGER NOT NULL DEFAULT 0,
    status       INTEGER NOT NULL DEFAULT 1,
    UNIQUE(project_id, file_path)
);

CREATE TABLE IF NOT EXISTS lineage_nodes (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id        TEXT    NOT NULL,
    file_path         TEXT    NOT NULL,
    node_id           TEXT    NOT NULL,
    node_type         TEXT    NOT NULL,
    label             TEXT    NOT NULL,
    qualified_name    TEXT,
    statement_index   INTEGER NOT NULL,
    resolution_source TEXT,
    created_at        INTEGER NOT NULL DEFAULT 0,
    updated_at        INTEGER NOT NULL DEFAULT 0,
    status            INTEGER NOT NULL DEFAULT 1,
    UNIQUE(project_id, file_path, node_id)
);

CREATE TABLE IF NOT EXISTS lineage_columns (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id      TEXT    NOT NULL,
    file_path       TEXT    NOT NULL,
    column_id       TEXT    NOT NULL,
    label           TEXT    NOT NULL,
    qualified_name  TEXT,
    parent_node_id  TEXT,
    expression      TEXT,
    statement_index INTEGER NOT NULL,
    created_at      INTEGER NOT NULL DEFAULT 0,
    updated_at      INTEGER NOT NULL DEFAULT 0,
    status          INTEGER NOT NULL DEFAULT 1,
    UNIQUE(project_id, file_path, column_id)
);

CREATE TABLE IF NOT EXISTS lineage_edges (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id      TEXT    NOT NULL,
    file_path       TEXT    NOT NULL,
    edge_id         TEXT    NOT NULL,
    from_id         TEXT    NOT NULL,
    to_id           TEXT    NOT NULL,
    edge_type       TEXT    NOT NULL,
    expression      TEXT,
    statement_index INTEGER,
    created_at      INTEGER NOT NULL DEFAULT 0,
    updated_at      INTEGER NOT NULL DEFAULT 0,
    status          INTEGER NOT NULL DEFAULT 1,
    UNIQUE(project_id, file_path, edge_id)
);

CREATE INDEX IF NOT EXISTS idx_lineage_nodes_project ON lineage_nodes(project_id);
CREATE INDEX IF NOT EXISTS idx_lineage_columns_project ON lineage_columns(project_id);
CREATE INDEX IF NOT EXISTS idx_lineage_edges_project ON lineage_edges(project_id);
CREATE INDEX IF NOT EXISTS idx_lineage_nodes_type ON lineage_nodes(project_id, node_type);
CREATE INDEX IF NOT EXISTS idx_project_file_results_project ON project_file_results(project_id);

CREATE TABLE IF NOT EXISTS table_metadata (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id      TEXT    NOT NULL,
    catalog         TEXT    NOT NULL DEFAULT '',
    schema_name     TEXT    NOT NULL DEFAULT '',
    table_name      TEXT    NOT NULL,
    table_type      TEXT    NOT NULL DEFAULT 'table',
    origin          TEXT    NOT NULL DEFAULT 'unknown',
    temporary       INTEGER NOT NULL DEFAULT 0,
    partition_keys  TEXT    NOT NULL DEFAULT '',
    cluster_keys    TEXT    NOT NULL DEFAULT '',
    file_format     TEXT    NOT NULL DEFAULT '',
    location        TEXT    NOT NULL DEFAULT '',
    properties_json TEXT    NOT NULL DEFAULT '{}',
    owner           TEXT    NOT NULL DEFAULT '',
    comment         TEXT    NOT NULL DEFAULT '',
    row_count       INTEGER NOT NULL DEFAULT -1,
    size_bytes      INTEGER NOT NULL DEFAULT -1,
    created_at      INTEGER NOT NULL DEFAULT 0,
    updated_at      INTEGER NOT NULL DEFAULT 0,
    status          INTEGER NOT NULL DEFAULT 1,
    UNIQUE(project_id, catalog, schema_name, table_name)
);

CREATE TABLE IF NOT EXISTS column_metadata (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id      TEXT    NOT NULL,
    table_id        INTEGER NOT NULL,
    column_name     TEXT    NOT NULL,
    ordinal         INTEGER NOT NULL DEFAULT 0,
    data_type       TEXT    NOT NULL DEFAULT '',
    is_nullable     INTEGER NOT NULL DEFAULT 1,
    is_primary_key  INTEGER NOT NULL DEFAULT 0,
    is_partition    INTEGER NOT NULL DEFAULT 0,
    default_value   TEXT,
    comment         TEXT    NOT NULL DEFAULT '',
    created_at      INTEGER NOT NULL DEFAULT 0,
    updated_at      INTEGER NOT NULL DEFAULT 0,
    status          INTEGER NOT NULL DEFAULT 1,
    UNIQUE(project_id, table_id, column_name),
    FOREIGN KEY(table_id) REFERENCES table_metadata(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_table_metadata_project ON table_metadata(project_id);
CREATE INDEX IF NOT EXISTS idx_column_metadata_table ON column_metadata(table_id);
```

## 表与字段

| 表 | 说明 | 大小字段 | 备注 |
|---|---|---|---|
| `project_files` | 项目 SQL 文件 | `size` | `UNIQUE(project_id, path)` |
| `schema_files` | Schema DDL 文件 | `size` | `UNIQUE(project_id, path)` |
| `analysis_cache` | 分析缓存（按 key） | `size_bytes` | `UNIQUE(cache_key)`, 含 `last_accessed_at` |
| `project_file_results` | 文件级分析结果 | `size_bytes` | `UNIQUE(project_id, file_path)` |
| `lineage_nodes` | 血缘节点 | — | `UNIQUE(project_id, file_path, node_id)` |
| `lineage_columns` | 血缘列 | — | `UNIQUE(project_id, file_path, column_id)` |
| `lineage_edges` | 血缘边 | — | `UNIQUE(project_id, file_path, edge_id)` |
| `table_metadata` | 物理表/视图元数据 | `size_bytes` | `UNIQUE(project_id, catalog, schema_name, table_name)`，含分区/格式/属性/注释 |
| `column_metadata` | 列定义 | — | `FOREIGN KEY(table_id) REFERENCES table_metadata(id)`，含类型/主键/分区/默认值 |

## REST API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/db/project-files?projectId=` | 读取 |
| POST | `/api/db/project-files` | 写入（支持分批 `batch_index`/`batch_total`） |
| GET | `/api/db/schema-files?projectId=` | 读取 |
| POST | `/api/db/schema-files` | 写入 |
| GET | `/api/db/cache?key=` | 读取缓存 |
| POST | `/api/db/cache` | 写入缓存 |
| POST | `/api/db/cache/clear` | 清空缓存 |
| GET | `/api/db/file-result?projectId=&filePath=` | 读取文件结果 |
| GET | `/api/db/file-results?projectId=` | 读取全部文件结果 |
| POST | `/api/db/file-results` | 写入文件结果 |
| GET | `/api/db/lineage/nodes?projectId=` | 查询节点 |
| GET | `/api/db/lineage/columns?projectId=` | 查询列 |
| GET | `/api/db/lineage/edges?projectId=` | 查询边 |
| POST | `/api/db/lineage` | 批量写入血缘 |
| GET | `/api/db/table-metadata?projectId=` | 读取表元数据 |
| POST | `/api/db/table-metadata` | 写入表+列元数据 |
| GET | `/api/db/column-metadata?projectId=` | 读取列定义 |

## 启动方式

```bash
# 纯 API 后端（配合 Vite dev server 使用）：
cargo run -p capybara-cli --features serve -- --db-only --port 3000

# Vite 前端：
cd app && yarn dev --port 5173
```

前端 `http://localhost:5173` 通过 CORS 代理到 `http://localhost:3000`，数据库文件在项目根目录 `capybara.db`。

## PRAGMA

```sql
PRAGMA journal_mode = DELETE;   -- 无 WAL/SHM 文件，kill -9 不会损坏
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
```
