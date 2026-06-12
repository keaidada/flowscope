import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AnalyzeResult, Edge, Node } from '@pondpilot/flowscope-core';
import { useLineageActions } from '@pondpilot/flowscope-react';
import {
  ArrowDownToLine,
  ArrowUpDown,
  ArrowUpToLine,
  ChevronDown,
  ChevronRight,
  FileCode2,
  Flame,
  FolderTree,
  Layers3,
  GitBranch,
  Network,
  Search,
  Sparkles,
  Table2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from './ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from './ui/sheet';
import { cn } from '@/lib/utils';

type GlobalLineageStatus = 'source' | 'bridge' | 'sink' | 'isolated';
type GlobalLineageSortKey = 'impact' | 'upstream' | 'downstream' | 'files' | 'name';
type GlobalLineageQuickView = 'all' | 'hotspots' | 'bridge' | 'source' | 'sink' | 'isolated';
type GlobalLineageInventoryMode = 'table' | 'grouped';
const PAGE_SIZE_OPTIONS = [25, 50, 100] as const;

interface GlobalLineageListViewProps {
  result: AnalyzeResult | null;
  onOpenGraphForNode?: (nodeId: string) => void;
}

interface RelationItem {
  nodeId: string;
  qualifiedName: string;
  label: string;
  comment?: string;
  status: GlobalLineageStatus;
  relatedFiles: string[];
  relationFiles: string[];
}

interface TableEntry {
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

interface GlobalLineageStats {
  totalTables: number;
  totalEdges: number;
  sourceTables: number;
  sinkTables: number;
  bridgeTables: number;
  isolatedTables: number;
}

interface GlobalLineageData {
  entries: TableEntry[];
  entryMap: Map<string, TableEntry>;
  stats: GlobalLineageStats;
}

interface FileGroupEntry {
  file: string;
  tableCount: number;
  maxImpactScore: number;
  topTableName: string;
}

interface InventoryFileGroup {
  file: string;
  entries: TableEntry[];
  maxImpactScore: number;
  totalRelations: number;
  sourceCount: number;
  bridgeCount: number;
  sinkCount: number;
  isolatedCount: number;
}

interface SelectionContext {
  kind: 'inventory' | 'inventory-group' | 'file-lens' | 'hotspot' | 'relation';
  label: string;
  file?: string;
}

interface StatusMeta {
  labelKey: string;
  dotClassName: string;
  badgeClassName: string;
}

const STATUS_META: Record<GlobalLineageStatus, StatusMeta> = {
  source: {
    labelKey: 'globalLineageList.statusSource',
    dotClassName: 'bg-emerald-500',
    badgeClassName:
      'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300',
  },
  bridge: {
    labelKey: 'globalLineageList.statusBridge',
    dotClassName: 'bg-sky-500',
    badgeClassName:
      'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900/60 dark:bg-sky-950/40 dark:text-sky-300',
  },
  sink: {
    labelKey: 'globalLineageList.statusSink',
    dotClassName: 'bg-amber-500',
    badgeClassName:
      'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300',
  },
  isolated: {
    labelKey: 'globalLineageList.statusIsolated',
    dotClassName: 'bg-slate-400',
    badgeClassName:
      'border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-800 dark:bg-slate-900/60 dark:text-slate-300',
  },
};

function getNodeComment(node: Node | undefined): string | undefined {
  const value = node?.metadata?.comment;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function getNodeStatus(incomingCount: number, outgoingCount: number): GlobalLineageStatus {
  if (incomingCount === 0 && outgoingCount === 0) return 'isolated';
  if (incomingCount === 0) return 'source';
  if (outgoingCount === 0) return 'sink';
  return 'bridge';
}

function sortNames(values: Iterable<string>): string[] {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
}

function getImpactScore(
  incomingCount: number,
  outgoingCount: number,
  relatedFilesCount: number,
  status: GlobalLineageStatus
): number {
  const statusBonus =
    status === 'bridge' ? 8 : status === 'sink' ? 4 : status === 'source' ? 2 : 0;
  return outgoingCount * 5 + incomingCount * 4 + relatedFilesCount * 2 + statusBonus;
}

function sortEntries(entries: TableEntry[], sortKey: GlobalLineageSortKey): TableEntry[] {
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

function MiniLineageBar({
  upstreamCount,
  downstreamCount,
}: {
  upstreamCount: number;
  downstreamCount: number;
}) {
  const { t } = useTranslation();
  const total = Math.max(1, upstreamCount + downstreamCount);
  const upstreamRatio = `${(upstreamCount / total) * 100}%`;
  const downstreamRatio = `${(downstreamCount / total) * 100}%`;

  return (
    <div className="space-y-1.5">
      <div className="flex h-2 overflow-hidden rounded-full bg-muted">
        <div className="bg-sky-500" style={{ width: upstreamRatio }} />
        <div className="bg-emerald-500" style={{ width: downstreamRatio }} />
      </div>
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span>
          {t('globalLineageList.upstreamMini', { count: upstreamCount })}
        </span>
        <span>
          {t('globalLineageList.downstreamMini', { count: downstreamCount })}
        </span>
      </div>
    </div>
  );
}

function OverviewCard({
  label,
  value,
  hint,
  icon,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-border bg-background px-3 py-3 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs text-muted-foreground">{label}</div>
          <div className="mt-1.5 text-xl font-semibold text-foreground">{value}</div>
        </div>
        {icon ? <div className="text-muted-foreground">{icon}</div> : null}
      </div>
      {hint ? <div className="mt-1.5 text-[11px] text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

function DrawerStatCard({
  label,
  value,
  accentClassName,
}: {
  label: string;
  value: React.ReactNode;
  accentClassName?: string;
}) {
  return (
    <div className="min-w-[132px] flex-1 rounded-xl border border-border bg-muted/20 px-4 py-3">
      <div className="text-[11px] uppercase tracking-[0.03em] text-muted-foreground">{label}</div>
      <div className={cn('mt-1 text-xl font-semibold text-foreground', accentClassName)}>{value}</div>
    </div>
  );
}

function QuickJumpSection({
  title,
  items,
  emptyLabel,
  onSelectTable,
}: {
  title: string;
  items: RelationItem[];
  emptyLabel: string;
  onSelectTable: (nodeId: string) => void;
}) {
  return (
    <section className="space-y-3 rounded-2xl border border-border bg-background px-4 py-4">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-semibold text-foreground">{title}</div>
        <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
          {items.length}
        </span>
      </div>
      {items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-muted/20 px-3 py-4 text-sm text-muted-foreground">
          {emptyLabel}
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {items.map((item) => (
            <button
              key={`${title}-${item.nodeId}`}
              type="button"
              onClick={() => onSelectTable(item.nodeId)}
              className="inline-flex max-w-full items-center gap-2 rounded-full border border-border bg-muted/30 px-3 py-1.5 text-xs text-foreground transition-colors hover:border-primary/30 hover:bg-primary/5"
            >
              <span className={cn('inline-block h-2 w-2 rounded-full', STATUS_META[item.status].dotClassName)} />
              <span className="max-w-56 truncate">{item.qualifiedName}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function RelationTableSection({
  icon,
  title,
  items,
  emptyLabel,
  onSelectTable,
  onOpenFile,
}: {
  icon: React.ReactNode;
  title: string;
  items: RelationItem[];
  emptyLabel: string;
  onSelectTable: (nodeId: string) => void;
  onOpenFile: (sourceName: string, targetName?: string) => void;
}) {
  const { t } = useTranslation();

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2 text-[13px] font-semibold text-foreground">
        {icon}
        <span>{title}</span>
        <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
          {items.length}
        </span>
      </div>
      {items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-muted/20 px-4 py-6 text-center text-sm text-muted-foreground">
          {emptyLabel}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-background">
          <table className="min-w-full border-collapse text-sm">
            <thead className="bg-muted/40 text-[11px] uppercase tracking-[0.04em] text-muted-foreground">
              <tr>
                <th className="w-28 px-4 py-2.5 text-left font-medium">
                  {t('globalLineageList.statusColumn')}
                </th>
                <th className="px-4 py-2.5 text-left font-medium">
                  {t('globalLineageList.tableColumn')}
                </th>
                <th className="w-[32%] px-4 py-2.5 text-left font-medium">
                  {t('globalLineageList.filesColumn')}
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={`${item.nodeId}-${title}`} className="border-t border-border align-top">
                  <td className="px-4 py-3">
                    <span
                      className={cn(
                        'inline-flex rounded-full border px-2.5 py-1 text-xs font-medium',
                        STATUS_META[item.status].badgeClassName
                      )}
                    >
                      {t(STATUS_META[item.status].labelKey)}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <button
                      type="button"
                      onClick={() => onSelectTable(item.nodeId)}
                      className="group min-w-0 text-left"
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className={cn(
                            'inline-block h-2.5 w-2.5 shrink-0 rounded-full',
                            STATUS_META[item.status].dotClassName
                          )}
                        />
                        <span className="break-all font-medium text-foreground transition-colors group-hover:text-primary">
                          {item.qualifiedName}
                        </span>
                      </div>
                      {item.comment && (
                        <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">
                          {item.comment}
                        </p>
                      )}
                    </button>
                  </td>
                  <td className="px-4 py-3">
                    {item.relationFiles.length === 0 ? (
                      <span className="text-xs text-muted-foreground">-</span>
                    ) : (
                      <div className="flex flex-wrap gap-1.5">
                        {item.relationFiles.map((file) => (
                          <button
                            key={`${item.nodeId}-${file}`}
                            type="button"
                            onClick={() => onOpenFile(file, item.label)}
                            className="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-muted/30 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-primary/30 hover:text-foreground"
                          >
                            <FileCode2 className="h-3.5 w-3.5" />
                            <span className="max-w-64 truncate">{file}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function GlobalLineageListView({
  result,
  onOpenGraphForNode,
}: GlobalLineageListViewProps) {
  const { t } = useTranslation();
  const { requestNavigation, selectNode } = useLineageActions();
  const [searchTerm, setSearchTerm] = useState('');
  const [activeStatuses, setActiveStatuses] = useState<Set<GlobalLineageStatus>>(() => new Set());
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<GlobalLineageSortKey>('impact');
  const [quickView, setQuickView] = useState<GlobalLineageQuickView>('all');
  const [selectedFileGroup, setSelectedFileGroup] = useState<string | null>(null);
  const [inventoryMode, setInventoryMode] = useState<GlobalLineageInventoryMode>('table');
  const [expandedInventoryGroups, setExpandedInventoryGroups] = useState<Set<string>>(() => new Set());
  const [selectionContext, setSelectionContext] = useState<SelectionContext | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState<(typeof PAGE_SIZE_OPTIONS)[number]>(50);
  const [analyticsCollapsed, setAnalyticsCollapsed] = useState(false);
  const [inventoryCollapsed, setInventoryCollapsed] = useState(false);
  const [insightsCollapsed, setInsightsCollapsed] = useState(false);

  const graphData = useMemo<GlobalLineageData>(() => {
    if (!result) {
      return {
        entries: [] as TableEntry[],
        entryMap: new Map<string, TableEntry>(),
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
    const stats = {
      totalTables: entries.length,
      totalEdges: edges.length,
      sourceTables: entries.filter((entry) => entry.upstream.length === 0).length,
      sinkTables: entries.filter((entry) => entry.downstream.length === 0).length,
      bridgeTables: entries.filter((entry) => entry.status === 'bridge').length,
      isolatedTables: entries.filter((entry) => entry.status === 'isolated').length,
    };

    return { entries, entryMap, stats };
  }, [result]);

  const filteredEntries = useMemo(() => {
    const lowered = searchTerm.trim().toLowerCase();
    return graphData.entries.filter((entry) => {
      if (activeStatuses.size > 0 && !activeStatuses.has(entry.status)) {
        return false;
      }
      if (!lowered) {
        return true;
      }

      const searchable = [
        entry.qualifiedName,
        entry.comment ?? '',
        ...entry.relatedFiles,
        ...entry.upstream.map((item) => item.qualifiedName),
        ...entry.downstream.map((item) => item.qualifiedName),
      ]
        .join('\n')
        .toLowerCase();

      return searchable.includes(lowered);
    });
  }, [activeStatuses, graphData.entries, searchTerm]);

  const quickViewEntries = useMemo(() => {
    switch (quickView) {
      case 'hotspots': {
        const hotspotLimit = Math.max(8, Math.ceil(filteredEntries.length * 0.2));
        return sortEntries(filteredEntries, 'impact').slice(0, hotspotLimit);
      }
      case 'bridge':
      case 'source':
      case 'sink':
      case 'isolated':
        return filteredEntries.filter((entry) => entry.status === quickView);
      case 'all':
      default:
        return filteredEntries;
    }
  }, [filteredEntries, quickView]);

  const fileScopedEntries = useMemo(() => {
    if (!selectedFileGroup) {
      return quickViewEntries;
    }
    return quickViewEntries.filter((entry) => entry.primaryFile === selectedFileGroup);
  }, [quickViewEntries, selectedFileGroup]);

  const sortedEntries = useMemo(
    () => sortEntries(fileScopedEntries, sortKey),
    [fileScopedEntries, sortKey]
  );
  const hotspotEntries = useMemo(
    () => sortEntries(graphData.entries, 'impact').slice(0, 5),
    [graphData.entries]
  );
  const topImpactEntry = hotspotEntries[0] ?? null;
  const topUpstreamEntry = useMemo(
    () => sortEntries(graphData.entries, 'upstream')[0] ?? null,
    [graphData.entries]
  );
  const topDownstreamEntry = useMemo(
    () => sortEntries(graphData.entries, 'downstream')[0] ?? null,
    [graphData.entries]
  );
  const fileGroups = useMemo<FileGroupEntry[]>(() => {
    const grouped = new Map<string, FileGroupEntry>();

    for (const entry of graphData.entries) {
      if (!entry.primaryFile) continue;
      const current = grouped.get(entry.primaryFile);
      if (!current) {
        grouped.set(entry.primaryFile, {
          file: entry.primaryFile,
          tableCount: 1,
          maxImpactScore: entry.impactScore,
          topTableName: entry.qualifiedName,
        });
        continue;
      }

      current.tableCount += 1;
      if (entry.impactScore > current.maxImpactScore) {
        current.maxImpactScore = entry.impactScore;
        current.topTableName = entry.qualifiedName;
      }
    }

    return Array.from(grouped.values()).sort((a, b) => {
      return (
        b.tableCount - a.tableCount ||
        b.maxImpactScore - a.maxImpactScore ||
        a.file.localeCompare(b.file)
      );
    });
  }, [graphData.entries]);
  const activeFilterCount =
    activeStatuses.size +
    (searchTerm.trim() ? 1 : 0) +
    (quickView !== 'all' ? 1 : 0) +
    (selectedFileGroup ? 1 : 0);
  const selectedEntry = selectedNodeId ? graphData.entryMap.get(selectedNodeId) ?? null : null;
  const selectedFileEntries = useMemo(
    () =>
      selectedFileGroup
        ? sortEntries(
            graphData.entries.filter((entry) => entry.primaryFile === selectedFileGroup),
            'impact'
          )
        : [],
    [graphData.entries, selectedFileGroup]
  );
  const totalFilteredEntries = sortedEntries.length;
  const totalPages = Math.max(1, Math.ceil(totalFilteredEntries / pageSize));
  const paginatedEntries = useMemo(() => {
    const startIndex = (currentPage - 1) * pageSize;
    return sortedEntries.slice(startIndex, startIndex + pageSize);
  }, [currentPage, pageSize, sortedEntries]);
  const inventoryFileGroups = useMemo<InventoryFileGroup[]>(() => {
    const grouped = new Map<string, TableEntry[]>();

    for (const entry of paginatedEntries) {
      const key = entry.primaryFile ?? t('globalLineageList.noFilesGroup');
      if (!grouped.has(key)) {
        grouped.set(key, []);
      }
      grouped.get(key)!.push(entry);
    }

    return Array.from(grouped.entries())
      .map(([file, entries]) => ({
        file,
        entries,
        maxImpactScore: Math.max(...entries.map((entry) => entry.impactScore)),
        totalRelations: entries.reduce((sum, entry) => sum + entry.relationCount, 0),
        sourceCount: entries.filter((entry) => entry.status === 'source').length,
        bridgeCount: entries.filter((entry) => entry.status === 'bridge').length,
        sinkCount: entries.filter((entry) => entry.status === 'sink').length,
        isolatedCount: entries.filter((entry) => entry.status === 'isolated').length,
      }))
      .sort((a, b) => {
        return (
          b.entries.length - a.entries.length ||
          b.maxImpactScore - a.maxImpactScore ||
          a.file.localeCompare(b.file)
        );
      });
  }, [paginatedEntries, t]);
  const quickViewCounts = useMemo(
    () => ({
      all: graphData.entries.length,
      hotspots: Math.min(graphData.entries.length, Math.max(8, Math.ceil(graphData.entries.length * 0.2))),
      bridge: graphData.stats.bridgeTables,
      source: graphData.stats.sourceTables,
      sink: graphData.stats.sinkTables,
      isolated: graphData.stats.isolatedTables,
    }),
    [graphData.entries.length, graphData.stats]
  );

  useEffect(() => {
    setCurrentPage(1);
  }, [searchTerm, activeStatuses, sortKey, quickView, selectedFileGroup, pageSize]);

  useEffect(() => {
    setCurrentPage((previous) => Math.min(previous, totalPages));
  }, [totalPages]);

  useEffect(() => {
    if (inventoryMode !== 'grouped') {
      return;
    }

    const validKeys = new Set(inventoryFileGroups.map((group) => group.file));
    setExpandedInventoryGroups((previous) => {
      const next = new Set(Array.from(previous).filter((key) => validKeys.has(key)));
      if (next.size === 0) {
        inventoryFileGroups.slice(0, 3).forEach((group) => next.add(group.file));
      }
      return next;
    });
  }, [inventoryFileGroups, inventoryMode]);

  const toggleStatus = useCallback((status: GlobalLineageStatus) => {
    setActiveStatuses((previous) => {
      const next = new Set(previous);
      if (next.has(status)) {
        next.delete(status);
      } else {
        next.add(status);
      }
      return next;
    });
  }, []);

  const handleOpenFile = useCallback(
    (sourceName: string, targetName?: string) => {
      requestNavigation({
        sourceName,
        targetName,
        targetType: 'table',
      });
    },
    [requestNavigation]
  );

  const handleOpenGraph = useCallback(() => {
    if (!selectedEntry) return;
    selectNode(selectedEntry.nodeId);
    onOpenGraphForNode?.(selectedEntry.nodeId);
  }, [onOpenGraphForNode, selectNode, selectedEntry]);

  const openEntry = useCallback((nodeId: string, context?: SelectionContext) => {
    setSelectedNodeId(nodeId);
    if (context) {
      setSelectionContext(context);
    }
  }, []);

  const handleResetFilters = useCallback(() => {
    setSearchTerm('');
    setActiveStatuses(new Set());
    setSortKey('impact');
    setQuickView('all');
    setSelectedFileGroup(null);
    setInventoryMode('table');
    setSelectionContext(null);
  }, []);

  const toggleInventoryGroup = useCallback((file: string) => {
    setExpandedInventoryGroups((previous) => {
      const next = new Set(previous);
      if (next.has(file)) {
        next.delete(file);
      } else {
        next.add(file);
      }
      return next;
    });
  }, []);

  const handleExpandAllInventoryGroups = useCallback(() => {
    setExpandedInventoryGroups(new Set(inventoryFileGroups.map((group) => group.file)));
  }, [inventoryFileGroups]);

  const handleCollapseAllInventoryGroups = useCallback(() => {
    setExpandedInventoryGroups(new Set());
  }, []);

  const handlePreviousPage = useCallback(() => {
    setCurrentPage((previous) => Math.max(1, previous - 1));
  }, []);

  const handleNextPage = useCallback(() => {
    setCurrentPage((previous) => Math.min(totalPages, previous + 1));
  }, [totalPages]);

  const handleReturnToSource = useCallback(() => {
    if (!selectionContext) return;
    if (selectionContext.file) {
      setInventoryMode('grouped');
      setSelectedFileGroup(selectionContext.file);
      setExpandedInventoryGroups((previous) => new Set([...Array.from(previous), selectionContext.file!]));
    }
    setSelectedNodeId(null);
  }, [selectionContext]);

  const handleSelectRelatedTable = useCallback(
    (nodeId: string) => {
      openEntry(nodeId, selectedEntry ? { kind: 'relation', label: selectedEntry.qualifiedName } : undefined);
    },
    [openEntry, selectedEntry]
  );

  if (!result) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <div className="flex flex-col items-center gap-3 text-center">
          <Network className="h-10 w-10 opacity-30" />
          <p className="text-sm">{t('globalLineageList.empty')}</p>
        </div>
      </div>
    );
  }

  const hasVisibleInventory = !inventoryCollapsed;
  const hasVisibleInsights = !insightsCollapsed;
  const lowerGridClassName =
    hasVisibleInventory && hasVisibleInsights
      ? 'xl:grid-cols-[minmax(0,3.7fr)_minmax(240px,0.95fr)]'
      : 'grid-cols-1';

  return (
    <div className="flex min-h-[125vh] flex-col overflow-y-auto bg-background">
      <div
        className={cn(
          'border-b border-border bg-muted/10 px-4 transition-all',
          analyticsCollapsed ? 'py-2' : 'flex min-h-[24vh] items-end py-4 xl:py-5'
        )}
      >
        <div className="flex w-full flex-col gap-3">
          <div className="flex flex-col gap-2 lg:flex-row lg:items-end lg:justify-between">
            <div className="space-y-1">
              <div className="text-sm font-semibold text-foreground">
                {t('globalLineageList.analyticsTitle')}
              </div>
              {!analyticsCollapsed ? (
                <p className="max-w-4xl text-xs text-muted-foreground">
                  {t('globalLineageList.analyticsDescription')}
                </p>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span className="rounded-full border border-border bg-background px-3 py-1.5">
                {t('globalLineageList.visibleResults', {
                  visible: sortedEntries.length,
                  total: graphData.stats.totalTables,
                })}
              </span>
              {activeFilterCount > 0 ? (
                <span className="rounded-full border border-primary/20 bg-primary/5 px-3 py-1.5 text-primary">
                  {t('globalLineageList.activeFilters', { count: activeFilterCount })}
                </span>
              ) : null}
              <Button
                variant="outline"
                size="sm"
                onClick={() => setAnalyticsCollapsed((value) => !value)}
                className="h-7 gap-1 text-xs"
              >
                {analyticsCollapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                {analyticsCollapsed
                  ? t('globalLineageList.expandPanel')
                  : t('globalLineageList.collapsePanel')}
              </Button>
            </div>
          </div>
          {!analyticsCollapsed ? (
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
              <OverviewCard
                label={t('globalLineageList.totalTables')}
                value={graphData.stats.totalTables}
                hint={
                  topImpactEntry
                    ? t('globalLineageList.topImpactHint', {
                        name: topImpactEntry.qualifiedName,
                        score: topImpactEntry.impactScore,
                      })
                    : t('globalLineageList.totalFlowsHint', { count: graphData.stats.totalEdges })
                }
                icon={<Layers3 className="h-4 w-4" />}
              />
              <OverviewCard
                label={t('globalLineageList.bridgeTables')}
                value={graphData.stats.bridgeTables}
                hint={t('globalLineageList.bridgeTablesHint')}
                icon={<Sparkles className="h-4 w-4" />}
              />
              <OverviewCard
                label={t('globalLineageList.sourceTables')}
                value={graphData.stats.sourceTables}
                hint={t('globalLineageList.sourceTablesHint')}
                icon={<ArrowUpToLine className="h-4 w-4" />}
              />
              <OverviewCard
                label={t('globalLineageList.targetTables')}
                value={graphData.stats.sinkTables}
                hint={t('globalLineageList.targetTablesHint')}
                icon={<ArrowDownToLine className="h-4 w-4" />}
              />
            </div>
          ) : null}
        </div>
      </div>

      <div className="min-h-screen px-4 py-4">
        {(inventoryCollapsed || insightsCollapsed) && (
          <div className="mb-3 flex flex-wrap items-center gap-2">
            {inventoryCollapsed ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setInventoryCollapsed(false)}
                className="h-8 gap-1.5 text-xs"
              >
                <ChevronRight className="h-3.5 w-3.5" />
                {t('globalLineageList.restorePanel', {
                  name: t('globalLineageList.inventoryTitle'),
                })}
              </Button>
            ) : null}
            {insightsCollapsed ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setInsightsCollapsed(false)}
                className="h-8 gap-1.5 text-xs"
              >
                <ChevronRight className="h-3.5 w-3.5" />
                {t('globalLineageList.restorePanel', {
                  name: t('globalLineageList.insightsTitle'),
                })}
              </Button>
            ) : null}
          </div>
        )}
        <div className={cn('grid items-start gap-3', lowerGridClassName)}>
          {!inventoryCollapsed ? (
          <section className="flex min-h-screen min-h-0 flex-col rounded-2xl border border-border bg-background">
            <div className="border-b border-border px-3 py-3">
              <div className="flex flex-col gap-2">
                <div className="flex flex-col gap-2 lg:flex-row lg:items-end lg:justify-between">
                  <div className="space-y-1">
                    <div className="text-base font-semibold text-foreground">
                      {t('globalLineageList.inventoryTitle')}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {t('globalLineageList.inventoryDescription')}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span className="rounded-full border border-border bg-muted/20 px-3 py-1.5">
                      {t('globalLineageList.visibleResults', {
                        visible: totalFilteredEntries,
                        total: graphData.stats.totalTables,
                      })}
                    </span>
                    <span className="rounded-full border border-border bg-muted/20 px-3 py-1.5">
                      {t('globalLineageList.totalFlowsHint', { count: graphData.stats.totalEdges })}
                    </span>
                    <span className="rounded-full border border-border bg-muted/20 px-3 py-1.5">
                      {t('globalLineageList.pageSummary', {
                        page: currentPage,
                        totalPages,
                        count: paginatedEntries.length,
                      })}
                    </span>
                    {selectedFileGroup ? (
                      <span className="rounded-full border border-sky-200 bg-sky-50 px-3 py-1.5 text-sky-700 dark:border-sky-900/60 dark:bg-sky-950/40 dark:text-sky-300">
                        {t('globalLineageList.fileScopeActive', { file: selectedFileGroup })}
                      </span>
                    ) : null}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setInventoryCollapsed(true)}
                      className="h-7 gap-1 text-xs"
                    >
                      <ChevronDown className="h-3.5 w-3.5" />
                      {t('globalLineageList.collapsePanel')}
                    </Button>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <div className="relative min-w-[260px] flex-1">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <input
                      value={searchTerm}
                      onChange={(event) => setSearchTerm(event.target.value)}
                      placeholder={t('globalLineageList.searchPlaceholder')}
                      className="h-9 w-full rounded-full border border-border bg-background pl-10 pr-4 text-sm outline-hidden transition-colors focus:border-primary/40"
                    />
                  </div>
                  <div className="flex items-center gap-2 rounded-full border border-border bg-background px-3 py-1.5">
                    <ArrowUpDown className="h-4 w-4 text-muted-foreground" />
                    <span className="text-xs text-muted-foreground">{t('globalLineageList.sortBy')}</span>
                    <select
                      value={sortKey}
                      onChange={(event) => setSortKey(event.target.value as GlobalLineageSortKey)}
                      className="bg-transparent text-sm text-foreground outline-hidden"
                    >
                      <option value="impact">{t('globalLineageList.sortImpact')}</option>
                      <option value="upstream">{t('globalLineageList.sortUpstream')}</option>
                      <option value="downstream">{t('globalLineageList.sortDownstream')}</option>
                      <option value="files">{t('globalLineageList.sortFiles')}</option>
                      <option value="name">{t('globalLineageList.sortName')}</option>
                    </select>
                  </div>
                  {activeFilterCount > 0 ? (
                    <Button variant="outline" size="sm" onClick={handleResetFilters}>
                      {t('globalLineageList.resetFilters')}
                    </Button>
                  ) : null}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    {t('globalLineageList.inventoryMode')}
                  </span>
                  <button
                    type="button"
                    onClick={() => setInventoryMode('table')}
                    className={cn(
                      'inline-flex items-center rounded-full border px-3 py-1.5 text-xs transition-colors',
                      inventoryMode === 'table'
                        ? 'border-primary/30 bg-primary/10 text-primary'
                        : 'border-border bg-background text-muted-foreground hover:text-foreground'
                    )}
                  >
                    {t('globalLineageList.inventoryModeTable')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setInventoryMode('grouped')}
                    className={cn(
                      'inline-flex items-center rounded-full border px-3 py-1.5 text-xs transition-colors',
                      inventoryMode === 'grouped'
                        ? 'border-primary/30 bg-primary/10 text-primary'
                        : 'border-border bg-background text-muted-foreground hover:text-foreground'
                    )}
                  >
                    {t('globalLineageList.inventoryModeGrouped')}
                  </button>
                  {inventoryMode === 'grouped' ? (
                    <>
                      <Button variant="outline" size="sm" onClick={handleExpandAllInventoryGroups}>
                        {t('globalLineageList.expandAllGroups')}
                      </Button>
                      <Button variant="outline" size="sm" onClick={handleCollapseAllInventoryGroups}>
                        {t('globalLineageList.collapseAllGroups')}
                      </Button>
                    </>
                  ) : null}
                </div>

                {selectedFileGroup ? (
                  <div className="rounded-xl border border-sky-200 bg-sky-50/70 px-3 py-2.5 text-sm dark:border-sky-900/60 dark:bg-sky-950/30">
                    <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
                      <div className="min-w-0">
                        <div className="truncate font-medium text-foreground">
                          {selectedFileGroup}
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          {t('globalLineageList.fileScopeSummary', {
                            count: selectedFileEntries.length,
                          })}
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleOpenFile(selectedFileGroup)}
                        >
                          {t('globalLineageList.openFile')}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setSelectedFileGroup(null)}
                        >
                          {t('globalLineageList.clearFileScope')}
                        </Button>
                      </div>
                    </div>
                  </div>
                ) : null}

                <div className="flex flex-wrap items-center gap-2">
                  {(
                    [
                      'all',
                      'hotspots',
                      'bridge',
                      'source',
                      'sink',
                      'isolated',
                    ] as GlobalLineageQuickView[]
                  ).map((view) => {
                    const isActive = quickView === view;
                    return (
                      <button
                        key={view}
                        type="button"
                        onClick={() => setQuickView(view)}
                        className={cn(
                          'inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition-colors',
                          isActive
                            ? 'border-primary/30 bg-primary/10 text-primary'
                            : 'border-border bg-background text-muted-foreground hover:text-foreground'
                        )}
                      >
                        <span>{t(`globalLineageList.quickView${view.charAt(0).toUpperCase()}${view.slice(1)}`)}</span>
                        <span className="rounded-full bg-background/80 px-1.5 py-0.5 text-[10px]">
                          {quickViewCounts[view]}
                        </span>
                      </button>
                    );
                  })}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {(Object.keys(STATUS_META) as GlobalLineageStatus[]).map((status) => {
                    const meta = STATUS_META[status];
                    const isActive = activeStatuses.has(status);
                    return (
                      <button
                        key={status}
                        type="button"
                        onClick={() => toggleStatus(status)}
                        className={cn(
                          'inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition-colors',
                          isActive
                            ? meta.badgeClassName
                            : 'border-border bg-background text-muted-foreground hover:text-foreground'
                        )}
                      >
                        <span className={cn('inline-block h-2.5 w-2.5 rounded-full', meta.dotClassName)} />
                        <span>{t(meta.labelKey)}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-hidden">
              {totalFilteredEntries === 0 ? (
                <div className="flex h-full min-h-[280px] flex-col items-center justify-center gap-3 px-4 text-center text-muted-foreground">
                  <Table2 className="h-10 w-10 opacity-30" />
                  <p className="text-sm">{t('globalLineageList.noMatches')}</p>
                </div>
              ) : inventoryMode === 'grouped' ? (
                <div className="max-h-[calc(100vh-320px)] overflow-auto space-y-3 p-3">
                  {inventoryFileGroups.map((group) => {
                    const isExpanded = expandedInventoryGroups.has(group.file);
                    return (
                      <section
                        key={group.file}
                        className="overflow-hidden rounded-2xl border border-border bg-background"
                      >
                        <div className="flex items-start justify-between gap-3 border-b border-border bg-muted/20 px-4 py-3">
                          <button
                            type="button"
                            onClick={() => toggleInventoryGroup(group.file)}
                            className="flex min-w-0 flex-1 items-start gap-2 text-left"
                          >
                            {isExpanded ? (
                              <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                            ) : (
                              <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                            )}
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-sm font-semibold text-foreground">
                                {group.file}
                              </div>
                              <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                                <span>
                                  {t('globalLineageList.tablesInFile', {
                                    count: group.entries.length,
                                  })}
                                </span>
                                <span>
                                  {t('globalLineageList.impactScore')}: {group.maxImpactScore}
                                </span>
                                <span>
                                  {t('globalLineageList.totalRelations')}: {group.totalRelations}
                                </span>
                              </div>
                              <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
                                <span className="rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 text-sky-700 dark:border-sky-900/60 dark:bg-sky-950/40 dark:text-sky-300">
                                  {t('globalLineageList.quickViewBridge')}: {group.bridgeCount}
                                </span>
                                <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300">
                                  {t('globalLineageList.quickViewSource')}: {group.sourceCount}
                                </span>
                                <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300">
                                  {t('globalLineageList.quickViewSink')}: {group.sinkCount}
                                </span>
                                {group.isolatedCount > 0 ? (
                                  <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-slate-700 dark:border-slate-800 dark:bg-slate-900/60 dark:text-slate-300">
                                    {t('globalLineageList.quickViewIsolated')}: {group.isolatedCount}
                                  </span>
                                ) : null}
                              </div>
                            </div>
                          </button>
                          <div className="flex shrink-0 items-center gap-2">
                            {group.file !== t('globalLineageList.noFilesGroup') ? (
                              <>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => setSelectedFileGroup(group.file)}
                                >
                                  {t('globalLineageList.scopeToFile')}
                                </Button>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => handleOpenFile(group.file)}
                                >
                                  {t('globalLineageList.openFile')}
                                </Button>
                              </>
                            ) : null}
                          </div>
                        </div>
                        {isExpanded ? (
                          <div className="overflow-auto">
                            <table className="min-w-full border-collapse text-sm">
                              <thead className="bg-muted/30 text-xs uppercase tracking-wide text-muted-foreground">
                                <tr>
                                  <th className="px-4 py-2.5 text-left font-medium">
                                    {t('globalLineageList.tableColumn')}
                                  </th>
                                  <th className="px-4 py-2.5 text-left font-medium">
                                    {t('globalLineageList.statusColumn')}
                                  </th>
                                  <th className="px-4 py-2.5 text-right font-medium">
                                    {t('globalLineageList.impactColumn')}
                                  </th>
                                  <th className="px-4 py-2.5 text-left font-medium">
                                    {t('globalLineageList.relationsColumn')}
                                  </th>
                                </tr>
                              </thead>
                              <tbody>
                                {group.entries.map((entry) => (
                                  <tr
                                    key={`${group.file}-${entry.nodeId}`}
                                    className="cursor-pointer border-t border-border transition-colors hover:bg-muted/30"
                                    onClick={() =>
                                      openEntry(entry.nodeId, {
                                        kind: 'inventory-group',
                                        label: group.file,
                                        file: group.file !== t('globalLineageList.noFilesGroup') ? group.file : undefined,
                                      })
                                    }
                                  >
                                    <td className="px-4 py-3">
                                      <div className="min-w-0">
                                        <div className="flex items-center gap-2">
                                          <span
                                            className={cn(
                                              'inline-block h-2.5 w-2.5 shrink-0 rounded-full',
                                              STATUS_META[entry.status].dotClassName
                                            )}
                                          />
                                          <span className="truncate font-medium text-foreground">
                                            {entry.qualifiedName}
                                          </span>
                                        </div>
                                        {entry.comment ? (
                                          <p className="mt-1 line-clamp-1 text-xs text-muted-foreground">
                                            {entry.comment}
                                          </p>
                                        ) : null}
                                      </div>
                                    </td>
                                    <td className="px-4 py-3">
                                      <span
                                        className={cn(
                                          'inline-flex rounded-full border px-2 py-0.5 text-xs',
                                          STATUS_META[entry.status].badgeClassName
                                        )}
                                      >
                                        {t(STATUS_META[entry.status].labelKey)}
                                      </span>
                                    </td>
                                    <td className="px-4 py-3 text-right">
                                      <div className="font-mono text-base font-semibold text-foreground">
                                        {entry.impactScore}
                                      </div>
                                      <div className="text-[11px] text-muted-foreground">
                                        {t('globalLineageList.totalRelations')}: {entry.relationCount}
                                      </div>
                                    </td>
                                    <td className="px-4 py-3">
                                      <div className="min-w-[180px] max-w-[240px]">
                                        <MiniLineageBar
                                          upstreamCount={entry.upstream.length}
                                          downstreamCount={entry.downstream.length}
                                        />
                                      </div>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        ) : null}
                      </section>
                    );
                  })}
                </div>
              ) : (
                <div className="max-h-[calc(100vh-320px)] overflow-auto">
                  <table className="min-w-full border-collapse text-sm">
                    <thead className="sticky top-0 z-10 bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                      <tr>
                        <th className="px-4 py-3 text-left font-medium">
                          {t('globalLineageList.tableColumn')}
                        </th>
                        <th className="px-4 py-3 text-left font-medium">
                          {t('globalLineageList.statusColumn')}
                        </th>
                        <th className="px-4 py-3 text-right font-medium">
                          {t('globalLineageList.impactColumn')}
                        </th>
                        <th className="px-4 py-3 text-left font-medium">
                          {t('globalLineageList.relationsColumn')}
                        </th>
                        <th className="px-4 py-3 text-left font-medium">
                          {t('globalLineageList.primaryFileColumn')}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {paginatedEntries.map((entry, index) => {
                        const absoluteIndex = (currentPage - 1) * pageSize + index;
                        return (
                          <tr
                            key={entry.nodeId}
                            className="cursor-pointer border-t border-border transition-colors hover:bg-muted/30"
                            onClick={() =>
                              openEntry(entry.nodeId, {
                                kind: 'inventory',
                                label: t('globalLineageList.inventoryTitle'),
                                file: entry.primaryFile,
                              })
                            }
                          >
                            <td className="px-4 py-3">
                              <div className="min-w-0">
                                <div className="flex items-center gap-2">
                                  <span
                                    className={cn(
                                      'inline-block h-2.5 w-2.5 shrink-0 rounded-full',
                                      STATUS_META[entry.status].dotClassName
                                    )}
                                  />
                                  <span className="truncate font-medium text-foreground">
                                    {entry.qualifiedName}
                                  </span>
                                  {absoluteIndex < 3 ? (
                                    <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
                                      Top {absoluteIndex + 1}
                                    </span>
                                  ) : null}
                                </div>
                                {entry.comment && (
                                  <p className="mt-1 line-clamp-1 text-xs text-muted-foreground">
                                    {entry.comment}
                                  </p>
                                )}
                              </div>
                            </td>
                            <td className="px-4 py-3">
                              <span
                                className={cn(
                                  'inline-flex rounded-full border px-2 py-0.5 text-xs',
                                  STATUS_META[entry.status].badgeClassName
                                )}
                              >
                                {t(STATUS_META[entry.status].labelKey)}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-right">
                              <div className="font-mono text-base font-semibold text-foreground">
                                {entry.impactScore}
                              </div>
                              <div className="text-[11px] text-muted-foreground">
                                {t('globalLineageList.totalRelations')}: {entry.relationCount}
                              </div>
                            </td>
                            <td className="px-4 py-3">
                              <div className="min-w-[180px] max-w-[240px]">
                                <MiniLineageBar
                                  upstreamCount={entry.upstream.length}
                                  downstreamCount={entry.downstream.length}
                                />
                              </div>
                            </td>
                            <td className="px-4 py-3">
                              {entry.primaryFile ? (
                                <div className="max-w-[320px]">
                                  <div className="truncate text-sm text-foreground">{entry.primaryFile}</div>
                                  <div className="mt-1 text-[11px] text-muted-foreground">
                                    {t('globalLineageList.fileCountHint', {
                                      count: entry.relatedFiles.length,
                                    })}
                                  </div>
                                </div>
                              ) : (
                                <span className="text-xs text-muted-foreground">
                                  {t('globalLineageList.noFiles')}
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {totalFilteredEntries > 0 ? (
              <div className="border-t border-border px-3 py-2.5">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span>
                      {t('globalLineageList.paginationRange', {
                        start: (currentPage - 1) * pageSize + 1,
                        end: Math.min(currentPage * pageSize, totalFilteredEntries),
                        total: totalFilteredEntries,
                      })}
                    </span>
                    <span className="hidden h-1 w-1 rounded-full bg-muted-foreground/50 lg:inline-block" />
                    <span>{t('globalLineageList.paginationPages', { page: currentPage, total: totalPages })}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="flex items-center gap-2 rounded-full border border-border bg-background px-3 py-2">
                      <span className="text-xs text-muted-foreground">
                        {t('globalLineageList.pageSize')}
                      </span>
                      <select
                        value={pageSize}
                        onChange={(event) =>
                          setPageSize(Number(event.target.value) as (typeof PAGE_SIZE_OPTIONS)[number])
                        }
                        className="bg-transparent text-sm text-foreground outline-hidden"
                      >
                        {PAGE_SIZE_OPTIONS.map((size) => (
                          <option key={size} value={size}>
                            {t('globalLineageList.pageSizeOption', { count: size })}
                          </option>
                        ))}
                      </select>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handlePreviousPage}
                      disabled={currentPage === 1}
                    >
                      {t('globalLineageList.previousPage')}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleNextPage}
                      disabled={currentPage === totalPages}
                    >
                      {t('globalLineageList.nextPage')}
                    </Button>
                  </div>
                </div>
              </div>
            ) : null}
          </section>
          ) : null}

          {!insightsCollapsed ? (
          <aside className="rounded-2xl border border-border bg-background p-3 shadow-sm xl:sticky xl:top-3">
            <div className="space-y-3">
              <div className="flex items-start justify-between gap-2">
                <div className="space-y-1">
                  <div className="text-base font-semibold text-foreground">
                    {t('globalLineageList.insightsTitle')}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t('globalLineageList.insightsDescription')}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setInsightsCollapsed(true)}
                  className="h-7 gap-1 text-xs"
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                  {t('globalLineageList.collapsePanel')}
                </Button>
              </div>

              <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-1">
                <div className="rounded-xl border border-border bg-muted/20 px-3 py-2.5">
                  <div className="text-[11px] uppercase tracking-[0.03em] text-muted-foreground">
                    {t('globalLineageList.fanInLeader')}
                  </div>
                  <div className="mt-1 truncate text-sm font-medium text-foreground">
                    {topUpstreamEntry?.qualifiedName ?? '-'}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {topUpstreamEntry
                      ? t('globalLineageList.upstreamCountHint', {
                          count: topUpstreamEntry.upstream.length,
                        })
                      : '-'}
                  </div>
                </div>
                <div className="rounded-xl border border-border bg-muted/20 px-3 py-2.5">
                  <div className="text-[11px] uppercase tracking-[0.03em] text-muted-foreground">
                    {t('globalLineageList.fanOutLeader')}
                  </div>
                  <div className="mt-1 truncate text-sm font-medium text-foreground">
                    {topDownstreamEntry?.qualifiedName ?? '-'}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {topDownstreamEntry
                      ? t('globalLineageList.downstreamCountHint', {
                          count: topDownstreamEntry.downstream.length,
                        })
                      : '-'}
                  </div>
                </div>
              </div>

              <div className="rounded-2xl border border-border bg-background px-3 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <Flame className="h-4 w-4 text-amber-500" />
                    <span>{t('globalLineageList.hotspotsTitle')}</span>
                  </div>
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                    Top {hotspotEntries.length}
                  </span>
                </div>

                <div className="mt-3 space-y-2">
                  {hotspotEntries.map((entry, index) => (
                    <button
                      key={`hotspot-${entry.nodeId}`}
                      type="button"
                      onClick={() =>
                        openEntry(entry.nodeId, {
                          kind: 'hotspot',
                          label: t('globalLineageList.hotspotsTitle'),
                          file: entry.primaryFile,
                        })
                      }
                      className="flex w-full items-start gap-3 rounded-xl border border-border bg-muted/20 px-3 py-2.5 text-left transition-colors hover:border-primary/20 hover:bg-primary/5"
                    >
                      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-background text-xs font-semibold text-foreground">
                        {index + 1}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-foreground">
                          {entry.qualifiedName}
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                          <span>{t('globalLineageList.impactScore')}: {entry.impactScore}</span>
                          <span>{t('globalLineageList.totalRelations')}: {entry.relationCount}</span>
                        </div>
                        <div className="mt-2">
                          <MiniLineageBar
                            upstreamCount={entry.upstream.length}
                            downstreamCount={entry.downstream.length}
                          />
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              <div className="rounded-2xl border border-border bg-background px-3 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <FolderTree className="h-4 w-4 text-sky-500" />
                    <span>{t('globalLineageList.fileGroupsTitle')}</span>
                  </div>
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                    Top {Math.min(fileGroups.length, 6)}
                  </span>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  {t('globalLineageList.fileGroupsDescription')}
                </p>

                <div className="mt-3 space-y-2">
                  {fileGroups.slice(0, 6).map((group) => (
                    <div
                      key={group.file}
                      className="rounded-xl border border-border bg-muted/20 px-3 py-3"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <button
                          type="button"
                          onClick={() =>
                            setSelectedFileGroup((current) =>
                              current === group.file ? null : group.file
                            )
                          }
                          className="flex min-w-0 flex-1 items-start gap-2 text-left"
                        >
                          {selectedFileGroup === group.file ? (
                            <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                          ) : (
                            <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                          )}
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-medium text-foreground">
                              {group.file}
                            </div>
                            <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                              <span>
                                {t('globalLineageList.tablesInFile', { count: group.tableCount })}
                              </span>
                              <span>
                                {t('globalLineageList.impactScore')}: {group.maxImpactScore}
                              </span>
                            </div>
                            <div className="mt-1 text-[11px] text-muted-foreground">
                              {t('globalLineageList.topTableInFile', {
                                name: group.topTableName,
                              })}
                            </div>
                          </div>
                        </button>
                        <div className="flex shrink-0 items-center gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setSearchTerm(group.file)}
                          >
                            {t('globalLineageList.filterTables')}
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleOpenFile(group.file)}
                          >
                            {t('globalLineageList.openFile')}
                          </Button>
                        </div>
                      </div>
                      {selectedFileGroup === group.file ? (
                        <div className="mt-3 space-y-2 border-t border-border pt-3">
                          {selectedFileEntries.slice(0, 8).map((entry) => (
                            <button
                              key={`${group.file}-${entry.nodeId}`}
                              type="button"
                              onClick={() =>
                                openEntry(entry.nodeId, {
                                  kind: 'file-lens',
                                  label: group.file,
                                  file: group.file,
                                })
                              }
                              className="flex w-full items-start gap-2 rounded-lg border border-border bg-background px-3 py-2 text-left transition-colors hover:border-primary/20 hover:bg-primary/5"
                            >
                              <span
                                className={cn(
                                  'mt-1 inline-block h-2.5 w-2.5 shrink-0 rounded-full',
                                  STATUS_META[entry.status].dotClassName
                                )}
                              />
                              <div className="min-w-0 flex-1">
                                <div className="truncate text-sm font-medium text-foreground">
                                  {entry.qualifiedName}
                                </div>
                                <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                                  <span>
                                    {t('globalLineageList.impactScore')}: {entry.impactScore}
                                  </span>
                                  <span>
                                    {t('globalLineageList.totalRelations')}: {entry.relationCount}
                                  </span>
                                </div>
                              </div>
                            </button>
                          ))}
                          {selectedFileEntries.length > 8 ? (
                            <div className="text-xs text-muted-foreground">
                              {t('globalLineageList.moreTablesInFile', {
                                count: selectedFileEntries.length - 8,
                              })}
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </aside>
          ) : null}
        </div>
      </div>

      <Sheet open={selectedEntry !== null} onOpenChange={(open) => !open && setSelectedNodeId(null)}>
        <SheetContent
          side="right"
          className="gap-0 overflow-y-auto p-0 sm:max-w-none"
          style={{
            width: '72vw',
            minWidth: '60vw',
            maxWidth: '1480px',
          }}
        >
          {selectedEntry && (
            <div className="flex h-full flex-col">
              <SheetHeader className="border-b border-border bg-background px-6 py-4">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0 flex-1">
                    {selectionContext ? (
                      <div className="mb-2 flex flex-wrap items-center gap-2">
                        <span className="rounded-full border border-border bg-muted/20 px-3 py-1 text-xs text-muted-foreground">
                          {t('globalLineageList.sourceContext')}: {selectionContext.label}
                        </span>
                        {selectionContext.file ? (
                          <span className="rounded-full border border-sky-200 bg-sky-50 px-3 py-1 text-xs text-sky-700 dark:border-sky-900/60 dark:bg-sky-950/40 dark:text-sky-300">
                            {selectionContext.file}
                          </span>
                        ) : null}
                      </div>
                    ) : null}
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          'inline-block h-2.5 w-2.5 rounded-full',
                          STATUS_META[selectedEntry.status].dotClassName
                        )}
                      />
                      <SheetTitle className="break-all text-xl leading-snug">
                        {selectedEntry.qualifiedName}
                      </SheetTitle>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      <span>
                        {t('globalLineageList.upstreamColumn')}:&nbsp;
                        <span className="font-medium text-foreground">{selectedEntry.upstream.length}</span>
                      </span>
                      <span>
                        {t('globalLineageList.downstreamColumn')}:&nbsp;
                        <span className="font-medium text-foreground">
                          {selectedEntry.downstream.length}
                        </span>
                      </span>
                      <span>
                        {t('globalLineageList.filesColumn')}:&nbsp;
                        <span className="font-medium text-foreground">
                          {selectedEntry.relatedFiles.length}
                        </span>
                      </span>
                      <span>
                        {t('globalLineageList.statusColumn')}:&nbsp;
                        <span className="font-medium text-foreground">
                          {t(STATUS_META[selectedEntry.status].labelKey)}
                        </span>
                      </span>
                    <span>
                      {t('globalLineageList.impactScore')}:&nbsp;
                      <span className="font-medium text-foreground">{selectedEntry.impactScore}</span>
                    </span>
                    </div>
                    <SheetDescription className="mt-2 max-w-4xl text-left text-sm leading-6">
                      {selectedEntry.comment || t('globalLineageList.noComment')}
                    </SheetDescription>
                  </div>
                  <div className="flex shrink-0 items-center gap-2 self-start">
                    {selectionContext ? (
                      <Button variant="outline" size="sm" onClick={handleReturnToSource}>
                        {t('globalLineageList.backToSource')}
                      </Button>
                    ) : null}
                    <Button variant="outline" size="sm" onClick={handleOpenGraph}>
                      <GitBranch className="h-4 w-4" />
                      {t('globalLineageList.openInGraph')}
                    </Button>
                  </div>
                </div>
              </SheetHeader>

              <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
                <div className="mb-5 grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
                  <section className="rounded-2xl border border-border bg-background px-4 py-4">
                    <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                      <Sparkles className="h-4 w-4 text-primary" />
                      <span>{t('globalLineageList.relationOverview')}</span>
                    </div>
                    <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                      <DrawerStatCard
                        label={t('globalLineageList.upstreamColumn')}
                        value={selectedEntry.upstream.length}
                      />
                      <DrawerStatCard
                        label={t('globalLineageList.downstreamColumn')}
                        value={selectedEntry.downstream.length}
                      />
                      <DrawerStatCard
                        label={t('globalLineageList.filesColumn')}
                        value={selectedEntry.relatedFiles.length}
                      />
                      <DrawerStatCard
                        label={t('globalLineageList.impactScore')}
                        value={selectedEntry.impactScore}
                      />
                    </div>
                    <div className="mt-4 rounded-xl border border-border bg-muted/20 px-4 py-4">
                      <div className="mb-2 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                        <span>{t('globalLineageList.relationsColumn')}</span>
                        <span>
                          {t('globalLineageList.totalRelations')}: {selectedEntry.relationCount}
                        </span>
                      </div>
                      <MiniLineageBar
                        upstreamCount={selectedEntry.upstream.length}
                        downstreamCount={selectedEntry.downstream.length}
                      />
                    </div>
                  </section>

                  <div className="space-y-4">
                    <QuickJumpSection
                      title={t('globalLineageList.quickJumpUpstream')}
                      items={selectedEntry.upstream.slice(0, 8)}
                      emptyLabel={t('globalLineageList.noUpstream')}
                      onSelectTable={handleSelectRelatedTable}
                    />
                    <QuickJumpSection
                      title={t('globalLineageList.quickJumpDownstream')}
                      items={selectedEntry.downstream.slice(0, 8)}
                      emptyLabel={t('globalLineageList.noDownstream')}
                      onSelectTable={handleSelectRelatedTable}
                    />
                  </div>
                </div>

                <div className="mb-5 flex flex-wrap gap-3">
                  <DrawerStatCard
                    label={t('globalLineageList.upstreamColumn')}
                    value={selectedEntry.upstream.length}
                  />
                  <DrawerStatCard
                    label={t('globalLineageList.downstreamColumn')}
                    value={selectedEntry.downstream.length}
                  />
                  <DrawerStatCard
                    label={t('globalLineageList.filesColumn')}
                    value={selectedEntry.relatedFiles.length}
                  />
                  <DrawerStatCard
                    label={t('globalLineageList.statusColumn')}
                    value={t(STATUS_META[selectedEntry.status].labelKey)}
                  />
                </div>

                <div className="space-y-6">
                  <section className="space-y-3">
                    <div className="flex items-center gap-2 text-[13px] font-semibold text-foreground">
                      <FolderTree className="h-4 w-4" />
                      <span>{t('globalLineageList.relatedFiles')}</span>
                      <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
                        {selectedEntry.relatedFiles.length}
                      </span>
                    </div>
                    {selectedEntry.relatedFiles.length === 0 ? (
                      <div className="rounded-xl border border-dashed border-border bg-muted/20 px-4 py-6 text-center text-sm text-muted-foreground">
                        {t('globalLineageList.noFiles')}
                      </div>
                    ) : (
                      <div className="flex flex-wrap gap-1.5 rounded-xl border border-border bg-background px-4 py-4">
                        {selectedEntry.relatedFiles.map((file) => (
                          <button
                            key={file}
                            type="button"
                            onClick={() => handleOpenFile(file, selectedEntry.label)}
                            className="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-muted/30 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-primary/30 hover:text-foreground"
                          >
                            <FileCode2 className="h-3.5 w-3.5" />
                            <span className="max-w-80 truncate">{file}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </section>

                  <RelationTableSection
                    icon={<ArrowUpToLine className="h-4 w-4" />}
                    title={t('globalLineageList.upstreamTablesSection')}
                    items={selectedEntry.upstream}
                    emptyLabel={t('globalLineageList.noUpstream')}
                    onSelectTable={handleSelectRelatedTable}
                    onOpenFile={handleOpenFile}
                  />

                  <RelationTableSection
                    icon={<ArrowDownToLine className="h-4 w-4" />}
                    title={t('globalLineageList.downstreamTablesSection')}
                    items={selectedEntry.downstream}
                    emptyLabel={t('globalLineageList.noDownstream')}
                    onSelectTable={handleSelectRelatedTable}
                    onOpenFile={handleOpenFile}
                  />
                </div>
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
