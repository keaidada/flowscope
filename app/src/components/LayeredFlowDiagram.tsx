// ============================================================================
// LayeredFlowDiagram.tsx
//
// Left-to-right layered DAG view replacing TaskLayerMatrix.
//
//   - Columns = topological layers (computed via longest path)
//   - Cards   = scripts (minimal: just script name; click for details)
//   - Arrows  = script→script dependencies (bezier curves)
//   - Red dashed arrows = edges broken to enforce DAG
//
// Scroll: canvas uses absolute positioning to guarantee overflow scrolling.
// ============================================================================

import { useMemo, useState, useRef, useCallback, useEffect, memo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Search,
  X,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  XCircle,
  Filter,
  CheckSquare,
  Square,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { PipelineTask } from '@/types/pipeline-matrix';
import {
  computeLayeredLayout,
  getLayerColor,
  type LayeredLayout,
  type LayeredNode,
} from '@/lib/layered-layout';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
} from './ui/dropdown-menu';

// ============================================================================
// Props
// ============================================================================

interface LayeredFlowDiagramProps {
  tasks: PipelineTask[];
  className?: string;
}

// ============================================================================
// Constants
// ============================================================================

const COLUMN_WIDTH = 220;
const COLUMN_GAP = 60;
const CARD_HEIGHT = 56;
const CARD_GAP = 12;
const CANVAS_PADDING_X = 40;
const CANVAS_PADDING_Y = 24;
const HEADER_HEIGHT = 40;

// ============================================================================
// Helpers
// ============================================================================

/** Extract just the file name (last path segment). Extension preserved. */
function basename(path: string): string {
  if (!path) return path;
  // Handle both / and \ as path separators
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

// ============================================================================
// Component
// ============================================================================

export const LayeredFlowDiagram = memo(function LayeredFlowDiagram({
  tasks,
  className,
}: LayeredFlowDiagramProps) {
  const { t } = useTranslation();
  const safeTasks = useMemo(() => tasks ?? [], [tasks]);

  // ── Debug: detect excessive layout recalculations ────────────────────────
  const layoutCallCount = useRef(0);

  // ── Layered layout ─────────────────────────────────────────────────────
  const layout: LayeredLayout = useMemo(() => {
    layoutCallCount.current++;
    if (layoutCallCount.current > 2) {
      console.warn(
        `[LayeredFlowDiagram] computeLayeredLayout called ${layoutCallCount.current} times. ` +
        `Tasks length: ${safeTasks.length}. May indicate a re-render loop.`,
      );
    }
    return computeLayeredLayout(safeTasks);
  }, [safeTasks]);

  // ── UI state ───────────────────────────────────────────────────────────
  const [search, setSearch] = useState('');
  const [hovered, setHovered] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [showCyclePanel, setShowCyclePanel] = useState(false);
  // Per-layer focused scripts. When non-empty, only these + their upstream/downstream are visible.
  const [focusedNodes, setFocusedNodes] = useState<Set<string>>(new Set());
  // Search text within the layer filter dropdown
  const [layerFilterSearch, setLayerFilterSearch] = useState('');

  const canvasRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());
  const [arrowPaths, setArrowPaths] = useState<
    Array<{ key: string; d: string; from: string; to: string; broken: boolean }>
  >([]);

  // ── Group nodes by layer ───────────────────────────────────────────────
  const layerBuckets = useMemo(() => {
    const buckets: LayeredNode[][] = Array.from({ length: layout.layerCount }, () => []);
    for (const n of layout.nodes) {
      if (buckets[n.computedLayer]) buckets[n.computedLayer].push(n);
      else buckets[n.computedLayer] = [n];
    }
    for (const b of buckets) b.sort((a, b) => a.id.localeCompare(b.id));
    return buckets;
  }, [layout]);

  // ── Reachability for highlight ─────────────────────────────────────────
  const reachable = useCallback(
    (id: string, dir: 'up' | 'down'): Set<string> => {
      const result = new Set<string>();
      const queue = [id];
      const seen = new Set<string>([id]);
      while (queue.length) {
        const cur = queue.shift()!;
        for (const e of layout.edges) {
          if (e.isBroken) continue;
          const next = dir === 'down' ? (e.from === cur ? e.to : null) : e.to === cur ? e.from : null;
          if (next && !seen.has(next)) {
            seen.add(next);
            result.add(next);
            queue.push(next);
          }
        }
      }
      return result;
    },
    [layout.edges],
  );

  const highlightSet = useMemo(() => {
    const activeId = selected ?? hovered;
    if (!activeId) return null;
    const up = reachable(activeId, 'up');
    const down = reachable(activeId, 'down');
    return new Set([activeId, ...up, ...down]);
  }, [selected, hovered, reachable]);

  // ── Selection chain set: when a card is selected, only its up/down chain stays visible ──
  const selectionChainSet = useMemo(() => {
    if (!selected) return null;
    const up = reachable(selected, 'up');
    const down = reachable(selected, 'down');
    return new Set([selected, ...up, ...down]);
  }, [selected, reachable]);

  // ── Focus visible set: when focusedNodes non-empty, only these + their upstream/downstream are visible ──
  const focusVisibleSet = useMemo(() => {
    if (focusedNodes.size === 0) return null;
    const result = new Set<string>(focusedNodes);
    for (const id of focusedNodes) {
      for (const u of reachable(id, 'up')) result.add(u);
      for (const d of reachable(id, 'down')) result.add(d);
    }
    return result;
  }, [focusedNodes, reachable]);

  const isVisibleDueToFocus = useCallback(
    (nodeId: string) => {
      if (focusVisibleSet && !focusVisibleSet.has(nodeId)) return false;
      if (selectionChainSet && !selectionChainSet.has(nodeId)) return false;
      return true;
    },
    [focusVisibleSet, selectionChainSet],
  );

  // ── Combined arrow visibility: intersection of focusVisibleSet and selectionChainSet ──
  const arrowVisibleSet = useMemo(() => {
    if (focusVisibleSet === null && selectionChainSet === null) return null;
    const result = new Set<string>();
    for (const n of layout.nodes) {
      const inFocus = !focusVisibleSet || focusVisibleSet.has(n.id);
      const inChain = !selectionChainSet || selectionChainSet.has(n.id);
      if (inFocus && inChain) result.add(n.id);
    }
    return result;
  }, [focusVisibleSet, selectionChainSet, layout.nodes]);

  // ── Search filter ──────────────────────────────────────────────────────
  const searchLower = search.trim().toLowerCase();
  const matchesSearch = useCallback(
    (n: LayeredNode) => {
      if (!searchLower) return true;
      return (
        n.id.toLowerCase().includes(searchLower) ||
        n.label.toLowerCase().includes(searchLower) ||
        n.reads.some((r) => r.toLowerCase().includes(searchLower)) ||
        n.writes.some((w) => w.toLowerCase().includes(searchLower))
      );
    },
    [searchLower],
  );

  // ── Compact buckets: drop empty layers when focus/search is active ──────
  // Maps display index (0,1,2...) → original layer index, skipping empties
  const compactMap = useMemo(() => {
    const map: Array<{ origIdx: number; bucket: LayeredNode[] }> = [];
    for (let i = 0; i < layerBuckets.length; i++) {
      const visibleNodes = layerBuckets[i].filter(
        (n) => matchesSearch(n) && isVisibleDueToFocus(n.id),
      );
      if (visibleNodes.length > 0) {
        map.push({ origIdx: i, bucket: layerBuckets[i] });
      }
    }
    return map;
  }, [layerBuckets, matchesSearch, isVisibleDueToFocus]);

  const isCompactMode = focusVisibleSet !== null || search.trim() !== '';

  // ── Diagnostics ────────────────────────────────────────────────────────
  const diagnostics = useMemo(() => {
    const totalEdges = layout.edges.length;
    const brokenEdges = layout.edges.filter((e) => e.isBroken).length;
    const liveEdges = totalEdges - brokenEdges;
    const isolated = layout.nodes.filter(
      (n) => !layout.edges.some((e) => !e.isBroken && (e.from === n.id || e.to === n.id)),
    ).length;
    return { totalEdges, brokenEdges, liveEdges, isolated, totalNodes: layout.nodes.length };
  }, [layout]);

  // ── Arrow path computation ─────────────────────────────────────────────
  const recomputeArrows = useCallback(() => {
    const canvasEl = canvasRef.current;
    if (!canvasEl) return;
    const c = canvasEl.getBoundingClientRect();
    const newPaths: typeof arrowPaths = [];

    for (const e of layout.edges) {
      const fromEl = cardRefs.current.get(e.from);
      const toEl = cardRefs.current.get(e.to);
      if (!fromEl || !toEl) continue;
      const fr = fromEl.getBoundingClientRect();
      const tr = toEl.getBoundingClientRect();
      const x1 = fr.right - c.left;
      const y1 = fr.top + fr.height / 2 - c.top;
      const x2 = tr.left - c.left;
      const y2 = tr.top + tr.height / 2 - c.top;
      const dx = x2 - x1;
      const cp1x = x1 + dx * 0.5;
      const cp2x = x2 - dx * 0.5;
      const d = `M ${x1} ${y1} C ${cp1x} ${y1}, ${cp2x} ${y2}, ${x2} ${y2}`;
      newPaths.push({
        key: `${e.from}__${e.to}__${e.viaTable}`,
        d,
        from: e.from,
        to: e.to,
        broken: !!e.isBroken,
      });
    }
    setArrowPaths(newPaths);
  }, [layout.edges]);

  useEffect(() => {
    const id = requestAnimationFrame(recomputeArrows);
    return () => cancelAnimationFrame(id);
  }, [recomputeArrows, layout, layerBuckets, focusedNodes, search, isCompactMode, compactMap]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => recomputeArrows());
    ro.observe(el);
    return () => ro.disconnect();
  }, [recomputeArrows]);

  // ── Canvas dimensions ──────────────────────────────────────────────────
  // Effective column count (compact when filter is active)
  const effectiveLayerCount = isCompactMode ? compactMap.length : layout.layerCount;

  const canvasWidth = useMemo(
    () =>
      Math.max(
        effectiveLayerCount * (COLUMN_WIDTH + COLUMN_GAP) -
          COLUMN_GAP +
          CANVAS_PADDING_X * 2,
        800,
      ),
    [effectiveLayerCount],
  );

  const canvasHeight = useMemo(() => {
    let maxStackHeight = 0;
    const bucketsToMeasure = isCompactMode
      ? compactMap.map((c) => c.bucket)
      : layerBuckets;
    for (const bucket of bucketsToMeasure) {
      // Account for variable-height cards (cards may wrap if name is long)
      const h = bucket.length * (CARD_HEIGHT + 20) + Math.max(0, bucket.length - 1) * CARD_GAP;
      if (h > maxStackHeight) maxStackHeight = h;
    }
    return maxStackHeight + HEADER_HEIGHT + CANVAS_PADDING_Y * 2;
  }, [layerBuckets, compactMap, isCompactMode]);

  // ── Handlers ───────────────────────────────────────────────────────────
  const handleCardHover = useCallback((id: string | null) => setHovered(id), []);
  const handleCardClick = useCallback((id: string) => setSelected(id), []);
  const clearSelection = useCallback(() => {
    setSelected(null);
    setHovered(null);
  }, []);

  // ── Focus (per-layer script filter) ────────────────────────────────────
  const toggleFocusNode = useCallback((id: string) => {
    setFocusedNodes((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const clearFocus = useCallback(() => setFocusedNodes(new Set()), []);

  // Focused nodes count within a given layer
  const focusedCountInLayer = useCallback(
    (allIds: string[]) => allIds.filter((id) => focusedNodes.has(id)).length,
    [focusedNodes],
  );

  // ── Selected node details ──────────────────────────────────────────────
  const selectedNode = selected ? layout.nodes.find((n) => n.id === selected) : null;
  const selectedEdges = useMemo(() => {
    if (!selected) return { upstream: [], downstream: [] };
    return {
      upstream: layout.edges.filter((e) => !e.isBroken && e.to === selected),
      downstream: layout.edges.filter((e) => !e.isBroken && e.from === selected),
    };
  }, [selected, layout.edges]);

  // ── Empty state ────────────────────────────────────────────────────────
  if (layout.nodes.length === 0) {
    return (
      <div className={cn('flex h-full w-full items-center justify-center', className)}>
        <div className="text-center">
          <p className="text-sm text-muted-foreground">
            {t('layeredFlow.empty', '暂无可显示的脚本依赖关系')}
          </p>
          <p className="mt-1 text-xs text-muted-foreground/70">
            {t(
              'layeredFlow.emptyHint',
              '请先运行分析，或确认脚本包含可解析的输入/输出表',
            )}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={cn('absolute inset-0 flex flex-col bg-background', className)}>
      {/* ── Toolbar ─────────────────────────────────────────────────────── */}
      <div className="flex flex-shrink-0 items-center gap-3 border-b border-border bg-muted/10 px-4 py-2">
        <div className="flex items-baseline gap-3">
          <span className="text-sm font-semibold">
            {t('layeredFlow.title', '分层流程图')}
          </span>
          <span className="text-xs text-muted-foreground">
            {diagnostics.totalNodes} {t('layeredFlow.scripts', '脚本')} ·{' '}
            {diagnostics.liveEdges} {t('layeredFlow.dependencies', '依赖')} ·{' '}
            {layout.layerCount} {t('layeredFlow.layers', '层')}
            {diagnostics.isolated > 0 && (
              <span className="ml-1 text-amber-500">
                · {diagnostics.isolated} {t('layeredFlow.isolated', '孤立')}
              </span>
            )}
            {focusedNodes.size > 0 && (
              <button
                type="button"
                onClick={clearFocus}
                className="ml-2 inline-flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-medium text-primary hover:bg-primary/25"
              >
                <Filter className="h-2.5 w-2.5" />
                {t('layeredFlow.focused', '已聚焦')} {focusedNodes.size}
                <X className="h-2.5 w-2.5" />
              </button>
            )}
          </span>
        </div>

        <div className="flex-1" />

        {/* Cycle warning chip */}
        {layout.cycleWarning && (
          <button
            type="button"
            onClick={() => setShowCyclePanel((v) => !v)}
            className={cn(
              'flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors',
              'border-amber-500/40 bg-amber-500/10 text-amber-600 hover:bg-amber-500/20',
              'dark:border-amber-500/30 dark:text-amber-400 dark:hover:bg-amber-500/20',
            )}
            title={t('layeredFlow.cycleTooltip', '检测到循环依赖，已自动断开部分边')}
          >
            <AlertTriangle className="h-3.5 w-3.5" />
            <span>
              {t('layeredFlow.cycleCount', '断环 {{count}} 处', {
                count: layout.cycleWarning.count,
              })}
            </span>
            {showCyclePanel ? (
              <ChevronUp className="h-3 w-3" />
            ) : (
              <ChevronDown className="h-3 w-3" />
            )}
          </button>
        )}

        {/* Search */}
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('layeredFlow.searchPlaceholder', '搜索脚本/表名...')}
            className={cn(
              'h-7 w-56 rounded-md border border-input bg-background pl-7 pr-7 text-xs',
              'placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            )}
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Cycle expandable panel */}
      {layout.cycleWarning && showCyclePanel && (
        <div className="border-b border-amber-500/20 bg-amber-500/5 px-4 py-2 text-xs">
          <div className="mb-1 font-medium text-amber-700 dark:text-amber-400">
            {t(
              'layeredFlow.cycleTitle',
              '检测到循环依赖（已断开以下边以保证从左到右的数据流）',
            )}
          </div>
          <ul className="space-y-1">
            {layout.cycleWarning.brokenEdges.map((e) => (
              <li key={`${e.from}__${e.to}__${e.viaTable}`} className="font-mono text-[11px]">
                <span className="text-foreground">{e.from}</span>
                <span className="mx-1 text-muted-foreground">→</span>
                <span className="text-foreground">{e.to}</span>
                <span className="ml-2 text-muted-foreground">
                  ({t('layeredFlow.viaTable', '通过')} {e.viaTable})
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ── Canvas wrapper (positioning context for scroll + detail panel) ── */}
      <div className="relative min-h-0 flex-1">
        {/* Scrollable canvas */}
        <div
          ref={scrollRef}
          className="h-full w-full overflow-auto"
          onClick={clearSelection}
        >
          <div
            ref={canvasRef}
            className="relative"
            style={{
              width: `${canvasWidth}px`,
              height: `${canvasHeight}px`,
            }}
          >
            {/* Layer columns — iterates over display order (compact when filter is active) */}
            {(isCompactMode
              ? compactMap.map((c, i) => ({ bucket: c.bucket, layerIdx: c.origIdx, displayIdx: i }))
              : layerBuckets.map((bucket, layerIdx) => ({ bucket, layerIdx, displayIdx: layerIdx }))
            ).map(({ bucket, layerIdx, displayIdx }) => {
              // In compact mode, completely skip layers with no visible nodes
              if (isCompactMode) {
                const visN = bucket.filter(
                  (n) => matchesSearch(n) && isVisibleDueToFocus(n.id),
                );
                if (visN.length === 0) return null;
              }
              const color = getLayerColor(layerIdx);
              const visibleNodes = bucket.filter(
                (n) => matchesSearch(n) && isVisibleDueToFocus(n.id),
              );
              const bucketIds = bucket.map((n) => n.id);
              const focusedInLayer = focusedCountInLayer(bucketIds);
              return (
                <div
                  key={`layer-${layerIdx}`}
                  className="absolute flex flex-col"
                  style={{
                    left: `${CANVAS_PADDING_X + displayIdx * (COLUMN_WIDTH + COLUMN_GAP)}px`,
                    top: `${CANVAS_PADDING_Y}px`,
                    width: `${COLUMN_WIDTH}px`,
                  }}
                >
                  {/* Header */}
                  <div
                    className="flex items-center justify-between rounded-t-lg border-x border-t px-2 py-1.5 text-xs font-semibold"
                    style={{
                      background: color.bg,
                      borderColor: color.border,
                      color: color.text,
                      borderBottom: `2px solid ${color.border}`,
                      minHeight: `${HEADER_HEIGHT}px`,
                    }}
                  >
                    <span className="flex items-center gap-1.5">
                      <span
                        className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-[10px] font-bold"
                        style={{ background: 'rgba(255,255,255,0.1)' }}
                      >
                        L{layerIdx + 1}
                      </span>
                      <span className="truncate">
                        {t('layeredFlow.layer', '层')} {layerIdx + 1}
                      </span>
                    </span>
                    <div className="flex flex-shrink-0 items-center gap-1">
                      <span className="text-[10px] opacity-70">
                        {visibleNodes.length}/{bucket.length}
                      </span>
                      {/* Per-layer filter dropdown */}
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            onClick={(e) => e.stopPropagation()}
                            className={cn(
                              'flex h-5 w-5 items-center justify-center rounded transition-colors',
                              focusedInLayer > 0
                                ? 'bg-primary/30 text-primary'
                                : 'hover:bg-white/10',
                            )}
                            title={t('layeredFlow.filterScripts', '筛选脚本')}
                          >
                            <Filter className="h-3 w-3" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          align="end"
                          className="w-64 p-0"
                          onClick={(e) => e.stopPropagation()}
                          onCloseAutoFocus={(e) => e.preventDefault()}
                        >
                          {/* Header with count + clear */}
                          <div className="flex items-center justify-between border-b border-border px-3 py-2">
                            <span className="text-xs font-semibold">
                              {t('layeredFlow.filterLayer', 'L{{n}} 筛选', { n: layerIdx + 1 })}{' '}
                              ({bucket.length})
                            </span>
                            {focusedInLayer > 0 && (
                              <button
                                type="button"
                                onClick={() => {
                                  for (const id of bucketIds) {
                                    if (focusedNodes.has(id)) toggleFocusNode(id);
                                  }
                                }}
                                className="text-[10px] text-primary hover:underline"
                              >
                                {t('layeredFlow.clear', '清除')} ({focusedInLayer})
                              </button>
                            )}
                          </div>
                          {/* Select-all toggle */}
                          <button
                            type="button"
                            onClick={() => {
                              const allSelected = bucketIds.every((id) =>
                                focusedNodes.has(id),
                              );
                              setFocusedNodes((cur) => {
                                if (allSelected) {
                                  const next = new Set(cur);
                                  for (const id of bucketIds) next.delete(id);
                                  return next;
                                }
                                // When adding, clear other layers' focuses first
                                const next = new Set<string>();
                                for (const id of bucketIds) next.add(id);
                                return next;
                              });
                            }}
                            className="flex w-full items-center gap-2 border-b border-border px-3 py-1.5 text-[11px] hover:bg-muted"
                          >
                            {bucket.every((n) => focusedNodes.has(n.id)) ? (
                              <CheckSquare className="h-3.5 w-3.5 text-primary" />
                            ) : (
                              <Square className="h-3.5 w-3.5 text-muted-foreground" />
                            )}
                            <span>
                              {t('layeredFlow.toggleAll', '全选/全不选')} ({focusedInLayer}/
                              {bucket.length})
                            </span>
                          </button>
                          {/* Search input */}
                          <div className="relative border-b border-border">
                            <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
                            <input
                              type="text"
                              value={layerFilterSearch}
                              onChange={(e) => setLayerFilterSearch(e.target.value)}
                              placeholder={t('layeredFlow.searchInLayer', '搜索本层...')}
                              className="w-full border-none bg-transparent py-1.5 pl-7 pr-2 text-xs placeholder:text-muted-foreground focus:outline-none"
                              onClick={(e) => e.stopPropagation()}
                              onKeyDown={(e) => e.stopPropagation()}
                            />
                            {layerFilterSearch && (
                              <button
                                type="button"
                                onClick={() => setLayerFilterSearch('')}
                                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                              >
                                <X className="h-3 w-3" />
                              </button>
                            )}
                          </div>
                          {/* Script list (filtered by search) */}
                          <div className="max-h-60 overflow-y-auto">
                            {bucket
                              .filter((n) => {
                                if (!layerFilterSearch.trim()) return true;
                                const q = layerFilterSearch.toLowerCase();
                                return (
                                  n.id.toLowerCase().includes(q) ||
                                  n.label.toLowerCase().includes(q) ||
                                  basename(n.label).toLowerCase().includes(q)
                                );
                              })
                              .map((n) => {
                                const isFocused = focusedNodes.has(n.id);
                                return (
                                  <button
                                    type="button"
                                    key={n.id}
                                    onClick={() => toggleFocusNode(n.id)}
                                    className="flex w-full items-center gap-2 px-3 py-1 text-left text-xs hover:bg-muted"
                                  >
                                    {isFocused ? (
                                      <CheckSquare className="h-3 w-3 flex-shrink-0 text-primary" />
                                    ) : (
                                      <Square className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
                                    )}
                                    <span className="truncate">{basename(n.label)}</span>
                                  </button>
                                );
                              })}
                            {bucket.filter((n) => {
                              if (!layerFilterSearch.trim()) return true;
                              const q = layerFilterSearch.toLowerCase();
                              return (
                                n.id.toLowerCase().includes(q) ||
                                n.label.toLowerCase().includes(q) ||
                                basename(n.label).toLowerCase().includes(q)
                              );
                            }).length === 0 && (
                              <div className="px-3 py-4 text-center text-[11px] text-muted-foreground/60">
                                {t('layeredFlow.noMatches', '无匹配项')}
                              </div>
                            )}
                          </div>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>

                  {/* Body */}
                  <div
                    className="flex flex-col gap-3 rounded-b-xl border-x border-b p-2"
                    style={{
                      background: `${color.bg}66`,
                      borderColor: color.border,
                      minHeight: `${CARD_HEIGHT}px`,
                    }}
                  >
                    {visibleNodes.length === 0 && (
                      <div className="py-4 text-center text-[11px] text-muted-foreground/60">
                        {t('layeredFlow.noMatches', '无匹配项')}
                      </div>
                    )}
                    {visibleNodes.map((node) => {
                      const isHighlighted = highlightSet?.has(node.id) ?? false;
                      const isDimmed = highlightSet && !isHighlighted;
                      const isSelected = selected === node.id;
                      const isCycle = node.isInCycle;
                      const fanOut = layout.edges.filter(
                        (e) => !e.isBroken && e.from === node.id,
                      ).length;
                      const fanIn = layout.edges.filter(
                        (e) => !e.isBroken && e.to === node.id,
                      ).length;
                      return (
                        <div
                          key={node.id}
                          ref={(el) => {
                            cardRefs.current.set(node.id, el);
                          }}
                          onMouseEnter={() => handleCardHover(node.id)}
                          onMouseLeave={() => handleCardHover(null)}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleCardClick(node.id);
                          }}
                          className={cn(
                            'group relative flex cursor-pointer items-center justify-between gap-2 rounded-md border bg-card px-3 py-2 transition-all',
                            'hover:-translate-y-0.5 hover:shadow-md',
                            isSelected
                              ? 'border-primary shadow-md ring-2 ring-primary/60'
                              : isHighlighted
                                ? 'border-primary/60 shadow-sm'
                                : 'border-border',
                            isDimmed && 'opacity-30',
                          )}
                          style={{
                            borderLeft: `3px solid ${color.border}`,
                            minHeight: `${CARD_HEIGHT}px`,
                          }}
                          title={node.label}
                        >
                          {/* Script name — full, allowed to wrap */}
                          <span className="break-all text-xs font-medium leading-tight">
                            {basename(node.label)}
                          </span>

                          {/* Right indicators (compact) */}
                          <div className="flex flex-shrink-0 flex-col items-end gap-1">
                            {isCycle && (
                              <AlertTriangle className="h-3 w-3 text-amber-500" />
                            )}
                            {(fanIn > 0 || fanOut > 0) && (
                              <span className="rounded bg-muted/60 px-1.5 py-0.5 text-[9px] font-mono text-muted-foreground">
                                {fanIn}→{fanOut}
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}

            {/* SVG arrows */}
            <svg
              className="pointer-events-none absolute left-0 top-0 h-full w-full"
              style={{ zIndex: 1 }}
            >
              <defs>
                <marker
                  id="layered-arrow-default"
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="rgba(139,148,158,0.55)" />
                </marker>
                <marker
                  id="layered-arrow-highlight"
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="7"
                  markerHeight="7"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="hsl(var(--primary))" />
                </marker>
                <marker
                  id="layered-arrow-broken"
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="#f59e0b" />
                </marker>
              </defs>
              {arrowPaths.map((p) => {
                // Hide edges outside visible set (focus filter + selection chain)
                if (
                  arrowVisibleSet &&
                  (!arrowVisibleSet.has(p.from) || !arrowVisibleSet.has(p.to))
                ) {
                  return null;
                }
                const touched =
                  highlightSet && (highlightSet.has(p.from) || highlightSet.has(p.to));
                const isOnHighlightPath =
                  highlightSet && highlightSet.has(p.from) && highlightSet.has(p.to);
                let stroke = 'rgba(139,148,158,0.35)';
                let strokeWidth = 1.5;
                let marker = 'url(#layered-arrow-default)';
                let opacity = 1;

                if (p.broken) {
                  stroke = '#f59e0b';
                  strokeWidth = 1.5;
                  marker = 'url(#layered-arrow-broken)';
                } else if (isOnHighlightPath) {
                  stroke = 'hsl(var(--primary))';
                  strokeWidth = 2.5;
                  marker = 'url(#layered-arrow-highlight)';
                } else if (highlightSet && touched) {
                  stroke = 'hsl(var(--primary) / 0.6)';
                  strokeWidth = 2;
                  marker = 'url(#layered-arrow-highlight)';
                } else if (highlightSet) {
                  opacity = 0.15;
                }

                return (
                  <path
                    key={p.key}
                    d={p.d}
                    fill="none"
                    stroke={stroke}
                    strokeWidth={strokeWidth}
                    markerEnd={marker}
                    opacity={opacity}
                    strokeDasharray={p.broken ? '5 3' : undefined}
                  />
                );
              })}
            </svg>
          </div>
        </div>

        {/* ── Detail panel (right side drawer on card click) ────────────── */}
        {selectedNode && (
          <DetailPanel
            node={selectedNode}
            upstreamEdges={selectedEdges.upstream}
            downstreamEdges={selectedEdges.downstream}
            layerCount={layout.layerCount}
            onClose={() => setSelected(null)}
            onSelectNode={(id) => setSelected(id)}
          />
        )}
      </div>

      {/* Hint bar */}
      <div className="flex flex-shrink-0 items-center justify-center gap-3 border-t border-border bg-muted/10 px-4 py-1.5 text-[10px] text-muted-foreground">
        <span>
          {t('layeredFlow.hintHover', '悬停查看上下游')} ·{' '}
          {t('layeredFlow.hintClick', '点击查看详情')} ·{' '}
          {t('layeredFlow.hintFilter', '点击右上角漏斗筛选本层脚本')} ·{' '}
          {t('layeredFlow.hintLegend', '卡片左边框颜色 = 层级')}
        </span>
      </div>
    </div>
  );
});

// ============================================================================
// Detail panel (right side, slides in on card click)
// ============================================================================

interface DetailPanelProps {
  node: LayeredNode;
  upstreamEdges: Array<{ from: string; viaTable: string }>;
  downstreamEdges: Array<{ to: string; viaTable: string }>;
  layerCount: number;
  onClose: () => void;
  onSelectNode: (id: string) => void;
}

function DetailPanel({
  node,
  upstreamEdges,
  downstreamEdges,
  layerCount,
  onClose,
  onSelectNode,
}: DetailPanelProps) {
  const { t } = useTranslation();
  const color = getLayerColor(node.computedLayer);

  return (
    <>
      {/* Click-outside catcher */}
      <div className="absolute inset-0 z-20" onClick={onClose} />

      {/* Panel — auto-fit width, no horizontal scroll */}
      <div
        className="absolute right-0 top-0 z-30 flex h-full flex-col border-l border-border bg-background shadow-2xl"
        style={{ width: 'max-content', minWidth: '360px', maxWidth: '60%' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <div
              className="h-3 w-3 flex-shrink-0 rounded-sm"
              style={{ background: color.border }}
            />
            <span className="break-all text-sm font-semibold leading-tight">
              {basename(node.label)}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex-shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <XCircle className="h-4 w-4" />
          </button>
        </div>

        {/* Body — auto-width, vertical scroll only */}
        <div className="flex-1 overflow-y-auto overflow-x-hidden p-4 text-xs">
          {/* Layer badge */}
          <div className="mb-4 flex items-center gap-2">
            <span
              className="rounded-md px-2 py-1 text-[11px] font-semibold"
              style={{
                background: color.bg,
                color: color.text,
                border: `1px solid ${color.border}`,
              }}
            >
              {t('layeredFlow.layer', '层')} {node.computedLayer + 1} / {layerCount}
            </span>
            {node.isInCycle && (
              <span className="flex items-center gap-1 rounded-md bg-amber-500/10 px-2 py-1 text-[11px] text-amber-600 dark:text-amber-400">
                <AlertTriangle className="h-3 w-3" />
                {t('layeredFlow.inCycle', '环中')}
              </span>
            )}
          </div>

          {/* Writes */}
          <Section title={t('layeredFlow.writes', '写入') + ` (${node.writes.length})`}>
            {node.writes.length === 0 ? (
              <Empty />
            ) : (
              <ul className="space-y-1">
                {node.writes.map((w) => (
                  <li key={w}>
                    <code className="block break-all rounded bg-primary/10 px-2 py-1 font-mono text-[11px] text-primary">
                      {w}
                    </code>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          {/* Reads */}
          <Section title={t('layeredFlow.reads', '读取') + ` (${node.reads.length})`}>
            {node.reads.length === 0 ? (
              <Empty />
            ) : (
              <ul className="space-y-1">
                {node.reads.map((r) => (
                  <li key={r}>
                    <code className="block break-all rounded bg-muted px-2 py-1 font-mono text-[11px] text-muted-foreground">
                      {r}
                    </code>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          {/* Upstream */}
          <Section
            title={`${t('layeredFlow.upstream', '上游')} (${upstreamEdges.length})`}
          >
            {upstreamEdges.length === 0 ? (
              <Empty />
            ) : (
              <ul className="space-y-1">
                {upstreamEdges.map((e) => (
                  <li key={`${e.from}-${e.viaTable}`}>
                    <button
                      type="button"
                      onClick={() => onSelectNode(e.from)}
                      className="block w-full break-all rounded px-2 py-1 text-left font-mono text-[11px] hover:bg-muted"
                    >
                      <span className="text-foreground">{e.from}</span>
                      <span className="text-muted-foreground"> → {e.viaTable}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          {/* Downstream */}
          <Section
            title={`${t('layeredFlow.downstream', '下游')} (${downstreamEdges.length})`}
          >
            {downstreamEdges.length === 0 ? (
              <Empty />
            ) : (
              <ul className="space-y-1">
                {downstreamEdges.map((e) => (
                  <li key={`${e.to}-${e.viaTable}`}>
                    <button
                      type="button"
                      onClick={() => onSelectNode(e.to)}
                      className="block w-full break-all rounded px-2 py-1 text-left font-mono text-[11px] hover:bg-muted"
                    >
                      <span className="text-foreground">{e.to}</span>
                      <span className="text-muted-foreground"> via {e.viaTable}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      </div>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </div>
      {children}
    </div>
  );
}

function Empty() {
  return <div className="text-[11px] text-muted-foreground/60">—</div>;
}
