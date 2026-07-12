/**
 * Analysis result cache and lineage persistence.
 *
 * All storage goes through the Rust backend SQLite via REST API.
 */

import type { AnalyzeResult, StatementLineage, Node, Edge } from '@pondpilot/flowscope-core';
import * as serverDb from './server-db';

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
    updated_at: Date.now(),
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
    updated_at: Date.now(),
  }]);

  const cacheKey = `result:${projectId}:hash:${contentHash || 'no_hash'}`;
  await serverDb.setCacheResult(cacheKey, result);
}

export async function readFileResultPaths(projectId: string): Promise<string[]> {
  const rows = await serverDb.loadProjectFileResults(projectId);
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

    for (const node of stmt.nodes) {
      if (node.type === 'column') {
        columns.push({
          column_id: node.id,
          label: node.label,
          qualified_name: node.qualifiedName ?? null,
          parent_node_id: ownershipMap.get(node.id) ?? null,
          expression: node.expression ?? null,
          statement_index: stmt.statementIndex,
          file_path: fp,
        });
      } else {
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

/** 预计算表级血缘(穿透 CTE 的物理表 table→table),物化到后端 table_level_edges。
 *  from/to 用全名(catalog.schema.name),script 取源表所在脚本的 sourceName。 */
export async function writeTableLevelEdges(
  projectId: string,
  result: AnalyzeResult,
): Promise<void> {
  const { buildTableLevelLineage } = await import('./merge-results');
  const tableLevel = buildTableLevelLineage(result, new Map());
  // 全名 catalog.schema.name
  const nodeFull = new Map<string, string>();
  for (const n of tableLevel.globalLineage.nodes) {
    const cn = (n as { canonicalName?: { catalog?: string; schema?: string; name: string } }).canonicalName;
    const full = cn ? [cn.catalog, cn.schema, cn.name].filter(Boolean).join('.') : n.label;
    nodeFull.set(n.id, full);
  }
  // statementIndex → sourceName(脚本名)
  const stmtSource = new Map<number, string>();
  result.statements.forEach((s, i) => stmtSource.set(i, s.sourceName ?? ''));
  const edges: Array<[string, string, string]> = [];
  for (const edge of tableLevel.globalLineage.edges) {
    if (edge.type === 'data_flow') {
      const fromNode = tableLevel.globalLineage.nodes.find((n) => n.id === edge.from);
      const ref = fromNode?.statementRefs?.[0];
      const script = ref ? (stmtSource.get(ref.statementIndex) ?? '') : '';
      edges.push([nodeFull.get(edge.from) ?? edge.from, nodeFull.get(edge.to) ?? edge.to, script]);
    }
  }
  await serverDb.saveTableLevelEdges(projectId, edges);
}

// ── 结构化表查询 ──────────────────────────────────────────────────

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
    statementIndex: e.statement_index,
  }));
}

// ── 全局血缘重建 ─────────────────────────────────────────────────

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
  result: AnalyzeResult
): Promise<void> {
  if (!result.resolvedSchema?.tables?.length) return;

  const tables: serverDb.TableMetadataRow[] = [];
  const columns: serverDb.ColumnMetadataRow[] = [];
  const now = Date.now();
  let tableSeqId = 0;

  for (const t of result.resolvedSchema.tables) {
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
