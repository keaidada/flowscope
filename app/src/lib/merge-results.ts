/**
 * 合并多个 AnalyzeResult 并提取全局表级血缘。
 *
 * 全局血缘只保留实体表（源表→目标表），过滤 CTE/临时表/子查询别名。
 * 数据提取逻辑与 AnalysisView.extractSchemaFromResult 保持一致。
 */

import type {
  AnalyzeResult,
  GlobalNode,
  GlobalEdge,
  StatementLineage,
} from '@pondpilot/flowscope-core';

/**
 * 合并多个 AnalyzeResult 为完整的全局视图（不做过滤）。
 */
export function mergeAnalyzeResults(results: AnalyzeResult[]): AnalyzeResult | null {
  if (results.length === 0) return null;
  if (results.length === 1) return results[0];

  const allStatements = results.flatMap((r) => r.statements);

  const nodeMap = new Map<string, GlobalNode>();
  for (const r of results) {
    for (const node of r.globalLineage?.nodes ?? []) {
      const existing = nodeMap.get(node.id);
      if (existing) {
        const refSet = new Set(
          existing.statementRefs.map((s) => `${s.statementIndex}:${s.nodeId ?? ''}`)
        );
        for (const ref of node.statementRefs) {
          const key = `${ref.statementIndex}:${ref.nodeId ?? ''}`;
          if (!refSet.has(key)) {
            existing.statementRefs.push(ref);
          }
        }
      } else {
        nodeMap.set(node.id, { ...node, statementRefs: [...node.statementRefs] });
      }
    }
  }

  const edgeMap = new Map<string, GlobalEdge>();
  for (const r of results) {
    for (const edge of r.globalLineage?.edges ?? []) {
      const key = `${edge.from}->${edge.to}:${edge.type}`;
      if (!edgeMap.has(key)) {
        edgeMap.set(key, edge);
      }
    }
  }

  const allIssues = results.flatMap((r) => r.issues ?? []);

  // 合并 resolvedSchema tables
  const schemaTableMap = new Map<string, NonNullable<AnalyzeResult['resolvedSchema']>['tables'][0]>();
  for (const r of results) {
    for (const table of r.resolvedSchema?.tables ?? []) {
      const key = [table.catalog, table.schema, table.name].filter(Boolean).join('.');
      if (!schemaTableMap.has(key)) {
        schemaTableMap.set(key, table);
      }
    }
  }

  const summary = {
    statementCount: allStatements.length,
    tableCount: nodeMap.size,
    columnCount: 0,
    joinCount: allStatements.reduce((sum, s) => sum + (s.joinCount ?? 0), 0),
    complexityScore: Math.round(
      results.reduce((sum, r) => sum + (r.summary?.complexityScore ?? 0), 0) / results.length
    ),
    issueCount: {
      errors: allIssues.filter((i) => i.severity === 'error').length,
      warnings: allIssues.filter((i) => i.severity === 'warning').length,
      infos: allIssues.filter((i) => i.severity === 'info').length,
    },
    hasErrors: allIssues.some((i) => i.severity === 'error'),
  };

  return {
    statements: allStatements,
    globalLineage: {
      nodes: [...nodeMap.values()],
      edges: [...edgeMap.values()],
    },
    issues: allIssues,
    summary,
    resolvedSchema: schemaTableMap.size > 0
      ? { tables: [...schemaTableMap.values()] }
      : undefined,
  };
}

/**
 * 从合并的 AnalyzeResult 中提取表级全局血缘。
 * 仅保留实体表（源表→目标表），与 schema 视图一致。
 *
 * 逻辑参考 AnalysisView.extractSchemaFromResult：
 * - 过滤 CTE、临时表、子查询别名
 * - 通过 BFS 穿透中间节点建立实体表之间的直接关系
 */
/**
 * 从 SQL 文件内容中提取表的中文注释。
 * 支持格式：--# 程序名称:     XXX.HQL:中文名称
 *          --# 目标表名:     schema.table_name
 */
export function extractTableComments(
  fileContents: Map<string, string>
): Map<string, string> {
  const comments = new Map<string, string>();
  for (const [, content] of fileContents) {
    // 提取程序中文名
    const nameMatch = content.match(/--#\s*程序名称:\s*\S+[.:：](.+)/);
    const chineseName = nameMatch?.[1]?.trim();
    if (!chineseName) continue;

    // 提取目标表名
    const tableMatch = content.match(/--#\s*目标表名:\s*(\S+)/);
    if (tableMatch) {
      const tableName = tableMatch[1].trim().toLowerCase();
      comments.set(tableName, chineseName);
      // 也存短名（不带 schema）
      const parts = tableName.split('.');
      if (parts.length > 1) {
        comments.set(parts[parts.length - 1], chineseName);
      }
    }
  }
  return comments;
}

export function buildTableLevelLineage(
  result: AnalyzeResult,
  tableComments?: Map<string, string>
): AnalyzeResult {
  // 构建临时表名集合
  const temporaryTableNames = new Set<string>();
  if (result.resolvedSchema?.tables) {
    for (const rst of result.resolvedSchema.tables) {
      if (rst.temporary) {
        temporaryTableNames.add(rst.name);
        if (rst.schema) temporaryTableNames.add(`${rst.schema}.${rst.name}`);
        if (rst.catalog && rst.schema) temporaryTableNames.add(`${rst.catalog}.${rst.schema}.${rst.name}`);
      }
    }
  }

  // 判断节点是否为物理表（与 extractSchemaFromResult.isPhysicalTable 一致）
  const isPhysicalTable = (node: {
    type: string;
    qualifiedName?: string;
    label: string;
    resolutionSource?: string;
  }): boolean => {
    if (node.type !== 'table' && node.type !== 'view') return false;
    const qName = node.qualifiedName || node.label;
    if (temporaryTableNames.has(qName) || temporaryTableNames.has(node.label)) return false;
    if (node.resolutionSource) return true;
    return qName.includes('.');
  };

  // 从 globalLineage 获取 canonical qualified name
  const getGlobalNodeQName = (node: GlobalNode): string => {
    const cn = node.canonicalName;
    if (cn) {
      const parts = [cn.catalog, cn.schema, cn.name].filter(Boolean);
      if (parts.length > 1) return parts.join('.');
    }
    return node.label;
  };

  // 收集所有物理表（从 statements + globalLineage）
  const tableMap = new Map<string, { catalog?: string; schema?: string; name: string; nodeId: string; sourceName?: string }>();

  // 1. 从 statements 中收集
  for (const stmt of result.statements) {
    for (const node of stmt.nodes) {
      if (isPhysicalTable(node)) {
        const qName = node.qualifiedName || node.label;
        if (!tableMap.has(qName)) {
          const parts = qName.split('.');
          if (parts.length >= 3) {
            tableMap.set(qName, { catalog: parts[0], schema: parts[1], name: parts.slice(2).join('.'), nodeId: node.id, sourceName: stmt.sourceName });
          } else if (parts.length === 2) {
            tableMap.set(qName, { schema: parts[0], name: parts[1], nodeId: node.id, sourceName: stmt.sourceName });
          } else {
            tableMap.set(qName, { name: qName, nodeId: node.id, sourceName: stmt.sourceName });
          }
        }
      }
    }
  }

  // 2. 从 globalLineage 中补充物理表（不做 BFS，只补充 tableMap）
  for (const node of result.globalLineage?.nodes ?? []) {
    const qName = getGlobalNodeQName(node);

    const isPhysical =
      node.type !== 'cte' &&
      node.type !== 'column' &&
      !temporaryTableNames.has(qName) &&
      !temporaryTableNames.has(node.label) &&
      (node.resolutionSource || node.canonicalName?.schema);

    if (isPhysical) {
      if (!tableMap.has(qName)) {
        const cn = node.canonicalName;
        tableMap.set(qName, {
          catalog: cn?.catalog,
          schema: cn?.schema,
          name: cn?.name || node.label,
          nodeId: node.id,
        });
      }
    }
  }

  // 收集表级 data_flow 关系（BFS 穿透中间节点），同时记录来源文件
  const flowEdgesWithSource: { source: string; target: string; sourceName: string }[] = [];

  // 2a. 从 statements 的 per-statement BFS
  for (const stmt of result.statements) {
    const stmtSource = stmt.sourceName || 'unknown';
    const nodeById = new Map(stmt.nodes.map((n) => [n.id, n]));
    const physicalIds = new Set(stmt.nodes.filter(isPhysicalTable).map((n) => n.id));

    // 构建邻接表（包含反向 ownership，与 extractSchemaFromResult 一致）
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

    for (const srcNode of stmt.nodes.filter(isPhysicalTable)) {
      const srcQName = srcNode.qualifiedName || srcNode.label;
      const visited = new Set<string>();
      const queue = [srcNode.id];
      visited.add(srcNode.id);
      while (queue.length > 0) {
        const current = queue.shift()!;
        for (const next of adj.get(current) || []) {
          if (visited.has(next)) continue;
          visited.add(next);
          if (physicalIds.has(next)) {
            const targetNode = nodeById.get(next)!;
            const targetQName = targetNode.qualifiedName || targetNode.label;
            if (srcQName !== targetQName) {
              flowEdgesWithSource.push({ source: srcQName, target: targetQName, sourceName: stmtSource });
            }
          } else {
            queue.push(next);
          }
        }
      }
    }
  }

  // 去重：同一物理表可能有多种名字形式，取最长的作为 canonical
  const canonicalKeyMap = new Map<string, string>();
  for (const qName of tableMap.keys()) {
    const info = tableMap.get(qName)!;
    const identity = info.schema ? `${info.schema}.${info.name}` : info.name;
    const existing = canonicalKeyMap.get(identity);
    if (!existing || qName.length > existing.length) {
      canonicalKeyMap.set(identity, qName);
    }
  }
  const keysToKeep = new Set(canonicalKeyMap.values());
  const keyToCanonical = new Map<string, string>();
  for (const qName of tableMap.keys()) {
    const info = tableMap.get(qName)!;
    const identity = info.schema ? `${info.schema}.${info.name}` : info.name;
    keyToCanonical.set(qName, canonicalKeyMap.get(identity)!);
  }

  // 构建节点（全局去重）
  const allNodes: StatementLineage['nodes'] = [];
  const nodeIdMap = new Map<string, string>(); // canonicalQName -> nodeId

  let idx = 0;
  for (const [qName] of tableMap) {
    if (!keysToKeep.has(qName)) continue;
    const info = tableMap.get(qName)!;
    const nodeId = `global_table_${idx++}`;
    nodeIdMap.set(qName, nodeId);
    allNodes.push({
      id: nodeId,
      type: 'table',
      label: info.name,
      qualifiedName: qName,
      metadata: {
        ...(info.sourceName ? { sourceName: info.sourceName } : {}),
        ...(tableComments?.get(qName.toLowerCase()) ? { comment: tableComments.get(qName.toLowerCase()) } : {}),
        ...(tableComments?.get(info.name.toLowerCase()) ? { comment: tableComments.get(info.name.toLowerCase()) } : {}),
      },
    });
  }

  // 按 sourceName 分组构建 statements
  const stmtGroups = new Map<string, { nodeIds: Set<string>; edges: StatementLineage['edges'] }>();
  const dedupEdges = new Set<string>();
  let edgeIdx = 0;

  for (const fe of flowEdgesWithSource) {
    const canonSrc = keyToCanonical.get(fe.source) || fe.source;
    const canonTgt = keyToCanonical.get(fe.target) || fe.target;
    const dedupKey = `${canonSrc}→${canonTgt}`;
    if (dedupEdges.has(dedupKey)) continue;
    dedupEdges.add(dedupKey);

    const fromId = nodeIdMap.get(canonSrc);
    const toId = nodeIdMap.get(canonTgt);
    if (!fromId || !toId) continue;

    if (!stmtGroups.has(fe.sourceName)) {
      stmtGroups.set(fe.sourceName, { nodeIds: new Set(), edges: [] });
    }
    const group = stmtGroups.get(fe.sourceName)!;
    group.nodeIds.add(fromId);
    group.nodeIds.add(toId);
    group.edges.push({
      id: `global_edge_${edgeIdx++}`,
      from: fromId,
      to: toId,
      type: 'data_flow',
    });
  }

  // 节点 id -> 节点对象映射
  const nodeById = new Map(allNodes.map((n) => [n.id, n]));

  const statements: StatementLineage[] = [];
  let stmtIdx = 0;
  for (const [sourceName, group] of stmtGroups) {
    const stmtNodes = [...group.nodeIds].map((id) => nodeById.get(id)!).filter(Boolean);
    statements.push({
      statementIndex: stmtIdx++,
      statementType: 'GLOBAL',
      sourceName,
      nodes: stmtNodes,
      edges: group.edges,
      joinCount: 0,
      complexityScore: 0,
    });
  }

  // 收集所有出现在 statements 中的边（给 globalLineage 用）
  const allEdges = statements.flatMap((s) => s.edges);

  // 构建 nodeId -> tableMap info 的映射（用于 globalLineage canonicalName）
  const nodeIdToInfo = new Map<string, { catalog?: string; schema?: string; name: string; sourceName?: string }>();
  for (const [qName, nodeId] of nodeIdMap) {
    const info = tableMap.get(qName);
    if (info) nodeIdToInfo.set(nodeId, info);
  }

  return {
    statements,
    globalLineage: {
      nodes: allNodes.map((n) => {
        const info = nodeIdToInfo.get(n.id);
        return {
          id: n.id,
          type: n.type as 'table',
          label: n.label,
          canonicalName: {
            catalog: info?.catalog,
            schema: info?.schema,
            name: info?.name || n.label,
          },
          statementRefs: statements
            .filter((s) => s.nodes.some((sn) => sn.id === n.id))
            .map((s) => ({ statementIndex: s.statementIndex, nodeId: n.id })),
        };
      }),
      edges: allEdges.map((e) => ({
        id: e.id,
        from: e.from,
        to: e.to,
        type: e.type,
      })),
    },
    issues: [],
    summary: {
      statementCount: statements.length,
      tableCount: allNodes.length,
      columnCount: 0,
      joinCount: 0,
      complexityScore: 0,
      issueCount: { errors: 0, warnings: 0, infos: 0 },
      hasErrors: false,
    },
    resolvedSchema: result.resolvedSchema,
  };
}
