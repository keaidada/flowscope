# FlowScope 存储过程修复 Skill

处理 BigQuery 存储过程 DML 提取、行号映射、批量分析等问题的标准流程。

## 架构概览

```
存储过程原始 SQL
    ↓ sanitize_bigquery_raw_double_quoted_literals (Rust)
    ↓ 提取 DML + 生成 lineMap
    ↓ Wasm → 前端 JSON: { dml, lineMap }
    ↓ 前端: rightLines[i] = dmlLines[lineMap[i]]
```

## 目录

- [批量分析流程](#批量分析流程)
- [行号映射](#行号映射)
- [存储过程 DML 提取 (Rust)](#存储过程-dml-提取-rust)
- [前端渲染](#前端渲染)
- [批量分析 API](#批量分析-api)
- [管线](#管线)
- [常驻命令](#常驻命令)
- [已知问题与限制](#已知问题与限制)

## 批量分析流程

### 单文件弹窗 (ProcedureRepairDialog)

```
1. 弹窗打开 → useEffect 调 extractDmlWithLineMap(content)
2. Wasm 返回 { dml: "DELETE ...\nCREATE ...", lineMap: [-1, -1, 0, 1, 2, ...] }
3. setTransformedContent(dml) + setLineMap(lineMap)
4. rightLines = dmlLines[lineMap[i]] — 直接渲染，无前端匹配
5. 操作: <- 删除, -> 恢复
6. output = non-empty rightLines - userRemoved
```

### 文件夹批量转换 (ConvertFolderDialog)

```
1. 前端调 POST /api/db/convert-procedures
2. 后端: load_project_files → filter procedures → sanitize → batch_update_transformed
3. 返回 { success, empty, errors, total }
4. 弹窗显示结果
5. DB 的 transformed_content 已更新
```

### 全选 / 全部文件分析 (Run All)

```
1. context.files.length > 1 → 走批量 API
2. POST /api/db/analyze-batch { projectId, folderPath, dialect, templateMode }
3. 后端: load_project_files → 每文件用 transformed_content → rayon par_chunks(100) 并行分析
4. 批量写入 lineage_nodes/columns/edges
5. 完成后: writeTableLevelEdges → setLineageResult → 渲染
```

## 行号映射

### Rust 生成 (sanitize_with_line_map)

```rust
pub fn sanitize_with_line_map(sql: &str) -> Option<(String, Vec<i32>)> {
    let dml = sanitize_bigquery_raw_double_quoted_literals(sql)?;
    // 从 BEGIN 行开始，顺序比对 dml_lines 和 original_lines
    // 精确匹配（跳过空行/注释/skip_words）
    // strip ';' 后再比，处理 EXECUTE IMMEDIATE 提取差异
    Some((dml, lineMap))
}
```

### 关键规则

- `dml_no_sc == orig_trim` — 剥离尾部 `;` 比对
- skip_words: `["END;", "BEGIN"]` — 只过滤这两个，`)`、`);` 等合法 SQL 必须保留
- `begin_line` 从 `BEGIN` 关键字开始
- lineMap[i] = dml_line_index（或 -1 表示未匹配）

### 单文件 1+ 文件分析规则

- `context.files.length > 1` → 走批量 API
- 单文件 → 走旧流程（前端加载 Wasm worker）

## 存储过程 DML 提取 (Rust)

### 核心函数链

```
sanitize_with_line_map
    sanitize_bigquery_raw_double_quoted_literals
        sanitize_bigquery_procedure
            extract_begin_end_body
                strip_block_comments  → 移除 /* */ (内容+分隔符)
                split_sql_statements  → 按 ; 分句
                语句过滤              → 保留 DML, 去掉 DECLARE/SET/IF 等
                _ => {}  (丢弃)
```

### 关键修复记录

1. **`;` 必须在单独一行**: `out.push_str(content); if !out.ends_with('\n') out.push('\n'); out.push(';'); out.push('\n');`
   - 原因: `;` 追加到 `--SELECT` 后变成 `--SELECT;`，被 standalone 注释 filter 当成注释行整个删除
2. **strip_block_comments**: 完全移除 `/* */` 块（不"反注释"内容）
3. **FORMAT 占位符不解析**: `%s/%t/%d` 保留原样（不影响表/列血缘）
4. **CREATE TABLE CTE 匹配**: `words.windows(2).any(|w| w[0]=="AS" && w[1]=="WITH")`
5. **SET 语句**: 只从三重引号 (`"""..."""` 或 `'''...'''`) 的 SET 中提取 SQL，单引号 SET 值是描述文本
6. **standalone -- 注释过滤**: 移除独立 `--` 行和空行，但保留 DML 行内 `--` 注释

### `transformed_content` 使用规则

- `is_procedure=1` → **必须**使用 `transformed_content`
- `is_procedure=0` → 使用 `content`
- 不 fallback、不重新 sanitize。如果 `transformed_content` 过期/为空 → 重新转换文件夹

## 前端渲染

### 弹窗 rightLines

```typescript
const dmlLines = transformedContent.split('\n');
const result = new Array(originalLines.length).fill('');
for (let i = 0; i < Math.min(lineMap.length, originalLines.length); i++) {
  const dmlIdx = lineMap[i];
  if (dmlIdx >= 0 && dmlIdx < dmlLines.length) {
    result[i] = dmlLines[dmlIdx];
  }
}
```

### 输出

```typescript
const output = rightLines
  .map((line, i) => (line && !userRemoved.has(i) ? line : ''))
  .filter(Boolean)
  .join('\n');
```

### 右面板显示

- 有 DML 匹配: 显示提取的 DML 内容
- 未匹配 (isAutoRemoved): 显示原始内容 + 红色删除线
- 用户删除 (isUserRemoved): 原始内容 + 红色删除线 + strikethrough
- 用户保留 (isUserKept): 原始内容 + 蓝色高亮

## 批量分析 API

### POST /api/db/analyze-batch

```json
// Request
{ "projectId": "xxx", "folderPath": "bigquery/.../", "dialect": "bigquery", "templateMode": "dbt" }

// Response
{ "total": 4300, "success": 4100, "errors": 200, "empty": 1, "error_details": ["..."] }
```

### 处理流程

```
1. load_project_files → filter .sql/.hql → filter folder
2. rayon par_chunks(100) 并行:
   每个文件: is_procedure→transformed_content, 否则→content
   构建 AnalyzeRequest → analyze() → convert_to_lineage_rows
3. 合并所有 lineage → 一次 save_lineage_batch
4. 异常入 lineage_anomalies (analysis_error / no statements parsed)
5. 前端完成: writeTableLevelEdges → setLineageResult 渲染
```

### 性能

- 4300 文件 ~90 秒 (rayon 12 线程)
- par_chunks(100) 减少线程调度开销
- 批量 DB 写入 (一次 transaction)

## 管线

### 构建管线

```
# Rust 修复
1. 改 crates/flowscope-core/src/parser/mod.rs
2. cargo test -p flowscope-core --test lineage_engine (270 tests)
3. just build-wasm-dev
4. cargo build -p flowscope-cli --features serve

# 前端修复
5. 改 app/src/components/ProcedureRepairDialog.tsx 等
6. cd app && npx tsc --noEmit --pretty
```

### 部署流程

```
1. pkill -9 -f flowscope; pkill -f vite
2. nohup ./target/debug/flowscope --serve --port 3000 --watch ./app &
3. cd app && nohup npx vite --port 5173 &
4. curl http://127.0.0.1:3000/api/health  → 200
5. curl http://localhost:5173/  → 200
```

## 常驻命令

| 命令 | 说明 |
|------|------|
| `cargo test -p flowscope-core --test lineage_engine` | Rust 270 测试 |
| `cargo build -p flowscope-cli --features serve` | 构建 CLI + serve |
| `just build-wasm-dev` | 构建 Wasm |
| `cd app && npx tsc --noEmit --pretty` | TypeScript 检查 |
| `pkill -9 -f flowscope && pkill -f vite` | 停止服务 |
| `curl http://127.0.0.1:3000/api/health` | 后端健康检查 |
| `curl -s -o /dev/null -w '%{http_code}' http://localhost:5173/` | 前端检查 |
| `sqlite3 app/flowscope.db "SELECT ..."` | 数据库查询 |
| `POST /api/db/analyze-batch` | 批量分析 |
| `POST /api/db/convert-procedures` | 文件夹转换 |

## 已知问题与限制

1. **FORMAT 占位符不解析**: `%s/%t/%d` 原样保留。分析表/列血缘不受影响（占位符在字符串字面量中）
2. **动态 SQL 拼接**: `EXECUTE IMMEDIATE """...""" || var || """..."""` 无法完整提取。sanitizer 只拿到字符串片段
3. **`table_level_edges`**: 后端 `rebuild_table_level_edges` 未完全实现 CTE 链归属。前端 `writeTableLevelEdges` 可用
4. **`lineage_anomalies`**: `script_content` 字段存的是真正被解析的 SQL（存储过程用 `transformed_content`，普通用 `content`）
5. **`.sql` 文件识别**: 批量分析只处理 `.sql` / `.hql` 文件
6. **分析失败判定**: `result.statements.is_empty()` → 错误，否则成功（不管 issue 数量）
