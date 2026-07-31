import { useMemo, useRef, useCallback } from 'react';
import type { AnalyzeResult, Edge, Node } from '@pondpilot/capybara-core';

// ============================================================================
// Types (shared with GlobalLineageListView and MatrixView)
// ============================================================================

export type GlobalLineageStatus = 'source' | 'bridge' | 'sink' | 'isolated';
export type GlobalLineageSortKey = 'impact' | 'upstream' | 'downstream' | 'files' | 'name';

export interface RelationItem {
  nodeId: string;
  qualifiedName: string;
  label: string;
  comment?: string;
  status: GlobalLineageStatus;
  relatedFiles: string[];
  relationFiles: string[];
}

export interface TableEntry {
  nodeId: string;
  qualifiedName: string;
  label: string;
  comment?: string;
  relatedFiles: string[];
  upstream: RelationItem[];
  downstream: RelationItem[];
  status: GlobalLineageStatus;
  relationCount: number;
  impactScore: number;
  primaryFile?: string;
  /** 轻量模式：上游节点 ID 列表（详情按需构建） */
  _upstreamIds?: string[];
  /** 轻量模式：下游节点 ID 列表（详情按需构建） */
  _downstreamIds?: string[];
}

export interface GlobalLineageStats {
  totalTables: number;
  totalEdges: number;
  sourceTables: number;
  sinkTables: number;
  bridgeTables: number;
  isolatedTables: number;
}

export interface GlobalLineageData {
  entries: TableEntry[];
  entryMap: Map<string, TableEntry>;
  stats: GlobalLineageStats;
  /** 是否为轻量模式（大数据集优化） */
  isLightweight: boolean;
  /** 按需获取完整上下游详情 */
  loadEntryDetail: (entryId: string) => TableEntry | null;
  /** Pipeline task sourceName → 涉及的 table node IDs */
  taskTables: Map<string, Set<string>>;
}

// ============================================================================
// 轻量模式阈值 — 超过此边数则不预构建完整上下游数组
// ============================================================================
const LIGHTWEIGHT_EDGE_THRESHOLD = 500;

// ============================================================================
// Helpers
// ============================================================================

function getNodeComment(node: Node | undefined): string | undefined {
  const value = node?.metadata?.comment;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

export function getNodeStatus(incomingCount: number, outgoingCount: number): GlobalLineageStatus {
  if (incomingCount === 0 && outgoingCount === 0) return 'isolated';
  if (incomingCount === 0) return 'source';
  if (outgoingCount === 0) return 'sink';
  return 'bridge';
}

function sortNames(values: Iterable<string>): string[] {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
}

export function getImpactScore(
  incomingCount: number,
  outgoingCount: number,
  relatedFilesCount: number,
  status: GlobalLineageStatus
): number {
  const statusBonus = status === 'bridge' ? 8 : status === 'sink' ? 4 : status === 'source' ? 2 : 0;
  return outgoingCount * 5 + incomingCount * 4 + relatedFilesCount * 2 + statusBonus;
}

export function sortEntries(entries: TableEntry[], sortKey: GlobalLineageSortKey): TableEntry[] {
  return [...entries].sort((a, b) => {
    switch (sortKey) {
      case 'name':
        return a.qualifiedName.localeCompare(b.qualifiedName);
      case 'upstream':
        return (
          b.upstream.length - a.upstream.length ||
          b.impactScore - a.impactScore ||
          a.qualifiedName.localeCompare(b.qualifiedName)
        );
      case 'downstream':
        return (
          b.downstream.length - a.downstream.length ||
          b.impactScore - a.impactScore ||
          a.qualifiedName.localeCompare(b.qualifiedName)
        );
      case 'files':
        return (
          b.relatedFiles.length - a.relatedFiles.length ||
          b.impactScore - a.impactScore ||
          a.qualifiedName.localeCompare(b.qualifiedName)
        );
      case 'impact':
      default:
        return (
          b.impactScore - a.impactScore ||
          b.relationCount - a.relationCount ||
          a.qualifiedName.localeCompare(b.qualifiedName)
        );
    }
  });
}

// ============================================================================
// 原始数据缓存 — 避免 result 变化时重复构建 node/edge 映射
// ============================================================================

interface RawGraphCache {
  result: AnalyzeResult;
  nodeInfoById: Map<string, Node>;
  nodeFiles: Map<string, Set<string>>;
  edgeFiles: Map<string, Set<string>>;
  edges: Edge[];
  incoming: Map<string, string[]>;
  outgoing: Map<string, string[]>;
  relationStatusByNode: Map<string, GlobalLineageStatus>;
}

function buildRawGraphCache(result: AnalyzeResult): RawGraphCache {
  const nodeInfoById = new Map<string, Node>();
  const nodeFiles = new Map<string, Set<string>>();
  const edgeFiles = new Map<string, Set<string>>();

  for (const statement of result.statements) {
    const sourceName = statement.sourceName;
    for (const node of statement.nodes) {
      if (!nodeInfoById.has(node.id)) {
        nodeInfoById.set(node.id, node);
      } else {
        const existing = nodeInfoById.get(node.id);
        if (existing && !getNodeComment(existing) && getNodeComment(node)) {
          nodeInfoById.set(node.id, node);
        }
      }
      if (sourceName) {
        if (!nodeFiles.has(node.id)) {
          nodeFiles.set(node.id, new Set());
        }
        nodeFiles.get(node.id)!.add(sourceName);
      }
    }

    for (const edge of statement.edges) {
      if (!sourceName) continue;
      const key = `${edge.from}->${edge.to}`;
      if (!edgeFiles.has(key)) {
        edgeFiles.set(key, new Set());
      }
      edgeFiles.get(key)!.add(sourceName);
    }
  }

  // Sync globalLineage nodes
  const globalNodes = result.globalLineage?.nodes ?? [];
  const buildQNameFromGlobal = (gNode: (typeof globalNodes)[number]): string => {
    const cn = gNode.canonicalName;
    if (cn) {
      const parts = [cn.catalog, cn.schema, cn.name].filter(Boolean);
      if (parts.length > 1) return parts.join('.');
    }
    return gNode.label || gNode.id;
  };
  for (const gNode of globalNodes) {
    if (!nodeInfoById.has(gNode.id)) {
      const inferredQName = buildQNameFromGlobal(gNode);
      const fallback: Node = {
        id: gNode.id,
        label: gNode.label || inferredQName,
        qualifiedName: inferredQName,
        kind: gNode.type || 'table',
        statementRefs: gNode.statementRefs,
        metadata: gNode.metadata,
      } as unknown as Node;
      nodeInfoById.set(gNode.id, fallback);
    }
  }
  for (const gNode of globalNodes) {
    const existing = nodeInfoById.get(gNode.id);
    if (existing && existing.qualifiedName === existing.id) {
      const inferredQName = buildQNameFromGlobal(gNode);
      nodeInfoById.set(gNode.id, {
        ...existing,
        label: gNode.label || existing.label,
        qualifiedName: inferredQName,
      });
    }
  }

  const edges: Edge[] = result.globalLineage?.edges ?? [];
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();

  for (const edge of edges) {
    if (!incoming.has(edge.to)) incoming.set(edge.to, []);
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
    incoming.get(edge.to)!.push(edge.from);
    outgoing.get(edge.from)!.push(edge.to);
  }

  const relationStatusByNode = new Map<string, GlobalLineageStatus>();
  for (const nodeId of nodeInfoById.keys()) {
    relationStatusByNode.set(
      nodeId,
      getNodeStatus(incoming.get(nodeId)?.length ?? 0, outgoing.get(nodeId)?.length ?? 0)
    );
  }

  return {
    result,
    nodeInfoById,
    nodeFiles,
    edgeFiles,
    edges,
    incoming,
    outgoing,
    relationStatusByNode,
  };
}

function buildRelationItem(
  currentNodeId: string,
  relatedNodeId: string,
  cache: RawGraphCache
): RelationItem {
  const relatedNode = cache.nodeInfoById.get(relatedNodeId);
  const relatedFiles = sortNames(cache.nodeFiles.get(relatedNodeId) ?? []);
  const relationFiles = sortNames(
    cache.edgeFiles.get(`${relatedNodeId}->${currentNodeId}`) ??
      cache.edgeFiles.get(`${currentNodeId}->${relatedNodeId}`) ??
      []
  );

  return {
    nodeId: relatedNodeId,
    qualifiedName: relatedNode?.qualifiedName || relatedNode?.label || relatedNodeId,
    label: relatedNode?.label || relatedNodeId,
    comment: getNodeComment(relatedNode),
    status: cache.relationStatusByNode.get(relatedNodeId) ?? 'isolated',
    relatedFiles,
    relationFiles,
  };
}

/** 构建轻量条目 — 不含上下游详细信息，仅存储 ID 列表 */
function buildLightweightEntry(nodeId: string, cache: RawGraphCache): TableEntry {
  const node = cache.nodeInfoById.get(nodeId);
  const upstreamIds = cache.incoming.get(nodeId) ?? [];
  const downstreamIds = cache.outgoing.get(nodeId) ?? [];
  const status = cache.relationStatusByNode.get(nodeId) ?? 'isolated';

  return {
    nodeId,
    qualifiedName: node?.qualifiedName || node?.label || nodeId,
    label: node?.label || nodeId,
    comment: getNodeComment(node),
    relatedFiles: sortNames(cache.nodeFiles.get(nodeId) ?? []),
    upstream: [], // 轻量模式不预构建
    downstream: [], // 轻量模式不预构建
    status,
    relationCount: upstreamIds.length + downstreamIds.length,
    impactScore: getImpactScore(
      upstreamIds.length,
      downstreamIds.length,
      cache.nodeFiles.get(nodeId)?.size ?? 0,
      status
    ),
    primaryFile: sortNames(cache.nodeFiles.get(nodeId) ?? [])[0],
    _upstreamIds: upstreamIds,
    _downstreamIds: downstreamIds,
  };
}

/** 为单个条目按需构建完整上下游详情 */
function buildEntryDetail(entry: TableEntry, cache: RawGraphCache): TableEntry {
  if (entry.upstream.length > 0 || entry.downstream.length > 0) {
    return entry; // 已经是完整模式
  }
  const upstreamIds = entry._upstreamIds ?? [];
  const downstreamIds = entry._downstreamIds ?? [];

  return {
    ...entry,
    upstream: upstreamIds
      .map((id) => buildRelationItem(entry.nodeId, id, cache))
      .sort((a, b) => a.qualifiedName.localeCompare(b.qualifiedName)),
    downstream: downstreamIds
      .map((id) => buildRelationItem(entry.nodeId, id, cache))
      .sort((a, b) => a.qualifiedName.localeCompare(b.qualifiedName)),
  };
}

// ============================================================================
// Hook
// ============================================================================

export function useGlobalLineageData(result: AnalyzeResult | null): GlobalLineageData {
  // 缓存原始数据 — 仅在 result 引用变化时重建
  const rawCacheRef = useRef<RawGraphCache | null>(null);

  const cache = useMemo(() => {
    if (!result) {
      rawCacheRef.current = null;
      return null;
    }
    const newCache = buildRawGraphCache(result);
    rawCacheRef.current = newCache;
    return newCache;
  }, [result]);

  const entries = useMemo(() => {
    if (!cache) {
      return [];
    }

    const isLightweight = cache.edges.length > LIGHTWEIGHT_EDGE_THRESHOLD;

    const list = Array.from(cache.nodeInfoById.keys()).map((nodeId) => {
      if (isLightweight) {
        return buildLightweightEntry(nodeId, cache);
      }
      // 完整模式
      const node = cache.nodeInfoById.get(nodeId);
      const upstreamIds = cache.incoming.get(nodeId) ?? [];
      const downstreamIds = cache.outgoing.get(nodeId) ?? [];
      const status = cache.relationStatusByNode.get(nodeId) ?? 'isolated';

      return {
        nodeId,
        qualifiedName: node?.qualifiedName || node?.label || nodeId,
        label: node?.label || nodeId,
        comment: getNodeComment(node),
        relatedFiles: sortNames(cache.nodeFiles.get(nodeId) ?? []),
        upstream: upstreamIds
          .map((id) => buildRelationItem(nodeId, id, cache))
          .sort((a, b) => a.qualifiedName.localeCompare(b.qualifiedName)),
        downstream: downstreamIds
          .map((id) => buildRelationItem(nodeId, id, cache))
          .sort((a, b) => a.qualifiedName.localeCompare(b.qualifiedName)),
        status,
        relationCount: upstreamIds.length + downstreamIds.length,
        impactScore: getImpactScore(
          upstreamIds.length,
          downstreamIds.length,
          cache.nodeFiles.get(nodeId)?.size ?? 0,
          status
        ),
        primaryFile: sortNames(cache.nodeFiles.get(nodeId) ?? [])[0],
      } satisfies TableEntry;
    });

    return list.sort((a, b) => {
      return (
        b.impactScore - a.impactScore ||
        b.relationCount - a.relationCount ||
        a.qualifiedName.localeCompare(b.qualifiedName)
      );
    });
  }, [cache]);

  const entryMap = useMemo(() => new Map(entries.map((entry) => [entry.nodeId, entry])), [entries]);

  const stats = useMemo((): GlobalLineageStats => {
    if (!cache) {
      return {
        totalTables: 0,
        totalEdges: 0,
        sourceTables: 0,
        sinkTables: 0,
        bridgeTables: 0,
        isolatedTables: 0,
      };
    }
    return {
      totalTables: entries.length,
      totalEdges: cache.edges.length,
      sourceTables: entries.filter((entry) => entry.status === 'source').length,
      sinkTables: entries.filter((entry) => entry.status === 'sink').length,
      bridgeTables: entries.filter((entry) => entry.status === 'bridge').length,
      isolatedTables: entries.filter((entry) => entry.status === 'isolated').length,
    };
  }, [entries, cache]);

  const isLightweight = cache ? cache.edges.length > LIGHTWEIGHT_EDGE_THRESHOLD : false;

  const loadEntryDetail = useCallback(
    (entryId: string): TableEntry | null => {
      if (!cache) return null;
      const entry = entryMap.get(entryId);
      if (!entry) return null;
      return buildEntryDetail(entry, cache);
    },
    [cache, entryMap]
  );

  // Build task→tables mapping from all statements.
  // Maps each pipeline task (sourceName) to the set of table node IDs that
  // appear in that task. Used by the list view to search by task name.
  const taskTables = useMemo(() => {
    const map = new Map<string, Set<string>>();
    if (!result) return map;
    for (const stmt of result.statements) {
      const src = stmt.sourceName;
      if (!src) continue;
      let s = map.get(src);
      if (!s) {
        s = new Set<string>();
        map.set(src, s);
      }
      for (const n of stmt.nodes) {
        s.add(n.id);
      }
    }
    return map;
  }, [result]);

  return { entries, entryMap, stats, isLightweight, loadEntryDetail, taskTables };
}
