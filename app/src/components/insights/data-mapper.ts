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
 * 构建数据洞察图。
 *
 * ID 策略：使用短数字 ID（如 s0, t0, e0）而非完整路径，
 * 避免 data_flow 边 ID 拼接两个完整表实例路径（~280 字符/边），
 * 导致 worker postMessage 时 structured clone OOM。
 */
export function convertToInsightsGraph(original: AnalyzeResult): InsightsGraph {
  console.log('[data-mapper] convertToInsightsGraph called');
  console.log(
    '[data-mapper] statements:',
    original.statements.length,
    'GL nodes:',
    original.globalLineage?.nodes?.length,
    'GL edges:',
    original.globalLineage?.edges?.length
  );
  const globalNodes = original.globalLineage?.nodes ?? [];
  const globalEdges = original.globalLineage?.edges ?? [];

  // 1. 构建 qualifiedName → Set<sourceName> 映射
  const tableQNameToSources = new Map<string, Set<string>>();
  for (const stmt of original.statements) {
    const source = stmt.sourceName?.trim();
    if (!source) continue;
    for (const node of stmt.nodes ?? []) {
      if (node.type !== 'table' && node.type !== 'view') continue;
      const qName = node.qualifiedName || node.label;
      if (!qName) continue;
      let set = tableQNameToSources.get(qName);
      if (!set) {
        set = new Set();
        tableQNameToSources.set(qName, set);
      }
      set.add(source);
    }
  }
  console.log('[data-mapper] tableQNameToSources size:', tableQNameToSources.size);

  // 2. 收集所有物理表节点
  interface TableInfo {
    nodeId: string;
    qualifiedName: string;
    scripts: Set<string>;
  }
  const tableByNodeId = new Map<string, TableInfo>();
  const tableByQName = new Map<string, TableInfo>();

  for (const node of globalNodes) {
    if (node.type !== 'table' && node.type !== 'view') continue;
    const qualifiedName = getTableQualifiedName(node);
    if (!qualifiedName) continue;

    let scripts = tableQNameToSources.get(qualifiedName);
    if (!scripts || scripts.size === 0) {
      scripts = new Set<string>();
      for (const ref of node.statementRefs ?? []) {
        const stmt = original.statements.find(
          (s) => s.statementIndex === ref.statementIndex && s.sourceName
        );
        if (stmt?.sourceName) scripts.add(stmt.sourceName.trim());
      }
    }
    if (!scripts || scripts.size === 0) {
      scripts = new Set(['(unreferenced)']);
    }

    const info: TableInfo = { nodeId: node.id, qualifiedName, scripts };
    tableByNodeId.set(node.id, info);
    if (!tableByQName.has(qualifiedName)) {
      tableByQName.set(qualifiedName, info);
    }
  }

  // 3. 构建脚本 → 表的映射
  const scriptToTables = new Map<string, Set<string>>();
  for (const info of tableByNodeId.values()) {
    for (const script of info.scripts) {
      if (!scriptToTables.has(script)) scriptToTables.set(script, new Set());
      scriptToTables.get(script)!.add(info.qualifiedName);
    }
  }

  console.log(
    '[data-mapper] scriptToTables size:',
    scriptToTables.size,
    'tableByQName size:',
    tableByQName.size
  );

  // 4. 构建节点和边（使用短数字 ID）
  const insightsNodes: GlobalNode[] = [];
  const insightsEdges: GlobalEdge[] = [];

  // 短 ID 映射
  const scriptPathToId = new Map<string, string>(); // scriptPath → "s0"
  const instanceKeyToId = new Map<string, string>(); // "scriptPath||qName" → "t0"
  let scriptCounter = 0;
  let instanceCounter = 0;
  let edgeCounter = 0;

  // 4a. 脚本节点（type: 'table'）
  for (const [scriptPath, tableNames] of scriptToTables) {
    const scriptId = `s${scriptCounter++}`;
    scriptPathToId.set(scriptPath, scriptId);
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
  for (const [scriptPath, tableNames] of scriptToTables) {
    const scriptId = scriptPathToId.get(scriptPath)!;

    for (const qualifiedName of tableNames) {
      const instanceId = `t${instanceCounter++}`;
      const key = `${scriptPath}||${qualifiedName}`;
      instanceKeyToId.set(key, instanceId);
      const displayName = getTableDisplayName(qualifiedName);

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
        id: `o${edgeCounter++}`,
        from: scriptId,
        to: instanceId,
        type: 'ownership',
      });
    }
  }

  // 4c. 跨脚本 data_flow 边（去除 metadata 以减少 payload）
  let dataFlowEdgeCount = 0;
  for (const edge of globalEdges) {
    if (edge.type !== 'data_flow' && edge.type !== 'cross_statement') continue;

    const fromTable = tableByNodeId.get(edge.from);
    const toTable = tableByNodeId.get(edge.to);
    if (!fromTable || !toTable) continue;
    if (fromTable.qualifiedName === toTable.qualifiedName) continue;

    for (const fromScript of fromTable.scripts) {
      for (const toScript of toTable.scripts) {
        if (fromScript === toScript) continue;

        const fromInstanceId = instanceKeyToId.get(`${fromScript}||${fromTable.qualifiedName}`);
        const toInstanceId = instanceKeyToId.get(`${toScript}||${toTable.qualifiedName}`);
        if (!fromInstanceId || !toInstanceId) continue;

        insightsEdges.push({
          id: `f${edgeCounter++}`,
          from: fromInstanceId,
          to: toInstanceId,
          type: 'data_flow',
        });
        dataFlowEdgeCount++;
      }
    }
  }

  // 5. 构建新的 AnalyzeResult
  // GraphView 的早期守卫检查 result.statements.length === 0，
  // 所以需要至少一个合成 statement 来通过守卫。
  // 注意：worker 从 statement.nodes/edges 构建图，globalLineage 仅用于 canonicalName 查找。
  // 为避免 structured clone 重复复制（导致 OOM），globalLineage 设为空。
  const syntheticStatement = {
    statementIndex: 0,
    statementType: 'GLOBAL' as const,
    sourceName: '(insights)',
    nodes: insightsNodes,
    edges: insightsEdges,
    joinCount: 0,
    complexityScore: 0,
  };

  const insightsResult: AnalyzeResult = {
    // 不使用 ...original 展开，避免复制巨大的 resolvedSchema（数千表定义）
    // 导致 worker postMessage 时 DataCloneError OOM
    statements: [syntheticStatement],
    globalLineage: {
      nodes: [],
      edges: [],
    },
    issues: [],
    summary: {
      ...original.summary,
      statementCount: 1,
      tableCount: scriptToTables.size,
      columnCount: tableByQName.size,
    },
  };

  const stats = {
    scriptCount: scriptToTables.size,
    tableInstanceCount: insightsNodes.filter((n) => n.type === 'column').length,
    uniqueTableCount: tableByQName.size,
    ownershipEdgeCount: insightsEdges.filter((e) => e.type === 'ownership').length,
    dataFlowEdgeCount,
  };
  console.log('[data-mapper] Conversion complete:', stats);

  return {
    result: insightsResult,
    stats,
  };
}

/**
 * 判断一个 AnalyzeResult 是否为数据洞察视图的转换结果。
 * 用于在卸载时还原原始数据。
 *
 * 注意：insights 节点存储在 statements[0].nodes 中（不是 globalLineage.nodes），
 * 因为 worker 从 statement.nodes 构建图，而 globalLineage 设为空以避免 OOM。
 */
export function isInsightsResult(result: AnalyzeResult | null): boolean {
  if (!result?.statements?.length) return false;
  return result.statements.some((stmt) =>
    stmt.nodes?.some((n) => n.metadata?.isInsightsScriptNode || n.metadata?.isInsightsTableNode)
  );
}
