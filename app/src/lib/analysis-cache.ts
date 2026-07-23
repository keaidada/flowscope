/**
 * Analysis result cache and lineage persistence.
 *
 * All storage goes through the Rust backend SQLite via REST API.
 */

import type { AnalyzeResult, StatementLineage, Node, Edge } from '@pondpilot/flowscope-core';
import * as serverDb from './server-db';

// ── 统一异常拦截器 ──────────────────────────────────────────────

export type AnomalySeverity = 'error' | 'warning' | 'info';
export type AnomalyCategory =
  | 'no_dataflow'
  | 'self_ref_only'
  | 'write_failed'
  | 'parse_empty'
  | 'cache_stale'
  | 'repair_needed'
  | 'repair_ok';

export interface Anomaly {
  category: AnomalyCategory;
  severity: AnomalySeverity;
  message: string;
  script?: string;
  detail?: string;
}

let _anomalyListener: ((a: Anomaly) => void) | null = null;

/** 注册全局异常监听器（比如用于 toast 通知） */
export function onAnalysisAnomaly(listener: (a: Anomaly) => void): () => void {
  _anomalyListener = listener;
  return () => { _anomalyListener = null; };
}

function emit(anomaly: Anomaly, projectId?: string): void {
  if (_anomalyListener) {
    try { _anomalyListener(anomaly); } catch { /* listener 不应影响主流程 */ }
  }
  const level = anomaly.severity === 'error' ? 'error' : anomaly.severity === 'warning' ? 'warn' : 'log';
  console[level](`[LineageAnomaly][${anomaly.category}]`, anomaly.message, anomaly.detail ?? '');
  if (projectId && (anomaly.severity === 'error' || anomaly.severity === 'warning')) {
    recordAnomalyToDb(projectId, anomaly);
  }
}

/** 异步记录 anomaly 到数据库异常表，不阻塞主流程 */
function recordAnomalyToDb(projectId: string, anomaly: Anomaly): void {
  import('./server-db').then(db => {
    let fromPath = '';
    try { fromPath = window.location.pathname; } catch {}
    db.saveAnomaly(projectId, {
      filePath: anomaly.script ?? fromPath,
      scriptName: anomaly.script ?? '',
      scriptContent: '',
      severity: anomaly.severity,
      anomalyType: anomaly.category,
      message: anomaly.message,
      detail: anomaly.detail ?? '',
      isTest: 0,
    }).catch(() => {});
  }).catch(() => {});
}

/** 检查 AnalyzeResult 是否有有效的 data_flow（非纯自引用） */
export function hasMeaningfulLineage(result: AnalyzeResult | null): boolean {
  if (!result) return false;
  return result.statements.some(stmt =>
    stmt.edges?.some(e => e.type === 'data_flow' && e.from !== e.to)
  );
}

/** 检查 AnalyzeResult 是否有任何 data_flow 边 */
export function hasAnyDataFlow(result: AnalyzeResult | null): boolean {
  if (!result) return false;
  return result.statements.some(stmt =>
    stmt.edges?.some(e => e.type === 'data_flow')
  );
}

// ── Analysis result cache ───────────────────────────────────────────

export async function readCachedAnalysisResult(cacheKey: string): Promise<AnalyzeResult | null> {
  const { cached, result } = await serverDb.getCacheResult(cacheKey);
  if (!cached) return null;
  try {
    return result as AnalyzeResult;
  } catch {
    return null;
  }
}

export async function writeCachedAnalysisResult(
  cacheKey: string,
  result: AnalyzeResult,
  maxBytes: number
): Promise<void> {
  const resultJson = JSON.stringify(result);
  if (new TextEncoder().encode(resultJson).length > maxBytes) return;
  await serverDb.setCacheResult(cacheKey, result);
}

export async function deleteCachedAnalysisResult(cacheKey: string): Promise<void> {
  await serverDb.deleteCacheResult(cacheKey);
}

export async function clearAnalysisCache(): Promise<void> {
  await serverDb.clearCache();
}

// ── Per-file result ────────────────────────────────────────────────

export async function writeBatchFileResults(
  projectId: string,
  filePaths: string[],
  contentHash: string,
  result: AnalyzeResult
): Promise<void> {
  await serverDb.saveProjectFileResults(projectId, filePaths.map(fp => ({
    file_path: fp,
    content_hash: contentHash || 'no_hash',
    result_json: '',
    updated_at: new Date().toISOString(),
  })));

  // Also store the full result once, keyed by hash
  const cacheKey = `result:${projectId}:hash:${contentHash || 'no_hash'}`;
  await serverDb.setCacheResult(cacheKey, result);
}

export async function writeFileResult(
  projectId: string,
  filePath: string,
  contentHash: string,
  result: AnalyzeResult
): Promise<void> {
  await serverDb.saveProjectFileResults(projectId, [{
    file_path: filePath,
    content_hash: contentHash || 'no_hash',
    updated_at: new Date().toISOString(),
  }]);

  const cacheKey = `result:${projectId}:hash:${contentHash || 'no_hash'}`;
  await serverDb.setCacheResult(cacheKey, result);
}

export async function readFileResultPaths(projectId: string): Promise<string[]> {
  const rows = await serverDb.loadProjectFileResultsLight(projectId);
  return rows.map(r => r.file_path);
}

export async function readFileResult(
  projectId: string,
  filePath: string
): Promise<AnalyzeResult | null> {
  const rows = await serverDb.loadProjectFileResults(projectId);
  const row = rows.find(r => r.file_path === filePath);
  if (!row) return null;

  const hash = row.content_hash || 'no_hash';
  const cacheKey = `result:${projectId}:hash:${hash}`;
  const { cached, result } = await serverDb.getCacheResult(cacheKey);
  return cached ? (result as AnalyzeResult) : null;
}

export async function readFileResultJson(
  projectId: string,
  filePath: string
): Promise<string | null> {
  const result = await readFileResult(projectId, filePath);
  return result ? JSON.stringify(result) : null;
}

export async function readAllFileResults(
  projectId: string
): Promise<{ filePath: string; result: AnalyzeResult }[]> {
  const rows = await serverDb.loadProjectFileResults(projectId);
  const results: { filePath: string; result: AnalyzeResult }[] = [];

  // Group by hash, read each unique result once
  const hashCache = new Map<string, AnalyzeResult>();
  for (const row of rows) {
    const hash = row.content_hash || 'no_hash';
    let parsed = hashCache.get(hash);
    if (!parsed) {
      const cacheKey = `result:${projectId}:hash:${hash}`;
      const { cached, result } = await serverDb.getCacheResult(cacheKey);
      if (cached) {
        parsed = result as AnalyzeResult;
        hashCache.set(hash, parsed);
      }
    }
    if (parsed) {
      results.push({ filePath: row.file_path, result: parsed });
    }
  }

  return results;
}

export async function* streamUniqueProjectResultJsons(
  projectId: string
): AsyncGenerator<string, void, void> {
  const rows = await serverDb.loadProjectFileResults(projectId);
  const seen = new Set<string>();
  for (const row of rows) {
    const hash = row.content_hash || 'no_hash';
    if (seen.has(hash)) continue;
    seen.add(hash);

    const cacheKey = `result:${projectId}:hash:${hash}`;
    const { cached, result } = await serverDb.getCacheResult(cacheKey);
    if (cached) {
      yield JSON.stringify(result);
    }
  }
}

// ── 血缘结构化存储 ─────────────────────────────────────────────────

async function writeLineageDataViaServer(
  projectId: string,
  result: AnalyzeResult,
): Promise<void> {
  const nodes: serverDb.LineageNodeRow[] = [];
  const columns: serverDb.LineageColumnRow[] = [];
  const edges: serverDb.LineageEdgeRow[] = [];

  for (const stmt of result.statements) {
    const fp = stmt.sourceName || '';
    const ownershipMap = new Map<string, string>();
    for (const edge of stmt.edges) {
      if (edge.type === 'ownership') {
        ownershipMap.set(edge.to, edge.from);
      }
    }

    // Collect every node ID that exists in this statement (table/view/cte + column).
    // Used to drop orphan edges/columns whose owning endpoint is missing, which
    // can happen when analyzer's qualified-column fallback resolves a CTE owner
    // via `relation_node_id` (table_* prefix) while the CTE node itself uses a
    // `cte_*`-prefixed ID. Filtering at write-time keeps the persisted graph
    // referentially intact without churning analyzer internals.
    const allNodeIds = new Set<string>();
    for (const n of stmt.nodes) allNodeIds.add(n.id);

    // Track node IDs that actually get persisted (table/view/cte nodes are
    // always persisted; columns are persisted only if their parent exists).
    // Edges must reference only persisted endpoints, otherwise the DB will
    // contain edges whose endpoints aren't in lineage_nodes/lineage_columns.
    const persistedNodeIds = new Set<string>();

    for (const node of stmt.nodes) {
      if (node.type === 'column') {
        const parent = ownershipMap.get(node.id) ?? null;
        // Drop columns whose declared parent isn't actually present in this
        // statement — writing them would create dangling ownership edges.
        if (parent !== null && !allNodeIds.has(parent)) continue;
        persistedNodeIds.add(node.id);
        columns.push({
          column_id: node.id,
          label: node.label,
          qualified_name: node.qualifiedName ?? null,
          parent_node_id: parent,
          expression: node.expression ?? null,
          statement_index: stmt.statementIndex,
          file_path: fp,
        });
      } else {
        persistedNodeIds.add(node.id);
        nodes.push({
          node_id: node.id,
          node_type: node.type,
          label: node.label,
          qualified_name: node.qualifiedName ?? null,
          statement_index: stmt.statementIndex,
          resolution_source: node.resolutionSource ?? null,
          file_path: fp,
        });
      }
    }

    for (const edge of stmt.edges) {
      // Skip edges that point at non-existent OR non-persisted nodes.
      // Using `persistedNodeIds` (not `allNodeIds`) ensures we don't write
      // edges that reference columns filtered out above.
      if (!persistedNodeIds.has(edge.from) || !persistedNodeIds.has(edge.to)) continue;
      edges.push({
        edge_id: edge.id,
        from_id: edge.from,
        to_id: edge.to,
        edge_type: edge.type,
        expression: edge.expression ?? null,
        statement_index: stmt.statementIndex,
        file_path: fp,
      });
    }
  }

  await serverDb.saveLineageBatch(projectId, nodes, columns, edges);
}

export async function writeLineageData(
  projectId: string,
  result: AnalyzeResult,
): Promise<void> {
  await writeLineageDataViaServer(projectId, result);
}

/**
 * 从 lineage_nodes + lineage_edges 计算 table_level_edges。
 * 逻辑：遍历 data_flow 边的 from/to 端点，from=READ, to=WRITE。
 * 每个脚本内：READ 表 → WRITE 表 作为一条边。
 * 纯表级，不涉及字段/CTE 解析。
 */
// ── Script groups cache (computed once by writeTableLevelEdges, read by getOutputGroups) ──
const _groupsCache = new Map<string, Map<string, OutputGroup[]>>();

interface OutputGroup {
  inputs: string[];
  outputs: string[];
}

export async function writeTableLevelEdges(projectId: string): Promise<void> {
  const [rawNodes, rawEdges] = await Promise.all([
    serverDb.getLineageNodes(projectId),
    serverDb.getLineageEdges(projectId, undefined, 'data_flow'),
  ]);
  await _writeTableLevelEdgesInternal(projectId, rawNodes, rawEdges);
}

/** 内部函数：直接用已加载的数据重建 TLE，避免重复请求 */
async function _writeTableLevelEdgesInternal(
  projectId: string,
  rawNodes: serverDb.LineageNodeRow[],
  rawEdges: serverDb.LineageEdgeRow[],
): Promise<void> {

  // node_id is UNIQUE per (project_id, file_path), NOT globally unique.
  // Same CTE name in different files → same hash node_id.
  // Key by (file_path, node_id) to prevent cross-file contamination.
  const nidToQn = new Map<string, string>();
  for (const n of rawNodes) {
    if (n.node_type === 'table' || n.node_type === 'view') {
      nidToQn.set(`${n.file_path}\0${n.node_id}`, (n.qualified_name ?? n.label).toLowerCase());
    }
  }
  const tableIds = new Set(nidToQn.keys());

  // Group data_flow edges by (script, statement_index)
  const stmtReads = new Map<string, Set<string>>();
  const stmtWrites = new Map<string, Set<string>>();
  // Track CTE nodes per statement for CTE-chain merging
  const stmtCteNodes = new Map<string, Set<string>>();
  const allStmtKeys = new Set<string>();

  for (const e of rawEdges) {
    if (e.edge_type !== 'data_flow') continue;
    if (e.statement_index == null) continue;
    const stmtKey = `${e.file_path}\0${e.statement_index}`;
    const fromKey = `${e.file_path}\0${e.from_id}`;
    const toKey = `${e.file_path}\0${e.to_id}`;
    allStmtKeys.add(stmtKey);
    if (tableIds.has(fromKey)) {
      const qn = nidToQn.get(fromKey);
      if (qn) {
        if (!stmtReads.has(stmtKey)) stmtReads.set(stmtKey, new Set());
        stmtReads.get(stmtKey)!.add(qn);
      }
    }
    if (tableIds.has(toKey)) {
      const qn = nidToQn.get(toKey);
      if (qn) {
        if (!stmtWrites.has(stmtKey)) stmtWrites.set(stmtKey, new Set());
        stmtWrites.get(stmtKey)!.add(qn);
      }
    }
    // Track CTE/intermediate endpoints for union-find merging
    // CTE = endpoint NOT in tableIds (scoped) AND not a column
    if (!stmtCteNodes.has(stmtKey)) stmtCteNodes.set(stmtKey, new Set());
    if (!tableIds.has(fromKey) && !e.from_id.startsWith('column_')) stmtCteNodes.get(stmtKey)!.add(e.from_id);
    if (!tableIds.has(toKey) && !e.to_id.startsWith('column_')) stmtCteNodes.get(stmtKey)!.add(e.to_id);
  }

  // ── CTE-chain merge: union statements that share CTE nodes ──────────────
  // The parser may split a WITH...INSERT into multiple statement_index values.
  // Union-find merges them so reads in one sub-statement connect to writes in another.
  const ufParent = new Map<string, string>();
  function ufFind(x: string): string {
    if (!ufParent.has(x)) ufParent.set(x, x);
    let root = x;
    while (ufParent.get(root)! !== root) root = ufParent.get(root)!;
    let cur = x;
    while (ufParent.get(cur)! !== root) { const n = ufParent.get(cur)!; ufParent.set(cur, root); cur = n; }
    return root;
  }
  function ufUnion(a: string, b: string): void { const ra = ufFind(a), rb = ufFind(b); if (ra !== rb) ufParent.set(ra, rb); }

  // Build CTE → stmtKeys map — CTE key MUST include script path
  // because the Rust parser reuses CTE node IDs across different files
  // (same CTE name → same hash). Without script prefix, union-find would
  // merge statements from different scripts, causing cross-contamination.
  const cteToStmts = new Map<string, Set<string>>();
  for (const [stmtKey, ctes] of stmtCteNodes) {
    const script = stmtKey.split('\0')[0];
    for (const cte of ctes) {
      const perScriptCteKey = `${script}\0${cte}`;
      if (!cteToStmts.has(perScriptCteKey)) cteToStmts.set(perScriptCteKey, new Set());
      cteToStmts.get(perScriptCteKey)!.add(stmtKey);
    }
  }
  // Union stmtKeys sharing a CTE
  for (const stmts of cteToStmts.values()) {
    const arr = [...stmts];
    for (let i = 1; i < arr.length; i++) ufUnion(arr[0], arr[i]);
  }

  // Merge reads/writes by union representative
  const mergedReads = new Map<string, Set<string>>();
  const mergedWrites = new Map<string, Set<string>>();
  for (const stmtKey of allStmtKeys) {
    const root = ufFind(stmtKey);
    if (!mergedReads.has(root)) { mergedReads.set(root, new Set()); mergedWrites.set(root, new Set()); }
    for (const r of stmtReads.get(stmtKey) ?? []) mergedReads.get(root)!.add(r);
    for (const w of stmtWrites.get(stmtKey) ?? []) mergedWrites.get(root)!.add(w);
  }

  // Cross-product reads × writes WITHIN each merged group
  const mergedScript = new Map<string, string>();
  for (const stmtKey of allStmtKeys) {
    const root = ufFind(stmtKey);
    mergedScript.set(root, stmtKey.split('\0')[0]);
  }

  const edgeSet = new Set<string>();
  const edges: Array<[string, string, string]> = [];
  for (const [root, reads] of mergedReads) {
    const writes = mergedWrites.get(root);
    if (!writes || writes.size === 0) continue;
    const script = mergedScript.get(root)!;
    for (const fromQn of reads) {
      for (const toQn of writes) {
        if (fromQn !== toQn) {
          const dedup = `${fromQn}\0${toQn}\0${script}`;
          if (!edgeSet.has(dedup)) {
            edgeSet.add(dedup);
            edges.push([fromQn, toQn, script]);
          }
        }
      }
    }
  }

  if (edges.length > 0) {
    await serverDb.saveTableLevelEdges(projectId, edges);
  }

  // ── Cache per-script groups for getOutputGroups to reuse ──────────────
  const groupsByScript = new Map<string, OutputGroup[]>();
  for (const [root, reads] of mergedReads) {
    const writes = mergedWrites.get(root);
    if (!writes || writes.size === 0) continue;
    if (reads.size === 0) continue;
    const script = mergedScript.get(root)!;
    if (!groupsByScript.has(script)) groupsByScript.set(script, []);
    groupsByScript.get(script)!.push({ inputs: [...reads], outputs: [...writes] });
  }
  // ── 合并同脚本内共享输出表的组，避免同一表作为多个组 output 重复 ──
  for (const [, groups] of groupsByScript) {
    if (groups.length <= 1) continue;
    const parent = groups.map((_, i) => i);
    const find = (i: number): number => {
      while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
      return i;
    };
    const union = (a: number, b: number) => { parent[find(a)] = find(b); };
    // Build output → group index map, merge when collision
    const outToGroup = new Map<string, number>();
    for (let i = 0; i < groups.length; i++) {
      for (const o of groups[i].outputs) {
        const prev = outToGroup.get(o);
        if (prev !== undefined) union(prev, i);
        outToGroup.set(o, find(i));
      }
    }
    // Collect merged groups
    const merged: Map<number, { inputs: Set<string>; outputs: Set<string> }> = new Map();
    for (let i = 0; i < groups.length; i++) {
      const root = find(i);
      if (!merged.has(root)) merged.set(root, { inputs: new Set(), outputs: new Set() });
      const m = merged.get(root)!;
      for (const x of groups[i].inputs) m.inputs.add(x);
      for (const x of groups[i].outputs) m.outputs.add(x);
    }
    if (merged.size < groups.length) {
      groups.length = 0;
      for (const m of merged.values()) {
        groups.push({ inputs: [...m.inputs], outputs: [...m.outputs] });
      }
    }
  }
  _groupsCache.set(projectId, groupsByScript);
}

/**
 * 一次性重建 table_level_edges（全局血缘打开时触发）
 */

// ── 结构化表查询 ──────────────────────────────────────────────────

export interface LineageNodeRow {
  nodeId: string;
  nodeType: string;
  label: string;
  qualifiedName: string | null;
  filePath: string;
  fileName?: string;
  dirPath?: string;
  statementIndex: number;
}

export interface LineageColumnRow {
  columnId: string;
  label: string;
  qualifiedName: string | null;
  parentNodeId: string | null;
  expression: string | null;
  filePath: string;
  fileName?: string;
  dirPath?: string;
  statementIndex: number;
}

export interface LineageEdgeRow {
  edgeId: string;
  fromId: string;
  toId: string;
  edgeType: string;
  expression: string | null;
  filePath: string;
  fileName?: string;
  dirPath?: string;
  statementIndex: number | null;
}

export async function queryLineageNodes(
  projectId: string,
  nodeTypes?: string[],
  filePath?: string
): Promise<LineageNodeRow[]> {
  let nodes = await serverDb.getLineageNodes(projectId, filePath);
  if (nodeTypes?.length) {
    nodes = nodes.filter(n => nodeTypes.includes(n.node_type));
  }
  return nodes.map(n => ({
    nodeId: n.node_id,
    nodeType: n.node_type,
    label: n.label,
    qualifiedName: n.qualified_name,
    filePath: n.file_path,
    fileName: n.file_name,
    dirPath: n.dir_path,
    statementIndex: n.statement_index,
  }));
}

export async function queryLineageColumns(
  projectId: string,
  parentNodeIds?: string[],
  filePath?: string
): Promise<LineageColumnRow[]> {
  let cols = await serverDb.getLineageColumns(projectId, filePath);
  if (parentNodeIds?.length) {
    cols = cols.filter(c => parentNodeIds.includes(c.parent_node_id || ''));
  }
  return cols.map(c => ({
    columnId: c.column_id,
    label: c.label,
    qualifiedName: c.qualified_name,
    parentNodeId: c.parent_node_id,
    expression: c.expression,
    filePath: c.file_path,
    fileName: c.file_name,
    dirPath: c.dir_path,
    statementIndex: c.statement_index,
  }));
}

export async function queryLineageEdges(
  projectId: string,
  filePath?: string
): Promise<LineageEdgeRow[]> {
  const edges = await serverDb.getLineageEdges(projectId, filePath);
  return edges.map(e => ({
    edgeId: e.edge_id,
    fromId: e.from_id,
    toId: e.to_id,
    edgeType: e.edge_type,
    expression: e.expression,
    filePath: e.file_path,
    fileName: e.file_name,
    dirPath: e.dir_path,
    statementIndex: e.statement_index,
  }));
}

// ── 全局血缘重建（只用 lineage_nodes，不查 edges/columns）─────────

/**
 * 从完整的 AnalyzeResult 重新填充 table_level_edges。
 * 一次性操作，数据洞察的搜索精度依赖此表。
 */
export async function repopulateTableLevelEdges(
  projectId: string,
): Promise<number> {
  await writeTableLevelEdges(projectId);
  const result = await serverDb.loadTableLevelEdges(projectId).catch(() => [] as Array<[string, string, string]>);
  return result.length;
}

/**
 * 只从 lineage_nodes 表构建全局血缘。
 * 用 resolution_source='implied' 区分读写方向。
 * 每个脚本内：READ 表 → WRITE 表 作为 data_flow 边。
 * 极快（1.1MB 查询 vs 19.8MB 完整 AnalyzeResult）。
 */
export async function buildGlobalLineageFromNodes(
  projectId: string,
): Promise<AnalyzeResult | null> {
  const rawNodes = await getOrLoadNodes(projectId);
  const tableNodes = rawNodes.filter(
    (n) => n.node_type === 'table' || n.node_type === 'view',
  );
  if (tableNodes.length === 0) return null;

  // 去重：qualified_name → 统一 nodeId
  const qnameToNodeId = new Map<string, string>();
  const qnameToLabel = new Map<string, string>();
  let idx = 0;
  for (const n of tableNodes) {
    const qn = (n.qualified_name ?? n.label).toLowerCase();
    if (!qnameToNodeId.has(qn)) {
      qnameToNodeId.set(qn, `gt_${idx++}`);
      qnameToLabel.set(qn, n.label);
    }
  }

  // 按 (脚本, statement_index) 分组：reads / writes — 尊重 per-statement 边界
  const stmtMap = new Map<string, { script: string; reads: Set<string>; writes: Set<string> }>();
  for (const n of tableNodes) {
    const script = n.file_path;
    const stmtKey = `${script}\0${n.statement_index}`;
    const qn = (n.qualified_name ?? n.label).toLowerCase();
    if (!stmtMap.has(stmtKey)) stmtMap.set(stmtKey, { script, reads: new Set(), writes: new Set() });
    const isWrite = n.resolution_source === 'implied';
    if (isWrite) stmtMap.get(stmtKey)!.writes.add(qn);
    else stmtMap.get(stmtKey)!.reads.add(qn);
  }

  // 构建 statements + edges — 每条 statement 独立 cross-product
  const edgeSet = new Set<string>();
  const allEdges: Edge[] = [];
  let edgeIdx = 0;
  const statements: StatementLineage[] = [];
  let stmtIdx = 0;

  // 按 script 分组 statement 的 edges 和 nodes
  const scriptStmts = new Map<string, Array<{ reads: Set<string>; writes: Set<string> }>>();
  for (const { script, reads, writes } of stmtMap.values()) {
    if (!scriptStmts.has(script)) scriptStmts.set(script, []);
    scriptStmts.get(script)!.push({ reads, writes });
  }

  for (const [script, stmtList] of scriptStmts) {
    // 合并该脚本所有 statement 的 reads/writes 用于节点展示
    const scriptReads = new Set<string>();
    const scriptWrites = new Set<string>();
    for (const { reads, writes } of stmtList) {
      for (const r of reads) scriptReads.add(r);
      for (const w of writes) scriptWrites.add(w);
    }

    const stmtNodes: Node[] = [];
    const stmtEdges: Edge[] = [];
    const seen = new Set<string>();

    for (const qn of [...scriptReads, ...scriptWrites]) {
      const nodeId = qnameToNodeId.get(qn)!;
      if (seen.has(nodeId)) continue;
      seen.add(nodeId);
      stmtNodes.push({
        id: nodeId,
        type: 'table',
        label: qnameToLabel.get(qn)!,
        qualifiedName: qn,
      });
    }

    // READ → WRITE 边：per-statement cross-product，然后 dedup
    for (const { reads, writes } of stmtList) {
      for (const fromQn of reads) {
        for (const toQn of writes) {
          const fromId = qnameToNodeId.get(fromQn)!;
          const toId = qnameToNodeId.get(toQn)!;
          if (fromId === toId) continue;
          const key = `${fromId}->${toId}`;
          if (edgeSet.has(key)) continue;
          edgeSet.add(key);
          const edge: Edge = { id: `ge_${edgeIdx++}`, from: fromId, to: toId, type: 'data_flow' };
          allEdges.push(edge);
          stmtEdges.push(edge);
        }
      }
    }

    if (stmtNodes.length > 0) {
      statements.push({
        statementIndex: stmtIdx++,
        statementType: 'GLOBAL',
        sourceName: script,
        nodes: stmtNodes,
        edges: stmtEdges,
        joinCount: 0,
        complexityScore: 0,
      });
    }
  }

  const globalNodes = [...qnameToNodeId.entries()].map(([qn, id]) => ({
    id,
    type: 'table' as const,
    label: qnameToLabel.get(qn)!,
    canonicalName: { name: qn },
    statementRefs: [],
  }));

  return {
    statements,
    globalLineage: { nodes: globalNodes, edges: allEdges },
    issues: [],
    summary: {
      statementCount: statements.length,
      tableCount: qnameToNodeId.size,
      columnCount: 0,
      joinCount: 0,
      complexityScore: 0,
      issueCount: { errors: 0, warnings: 0, infos: 0 },
      hasErrors: false,
    },
  };
}

// ── 旧版全局血缘重建（查 nodes + columns + edges，较慢）────────────

export async function readGlobalLineageFromTables(
  projectId: string
): Promise<AnalyzeResult | null> {
  try {
    const allTableNodes = await queryLineageNodes(projectId);
    const allColumns = await queryLineageColumns(projectId);
    const allEdges = await queryLineageEdges(projectId);

    const physicalTableNodes = allTableNodes.filter(
      (n) => n.nodeType === 'table' || n.nodeType === 'view'
    );
    if (physicalTableNodes.length === 0) return null;

    const physicalTableIds = new Set(physicalTableNodes.map((n) => n.nodeId));
    const physicalColumns = allColumns.filter(
      (c) => c.parentNodeId && physicalTableIds.has(c.parentNodeId)
    );
    const physicalColumnIds = new Set(physicalColumns.map((c) => c.columnId));
    const keepIds = new Set([...physicalTableIds, ...physicalColumnIds]);

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
          if (keepIds.has(target) && target !== startId) {
            resolvedDataFlowEdges.push({ from: startId, to: target });
          } else {
            queue.push(target);
          }
        }
      }
    }

    for (const id of keepIds) {
      bfsResolve(id);
    }

    const edgeSet = new Set<string>();
    const finalEdges: Edge[] = [];

    for (const e of ownershipEdges) {
      const key = `${e.fromId}->${e.toId}`;
      if (!edgeSet.has(key)) {
        edgeSet.add(key);
        finalEdges.push({ id: e.edgeId, from: e.fromId, to: e.toId, type: 'ownership' });
      }
    }

    let syntheticIdx = 0;
    for (const e of resolvedDataFlowEdges) {
      const key = `${e.from}->${e.to}`;
      if (!edgeSet.has(key)) {
        edgeSet.add(key);
        finalEdges.push({ id: `synth_df_${syntheticIdx++}`, from: e.from, to: e.to, type: 'data_flow' });
      }
    }

    const stmtMap = new Map<string, { nodes: Node[]; edges: Edge[]; filePath: string; stmtIdx: number }>();

    for (const n of physicalTableNodes) {
      const key = `${n.filePath}::${n.statementIndex}`;
      if (!stmtMap.has(key)) {
        stmtMap.set(key, { nodes: [], edges: [], filePath: n.filePath, stmtIdx: n.statementIndex });
      }
      stmtMap.get(key)!.nodes.push({
        id: n.nodeId, type: n.nodeType as 'table' | 'view', label: n.label,
        qualifiedName: n.qualifiedName ?? undefined,
      });
    }

    for (const c of physicalColumns) {
      const key = `${c.filePath}::${c.statementIndex}`;
      if (!stmtMap.has(key)) {
        stmtMap.set(key, { nodes: [], edges: [], filePath: c.filePath, stmtIdx: c.statementIndex });
      }
      stmtMap.get(key)!.nodes.push({
        id: c.columnId, type: 'column', label: c.label,
        qualifiedName: c.qualifiedName ?? undefined,
        expression: c.expression ?? undefined,
      });
    }

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
          id: e.id, from: e.from, to: e.to, type: e.type as Edge['type'],
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
    console.error('[analysis-cache] Failed to read global lineage:', error);
    return null;
  }
}

// ── 数据洞察搜索 ────────────────────────────────────────────────

/**
 * 过滤掉在结果集中没有可见边的孤立脚本。
 * 用 qualifiedName 匹配（与 GraphView 的 getScriptIO/buildDirectScriptGraph 一致） */

/**
 * Get per-statement output groups for a script.
 * Reads from the cache populated by writeTableLevelEdges — no recomputation needed.
 */
function getOutputGroups(script: string, projectId: string): OutputGroup[] {
  return _groupsCache.get(projectId)?.get(script) ?? [];
}

function filterOrphanScripts(
  scripts: Set<string>,
  preserve: Set<string>,
  scriptReads: Map<string, Set<string>>,
  scriptWrites: Map<string, Set<string>>,
  _qnameReaders: Map<string, Set<string>>,
  _qnameWriters: Map<string, Set<string>>,
): Set<string> {
  const result = new Set<string>();
  for (const script of scripts) {
    if (preserve.has(script)) { result.add(script); continue; }
    const reads = scriptReads.get(script) ?? new Set();
    const writes = scriptWrites.get(script) ?? new Set();
    if (reads.size > 0 || writes.size > 0) { result.add(script); }
  }
  return result;
}

/**
 * 修复：从 analysis_cache 读取结果，补写入 lineage_nodes/edges 中缺失的脚本。
 * 场景：writeBatchFileResults 成功但 writeLineageData 失败（如缓存命中的二次分析跳过了写入）。
 * knownLineagePaths：可选的预加载节点路径集合，避免重复查询。
 */
async function _repairMissingLineageData(
  projectId: string,
  knownLineagePaths?: Set<string>,
): Promise<void> {
  const lineagePaths = knownLineagePaths ?? await _loadLineagePathsFallback(projectId);

  const fileResultPaths = await readFileResultPaths(projectId);
  const missing: string[] = [];
  for (const fp of fileResultPaths) {
    if (!lineagePaths.has(fp)) missing.push(fp);
  }
  if (missing.length === 0) return;

  let repaired = 0;
  let failed = 0;
  let stale = 0;
  const stalePaths: string[] = [];
  for (const fp of missing) {
    const result = await readFileResult(projectId, fp);
    if (!result || !result.statements?.length) {
      stalePaths.push(fp);
      stale++;
      continue;
    }
    if (!hasMeaningfulLineage(result)) {
      stalePaths.push(fp);
      stale++;
      emit({ category: 'self_ref_only', severity: 'warning', script: fp, message: '缓存结果无有效 data_flow，清除 file_results 残留' }, projectId);
      continue;
    }
    try {
      await writeLineageData(projectId, result);
      repaired++;
      emit({ category: 'repair_ok', severity: 'info', script: fp, message: '补写 lineage 成功' }, projectId);
    } catch (err) {
      failed++;
      emit({ category: 'write_failed', severity: 'error', script: fp, message: '补写 lineage 失败', detail: String(err) }, projectId);
    }
  }
  // 清除无血缘的 file_results 残留，避免绿色图标误导
  if (stalePaths.length > 0) {
    try { await serverDb.deleteProjectFileResults(projectId, stalePaths); } catch { /* non-fatal */ }
  }
  if (repaired > 0) {
    emit({ category: 'repair_needed', severity: 'warning', message: `已从缓存修复 ${repaired} 个脚本的 lineage 数据${stale > 0 ? `，清除 ${stale} 个残留` : ''}${failed > 0 ? `，${failed} 个失败` : ''}` }, projectId);
    try { await writeTableLevelEdges(projectId); } catch { /* non-fatal */ }
  }
}

const _tleEnsured = new Set<string>();
const _repairedSet = new Set<string>();
const _nodeCache = new Map<string, serverDb.LineageNodeRow[]>();
const _fileResultCache = new Map<string, { file_path: string; file_name?: string }[]>();
const _tleEdgeCache = new Map<string, Array<[string, string, string]>>(); // 缓存 table_level_edges

/**
 * 应用启动时后台初始化：加载所有需要的缓存数据。
 * 搜索直接走缓存，不阻塞。
 */
export async function initProjectData(projectId: string): Promise<void> {
  if (_tleEnsured.has(projectId) && _repairedSet.has(projectId)) return;
  
  // 并行加载所有数据
  const [rawNodes, rawEdges, fileResults, tleEdges] = await Promise.all([
    serverDb.getLineageNodes(projectId),
    serverDb.getLineageEdges(projectId, undefined, 'data_flow'),
    serverDb.loadProjectFileResultsLight(projectId),
    serverDb.loadTableLevelEdges(projectId).catch(() => [] as Array<[string, string, string]>),
  ]);

  // 写入缓存
  _nodeCache.set(projectId, rawNodes);
  _fileResultCache.set(projectId, fileResults);
  _tleEdgeCache.set(projectId, tleEdges);

  // 重建 TLE
  const lineagePaths = new Set<string>();
  for (const n of rawNodes) lineagePaths.add(n.file_path);
  try {
    await _writeTableLevelEdgesInternal(projectId, rawNodes, rawEdges);
  } catch { /* non-fatal */ }
  _tleEnsured.add(projectId);
  _repairedSet.add(projectId);
  _repairMissingLineageData(projectId, lineagePaths).catch(() => {});
}

/** 获取缓存的节点数据（优先用 TLE 计算时已加载的，避免重复请求） */
async function getOrLoadNodes(projectId: string): Promise<serverDb.LineageNodeRow[]> {
  const cached = _nodeCache.get(projectId);
  if (cached) return cached;
  const nodes = await serverDb.getLineageNodes(projectId);
  _nodeCache.set(projectId, nodes);
  return nodes;
}

/** 回退方案：从 lineage_nodes 加载 file_path（当 initProjectData 未运行时使用） */
async function _loadLineagePathsFallback(projectId: string): Promise<Set<string>> {
  const nodes = await serverDb.getLineageNodes(projectId);
  const paths = new Set<string>();
  for (const n of nodes) paths.add(n.file_path);
  return paths;
}

async function _ensureTableLevelEdges(projectId: string): Promise<void> {
  if (_tleEnsured.has(projectId) && _repairedSet.has(projectId)) return;
  // 未初始化时同步加载（兼容旧的直接调用路径）
  await initProjectData(projectId);
}

export async function searchLineageForInsights(
  projectId: string,
  searchTerm: string,
  upstreamDepth: number = 1,
  downstreamDepth: number = 1,
): Promise<AnalyzeResult | null> {
  const term = searchTerm.trim().toLowerCase();
  if (!term) return null;

  // ── 0. 确保 table_level_edges 已缓存 ────────────
  await _ensureTableLevelEdges(projectId);

  // ── 1. 从缓存读取 table_level_edges ──
  let tleEdges = _tleEdgeCache.get(projectId);
  if (!tleEdges) {
    tleEdges = await serverDb.loadTableLevelEdges(projectId)
      .catch(() => [] as Array<[string, string, string]>);
    _tleEdgeCache.set(projectId, tleEdges);
  }

  // ── 2. 从 table_level_edges 构建 reads/writes ────────────
  // edge = [from_table, to_table, script], 方向精确不用启发式
  const scriptWrites = new Map<string, Set<string>>();
  const scriptReads = new Map<string, Set<string>>();
  const qnameWriters = new Map<string, Set<string>>();
  const qnameReaders = new Map<string, Set<string>>();

  for (const [fromTable, toTable, script] of tleEdges) {
    const fromQ = fromTable.toLowerCase();
    const toQ = toTable.toLowerCase();

    if (!scriptReads.has(script)) scriptReads.set(script, new Set());
    scriptReads.get(script)!.add(fromQ);
    if (!qnameReaders.has(fromQ)) qnameReaders.set(fromQ, new Set());
    qnameReaders.get(fromQ)!.add(script);

    if (!scriptWrites.has(script)) scriptWrites.set(script, new Set());
    scriptWrites.get(script)!.add(toQ);
    if (!qnameWriters.has(toQ)) qnameWriters.set(toQ, new Set());
    qnameWriters.get(toQ)!.add(script);
  }

  // ── 3. 脚本级有向边 ──────────────────────────────────
  const scriptDown = new Map<string, Set<string>>(); // writer → {readers}
  const scriptUp = new Map<string, Set<string>>();   // reader → {writers}
  for (const [script, reads] of scriptReads) {
    for (const qname of reads) {
      if (!qname.includes('.')) continue; // 跳过无 schema 前缀的临时表
      for (const writer of qnameWriters.get(qname) ?? []) {
        if (writer === script) continue;
        if (!scriptDown.has(writer)) scriptDown.set(writer, new Set());
        scriptDown.get(writer)!.add(script);
        if (!scriptUp.has(script)) scriptUp.set(script, new Set());
        scriptUp.get(script)!.add(writer);
      }
    }
  }

  // ── 4. 匹配搜索词 ────────────────────────────────────
  const matchedScripts = new Set<string>();

  // 从 file_results 获取脚本名用于匹配（轻量，不加载 lineage_nodes）
  let fileResultRows = _fileResultCache.get(projectId);
  if (!fileResultRows) {
    fileResultRows = await serverDb.loadProjectFileResultsLight(projectId);
    _fileResultCache.set(projectId, fileResultRows);
  }
  const scriptFileName = new Map<string, string>();
  for (const r of fileResultRows) {
    if (r.file_path && r.file_name) scriptFileName.set(r.file_path, r.file_name);
  }

  for (const [script, fn] of scriptFileName) {
    const fp = script.toLowerCase();
    const fnLower = fn.toLowerCase();
    if (fp.includes(term) || fnLower.includes(term)) {
      matchedScripts.add(script);
      continue;
    }
    // 表名匹配
    const reads = scriptReads.get(script) ?? new Set();
    const writes = scriptWrites.get(script) ?? new Set();
    for (const qn of [...reads, ...writes]) {
      if (qn.includes(term)) {
        matchedScripts.add(script);
        break;
      }
    }
  }
  if (matchedScripts.size === 0) return null;
  if (upstreamDepth === 0 && downstreamDepth === 0) return null;

  // ── 4.5 收集匹配搜索词的表名 ────────────────────────────
  const matchedQNames = new Set<string>();
  for (const [script] of scriptFileName) {
    const reads = scriptReads.get(script) ?? new Set();
    const writes = scriptWrites.get(script) ?? new Set();
    for (const qn of [...reads, ...writes]) {
      if (qn.includes(term)) matchedQNames.add(qn);
    }
  }

  // ── 5. 表感知 BFS（上游/下游各自独立深度）────────────────
  const upstreamScripts = new Set<string>();
  const downstreamScripts = new Set<string>();
  const centerScripts = new Set<string>(); // 表搜索时的中心脚本

  if (matchedQNames.size > 0) {
    // 中心脚本：写入了匹配到的表（搜索表名时，写出该表的脚本是中心）
    // 中心脚本：写入了匹配到的表（搜索表名时，写出该表的脚本是中心）
    const centerScripts = new Set<string>();
    const centerScriptsArr: string[] = [];
    for (const s of matchedScripts) {
      const writes = scriptWrites.get(s) ?? new Set();
      for (const qn of matchedQNames) {
        if (writes.has(qn)) {
          centerScripts.add(s);
          centerScriptsArr.push(s);
          break;
        }
      }
    }
    // 如无脚本写出匹配表（纯读表），退化为所有匹配脚本
    if (centerScripts.size === 0) {
      for (const s of matchedScripts) centerScriptsArr.push(s);
    }

    // 上游：中心脚本的输入表的写出者
    if (upstreamDepth > 0) {
      for (const s of centerScriptsArr) {
        for (const qn of scriptReads.get(s) ?? []) {
          for (const writer of qnameWriters.get(qn) ?? []) {
            if (writer !== s) upstreamScripts.add(writer);
          }
        }
      }
      if (upstreamDepth >= 2 && upstreamScripts.size > 0) {
        const q: Array<[string, number]> = [...upstreamScripts].map(s => [s, 1] as [string, number]);
        for (let i = 0; i < q.length; i++) {
          const [s, d] = q[i];
          if (d >= upstreamDepth) continue;
          for (const prev of scriptUp.get(s) ?? []) {
            if (!upstreamScripts.has(prev) && !centerScripts.has(prev)) {
              upstreamScripts.add(prev);
              q.push([prev, d + 1]);
            }
          }
        }
      }
    }

    // 下游：中心脚本的输出表的读取者
    if (downstreamDepth > 0) {
      for (const s of centerScriptsArr) {
        for (const qn of scriptWrites.get(s) ?? []) {
          for (const reader of qnameReaders.get(qn) ?? []) {
            if (reader !== s) downstreamScripts.add(reader);
          }
        }
      }
      if (downstreamDepth >= 2 && downstreamScripts.size > 0) {
        const q: Array<[string, number]> = [...downstreamScripts].map(s => [s, 1] as [string, number]);
        for (let i = 0; i < q.length; i++) {
          const [s, d] = q[i];
          if (d >= downstreamDepth) continue;
          for (const next of scriptDown.get(s) ?? []) {
            if (!downstreamScripts.has(next) && !centerScripts.has(next)) {
              downstreamScripts.add(next);
              q.push([next, d + 1]);
            }
          }
        }
      }
    }
  } else {
    // 仅匹配脚本名（无匹配表名）：退化为全量图 BFS
    if (upstreamDepth > 0) {
      const upQ: Array<[string, number]> = [];
      for (const s of matchedScripts) upQ.push([s, 0]);
      for (let i = 0; i < upQ.length; i++) {
        const [s, d] = upQ[i];
        if (upstreamScripts.has(s)) continue;
        upstreamScripts.add(s);
        if (d >= upstreamDepth) continue;
        for (const prev of scriptUp.get(s) ?? []) {
          if (!upstreamScripts.has(prev)) upQ.push([prev, d + 1]);
        }
      }
    }

    if (downstreamDepth > 0) {
      const dnQ: Array<[string, number]> = [];
      for (const s of matchedScripts) dnQ.push([s, 0]);
      for (let i = 0; i < dnQ.length; i++) {
        const [s, d] = dnQ[i];
        if (downstreamScripts.has(s)) continue;
        downstreamScripts.add(s);
        if (d >= downstreamDepth) continue;
        for (const next of scriptDown.get(s) ?? []) {
          if (!downstreamScripts.has(next)) dnQ.push([next, d + 1]);
        }
      }
    }
  }

  let reachableScripts = new Set([
    ...(centerScripts.size > 0 ? centerScripts : matchedScripts),
    ...upstreamScripts,
    ...downstreamScripts,
  ]);
  // 表搜索时，纯读匹配脚本（不写匹配表）也纳入但不保留（可能被孤儿过滤）
  if (centerScripts.size > 0) {
    for (const s of matchedScripts) reachableScripts.add(s);
  }

  // ── 6. 过滤孤立脚本（保留中心/匹配脚本）─────────────────────
  reachableScripts = filterOrphanScripts(
    reachableScripts,
    centerScripts.size > 0 ? centerScripts : matchedScripts,
    scriptReads,
    scriptWrites,
    qnameReaders,
    qnameWriters,
  );

  // ── 7. 构建 AnalyzeResult ────────────────────────────
  // 只加载 reachable 脚本的 lineage_nodes，不加载全量
  const nodeIdToQn = new Map<string, string>();
  const scriptNodeMap = new Map<string, Node[]>();
  const scriptOutputGroups = new Map<string, OutputGroup[]>();

  const loadTasks: Promise<void>[] = [];
  const loadedPaths = new Set<string>();
  for (const script of reachableScripts) {
    if (loadedPaths.has(script)) continue;
    loadedPaths.add(script);
    loadTasks.push(
      serverDb.getLineageNodes(projectId, script).then(nodes => {
        for (const n of nodes) {
          if (n.node_type !== 'table' && n.node_type !== 'view') continue;
          const qn = (n.qualified_name ?? n.label).toLowerCase();
          nodeIdToQn.set(n.node_id, qn);
          // First script hit: init groups
          if (!scriptNodeMap.has(script)) {
            scriptNodeMap.set(script, []);
            const groups = getOutputGroups(script, projectId);
            scriptOutputGroups.set(script, groups);
          }
          const isWrite = (scriptWrites.get(script) ?? new Set()).has(qn);
          const isRead = (scriptReads.get(script) ?? new Set()).has(qn);
          scriptNodeMap.get(script)!.push({
            id: n.node_id,
            type: n.node_type as 'table' | 'view',
            label: n.label,
            qualifiedName: qn,
            metadata: {
              ...(isWrite ? { isCreated: true } : {}),
              ...(isRead ? { isRead: true } : {}),
            },
          });
        }
      }).catch(() => {}),
    );
  }
  await Promise.all(loadTasks);

  // ── Patch: 补齐 table_level_edges 中有但 lineage_nodes 中缺失的表 ──
  // 跨文件引用时，lineage_nodes 可能没有 B10 的 s01_lvplay_usr 节点，
  // 但 table_level_edges 正确记录了 B10 reads s01_lvplay_usr。
  // 不补齐 → getScriptIO 找不到该表 → 不生成边 → 脚本显示为孤立节点。
  for (const script of reachableScripts) {
    const nodes = scriptNodeMap.get(script);
    if (!nodes) continue;
    const existingQn = new Set(nodes.map((n) => (n.qualifiedName ?? n.label).toLowerCase()));
    const rds = scriptReads.get(script) ?? new Set<string>();
    const wrs = scriptWrites.get(script) ?? new Set<string>();
    for (const qn of [...rds, ...wrs]) {
      if (!existingQn.has(qn)) {
        existingQn.add(qn);
        nodes.push({
          id: `syn:${qn}`,
          type: 'table',
          label: qn.split('.').pop() ?? qn,
          qualifiedName: qn,
          metadata: {
            ...(wrs.has(qn) ? { isCreated: true } : {}),
            ...(rds.has(qn) ? { isRead: true } : {}),
          },
        });
      }
    }
  }

  const statements: StatementLineage[] = [];
  let stmtIdx = 0;
  for (const script of reachableScripts) {
    const nodes = scriptNodeMap.get(script) ?? [];
    if (nodes.length === 0) continue;
    const groups = scriptOutputGroups.get(script) ?? [];
    // Attach outputGroups to the first node's metadata
    if (nodes.length > 0 && groups.length > 0) {
      const firstNode = nodes[0];
      firstNode.metadata = {
        ...(firstNode.metadata ?? {}),
        outputGroups: groups,
      };
    }
    statements.push({
      statementIndex: stmtIdx++,
      statementType: 'SELECT',
      sourceName: script,
      nodes,
      edges: [],
      joinCount: 0,
      complexityScore: 0,
    });
  }

  if (statements.length === 0) return null;

  return {
    statements,
    globalLineage: { nodes: [], edges: [] },
    issues: [],
    summary: {
      statementCount: statements.length,
      tableCount: statements.reduce((s, st) => s + st.nodes.length, 0),
      columnCount: 0,
      joinCount: 0,
      complexityScore: 0,
      issueCount: { errors: 0, warnings: 0, infos: 0 },
      hasErrors: false,
    },
  };
}

export async function clearProjectLineage(_projectId: string): Promise<void> {
  // Data is cleared per-file on re-analyze; full project clear not needed
}

// ── Schema / hierarchy stubs ──────────────────────────────────────

export async function writeSchemaData(
  _projectId: string,
  _result: AnalyzeResult
): Promise<void> {
  // Schema metadata is extracted by Rust backend on schema file import.
}

export async function writeHierarchyData(
  _projectId: string,
  _result: AnalyzeResult
): Promise<void> {
  // Hierarchy is derived from lineage data at query time.
}

export async function writeTableFlows(
  _projectId: string,
  _filePath: string,
  _result: AnalyzeResult
): Promise<void> {
  // Table flows are derived from lineage data at query time.
}

// ── table_metadata persistence ───────────────────────────────────

export async function writeTableMetadata(
  projectId: string,
  result: AnalyzeResult,
  dialect?: string,
): Promise<void> {
  if (!result.resolvedSchema?.tables?.length) return;

  // For dialects where physical tables always live under a database/schema
  // (Hive, BigQuery, Snowflake, ...), an "implied + non-temporary + no
  // catalog/schema" entry is almost certainly a CTE / derived-table residue
  // from merged multi-file analysis (a small number of CTAS targets lose
  // their `temporary` flag in that path). Drop them so the persisted
  // `table_metadata` only contains real physical tables.
  //
  // For dialects with an implicit default schema (Postgres `public`, SQLite,
  // generic) we keep these entries because bare names are legitimate.
  const STRICT_SCHEMA_DIALECTS = new Set([
    'hive',
    'bigquery',
    'snowflake',
    'databricks',
    'spark',
    'trino',
    'presto',
  ]);
  const isStrict = dialect ? STRICT_SCHEMA_DIALECTS.has(dialect.toLowerCase()) : false;

  const tables: serverDb.TableMetadataRow[] = [];
  const columns: serverDb.ColumnMetadataRow[] = [];
  const now = new Date().toISOString();
  let tableSeqId = 0;

  for (const t of result.resolvedSchema.tables) {
    // Skip temporary tables (e.g. Hive's CREATE TEMPORARY TABLE A/B/C/D ...).
    // These are session-scoped, non-persistent relations and don't belong in
    // the physical table_metadata catalog. The lineage layer already surfaces
    // them as `NodeType::Cte`, so filtering them here keeps the metadata table
    // focused on real tables/views (which is what schema catalog consumers
    // expect).
    if (t.temporary) continue;

    // For strict-schema dialects, also drop implied homeless tables
    // (CTE/derived residues from merged analysis that lost their temporary flag).
    if (
      isStrict &&
      !t.temporary &&
      (t.catalog ?? '') === '' &&
      (t.schema ?? '') === '' &&
      t.origin !== 'imported'
    ) {
      continue;
    }

    tableSeqId++;
    const tableId = tableSeqId;
    tables.push({
      id: 0,
      project_id: projectId,
      catalog: t.catalog ?? '',
      schema_name: t.schema ?? '',
      table_name: t.name,
      table_type: 'table',
      origin: t.origin ?? 'unknown',
      temporary: !!t.temporary,
      partition_keys: '',
      cluster_keys: '',
      file_format: '',
      location: '',
      properties_json: '{}',
      owner: '',
      comment: '',
      row_count: -1,
      size_bytes: -1,
      created_at: now,
      updated_at: now,
      status: 1,
    });

    for (let i = 0; i < t.columns.length; i++) {
      const col = t.columns[i];
      columns.push({
        id: 0,
        project_id: projectId,
        table_id: tableId,
        column_name: col.name,
        ordinal: i + 1,
        data_type: col.dataType ?? '',
        is_nullable: !col.isPrimaryKey,
        is_primary_key: !!col.isPrimaryKey,
        is_partition: false,
        default_value: null,
        comment: '',
        created_at: now,
        updated_at: now,
        status: 1,
      });
    }
  }

  await serverDb.saveTableMetadata(projectId, tables, columns);
}
