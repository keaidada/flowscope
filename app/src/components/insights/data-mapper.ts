import type {
  AnalyzeResult,
  GlobalNode,
  GlobalEdge,
  CanonicalName,
} from '@pondpilot/flowscope-core';

/**
 * 数据洞察视图的数据映射工具
 *
 * 核心思路：将「脚本 → 表」的关系映射为现有 GraphView 中的「表 → 字段」关系。
 * - 脚本节点（type: 'table'）= 关系图中的表节点（可展开/折叠的容器）
 * - 表节点（type: 'column'）= 关系图中的字段节点（容器内的子项）
 * - ownership 边：脚本 → 表（包含关系）
 * - data_flow 边：跨脚本的表之间的关系（数据流向）
 */

const SCRIPT_PREFIX = 'insights_script:';
const TABLE_PREFIX = 'insights_table:';

/**
 * 从 GlobalNode 提取规范化的表名（qualified name）
 */
function getTableQualifiedName(node: GlobalNode): string | null {
  const cn = node.canonicalName;
  if (cn) {
    const parts = [cn.catalog, cn.schema, cn.name].filter(Boolean);
    if (parts.length > 1) return parts.join('.');
    if (cn.name) return cn.name;
  }
  return node.label || null;
}

/**
 * 获取脚本显示名（短文件名）
 */
function getScriptDisplayName(scriptPath: string): string {
  const parts = scriptPath.split('/');
  return parts[parts.length - 1] || scriptPath;
}

/**
 * 获取表显示名（短表名）
 */
function getTableDisplayName(qualifiedName: string): string {
  const parts = qualifiedName.split('.');
  return parts[parts.length - 1] || qualifiedName;
}

/**
 * 从限定表名构建 CanonicalName
 */
function buildTableCanonicalName(qualifiedName: string): CanonicalName {
  const parts = qualifiedName.split('.');
  if (parts.length >= 3) {
    return { catalog: parts[0], schema: parts[1], name: parts.slice(2).join('.') };
  }
  if (parts.length === 2) {
    return { schema: parts[0], name: parts[1] };
  }
  return { name: qualifiedName };
}

/**
 * 构建脚本节点的稳定 ID
 */
function buildScriptNodeId(scriptPath: string): string {
  return `${SCRIPT_PREFIX}${scriptPath}`;
}

/**
 * 构建脚本作用域下表实例的稳定 ID
 * 同一张物理表在不同脚本下有不同的实例 ID
 */
function buildTableInstanceId(scriptId: string, tableQualifiedName: string): string {
  return `${TABLE_PREFIX}${scriptId}::${tableQualifiedName}`;
}

/**
 * 数据洞察映射结果
 */
export interface InsightsGraph {
  /** 转换后的 AnalyzeResult，可直接注入 store 供 GraphView 渲染 */
  result: AnalyzeResult;
  /** 统计信息 */
  stats: {
    scriptCount: number;
    tableInstanceCount: number;
    uniqueTableCount: number;
    ownershipEdgeCount: number;
    dataFlowEdgeCount: number;
  };
}

/**
 * 将原始血缘分析结果转换为数据洞察视图的图数据。
 *
 * 转换规则：
 * 1. 从 statements 中提取每个 statement 的 sourceName（脚本路径）
 * 2. 通过 globalLineage.nodes 的 statementRefs 关联表与脚本
 * 3. 脚本成为 type='table' 的容器节点
 * 4. 每张表在每个引用它的脚本下创建一个 type='column' 的实例节点
 * 5. 添加 ownership 边（脚本 → 表实例）
 * 6. 添加跨脚本的 data_flow 边（基于原始表间血缘）
 *
 * @param original 原始 AnalyzeResult
 * @returns 转换后的图数据
 */
export function convertToInsightsGraph(original: AnalyzeResult): InsightsGraph {
  const globalNodes = original.globalLineage?.nodes ?? [];
  const globalEdges = original.globalLineage?.edges ?? [];

  // 1. 构建 statementIndex → sourceName 映射
  const stmtToSource = new Map<number, string>();
  for (const stmt of original.statements) {
    if (stmt.sourceName && stmt.sourceName.trim()) {
      stmtToSource.set(stmt.statementIndex, stmt.sourceName);
    }
  }

  // 2. 收集所有物理表节点，并建立 nodeId → 表信息的映射
  interface TableInfo {
    nodeId: string;
    qualifiedName: string;
    /** 引用此表的脚本路径集合 */
    scripts: Set<string>;
  }
  const tableByNodeId = new Map<string, TableInfo>();
  const tableByQName = new Map<string, TableInfo>();

  for (const node of globalNodes) {
    // 只处理物理表/视图，跳过 CTE、column 等
    if (node.type !== 'table' && node.type !== 'view') continue;
    const qualifiedName = getTableQualifiedName(node);
    if (!qualifiedName) continue;

    const scripts = new Set<string>();
    for (const ref of node.statementRefs ?? []) {
      const source = stmtToSource.get(ref.statementIndex);
      if (source) scripts.add(source);
    }

    // 如果没有任何脚本引用（例如全局 schema 中定义但未使用的表），使用占位脚本
    if (scripts.size === 0) scripts.add('(unreferenced)');

    const info: TableInfo = { nodeId: node.id, qualifiedName, scripts };
    tableByNodeId.set(node.id, info);
    // 同名表只保留第一个（按 nodeId 去重）
    if (!tableByQName.has(qualifiedName)) {
      tableByQName.set(qualifiedName, info);
    }
  }

  // 3. 构建脚本 → 表的映射（用于创建脚本节点）
  const scriptToTables = new Map<string, Set<string>>();
  for (const info of tableByNodeId.values()) {
    for (const script of info.scripts) {
      if (!scriptToTables.has(script)) scriptToTables.set(script, new Set());
      scriptToTables.get(script)!.add(info.qualifiedName);
    }
  }

  // 4. 构建节点和边
  const insightsNodes: GlobalNode[] = [];
  const insightsEdges: GlobalEdge[] = [];

  // 4a. 脚本节点（type: 'table'）
  for (const [scriptPath, tableNames] of scriptToTables) {
    const scriptId = buildScriptNodeId(scriptPath);
    const displayName = getScriptDisplayName(scriptPath);

    insightsNodes.push({
      id: scriptId,
      type: 'table',
      label: displayName,
      canonicalName: { name: displayName },
      statementRefs: [],
      metadata: {
        scriptPath,
        tableCount: tableNames.size,
        isInsightsScriptNode: true,
      },
    });
  }

  // 4b. 表实例节点（type: 'column'）+ ownership 边
  // 记录 (scriptId, qualifiedName) → instanceId 的映射，用于后续创建跨脚本边
  const instanceIdMap = new Map<string, string>(); // key: `${scriptId}||${qName}`

  for (const [scriptPath, tableNames] of scriptToTables) {
    const scriptId = buildScriptNodeId(scriptPath);

    for (const qualifiedName of tableNames) {
      const instanceId = buildTableInstanceId(scriptId, qualifiedName);
      const displayName = getTableDisplayName(qualifiedName);
      const key = `${scriptId}||${qualifiedName}`;
      instanceIdMap.set(key, instanceId);

      insightsNodes.push({
        id: instanceId,
        type: 'column',
        label: displayName,
        canonicalName: buildTableCanonicalName(qualifiedName),
        statementRefs: [],
        metadata: {
          qualifiedName,
          scriptPath,
          isInsightsTableNode: true,
        },
      });

      // ownership 边：脚本 → 表实例
      insightsEdges.push({
        id: `own:${instanceId}`,
        from: scriptId,
        to: instanceId,
        type: 'ownership',
      });
    }
  }

  // 4c. 跨脚本 data_flow 边
  // 遍历原始的表间 data_flow 边，映射到对应的脚本-表实例
  let dataFlowEdgeCount = 0;
  for (const edge of globalEdges) {
    if (edge.type !== 'data_flow' && edge.type !== 'cross_statement') continue;

    const fromTable = tableByNodeId.get(edge.from);
    const toTable = tableByNodeId.get(edge.to);
    if (!fromTable || !toTable) continue;
    if (fromTable.qualifiedName === toTable.qualifiedName) continue;

    // 为每对 (fromScript, toScript) 创建一条跨脚本边
    for (const fromScript of fromTable.scripts) {
      for (const toScript of toTable.scripts) {
        // 跳过同一脚本内部的边（避免过于密集）
        if (fromScript === toScript) continue;

        const fromScriptId = buildScriptNodeId(fromScript);
        const toScriptId = buildScriptNodeId(toScript);
        const fromInstanceId = instanceIdMap.get(`${fromScriptId}||${fromTable.qualifiedName}`);
        const toInstanceId = instanceIdMap.get(`${toScriptId}||${toTable.qualifiedName}`);

        if (!fromInstanceId || !toInstanceId) continue;

        const edgeId = `flow:${fromInstanceId}->${toInstanceId}`;
        insightsEdges.push({
          id: edgeId,
          from: fromInstanceId,
          to: toInstanceId,
          type: 'data_flow',
          metadata: {
            fromTable: fromTable.qualifiedName,
            toTable: toTable.qualifiedName,
            fromScript,
            toScript,
          },
        });
        dataFlowEdgeCount++;
      }
    }
  }

  // 5. 构建新的 AnalyzeResult
  const insightsResult: AnalyzeResult = {
    ...original,
    statements: [], // 数据洞察视图不需要 per-statement 数据
    globalLineage: {
      nodes: insightsNodes,
      edges: insightsEdges,
    },
    summary: {
      ...original.summary,
      statementCount: 0,
      tableCount: scriptToTables.size,
      columnCount: tableByQName.size,
    },
  };

  return {
    result: insightsResult,
    stats: {
      scriptCount: scriptToTables.size,
      tableInstanceCount: insightsNodes.filter((n) => n.type === 'column').length,
      uniqueTableCount: tableByQName.size,
      ownershipEdgeCount: insightsEdges.filter((e) => e.type === 'ownership').length,
      dataFlowEdgeCount,
    },
  };
}

/**
 * 判断一个 AnalyzeResult 是否为数据洞察视图的转换结果。
 * 用于在卸载时还原原始数据。
 */
export function isInsightsResult(result: AnalyzeResult | null): boolean {
  if (!result?.globalLineage?.nodes) return false;
  return result.globalLineage.nodes.some(
    (n) => n.metadata?.isInsightsScriptNode || n.metadata?.isInsightsTableNode
  );
}
