import { useMemo } from 'react';
import type { AnalyzeResult, Edge, Node } from '@pondpilot/flowscope-core';

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
}

// ============================================================================
// Helpers (extracted from GlobalLineageListView)
// ============================================================================

function getNodeComment(node: Node | undefined): string | undefined {
  const value = node?.metadata?.comment;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

export function getNodeStatus(
  incomingCount: number,
  outgoingCount: number
): GlobalLineageStatus {
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
  const statusBonus =
    status === 'bridge' ? 8 : status === 'sink' ? 4 : status === 'source' ? 2 : 0;
  return outgoingCount * 5 + incomingCount * 4 + relatedFilesCount * 2 + statusBonus;
}

export function sortEntries(
  entries: TableEntry[],
  sortKey: GlobalLineageSortKey
): TableEntry[] {
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
// Hook
// ============================================================================

export function useGlobalLineageData(result: AnalyzeResult | null): GlobalLineageData {
  return useMemo(() => {
    if (!result) {
      return {
        entries: [],
        entryMap: new Map(),
        stats: {
          totalTables: 0,
          totalEdges: 0,
          sourceTables: 0,
          sinkTables: 0,
          bridgeTables: 0,
          isolatedTables: 0,
        },
      };
    }

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

    // Sync globalLineage nodes that may not be in statements
    const globalNodes = result.globalLineage?.nodes ?? [];
    const globalNodeById = new Map<string, (typeof globalNodes)[number]>();
    const buildQNameFromGlobal = (gNode: (typeof globalNodes)[number]): string => {
      const cn = gNode.canonicalName;
      if (cn) {
        const parts = [cn.catalog, cn.schema, cn.name].filter(Boolean);
        if (parts.length > 1) return parts.join('.');
      }
      return gNode.label || gNode.id;
    };
    for (const gNode of globalNodes) {
      globalNodeById.set(gNode.id, gNode);
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

    const buildRelation = (currentNodeId: string, relatedNodeId: string): RelationItem => {
      const relatedNode = nodeInfoById.get(relatedNodeId);
      const relatedFiles = sortNames(nodeFiles.get(relatedNodeId) ?? []);
      const relationFiles = sortNames(
        edgeFiles.get(`${relatedNodeId}->${currentNodeId}`) ??
          edgeFiles.get(`${currentNodeId}->${relatedNodeId}`) ??
          []
      );

      return {
        nodeId: relatedNodeId,
        qualifiedName: relatedNode?.qualifiedName || relatedNode?.label || relatedNodeId,
        label: relatedNode?.label || relatedNodeId,
        comment: getNodeComment(relatedNode),
        status: relationStatusByNode.get(relatedNodeId) ?? 'isolated',
        relatedFiles,
        relationFiles,
      };
    };

    const entries = Array.from(nodeInfoById.values())
      .map((node) => {
        const upstreamIds = incoming.get(node.id) ?? [];
        const downstreamIds = outgoing.get(node.id) ?? [];
        const status = relationStatusByNode.get(node.id) ?? 'isolated';

        return {
          nodeId: node.id,
          qualifiedName: node.qualifiedName || node.label,
          label: node.label,
          comment: getNodeComment(node),
          relatedFiles: sortNames(nodeFiles.get(node.id) ?? []),
          upstream: upstreamIds
            .map((relatedNodeId) => buildRelation(node.id, relatedNodeId))
            .sort((a, b) => a.qualifiedName.localeCompare(b.qualifiedName)),
          downstream: downstreamIds
            .map((relatedNodeId) => buildRelation(node.id, relatedNodeId))
            .sort((a, b) => a.qualifiedName.localeCompare(b.qualifiedName)),
          status,
          relationCount: upstreamIds.length + downstreamIds.length,
          impactScore: getImpactScore(
            upstreamIds.length,
            downstreamIds.length,
            nodeFiles.get(node.id)?.size ?? 0,
            status
          ),
          primaryFile: sortNames(nodeFiles.get(node.id) ?? [])[0],
        } satisfies TableEntry;
      })
      .sort((a, b) => {
        return (
          b.impactScore - a.impactScore ||
          b.relationCount - a.relationCount ||
          a.qualifiedName.localeCompare(b.qualifiedName)
        );
      });

    const entryMap = new Map(entries.map((entry) => [entry.nodeId, entry]));
    const stats: GlobalLineageStats = {
      totalTables: entries.length,
      totalEdges: edges.length,
      sourceTables: entries.filter((entry) => entry.upstream.length === 0).length,
      sinkTables: entries.filter((entry) => entry.downstream.length === 0).length,
      bridgeTables: entries.filter((entry) => entry.status === 'bridge').length,
      isolatedTables: entries.filter((entry) => entry.status === 'isolated').length,
    };

    return { entries, entryMap, stats };
  }, [result]);
}
