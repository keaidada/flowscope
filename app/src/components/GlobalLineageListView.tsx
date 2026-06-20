import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { AnalyzeResult } from '@pondpilot/flowscope-core';
import { useLineageActions } from '@pondpilot/flowscope-react';
import {
  ArrowDownToLine,
  ArrowUpDown,
  ArrowUpToLine,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  FileCode2,
  FolderTree,
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
import {
  useGlobalLineageData,
  sortEntries,
  type GlobalLineageStatus,
  type GlobalLineageSortKey,
  type TableEntry,
  type RelationItem,
} from '@/hooks/useGlobalLineageData';

type GlobalLineageQuickView = 'all' | 'hotspots' | 'bridge' | 'source' | 'sink' | 'isolated';
type GlobalLineageInventoryMode = 'table' | 'grouped';
const PAGE_SIZE_OPTIONS = [50, 100, 200, 500] as const;

interface GlobalLineageListViewProps {
  result: AnalyzeResult | null;
  onOpenGraphForNode?: (nodeId: string) => void;
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
  const [pageAnnouncement, setPageAnnouncement] = useState('');
  const tableScrollRef = useRef<HTMLDivElement | null>(null);
  const [quickView, setQuickView] = useState<GlobalLineageQuickView>('all');
  const [selectedFileGroup, setSelectedFileGroup] = useState<string | null>(null);
  const [inventoryMode, setInventoryMode] = useState<GlobalLineageInventoryMode>('table');
  const [expandedInventoryGroups, setExpandedInventoryGroups] = useState<Set<string>>(() => new Set());
  const [selectionContext, setSelectionContext] = useState<SelectionContext | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState<(typeof PAGE_SIZE_OPTIONS)[number]>(100);

  const graphData = useGlobalLineageData(result);

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
  const activeFilterCount =
    activeStatuses.size +
    (searchTerm.trim() ? 1 : 0) +
    (quickView !== 'all' ? 1 : 0) +
    (selectedFileGroup ? 1 : 0);
  const selectedEntry = selectedNodeId ? graphData.entryMap.get(selectedNodeId) ?? null : null;
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

  const handleFirstPage = useCallback(() => {
    setCurrentPage(1);
  }, []);

  const handleLastPage = useCallback(() => {
    setCurrentPage(totalPages);
  }, [totalPages]);

  const handlePreviousStep = useCallback(
    (step: number) => {
      setCurrentPage((previous) => Math.max(1, previous - step));
    },
    []
  );

  const handleNextStep = useCallback(
    (step: number) => {
      setCurrentPage((previous) => Math.min(totalPages, previous + step));
    },
    [totalPages]
  );

  // 翻页后轻量播报，方便屏幕阅读器与键盘用户感知
  useEffect(() => {
    if (totalFilteredEntries === 0 || totalPages === 0) return;
    const start = (currentPage - 1) * pageSize + 1;
    const end = Math.min(currentPage * pageSize, totalFilteredEntries);
    setPageAnnouncement(
      t('globalLineageList.paginationAnnouncement', {
        page: currentPage,
        totalPages,
        start,
        end,
        total: totalFilteredEntries,
      })
    );
  }, [currentPage, pageSize, totalPages, totalFilteredEntries, t]);

  // 翻页后把表格滚动位置归零，避免上下页内容错位
  useEffect(() => {
    if (tableScrollRef.current) {
      tableScrollRef.current.scrollTop = 0;
    }
  }, [currentPage, pageSize]);

  const handleJumpToPage = useCallback((target: number) => {
    setCurrentPage(Math.min(totalPages, Math.max(1, target)));
  }, [totalPages]);

  const handleJumpToPageInput = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key !== 'Enter') return;
      const raw = (event.target as HTMLInputElement).value.trim();
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) return;
      handleJumpToPage(Math.floor(parsed));
    },
    [handleJumpToPage]
  );

  const handleReturnToSource = useCallback(() => {
    if (!selectionContext) return;
    if (selectionContext.file) {
      setInventoryMode('grouped');
      setSelectedFileGroup(selectionContext.file);
      setExpandedInventoryGroups((previous) => new Set([...Array.from(previous), selectionContext.file!]));
    }
  }, [selectionContext]);

  // 全局键盘翻页：← / → 在表格区域内翻页，Shift + 翻页按 5 页跳
  useEffect(() => {
    if (!result) return undefined;
    const listener = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName?.toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable) {
          return;
        }
      }
      if (event.key === 'ArrowLeft') {
        if (event.metaKey || event.ctrlKey) handlePreviousStep(10);
        else if (event.shiftKey) handlePreviousStep(5);
        else handlePreviousPage();
        event.preventDefault();
      } else if (event.key === 'ArrowRight') {
        if (event.metaKey || event.ctrlKey) handleNextStep(10);
        else if (event.shiftKey) handleNextStep(5);
        else handleNextPage();
        event.preventDefault();
      } else if (event.key === 'Home') {
        handleFirstPage();
        event.preventDefault();
      } else if (event.key === 'End') {
        handleLastPage();
        event.preventDefault();
      } else if (event.key === 'PageUp') {
        handlePreviousPage();
        event.preventDefault();
      } else if (event.key === 'PageDown') {
        handleNextPage();
        event.preventDefault();
      }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [
    result,
    handlePreviousPage,
    handleNextPage,
    handlePreviousStep,
    handleNextStep,
    handleFirstPage,
    handleLastPage,
  ]);

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

  return (
    <div className="flex min-h-full flex-col overflow-y-auto bg-background px-4 py-4">
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
                    <span className="rounded-md border border-border bg-muted/20 px-3 py-1.5 font-medium text-foreground">
                      {t('globalLineageList.visibleResults', {
                        visible: totalFilteredEntries,
                        total: graphData.stats.totalTables,
                      })}
                    </span>
                    <span className="rounded-md border border-border bg-muted/20 px-3 py-1.5">
                      {t('globalLineageList.totalFlowsHint', { count: graphData.stats.totalEdges })}
                    </span>
                    <div className="flex flex-wrap items-center gap-1 rounded-md border border-border bg-muted/20 px-2 py-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleFirstPage}
                        disabled={currentPage === 1}
                        aria-label={t('globalLineageList.firstPage')}
                        title={t('globalLineageList.firstPage')}
                        className="h-7 min-w-7 px-1.5 text-xs text-foreground"
                      >
                        <ChevronsLeft className="h-4 w-4 shrink-0" strokeWidth={2.25} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={handlePreviousPage}
                        disabled={currentPage === 1}
                        aria-label={t('globalLineageList.previousPage')}
                        title={t('globalLineageList.previousPage')}
                        className="h-7 gap-1 px-2 text-xs text-foreground"
                      >
                        <ChevronLeft className="h-4 w-4 shrink-0" strokeWidth={2.25} />
                        <span>{t('globalLineageList.previousPage')}</span>
                      </Button>
                      <span className="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground">
                        {t('globalLineageList.pageSummary', {
                          page: currentPage,
                          totalPages,
                          count: paginatedEntries.length,
                        })}
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleNextPage}
                        disabled={currentPage === totalPages}
                        aria-label={t('globalLineageList.nextPage')}
                        title={t('globalLineageList.nextPage')}
                        className="h-7 gap-1 px-2 text-xs text-foreground"
                      >
                        <span>{t('globalLineageList.nextPage')}</span>
                        <ChevronRight className="h-4 w-4 shrink-0" strokeWidth={2.25} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleLastPage}
                        disabled={currentPage === totalPages}
                        aria-label={t('globalLineageList.lastPage')}
                        title={t('globalLineageList.lastPage')}
                        className="h-7 min-w-7 px-1.5 text-xs text-foreground"
                      >
                        <ChevronsRight className="h-4 w-4 shrink-0" strokeWidth={2.25} />
                      </Button>
                    </div>
                    {selectedFileGroup ? (
                      <span className="rounded-md border border-sky-200 bg-sky-50 px-3 py-1.5 text-sky-700 dark:border-sky-900/60 dark:bg-sky-950/40 dark:text-sky-300">
                        {t('globalLineageList.fileScopeActive', { file: selectedFileGroup })}
                      </span>
                    ) : null}
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <div className="relative min-w-[220px] flex-1">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                    <input
                      value={searchTerm}
                      onChange={(event) => setSearchTerm(event.target.value)}
                      placeholder={t('globalLineageList.searchPlaceholder')}
                      className="h-7 w-full rounded-md border border-border bg-background pl-8 pr-3 text-xs outline-hidden transition-colors focus:border-primary/40"
                    />
                  </div>
                  <div className="flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1">
                    <ArrowUpDown className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="text-xs text-muted-foreground">{t('globalLineageList.sortBy')}</span>
                    <select
                      value={sortKey}
                      onChange={(event) => setSortKey(event.target.value as GlobalLineageSortKey)}
                      className="bg-transparent text-xs text-foreground outline-hidden"
                    >
                      <option value="impact">{t('globalLineageList.sortImpact')}</option>
                      <option value="upstream">{t('globalLineageList.sortUpstream')}</option>
                      <option value="downstream">{t('globalLineageList.sortDownstream')}</option>
                      <option value="files">{t('globalLineageList.sortFiles')}</option>
                      <option value="name">{t('globalLineageList.sortName')}</option>
                    </select>
                  </div>
                  {activeFilterCount > 0 ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleResetFilters}
                      className="h-7 text-xs"
                    >
                      {t('globalLineageList.resetFilters')}
                    </Button>
                  ) : null}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    {t('globalLineageList.inventoryMode')}
                  </span>
                  <div className="inline-flex items-center gap-1 rounded-md border border-border bg-background p-0.5">
                    {(['table', 'grouped'] as GlobalLineageInventoryMode[]).map((mode) => {
                      const isActive = inventoryMode === mode;
                      return (
                        <button
                          key={mode}
                          type="button"
                          onClick={() => setInventoryMode(mode)}
                          className={cn(
                            'rounded px-2.5 py-1 text-xs transition-colors',
                            isActive
                              ? 'bg-primary/10 text-primary'
                              : 'text-muted-foreground hover:text-foreground'
                          )}
                        >
                          {t(
                            mode === 'table'
                              ? 'globalLineageList.inventoryModeTable'
                              : 'globalLineageList.inventoryModeGrouped'
                          )}
                        </button>
                      );
                    })}
                  </div>
                  {inventoryMode === 'grouped' ? (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleExpandAllInventoryGroups}
                        className="h-7 text-xs"
                      >
                        {t('globalLineageList.expandAllGroups')}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleCollapseAllInventoryGroups}
                        className="h-7 text-xs"
                      >
                        {t('globalLineageList.collapseAllGroups')}
                      </Button>
                    </>
                  ) : null}
                  <span className="mx-1 hidden h-4 w-px bg-border sm:inline-block" />
                  <div className="flex flex-wrap items-center gap-1.5">
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
                            'inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs transition-colors',
                            isActive
                              ? 'border-primary/30 bg-primary/10 text-primary'
                              : 'border-border bg-background text-muted-foreground hover:text-foreground'
                          )}
                        >
                          <span>
                            {t(
                              `globalLineageList.quickView${view.charAt(0).toUpperCase()}${view.slice(1)}`
                            )}
                          </span>
                          <span className="rounded bg-background/80 px-1 text-[10px] tabular-nums">
                            {quickViewCounts[view]}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  <span className="mx-1 hidden h-4 w-px bg-border sm:inline-block" />
                  <div className="flex flex-wrap items-center gap-1.5">
                    {(Object.keys(STATUS_META) as GlobalLineageStatus[]).map((status) => {
                      const meta = STATUS_META[status];
                      const isActive = activeStatuses.has(status);
                      return (
                        <button
                          key={status}
                          type="button"
                          onClick={() => toggleStatus(status)}
                          className={cn(
                            'inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs transition-colors',
                            isActive
                              ? meta.badgeClassName
                              : 'border-border bg-background text-muted-foreground hover:text-foreground'
                          )}
                        >
                          <span
                            className={cn('inline-block h-2 w-2 rounded-full', meta.dotClassName)}
                          />
                          <span>{t(meta.labelKey)}</span>
                        </button>
                      );
                    })}
                  </div>
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
                <div
                  ref={tableScrollRef}
                  className="max-h-[calc(100vh-260px)] overflow-auto"
                >
                  <table className="min-w-full table-fixed border-collapse text-sm">
                    <colgroup>
                      <col className="w-[5%]" />
                      <col className="w-[33%]" />
                      <col className="w-[10%]" />
                      <col className="w-[10%]" />
                      <col className="w-[16%]" />
                      <col className="w-[26%]" />
                    </colgroup>
                    <thead className="sticky top-0 z-10 bg-muted/50 text-[11px] uppercase tracking-wide text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2 text-right font-medium tabular-nums">#</th>
                        <th className="px-3 py-2 text-left font-medium">
                          {t('globalLineageList.tableColumn')}
                        </th>
                        <th className="px-3 py-2 text-left font-medium">
                          {t('globalLineageList.statusColumn')}
                        </th>
                        <th className="px-3 py-2 text-right font-medium">
                          {t('globalLineageList.impactColumn')}
                        </th>
                        <th className="px-3 py-2 text-left font-medium">
                          {t('globalLineageList.relationsColumn')}
                        </th>
                        <th className="px-3 py-2 text-left font-medium">
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
                            className="cursor-pointer border-t border-border align-middle transition-colors hover:bg-muted/30"
                            onClick={() =>
                              openEntry(entry.nodeId, {
                                kind: 'inventory',
                                label: t('globalLineageList.inventoryTitle'),
                                file: entry.primaryFile,
                              })
                            }
                          >
                            <td className="px-3 py-1.5 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
                              {absoluteIndex + 1}
                            </td>
                            <td className="px-3 py-1.5">
                              <div className="flex min-w-0 items-center gap-2">
                                <span
                                  className={cn(
                                    'inline-block h-2 w-2 shrink-0 rounded-full',
                                    STATUS_META[entry.status].dotClassName
                                  )}
                                />
                                <span className="truncate text-sm font-medium text-foreground">
                                  {entry.qualifiedName}
                                </span>
                                {absoluteIndex < 3 ? (
                                  <span className="shrink-0 rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
                                    Top {absoluteIndex + 1}
                                  </span>
                                ) : null}
                                {entry.comment ? (
                                  <span className="truncate text-xs text-muted-foreground">
                                    · {entry.comment}
                                  </span>
                                ) : null}
                              </div>
                            </td>
                            <td className="px-3 py-1.5">
                              <span
                                className={cn(
                                  'inline-flex rounded border px-1.5 py-0.5 text-[11px] leading-tight',
                                  STATUS_META[entry.status].badgeClassName
                                )}
                              >
                                {t(STATUS_META[entry.status].labelKey)}
                              </span>
                            </td>
                            <td className="px-3 py-1.5 text-right">
                              <span className="font-mono text-sm font-semibold tabular-nums text-foreground">
                                {entry.impactScore}
                              </span>
                              <span className="ml-1 text-[11px] text-muted-foreground tabular-nums">
                                ·{entry.relationCount}
                              </span>
                            </td>
                            <td className="px-3 py-1.5">
                              <div className="flex items-center gap-2">
                                <div className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-muted">
                                  <div
                                    className="h-full bg-sky-500"
                                    style={{
                                      width: `${Math.max(
                                        2,
                                        Math.min(
                                          100,
                                          (entry.upstream.length /
                                            Math.max(
                                              1,
                                              entry.upstream.length + entry.downstream.length
                                            )) *
                                            100
                                        )
                                      )}%`,
                                    }}
                                  />
                                </div>
                                <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                                  ↑{entry.upstream.length} · ↓{entry.downstream.length}
                                </span>
                              </div>
                            </td>
                            <td className="px-3 py-1.5">
                              {entry.primaryFile ? (
                                <div className="flex min-w-0 items-center gap-1.5">
                                  <span className="truncate text-xs text-foreground">
                                    {entry.primaryFile}
                                  </span>
                                  <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                                    ·{entry.relatedFiles.length}
                                  </span>
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
              <div className="sticky bottom-0 z-20 shrink-0 border-t border-border bg-background/95 px-3 py-2.5 backdrop-blur supports-[backdrop-filter]:bg-background/80">
                <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span aria-live="polite" className="sr-only">
                      {pageAnnouncement}
                    </span>
                    <span aria-hidden="true">
                      {t('globalLineageList.paginationRange', {
                        start: (currentPage - 1) * pageSize + 1,
                        end: Math.min(currentPage * pageSize, totalFilteredEntries),
                        total: totalFilteredEntries,
                      })}
                    </span>
                    <span className="hidden h-1 w-1 rounded-full bg-muted-foreground/50 lg:inline-block" />
                    <span aria-hidden="true">
                      {t('globalLineageList.paginationPages', { page: currentPage, total: totalPages })}
                    </span>
                    <span className="hidden h-1 w-1 rounded-full bg-muted-foreground/50 lg:inline-block" />
                    <span
                      aria-hidden="true"
                      className="hidden rounded border border-border bg-muted/30 px-2 py-0.5 font-mono text-[10px] tracking-tight text-muted-foreground md:inline-block"
                    >
                      {t('globalLineageList.paginationShortcutHint')}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="flex flex-wrap items-center gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleFirstPage}
                        disabled={currentPage === 1}
                        aria-label={t('globalLineageList.firstPage')}
                        className="h-8 min-w-8 gap-1 border-border bg-background px-2 text-foreground shadow-sm"
                        title={t('globalLineageList.firstPage')}
                      >
                        <ChevronsLeft className="h-4 w-4 shrink-0" strokeWidth={2.25} />
                        <span className="text-xs font-medium">{t('globalLineageList.firstPage')}</span>
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handlePreviousPage}
                        disabled={currentPage === 1}
                        aria-label={t('globalLineageList.previousPage')}
                        className="h-8 min-w-8 gap-1 border-border bg-background px-2 text-foreground shadow-sm"
                        title={t('globalLineageList.previousPage')}
                      >
                        <ChevronLeft className="h-4 w-4 shrink-0" strokeWidth={2.25} />
                        <span className="text-xs font-medium">{t('globalLineageList.previousPage')}</span>
                      </Button>
                      {(() => {
                        const windowSize = 5;
                        const half = Math.floor(windowSize / 2);
                        let start = Math.max(1, currentPage - half);
                        const end = Math.min(totalPages, start + windowSize - 1);
                        start = Math.max(1, end - windowSize + 1);
                        const pages: number[] = [];
                        for (let p = start; p <= end; p++) pages.push(p);
                        return (
                          <>
                            {start > 1 ? (
                              <>
                                <button
                                  type="button"
                                  onClick={() => handleJumpToPage(1)}
                                  className="h-7 min-w-7 rounded-md border border-border bg-background px-2 text-xs text-muted-foreground hover:text-foreground"
                                >
                                  1
                                </button>
                                {start > 2 ? (
                                  <span className="px-1 text-xs text-muted-foreground">…</span>
                                ) : null}
                              </>
                            ) : null}
                            {pages.map((p) => {
                              const isActive = p === currentPage;
                              return (
                                <button
                                  key={p}
                                  type="button"
                                  onClick={() => handleJumpToPage(p)}
                                  className={cn(
                                    'h-7 min-w-7 rounded-md border px-2 text-xs tabular-nums transition-colors',
                                    isActive
                                      ? 'border-primary/40 bg-primary/10 font-semibold text-primary'
                                      : 'border-border bg-background text-muted-foreground hover:text-foreground'
                                  )}
                                >
                                  {p}
                                </button>
                              );
                            })}
                            {end < totalPages ? (
                              <>
                                {end < totalPages - 1 ? (
                                  <span className="px-1 text-xs text-muted-foreground">…</span>
                                ) : null}
                                <button
                                  type="button"
                                  onClick={() => handleJumpToPage(totalPages)}
                                  className="h-7 min-w-7 rounded-md border border-border bg-background px-2 text-xs text-muted-foreground hover:text-foreground"
                                >
                                  {totalPages}
                                </button>
                              </>
                            ) : null}
                          </>
                        );
                      })()}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleNextPage}
                        disabled={currentPage === totalPages}
                        aria-label={t('globalLineageList.nextPage')}
                        className="h-8 min-w-8 gap-1 border-border bg-background px-2 text-foreground shadow-sm"
                        title={t('globalLineageList.nextPage')}
                      >
                        <ChevronRight className="h-4 w-4 shrink-0" strokeWidth={2.25} />
                        <span className="text-xs font-medium">{t('globalLineageList.nextPage')}</span>
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleLastPage}
                        disabled={currentPage === totalPages}
                        aria-label={t('globalLineageList.lastPage')}
                        className="h-8 min-w-8 gap-1 border-border bg-background px-2 text-foreground shadow-sm"
                        title={t('globalLineageList.lastPage')}
                      >
                        <ChevronsRight className="h-4 w-4 shrink-0" strokeWidth={2.25} />
                        <span className="text-xs font-medium">{t('globalLineageList.lastPage')}</span>
                      </Button>
                    </div>
                    <div className="flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1">
                      <span className="text-xs text-muted-foreground">{t('globalLineageList.jumpToPage')}</span>
                      <input
                        type="number"
                        min={1}
                        max={totalPages}
                        defaultValue={currentPage}
                        onKeyDown={handleJumpToPageInput}
                        className="h-6 w-12 rounded border border-border bg-background px-1.5 text-xs text-foreground outline-hidden tabular-nums"
                      />
                    </div>
                    <div className="flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1">
                      <span className="text-xs text-muted-foreground">
                        {t('globalLineageList.pageSize')}
                      </span>
                      <select
                        value={pageSize}
                        onChange={(event) =>
                          setPageSize(Number(event.target.value) as (typeof PAGE_SIZE_OPTIONS)[number])
                        }
                        className="bg-transparent text-xs text-foreground outline-hidden"
                      >
                        {PAGE_SIZE_OPTIONS.map((size) => (
                          <option key={size} value={size}>
                            {t('globalLineageList.pageSizeOption', { count: size })}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
      </section>

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
