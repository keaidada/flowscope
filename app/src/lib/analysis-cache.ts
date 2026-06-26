/**
 * SQLite-WASM based analysis result cache with LRU eviction.
 *
 * Heavy AnalyzeResult JSON blobs are stored as individual OPFS files
 * (not in the SQLite DB) to keep the DB small and fast to load.
 * The project_file_results table only stores the file_path and hash;
 * the actual result JSON lives in:
 *   OPFS:  /flowscope/results/<project_id>/<encoded_path>.json
 */

import type { AnalyzeResult, StatementLineage, Node, Edge } from '@pondpilot/flowscope-core';
import { getDb, esc, persistNow } from './duckdb';

// ── OPFS helpers for per-file result storage ─────────────────────────

const RESULTS_DIR = 'results';

async function getResultsRoot(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  const flowscope = await root.getDirectoryHandle('flowscope', { create: true });
  return flowscope.getDirectoryHandle(RESULTS_DIR, { create: true });
}

function encodeResultPath(filePath: string): string {
  return encodeURIComponent(filePath) + '.json';
}

async function writeResultToOPFS(
  projectId: string,
  filePath: string,
  result: AnalyzeResult
): Promise<void> {
  try {
    const root = await getResultsRoot();
    const projectDir = await root.getDirectoryHandle(projectId, { create: true });
    const fileName = encodeResultPath(filePath);
    const fileHandle = await projectDir.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    const writer = writable.getWriter();
    await writer.write(JSON.stringify(result));
    await writer.close();
  } catch (error) {
    console.error('[analysis-cache] OPFS write failed for', filePath, error);
  }
}

async function readResultFromOPFS(
  projectId: string,
  filePath: string
): Promise<AnalyzeResult | null> {
  try {
    const root = await getResultsRoot();
    const projectDir = await root.getDirectoryHandle(projectId);
    const fileName = encodeResultPath(filePath);
    const fileHandle = await projectDir.getFileHandle(fileName);
    const file = await fileHandle.getFile();
    const text = await file.text();
    return JSON.parse(text) as AnalyzeResult;
  } catch {
    return null;
  }
}

async function removeProjectResultsDir(projectId: string): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    const flowscope = await root.getDirectoryHandle('flowscope');
    const resultsDir = await flowscope.getDirectoryHandle(RESULTS_DIR);
    await resultsDir.removeEntry(projectId, { recursive: true });
  } catch {
    // Directory doesn't exist or can't be removed — ignore
  }
}

export async function readCachedAnalysisResult(cacheKey: string): Promise<AnalyzeResult | null> {
  try {
    const db = await getDb();
    const stmt = db.prepare('SELECT result_json FROM analysis_cache WHERE cache_key = ?');
    stmt.bind([cacheKey]);

    if (!stmt.step()) {
      stmt.free();
      return null;
    }

    const json = String(stmt.get()[0]);
    stmt.free();

    // Touch last_accessed_at for LRU
    db.run(
      `UPDATE analysis_cache SET last_accessed_at = ${Date.now()} WHERE cache_key = '${esc(cacheKey)}'`
    );
    await persistNow();

    return JSON.parse(json) as AnalyzeResult;
  } catch (error) {
    console.error('[analysis-cache] Failed to read cache:', error);
    return null;
  }
}

export async function writeCachedAnalysisResult(
  cacheKey: string,
  result: AnalyzeResult,
  maxBytes: number
): Promise<void> {
  try {
    const resultJson = JSON.stringify(result);
    const sizeBytes = new TextEncoder().encode(resultJson).length;

    if (sizeBytes > maxBytes) return;

    const db = await getDb();
    const now = Date.now();

    db.run(`DELETE FROM analysis_cache WHERE cache_key = '${esc(cacheKey)}'`);

    const stmt = db.prepare(
      'INSERT INTO analysis_cache (cache_key, result_json, size_bytes, created_at, last_accessed_at) VALUES (?, ?, ?, ?, ?)'
    );
    stmt.run([cacheKey, resultJson, sizeBytes, now, now]);
    stmt.free();

    // Enforce LRU limit
    const totalResult = db.exec('SELECT COALESCE(SUM(size_bytes), 0) FROM analysis_cache');
    let totalBytes = Number(totalResult[0]?.values[0]?.[0] ?? 0);

    if (totalBytes > maxBytes) {
      const entries = db.exec(
        'SELECT cache_key, size_bytes FROM analysis_cache ORDER BY last_accessed_at ASC'
      );
      if (entries[0]) {
        for (const row of entries[0].values) {
          if (totalBytes <= maxBytes) break;
          db.run(`DELETE FROM analysis_cache WHERE cache_key = '${esc(String(row[0]))}'`);
          totalBytes -= Number(row[1]);
        }
      }
    }

    await persistNow();
  } catch (error) {
    console.error('[analysis-cache] Failed to write cache:', error);
  }
}

export async function deleteCachedAnalysisResult(cacheKey: string): Promise<void> {
  try {
    const db = await getDb();
    db.run(`DELETE FROM analysis_cache WHERE cache_key = '${esc(cacheKey)}'`);
    await persistNow();
  } catch (error) {
    console.error('[analysis-cache] Failed to delete cache entry:', error);
  }
}

// ── Per-file result cache (for global lineage) ─────────────────────

/**
 * 保存单文件分析结果。
 * - OPFS 文件名用 contentHash（相同结果共享文件）
 * - DB result_json 置空，content_hash 存 hash
 */
/**
 * Write the merged AnalyzeResult to OPFS once, then batch-insert DB pointer rows
 * for many files in a single transaction.  This avoids writing the same 10MB+ JSON
 * to OPFS thousands of times when many files share one result.
 */
export async function writeBatchFileResults(
  projectId: string,
  filePaths: string[],
  contentHash: string,
  result: AnalyzeResult
): Promise<void> {
  try {
    const hash = contentHash || 'no_hash';

    // Write the big JSON to OPFS once
    await writeResultToOPFS(projectId, hash, result);

    // Batch insert DB pointer rows in one transaction
    const db = await getDb();
    db.run('BEGIN TRANSACTION');
    const stmt = db.prepare(
      'INSERT OR REPLACE INTO project_file_results (project_id, file_path, result_json, content_hash, updated_at) VALUES (?, ?, ?, ?, ?)'
    );
    const now = Date.now();
    for (const fp of filePaths) {
      try {
        console.log('[analysis-cache] writeBatchFileResults:', { projectId, filePath: fp, hash });
      } catch (_) { /* ignore */ }
      stmt.run([projectId, fp, '', hash, now]);
    }
    stmt.free();
    db.run('COMMIT');
  } catch (error) {
    console.error('[analysis-cache] Failed to write batch file results:', error);
    throw error;
  }
}

export async function writeFileResult(
  projectId: string,
  filePath: string,
  contentHash: string,
  result: AnalyzeResult
): Promise<void> {
  try {
    const hash = contentHash || 'no_hash';

    // Write to OPFS using contentHash as key (shared across files with same result)
    await writeResultToOPFS(projectId, hash, result);

    // DB row: lightweight pointer (filePath → contentHash).
    // This is ALWAYS required for the restore path — never skip it.
    const db = await getDb();
    const now = Date.now();
    // Diagnostic: record stored filePath/hash to help debug path mismatches
    try {
      console.log('[analysis-cache] writeFileResult:', { projectId, filePath, hash });
    } catch (err) {}
    const stmt = db.prepare(
      'INSERT OR REPLACE INTO project_file_results (project_id, file_path, result_json, content_hash, updated_at) VALUES (?, ?, ?, ?, ?)'
    );
    stmt.run([projectId, filePath, '', hash, now]);
    stmt.free();
  } catch (error) {
    console.error('[analysis-cache] Failed to write file result:', error);
  }
}

/**
 * 读取项目下所有已缓存的分析结果文件路径（轻量查询，不解析 JSON）。
 * 同时查 project_file_results 和 lineage_statements 两张表取并集，
 * 避免因单表写入失败导致所有图标消失。
 */
export async function readFileResultPaths(
  projectId: string
): Promise<string[]> {
  try {
    const db = await getDb();
    const stmt = db.prepare(
      `SELECT DISTINCT file_path FROM project_file_results WHERE project_id = ?
       UNION
       SELECT DISTINCT file_path FROM lineage_statements WHERE project_id = ?`
    );
    stmt.bind([projectId, projectId]);
    const paths: string[] = [];
    while (stmt.step()) {
      paths.push(String(stmt.get()[0]));
    }
    stmt.free();
    return paths;
  } catch (error) {
    console.error('[analysis-cache] Failed to read file result paths:', error);
    return [];
  }
}

/**
 * 读取项目下所有已缓存的文件分析结果。
 *
 * 数据兼容三种存储代际：
 *   Gen1: result_json=''          → OPFS 文件按 filePath 存储 (encodeResultPath(filePath))
 *   Gen2: result_json='{...}'    → DB 列直接存 JSON (旧迁移数据)
 *   Gen3: result_json=contentHash → OPFS 文件按 hash 存储 (encodeResultPath(hash))
 *
 * 策略：按内容来源分组，每组只读取/解析一次。
 */
export async function readAllFileResults(
  projectId: string
): Promise<{ filePath: string; result: AnalyzeResult }[]> {
  try {
    const db = await getDb();
    const stmt = db.prepare(
      'SELECT file_path, result_json, content_hash FROM project_file_results WHERE project_id = ?'
    );
    stmt.bind([projectId]);
    const rows: Array<{ filePath: string; dbJson: string; contentHash: string }> = [];
    while (stmt.step()) {
      const row = stmt.get();
      rows.push({
        filePath: String(row[0]),
        dbJson: String(row[1] ?? ''),
        contentHash: String(row[2] ?? ''),
      });
    }
    stmt.free();

    if (rows.length === 0) return [];

    // ── Classify rows by data generation ──
    // Gen3: contentHash column is non-empty → OPFS by hash
    // Gen2: result_json column starts with '{' → DB JSON blob
    // Gen1: both empty → OPFS by filePath
    const hashGroups = new Map<string, string[]>(); // hash → filePaths (Gen3)
    const legacyByPath: Array<{ filePath: string; json: string }> = []; // Gen2: DB JSON
    const emptyByPath: Array<{ filePath: string }> = []; // Gen1: OPFS by filePath

    for (const row of rows) {
      if (row.contentHash) {
        // Gen3: content_hash stores the OPFS key
        if (!hashGroups.has(row.contentHash)) hashGroups.set(row.contentHash, []);
        hashGroups.get(row.contentHash)!.push(row.filePath);
      } else if (row.dbJson.startsWith('{')) {
        // Gen2: result_json is a JSON blob
        legacyByPath.push({ filePath: row.filePath, json: row.dbJson });
      } else {
        // Gen1: OPFS stored by filePath
        emptyByPath.push({ filePath: row.filePath });
      }
    }

    console.log('[readAllFileResults] total DB rows:', rows.length,
      'Gen1 (empty):', emptyByPath.length,
      'Gen2 (JSON):', legacyByPath.length,
      'Gen3 (hash):', hashGroups.size, 'groups,', [...hashGroups.values()].reduce((s, a) => s + a.length, 0), 'files');

    const results: { filePath: string; result: AnalyzeResult }[] = [];

    // ── Gen2: parse DB JSON directly (cached by JSON string) ──
    const jsonCache = new Map<string, AnalyzeResult>();
    for (const entry of legacyByPath) {
      let parsed = jsonCache.get(entry.json);
      if (!parsed) {
        try { parsed = JSON.parse(entry.json) as AnalyzeResult; jsonCache.set(entry.json, parsed); }
        catch { continue; }
      }
      results.push({ filePath: entry.filePath, result: parsed });
    }

    // ── Gen1: read OPFS by filePath, with content-dedup for runMode=all ──
    // Gen1 stores identical results per file when runMode=all (3000× same JSON).
    // Use a content fingerprint cache to skip re-reading identical OPFS files.
    if (emptyByPath.length > 0) {
      const sigCache = new Map<string, AnalyzeResult>(); // fingerprint → result
      const CONCURRENCY = 8;
      for (let i = 0; i < emptyByPath.length; i += CONCURRENCY) {
        const batch = emptyByPath.slice(i, i + CONCURRENCY);
        const batchResults = await Promise.all(
          batch.map(async ({ filePath }) => {
            const opfsResult = await readResultFromOPFS(projectId, filePath);
            if (!opfsResult) return [] as typeof results;
            // Fingerprint: statement count + first sourceName
            const sig = `${opfsResult.statements.length}|${opfsResult.statements[0]?.sourceName ?? ''}`;
            const cached = sigCache.get(sig);
            sigCache.set(sig, opfsResult);
            return [{ filePath, result: cached ?? opfsResult }]; // reuse cached if available
          })
        );
        for (const group of batchResults) results.push(...group);
      }
    }

    // ── Gen3: read OPFS once per unique hash, distribute to all files ──
    const uniqueHashes = [...hashGroups.keys()];
    for (let i = 0; i < uniqueHashes.length; i += 6) {
      const batch = uniqueHashes.slice(i, i + 6);
      const batchResults = await Promise.all(
        batch.map(async (hash) => {
          const filePaths = hashGroups.get(hash) || [];
          if (filePaths.length === 0) return null;
          const opfsResult = await readResultFromOPFS(projectId, hash);
          if (opfsResult) {
            return filePaths.map((fp) => ({ filePath: fp, result: opfsResult }));
          }
          return null;
        })
      );
      for (const group of batchResults) {
        if (group) results.push(...group);
      }
    }

    return results;
  } catch (error) {
    console.error('[analysis-cache] Failed to read file results:', error);
    return [];
  }
}

/**
 * 按文件路径读取单个文件的分析结果。
 * OPFS 优先（按 filePath 查找，GEN1），然后尝试 contentHash（GEN3），最后 DB JSON 兜底（GEN2）。
 */
export async function readFileResult(
  projectId: string,
  filePath: string
): Promise<AnalyzeResult | null> {
  // Try OPFS by filePath (Gen1 — original storage)
  const opfsByPath = await readResultFromOPFS(projectId, filePath);
  if (opfsByPath) return opfsByPath;

  // Read content_hash from DB
  try {
    const db = await getDb();
    const stmt = db.prepare(
      'SELECT content_hash, result_json FROM project_file_results WHERE project_id = ? AND file_path = ?'
    );
    stmt.bind([projectId, filePath]);
    if (!stmt.step()) {
      stmt.free();
      return null;
    }
    const contentHash = String(stmt.get()[0] ?? '');
    const dbJson = String(stmt.get()[1] ?? '');
    stmt.free();

    // Gen3: contentHash → OPFS by hash
    if (contentHash && !dbJson.startsWith('{')) {
      const opfsByHash = await readResultFromOPFS(projectId, contentHash);
      if (opfsByHash) return opfsByHash;
    }

    // Gen2: result_json is a JSON blob
    if (dbJson.startsWith('{')) {
      return JSON.parse(dbJson) as AnalyzeResult;
    }

    return null;
  } catch (error) {
    console.error('[analysis-cache] Failed to read file result:', error);
    return null;
  }
}

// ── 血缘结构化存储（四张表） ──────────────────────────────────────────

/**
 * 将 AnalyzeResult 拆解写入四张结构化表。
 * 先删除该文件的旧数据，再插入新数据。
 */
export async function writeLineageData(
  projectId: string,
  filePath: string,
  result: AnalyzeResult,
  fileContent?: string
): Promise<void> {
  try {
    const db = await getDb();
    const now = Date.now();
    // Begin a transaction to speed up many inserts and avoid partial writes
    try {
      db.run('BEGIN TRANSACTION');
    } catch (e) {
      // ignore if transaction cannot be started
    }

    // 清除该文件的旧数据
    for (const table of ['lineage_statements', 'lineage_nodes', 'lineage_columns', 'lineage_edges']) {
      db.run(`DELETE FROM ${table} WHERE project_id = '${esc(projectId)}' AND file_path = '${esc(filePath)}'`);
    }

    // Process statements in small batches and yield to the main thread occasionally
    const YIELD_EVERY = 50;
    for (let si = 0; si < result.statements.length; si++) {
      const stmt = result.statements[si];
      try {
        // 1. lineage_statements（含 SQL 原文）
        const stmtInsert = db.prepare(
          'INSERT OR REPLACE INTO lineage_statements (project_id, file_path, statement_index, statement_type, source_name, sql_text, join_count, complexity_score, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        );
      // 从 span 截取 SQL 原文
      let sqlText: string | null = null;
      if (fileContent && stmt.span) {
        sqlText = fileContent.slice(stmt.span.start, stmt.span.end);
      } else if (fileContent && result.statements.length === 1) {
        sqlText = fileContent;
      }
        stmtInsert.run([
          projectId,
          filePath,
          stmt.statementIndex,
          stmt.statementType,
          stmt.sourceName ?? null,
          sqlText,
          stmt.joinCount ?? 0,
          stmt.complexityScore ?? 0,
          now,
        ]);
        stmtInsert.free();

      // 构建 ownership 映射：column_id -> parent_node_id
      const ownershipMap = new Map<string, string>();
      for (const edge of stmt.edges) {
        if (edge.type === 'ownership') {
          ownershipMap.set(edge.to, edge.from);
        }
      }

      // 2. lineage_nodes + lineage_columns
      for (const node of stmt.nodes) {
        try {
          if (node.type === 'column') {
            const colInsert = db.prepare(
              'INSERT OR REPLACE INTO lineage_columns (project_id, file_path, column_id, label, qualified_name, parent_node_id, expression, statement_index) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
            );
            colInsert.run([
              projectId,
              filePath,
              node.id,
              node.label,
              node.qualifiedName ?? null,
              ownershipMap.get(node.id) ?? null,
              node.expression ?? null,
              stmt.statementIndex,
            ]);
            colInsert.free();
          } else {
            const nodeInsert = db.prepare(
              'INSERT OR REPLACE INTO lineage_nodes (project_id, file_path, node_id, node_type, label, qualified_name, statement_index, resolution_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
            );
            nodeInsert.run([
              projectId,
              filePath,
              node.id,
              node.type,
              node.label,
              node.qualifiedName ?? null,
              stmt.statementIndex,
              node.resolutionSource ?? null,
            ]);
            nodeInsert.free();
          }
        } catch (err) {
          console.error('[analysis-cache] writeLineageData: node insert failed', { projectId, filePath, nodeId: node.id, error: err });
          // continue with other nodes
        }
      }

      // 3. lineage_edges
      for (const edge of stmt.edges) {
        try {
          const edgeInsert = db.prepare(
            'INSERT OR REPLACE INTO lineage_edges (project_id, file_path, edge_id, from_id, to_id, edge_type, expression, statement_index) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
          );
          edgeInsert.run([
            projectId,
            filePath,
            edge.id,
            edge.from,
            edge.to,
            edge.type,
            edge.expression ?? null,
            stmt.statementIndex,
          ]);
          edgeInsert.free();
        } catch (err) {
          console.error('[analysis-cache] writeLineageData: edge insert failed', { projectId, filePath, edgeId: edge.id, error: err });
        }
      }

      // Periodically yield to the browser to avoid long main-thread blocking and reduce memory pressure
      if (si > 0 && si % YIELD_EVERY === 0) {
        await new Promise<void>((res) => requestAnimationFrame(() => res()));
      }
      
      } catch (err) {
        // If a fatal allocation error occurs, attempt to rollback and surface the error
        console.error('[analysis-cache] writeLineageData: statement processing failed', { projectId, filePath, statementIndex: si, error: err });
        try {
          db.run('ROLLBACK');
        } catch (e) {}
        return;
      }
    }
    console.log(`[analysis-cache] writeLineageData: projectId=${projectId}, filePath=${filePath}, statements=${result.statements.length}`);

    try {
      db.run('COMMIT');
    } catch (e) {
      // ignore commit errors — they will be surfaced elsewhere
    }
  } catch (error) {
    console.error('[analysis-cache] Failed to write lineage data:', error);
  }
}

// ── 结构化表查询 ────────────────────────────────────────────────────

export interface LineageNodeRow {
  nodeId: string;
  nodeType: string;
  label: string;
  qualifiedName: string | null;
  filePath: string;
  statementIndex: number;
}

export interface LineageColumnRow {
  columnId: string;
  label: string;
  qualifiedName: string | null;
  parentNodeId: string | null;
  expression: string | null;
  filePath: string;
  statementIndex: number;
}

export interface LineageEdgeRow {
  edgeId: string;
  fromId: string;
  toId: string;
  edgeType: string;
  expression: string | null;
  filePath: string;
  statementIndex: number | null;
}

/**
 * 查询项目下指定类型的节点。
 */
export async function queryLineageNodes(
  projectId: string,
  nodeTypes?: string[]
): Promise<LineageNodeRow[]> {
  try {
    const db = await getDb();
    let sql = 'SELECT node_id, node_type, label, qualified_name, file_path, statement_index FROM lineage_nodes WHERE project_id = ?';
    const params: (string | number)[] = [projectId];
    if (nodeTypes && nodeTypes.length > 0) {
      sql += ` AND node_type IN (${nodeTypes.map(() => '?').join(',')})`;
      params.push(...nodeTypes);
    }
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const rows: LineageNodeRow[] = [];
    while (stmt.step()) {
      const r = stmt.get();
      rows.push({
        nodeId: String(r[0]),
        nodeType: String(r[1]),
        label: String(r[2]),
        qualifiedName: r[3] != null ? String(r[3]) : null,
        filePath: String(r[4]),
        statementIndex: Number(r[5]),
      });
    }
    stmt.free();
    return rows;
  } catch (error) {
    console.error('[analysis-cache] Failed to query lineage nodes:', error);
    return [];
  }
}

/**
 * 查询项目下的列节点。
 */
export async function queryLineageColumns(
  projectId: string,
  parentNodeIds?: string[]
): Promise<LineageColumnRow[]> {
  try {
    const db = await getDb();
    let sql = 'SELECT column_id, label, qualified_name, parent_node_id, expression, file_path, statement_index FROM lineage_columns WHERE project_id = ?';
    const params: (string | number)[] = [projectId];
    if (parentNodeIds && parentNodeIds.length > 0) {
      sql += ` AND parent_node_id IN (${parentNodeIds.map(() => '?').join(',')})`;
      params.push(...parentNodeIds);
    }
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const rows: LineageColumnRow[] = [];
    while (stmt.step()) {
      const r = stmt.get();
      rows.push({
        columnId: String(r[0]),
        label: String(r[1]),
        qualifiedName: r[2] != null ? String(r[2]) : null,
        parentNodeId: r[3] != null ? String(r[3]) : null,
        expression: r[4] != null ? String(r[4]) : null,
        filePath: String(r[5]),
        statementIndex: Number(r[6]),
      });
    }
    stmt.free();
    return rows;
  } catch (error) {
    console.error('[analysis-cache] Failed to query lineage columns:', error);
    return [];
  }
}

/**
 * 查询项目下的边。
 */
export async function queryLineageEdges(
  projectId: string
): Promise<LineageEdgeRow[]> {
  try {
    const db = await getDb();
    const stmt = db.prepare(
      'SELECT edge_id, from_id, to_id, edge_type, expression, file_path, statement_index FROM lineage_edges WHERE project_id = ?'
    );
    stmt.bind([projectId]);
    const rows: LineageEdgeRow[] = [];
    while (stmt.step()) {
      const r = stmt.get();
      rows.push({
        edgeId: String(r[0]),
        fromId: String(r[1]),
        toId: String(r[2]),
        edgeType: String(r[3]),
        expression: r[4] != null ? String(r[4]) : null,
        filePath: String(r[5]),
        statementIndex: r[6] != null ? Number(r[6]) : null,
      });
    }
    stmt.free();
    return rows;
  } catch (error) {
    console.error('[analysis-cache] Failed to query lineage edges:', error);
    return [];
  }
}

/**
 * 从结构化表查询项目所有实体表的血缘，重建为 AnalyzeResult 供 GraphView 渲染。
 * 对 data_flow 边做传递闭包，穿透 CTE/output 等中间节点。
 */
export async function readGlobalLineageFromTables(
  projectId: string
): Promise<AnalyzeResult | null> {
  try {
    // 1. 查所有节点和边
    const allTableNodes = await queryLineageNodes(projectId);
    const allColumns = await queryLineageColumns(projectId);
    const allEdges = await queryLineageEdges(projectId);

    // 实体表节点
    const physicalTableNodes = allTableNodes.filter((n) => n.nodeType === 'table' || n.nodeType === 'view');
    if (physicalTableNodes.length === 0) return null;

    const physicalTableIds = new Set(physicalTableNodes.map((n) => n.nodeId));

    // 实体表的列
    const physicalColumns = allColumns.filter((c) => c.parentNodeId && physicalTableIds.has(c.parentNodeId));
    const physicalColumnIds = new Set(physicalColumns.map((c) => c.columnId));

    // 所有要保留的节点 ID
    const keepIds = new Set([...physicalTableIds, ...physicalColumnIds]);

    // 2. 构建邻接表用于传递闭包（data_flow 边）
    //    from -> [to1, to2, ...]
    const dataFlowAdj = new Map<string, Set<string>>();
    const ownershipEdges: LineageEdgeRow[] = [];

    for (const e of allEdges) {
      if (e.edgeType === 'data_flow') {
        if (!dataFlowAdj.has(e.fromId)) dataFlowAdj.set(e.fromId, new Set());
        dataFlowAdj.get(e.fromId)!.add(e.toId);
      } else if (e.edgeType === 'ownership' && keepIds.has(e.fromId) && keepIds.has(e.toId)) {
        ownershipEdges.push(e);
      }
    }

    // 3. BFS 穿透中间节点（CTE/output），对实体表节点和列节点都做
    //    从每个实体表节点/列出发，沿 data_flow 找到可达的其他实体表节点/列
    const resolvedDataFlowEdges: { from: string; to: string }[] = [];

    function bfsResolve(startId: string): void {
      const visited = new Set<string>();
      const queue = [startId];
      visited.add(startId);

      while (queue.length > 0) {
        const current = queue.shift()!;
        const targets = dataFlowAdj.get(current);
        if (!targets) continue;

        for (const target of targets) {
          if (visited.has(target)) continue;
          visited.add(target);

          if (keepIds.has(target)) {
            // 到达了另一个实体表/列，建立直接边
            if (target !== startId) {
              resolvedDataFlowEdges.push({ from: startId, to: target });
            }
          } else {
            // 中间节点（CTE/output），继续穿透
            queue.push(target);
          }
        }
      }
    }

    // 对实体表节点和实体表的列都做 BFS
    for (const id of keepIds) {
      bfsResolve(id);
    }

    // 4. 去重边
    const edgeSet = new Set<string>();
    const finalEdges: Edge[] = [];

    for (const e of ownershipEdges) {
      const key = `${e.fromId}->${e.toId}`;
      if (!edgeSet.has(key)) {
        edgeSet.add(key);
        finalEdges.push({
          id: e.edgeId,
          from: e.fromId,
          to: e.toId,
          type: 'ownership',
        });
      }
    }

    let syntheticIdx = 0;
    for (const e of resolvedDataFlowEdges) {
      const key = `${e.from}->${e.to}`;
      if (!edgeSet.has(key)) {
        edgeSet.add(key);
        finalEdges.push({
          id: `synth_df_${syntheticIdx++}`,
          from: e.from,
          to: e.to,
          type: 'data_flow',
        });
      }
    }

    // 5. 按文件分组重建 statements
    const stmtMap = new Map<string, { nodes: Node[]; edges: Edge[]; filePath: string; stmtIdx: number }>();

    for (const n of physicalTableNodes) {
      const key = `${n.filePath}::${n.statementIndex}`;
      if (!stmtMap.has(key)) {
        stmtMap.set(key, { nodes: [], edges: [], filePath: n.filePath, stmtIdx: n.statementIndex });
      }
      stmtMap.get(key)!.nodes.push({
        id: n.nodeId,
        type: n.nodeType as 'table' | 'view',
        label: n.label,
        qualifiedName: n.qualifiedName ?? undefined,
      });
    }

    for (const c of physicalColumns) {
      const key = `${c.filePath}::${c.statementIndex}`;
      if (!stmtMap.has(key)) {
        stmtMap.set(key, { nodes: [], edges: [], filePath: c.filePath, stmtIdx: c.statementIndex });
      }
      stmtMap.get(key)!.nodes.push({
        id: c.columnId,
        type: 'column',
        label: c.label,
        qualifiedName: c.qualifiedName ?? undefined,
        expression: c.expression ?? undefined,
      });
    }

    // 把边分配到 statement（取 from 节点所在的 statement）
    const nodeToStmtKey = new Map<string, string>();
    for (const n of physicalTableNodes) nodeToStmtKey.set(n.nodeId, `${n.filePath}::${n.statementIndex}`);
    for (const c of physicalColumns) nodeToStmtKey.set(c.columnId, `${c.filePath}::${c.statementIndex}`);

    for (const e of finalEdges) {
      const key = nodeToStmtKey.get(e.from) ?? nodeToStmtKey.get(e.to);
      if (key && stmtMap.has(key)) {
        stmtMap.get(key)!.edges.push(e);
      }
    }

    const statements: StatementLineage[] = [...stmtMap.values()].map((s) => ({
      statementIndex: s.stmtIdx,
      statementType: 'SELECT',
      sourceName: s.filePath,
      nodes: s.nodes,
      edges: s.edges,
      joinCount: 0,
      complexityScore: 0,
    }));

    // globalLineage
    const globalNodes = [...new Map(physicalTableNodes.map((n) => [n.nodeId, {
      id: n.nodeId,
      type: n.nodeType as 'table' | 'view',
      label: n.label,
      canonicalName: { name: n.qualifiedName ?? n.label },
      statementRefs: physicalTableNodes
        .filter((t) => t.nodeId === n.nodeId)
        .map((t) => ({ statementIndex: t.statementIndex, nodeId: t.nodeId })),
    }])).values()];

    return {
      statements,
      globalLineage: {
        nodes: globalNodes,
        edges: finalEdges.map((e) => ({
          id: e.id,
          from: e.from,
          to: e.to,
          type: e.type as Edge['type'],
        })),
      },
      issues: [],
      summary: {
        statementCount: statements.length,
        tableCount: physicalTableIds.size,
        columnCount: physicalColumns.length,
        joinCount: 0,
        complexityScore: 0,
        issueCount: { errors: 0, warnings: 0, infos: 0 },
        hasErrors: false,
      },
      resolvedSchema: undefined,
    };
  } catch (error) {
    console.error('[analysis-cache] Failed to read global lineage from tables:', error);
    return null;
  }
}

export async function clearAnalysisCache(): Promise<void> {
  try {
    const db = await getDb();
    db.run('DELETE FROM analysis_cache');
    await persistNow();
  } catch (error) {
    console.error('[analysis-cache] Failed to clear cache:', error);
  }
}

/**
 * 清理指定项目的所有血缘数据（四张结构化表 + project_file_results）。
 */
export async function clearProjectLineage(projectId: string): Promise<void> {
  try {
    const db = await getDb();
    for (const table of [
      'lineage_statements',
      'lineage_nodes',
      'lineage_columns',
      'lineage_edges',
      'lineage_table_flows',
      'lineage_hierarchy',
      'schema_tables',
      'schema_columns',
      'project_file_results',
    ]) {
      db.run(`DELETE FROM ${table} WHERE project_id = '${esc(projectId)}'`);
    }
    // Also delete OPFS result files
    await removeProjectResultsDir(projectId);
    console.log(`[analysis-cache] clearProjectLineage: projectId=${projectId}`);
    await persistNow();
  } catch (error) {
    console.error('[analysis-cache] Failed to clear project lineage:', error);
  }
}

// ── 源表→目标表映射写入 ────────────────────────────────────────────

/**
 * 从 AnalyzeResult 提取物理表之间的源→目标关系并写入 lineage_table_flows。
 * BFS 逻辑与 buildTableLevelLineage / extractSchemaFromResult 一致。
 */
export async function writeTableFlows(
  projectId: string,
  filePath: string,
  result: AnalyzeResult
): Promise<void> {
  try {
    const db = await getDb();
    try {
      db.run('BEGIN TRANSACTION');
    } catch (e) {}
    db.run(`DELETE FROM lineage_table_flows WHERE project_id = '${esc(projectId)}' AND file_path = '${esc(filePath)}'`);

    // 构建临时表名集合
    const tempNames = new Set<string>();
    for (const rst of result.resolvedSchema?.tables ?? []) {
      if (rst.temporary) {
        tempNames.add(rst.name);
        if (rst.schema) tempNames.add(`${rst.schema}.${rst.name}`);
      }
    }

    const isPhysical = (n: { type: string; qualifiedName?: string; label: string; resolutionSource?: string }) => {
      if (n.type !== 'table' && n.type !== 'view') return false;
      const qn = n.qualifiedName || n.label;
      if (tempNames.has(qn) || tempNames.has(n.label)) return false;
      if (n.resolutionSource) return true;
      return qn.includes('.');
    };

    const flows = new Set<string>();

    // Process statements with index and yield periodically to reduce memory pressure
    const YIELD_EVERY = 80;
    for (let si = 0; si < result.statements.length; si++) {
      const stmt = result.statements[si];
      const nodeById = new Map(stmt.nodes.map((n) => [n.id, n]));
      const physicalIds = new Set(stmt.nodes.filter(isPhysical).map((n) => n.id));

      const adj = new Map<string, string[]>();
      for (const edge of stmt.edges) {
        if (edge.type === 'ownership') {
          if (!adj.has(edge.to)) adj.set(edge.to, []);
          adj.get(edge.to)!.push(edge.from);
        } else {
          if (!adj.has(edge.from)) adj.set(edge.from, []);
          adj.get(edge.from)!.push(edge.to);
        }
      }

      for (const src of stmt.nodes.filter(isPhysical)) {
        const srcQ = src.qualifiedName || src.label;
        const visited = new Set<string>([src.id]);
        const queue = [src.id];
        while (queue.length > 0) {
          const cur = queue.shift()!;
          for (const next of adj.get(cur) || []) {
            if (visited.has(next)) continue;
            visited.add(next);
            if (physicalIds.has(next)) {
              const tgt = nodeById.get(next)!;
              const tgtQ = tgt.qualifiedName || tgt.label;
              if (srcQ !== tgtQ) flows.add(`${srcQ}\t${tgtQ}`);
            } else {
              queue.push(next);
            }
          }
        }
      }

      if (si > 0 && si % YIELD_EVERY === 0) {
        await new Promise<void>((res) => requestAnimationFrame(() => res()));
      }
    }

    // Insert flows in batches with error handling and periodic yielding
    let inserted = 0;
    for (const key of flows) {
      try {
        const [src, tgt] = key.split('\t');
        const ins = db.prepare(
          'INSERT OR REPLACE INTO lineage_table_flows (project_id, file_path, source_table, target_table) VALUES (?, ?, ?, ?)'
        );
        ins.run([projectId, filePath, src, tgt]);
        ins.free();
        inserted++;
      } catch (err) {
        console.error('[analysis-cache] writeTableFlows: insert failed', { projectId, filePath, key, error: err });
      }
      if (inserted > 0 && inserted % YIELD_EVERY === 0) {
        await new Promise<void>((res) => requestAnimationFrame(() => res()));
      }
    }

    try {
      db.run('COMMIT');
    } catch (e) {}

  } catch (error) {
    console.error('[analysis-cache] Failed to write table flows:', error);
  }
}

// ── Schema 结构写入 ─────────────────────────────────────────────────

/**
 * 从 resolvedSchema 写入 schema_tables + schema_columns。
 */
export async function writeSchemaData(
  projectId: string,
  result: AnalyzeResult
): Promise<void> {
  try {
    if (!result.resolvedSchema?.tables?.length) return;
    const db = await getDb();
    const now = Date.now();

    for (const table of result.resolvedSchema.tables) {
      const qName = [table.catalog, table.schema, table.name].filter(Boolean).join('.');
      const ins = db.prepare(
        'INSERT OR REPLACE INTO schema_tables (project_id, table_name, catalog, schema_name, short_name, origin, is_temporary, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      );
      ins.run([
        projectId, qName, table.catalog ?? null, table.schema ?? null,
        table.name, table.origin ?? null, table.temporary ? 1 : 0, now,
      ]);
      ins.free();

      for (const col of table.columns ?? []) {
        const colIns = db.prepare(
          'INSERT OR REPLACE INTO schema_columns (project_id, table_name, column_name, data_type, is_primary_key, fk_table, fk_column) VALUES (?, ?, ?, ?, ?, ?, ?)'
        );
        colIns.run([
          projectId, qName, col.name, col.dataType ?? null,
          col.isPrimaryKey ? 1 : 0, col.foreignKey?.table ?? null, col.foreignKey?.column ?? null,
        ]);
        colIns.free();
      }
    }

  } catch (error) {
    console.error('[analysis-cache] Failed to write schema data:', error);
  }
}

// ── 层级信息写入 ────────────────────────────────────────────────────

/**
 * 从 globalLineage.nodes 写入 lineage_hierarchy。
 */
export async function writeHierarchyData(
  projectId: string,
  result: AnalyzeResult
): Promise<void> {
  try {
    if (!result.globalLineage?.nodes?.length) return;
    const db = await getDb();

    // 构建 ownership 映射：child -> parent
    const parentMap = new Map<string, string>();
    for (const edge of result.globalLineage.edges ?? []) {
      if (edge.type === 'ownership') {
        parentMap.set(edge.to, edge.from);
      }
    }

    for (const node of result.globalLineage.nodes) {
      const parentId = parentMap.get(node.id) ?? null;
      const depth = node.type === 'column' ? 1 : 0;
      const cn = node.canonicalName;
      const qName = cn
        ? [cn.catalog, cn.schema, cn.name, cn.column].filter(Boolean).join('.')
        : node.label;

      const ins = db.prepare(
        'INSERT OR REPLACE INTO lineage_hierarchy (project_id, node_id, node_type, label, qualified_name, parent_id, depth, statement_refs) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      );
      ins.run([
        projectId, node.id, node.type, node.label, qName,
        parentId, depth, JSON.stringify(node.statementRefs ?? []),
      ]);
      ins.free();
    }

  } catch (error) {
    console.error('[analysis-cache] Failed to write hierarchy data:', error);
  }
}

/**
 * 导出整个 SQLite 数据库为 .db 文件，可用任意 SQLite 客户端打开。
 */
export async function exportSqliteDb(): Promise<Uint8Array> {
  const db = await getDb();
  return db.export();
}
