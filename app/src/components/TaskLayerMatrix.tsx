import { useMemo, useState, useRef, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { ZoomIn, ZoomOut, Maximize2, Search } from 'lucide-react';
import { Button } from './ui/button';
import type { PipelineTask, LayerDef } from '@/types/pipeline-matrix';

// ============================================================================
// 颜色映射
// ============================================================================
const TASK_TYPE_COLORS: Record<string, string> = {
  pyspark: '#3b82f6',
  spark_sql: '#8b5cf6',
  python: '#10b981',
  shell: '#f59e0b',
};

const STATUS_COLORS: Record<string, string> = {
  success: '#22c55e',
  failed: '#ef4444',
  running: '#3b82f6',
  waiting: '#9ca3af',
  pending: '#9ca3af',
};

const LAYER_BG_COLORS: Record<string, string> = {
  L1: 'rgba(236, 72, 153, 0.06)',
  L2: 'rgba(139, 92, 246, 0.06)',
  L3: 'rgba(59, 130, 246, 0.06)',
  L4: 'rgba(34, 197, 94, 0.06)',
  L5: 'rgba(245, 158, 11, 0.06)',
  L6: 'rgba(249, 115, 22, 0.05)',
};

function getLayerBg(key: string): string {
  if (LAYER_BG_COLORS[key]) return LAYER_BG_COLORS[key];
  const hues = [30, 90, 210, 270, 330, 350, 180, 45, 120, 300];
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = key.charCodeAt(i) + ((hash << 5) - hash);
  const hue = hues[Math.abs(hash) % hues.length];
  return `hsla(${hue}, 60%, 50%, 0.06)`;
}

// ============================================================================
// 箭头标记 ID（SVG defs）
// ============================================================================
const ARROW_MARKER_ID = 'matrix-dep-arrow';

// ============================================================================
// 单个任务圆点
// ============================================================================
function TaskCircle({
  task,
  size,
  dimmed,
  onClick,
}: {
  task: PipelineTask;
  size: number;
  dimmed: boolean;
  onClick: (e: React.MouseEvent<SVGGElement>) => void;
}) {
  const color = TASK_TYPE_COLORS[task.taskType] || '#6b7280';
  const statusColor = task.schedule
    ? STATUS_COLORS[task.schedule.wedataStatus] || '#9ca3af'
    : '#9ca3af';
  const [hovered, setHovered] = useState(false);

  return (
    <g
      className="cursor-pointer"
      data-matrix-circle="true"
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      opacity={dimmed ? 0.18 : hovered ? 1 : 0.85}
    >
      <circle cx={0} cy={0} r={size / 2 + 8} fill="transparent" stroke="none" />
      <circle
        cx={0}
        cy={0}
        r={size / 2 + 3}
        fill="none"
        stroke={color}
        strokeWidth={hovered ? 2 : 0}
        opacity={hovered ? 0.5 : 0}
      />
      <circle
        cx={0}
        cy={0}
        r={size / 2 + 1.5}
        fill="none"
        stroke={statusColor}
        strokeWidth={1.5}
        opacity={0.8}
      />
      <circle cx={0} cy={0} r={size / 2} fill={color} />
      <text
        x={0}
        y={0}
        textAnchor="middle"
        dominantBaseline="central"
        fill="white"
        fontSize={size * 0.45}
        fontWeight={600}
        style={{ pointerEvents: 'none' }}
      >
        {task.taskType === 'pyspark'
          ? 'P'
          : task.taskType === 'spark_sql'
            ? 'S'
            : task.taskType === 'python'
              ? 'Py'
              : task.taskType.charAt(0).toUpperCase()}
      </text>
    </g>
  );
}

// ============================================================================
// 图例
// ============================================================================
function Legend() {
  return (
    <div className="flex items-center gap-4 text-[11px] text-muted-foreground px-2">
      <span className="font-semibold text-foreground">图例:</span>
      {Object.entries(TASK_TYPE_COLORS).map(([type, color]) => (
        <span key={type} className="flex items-center gap-1">
          <span
            className="inline-block w-2.5 h-2.5 rounded-full"
            style={{ backgroundColor: color }}
          />
          {type}
        </span>
      ))}
      <span className="mx-1">|</span>
      {Object.entries(STATUS_COLORS).map(([status, color]) => (
        <span key={status} className="flex items-center gap-1">
          <span
            className="inline-block w-2.5 h-2.5 rounded-full border"
            style={{ borderColor: color }}
          />
          {status}
        </span>
      ))}
    </div>
  );
}

// ============================================================================
// MiniTaskMatrix — 弹窗左侧的分层矩阵子图
// ============================================================================

interface SubgraphData {
  upstream: PipelineTask[];
  downstream: PipelineTask[];
  edges: { from: string; to: string; via: string[] }[];
}

const MINI_CELL_W = 44;
const MINI_CELL_H = 30;
const MINI_AXIS_W = 28;
const MINI_LABEL_H = 16;
const MINI_CIRCLE_R = 5.5;
const MINI_PADDING = 12;

function MiniTaskMatrix({
  task,
  subgraph,
  layers,
  depGraph,
  onClickNode,
}: {
  task: PipelineTask;
  subgraph: SubgraphData | null;
  layers: LayerDef[];
  depGraph: {
    outputByTable: Map<string, Set<string>>;
    inputsByTask: Map<string, Set<string>>;
    taskByName: Map<string, PipelineTask>;
  };
  onClickNode: (name: string) => void;
}) {
  const graph = subgraph ?? { upstream: [], downstream: [], edges: [] };

  // 所有相关任务名 + 当前任务
  const allTaskNames = useMemo(() => {
    const s = new Set<string>();
    s.add(task.taskName);
    for (const t of graph.upstream) s.add(t.taskName);
    for (const t of graph.downstream) s.add(t.taskName);
    return Array.from(s);
  }, [task.taskName, graph]);

  // 按层级分布这些任务
  const columnTasks = useMemo(() => {
    const map = new Map<string, PipelineTask[]>();
    for (const name of allTaskNames) {
      const t = depGraph.taskByName.get(name);
      if (!t) continue;
      const lyr = t.layer;
      if (!map.has(lyr)) map.set(lyr, []);
      map.get(lyr)!.push(t);
    }
    return map;
  }, [allTaskNames, depGraph.taskByName]);

  // 按层级排序（从上到下）
  const sortedLayers = useMemo(() => {
    const active = new Set(columnTasks.keys());
    return layers.filter((l) => active.has(l.key)).sort((a, b) => a.order - b.order);
  }, [layers, columnTasks]);

  if (sortedLayers.length === 0) {
    return (
      <div className="text-xs text-muted-foreground text-center px-4">
        没有找到相关的上下游任务。
      </div>
    );
  }

  // 竖向布局：每一层是一行，该层内的任务水平排列
  const maxCols = Math.max(...sortedLayers.map((l) => columnTasks.get(l.key)?.length ?? 0), 1);
  const rows = sortedLayers.length;
  const cols = maxCols;
  const svgW = MINI_AXIS_W + cols * MINI_CELL_W + MINI_PADDING;
  const svgH = MINI_LABEL_H + rows * MINI_CELL_H + MINI_PADDING;

  // 任务坐标 — 竖向布局
  const taskCoords = useMemo(() => {
    const m = new Map<string, { cx: number; cy: number }>();
    sortedLayers.forEach((layer, rowIdx) => {
      const tasks = columnTasks.get(layer.key) ?? [];
      tasks.forEach((t, colIdx) => {
        // 水平居中：如果该行任务数少于 maxCols，从中间开始排
        const offsetX = ((cols - tasks.length) * MINI_CELL_W) / 2;
        const cx = MINI_AXIS_W + offsetX + colIdx * MINI_CELL_W + MINI_CELL_W / 2;
        const cy = MINI_LABEL_H + rowIdx * MINI_CELL_H + MINI_CELL_H / 2;
        m.set(t.taskName, { cx, cy });
      });
    });
    return m;
  }, [sortedLayers, columnTasks, cols]);

  // 依赖连线
  const miniEdges = useMemo(() => {
    const result: { x1: number; y1: number; x2: number; y2: number; row: number }[] = [];
    for (const e of graph.edges) {
      const from = taskCoords.get(e.from);
      const to = taskCoords.get(e.to);
      if (!from || !to) continue;
      const toRow = sortedLayers.findIndex((l) => l.key === depGraph.taskByName.get(e.to)?.layer);
      const dx = to.cx - from.cx;
      const dy = to.cy - from.cy;
      const len = Math.sqrt(dx * dx + dy * dy);
      const trim = MINI_CIRCLE_R + 3;
      const ratio = len > 1 ? (len - trim) / len : 0;
      result.push({
        x1: from.cx,
        y1: from.cy,
        x2: from.cx + dx * ratio,
        y2: from.cy + dy * ratio,
        row: toRow,
      });
    }
    return result;
  }, [graph.edges, taskCoords, sortedLayers, depGraph.taskByName]);

  const getMarkerId = (row: number) => `mm-arrow-r${row}`;

  return (
    <svg width={svgW} height={svgH} className="block">
      <defs>
        {sortedLayers.map((_, ri) => (
          <marker
            key={ri}
            id={getMarkerId(ri)}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="4"
            markerHeight="4"
            orient="auto"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="hsl(var(--primary) / 30%)" />
          </marker>
        ))}
      </defs>

      {/* 列背景 */}
      {Array.from({ length: cols }, (_, c) => (
        <rect
          key={`bg-${c}`}
          x={MINI_AXIS_W + c * MINI_CELL_W}
          y={MINI_LABEL_H}
          width={MINI_CELL_W}
          height={rows * MINI_CELL_H}
          fill={c % 2 === 0 ? 'hsl(var(--muted) / 10%)' : 'transparent'}
        />
      ))}

      {/* 水平分隔线 */}
      {Array.from({ length: rows + 1 }, (_, r) => (
        <line
          key={`h-${r}`}
          x1={MINI_AXIS_W}
          y1={MINI_LABEL_H + r * MINI_CELL_H}
          x2={MINI_AXIS_W + cols * MINI_CELL_W}
          y2={MINI_LABEL_H + r * MINI_CELL_H}
          stroke="hsl(var(--border))"
          strokeWidth={0.5}
        />
      ))}
      {/* 垂直分隔线 */}
      {Array.from({ length: cols + 1 }, (_, c) => (
        <line
          key={`v-${c}`}
          x1={MINI_AXIS_W + c * MINI_CELL_W}
          y1={MINI_LABEL_H}
          x2={MINI_AXIS_W + c * MINI_CELL_W}
          y2={MINI_LABEL_H + rows * MINI_CELL_H}
          stroke="hsl(var(--border))"
          strokeWidth={0.5}
        />
      ))}

      {/* 行头：层级名（左侧竖条区域） */}
      {sortedLayers.map((layer, ri) => (
        <text
          key={`rh-${ri}`}
          x={MINI_AXIS_W / 2}
          y={MINI_LABEL_H + ri * MINI_CELL_H + MINI_CELL_H / 2 + 1}
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={9}
          fontWeight={600}
          fill="currentColor"
          style={{ pointerEvents: 'none' }}
        >
          {layer.label}
        </text>
      ))}

      {/* 依赖连线 */}
      {miniEdges.map((e, i) => (
        <line
          key={`me-${i}`}
          x1={e.x1}
          y1={e.y1}
          x2={e.x2}
          y2={e.y2}
          stroke="hsl(var(--primary) / 25%)"
          strokeWidth={1}
          markerEnd={`url(#${getMarkerId(e.row)})`}
        />
      ))}

      {/* 圆点 */}
      {sortedLayers.map((layer, _ri) => {
        const tasks = columnTasks.get(layer.key) ?? [];
        return tasks.map((t) => {
          const coord = taskCoords.get(t.taskName);
          if (!coord) return null;
          const isSelected = t.taskName === task.taskName;
          const color = TASK_TYPE_COLORS[t.taskType] || '#6b7280';
          return (
            <g
              key={`mc-${t.taskName}`}
              className="cursor-pointer"
              onClick={(e) => {
                e.stopPropagation();
                onClickNode(t.taskName);
              }}
            >
              {isSelected && (
                <circle
                  cx={coord.cx}
                  cy={coord.cy}
                  r={MINI_CIRCLE_R + 3}
                  fill="none"
                  stroke={color}
                  strokeWidth={2}
                  opacity={0.5}
                />
              )}
              <circle
                cx={coord.cx}
                cy={coord.cy}
                r={MINI_CIRCLE_R}
                fill={color}
                opacity={isSelected ? 1 : 0.7}
              />
              <text
                x={coord.cx}
                y={coord.cy}
                textAnchor="middle"
                dominantBaseline="central"
                fill="white"
                fontSize={MINI_CIRCLE_R * 0.85}
                fontWeight={600}
                style={{ pointerEvents: 'none' }}
              >
                {t.taskType === 'pyspark'
                  ? 'P'
                  : t.taskType === 'spark_sql'
                    ? 'S'
                    : t.taskType === 'python'
                      ? 'Py'
                      : t.taskType.charAt(0).toUpperCase()}
              </text>
              <title>{t.taskName}</title>
            </g>
          );
        });
      })}
    </svg>
  );
}

// ============================================================================
// 主组件
// ============================================================================
interface TaskLayerMatrixProps {
  tasks: PipelineTask[];
  taskNames: string[];
  layers: LayerDef[];
  className?: string;
}

export function TaskLayerMatrix({ tasks, taskNames, layers, className }: TaskLayerMatrixProps) {
  const safeTasks = tasks ?? [];
  const safeTaskNames = taskNames ?? [];
  const safeLayers = layers ?? [];

  // ── 共享依赖图 ──
  const depGraph = useMemo(() => {
    const outputByTable = new Map<string, Set<string>>();
    const inputsByTask = new Map<string, Set<string>>();
    const taskByName = new Map<string, PipelineTask>();
    for (const task of safeTasks) {
      taskByName.set(task.taskName, task);
      const outs = task.outputTable ? task.outputTable.split(', ').filter(Boolean) : [];
      for (const t of outs) {
        if (!outputByTable.has(t)) outputByTable.set(t, new Set());
        outputByTable.get(t)!.add(task.taskName);
      }
      const ins = task.inputTable ? task.inputTable.split(', ').filter(Boolean) : [];
      inputsByTask.set(task.taskName, new Set(ins));
    }
    return { outputByTable, inputsByTask, taskByName };
  }, [safeTasks]);

  // ── 过滤器状态 ──
  const [layerFilter, setLayerFilter] = useState<string | null>(null);
  const [tableNameSearch, setTableNameSearch] = useState('');
  const [exactMatch, setExactMatch] = useState(false);
  const [showTableSearch, setShowTableSearch] = useState(false);

  // ── 点击高亮状态 ──
  const [highlightedTask, setHighlightedTask] = useState<string | null>(null);

  // ── 高亮任务关联的上下游（点击时使用 tooltip 任务） ──
  const highlightedRelatedNames = useMemo(() => {
    if (!highlightedTask) return null;
    const related = new Set<string>();
    related.add(highlightedTask);
    // upstream
    const ins = depGraph.inputsByTask.get(highlightedTask) ?? [];
    for (const tb of ins) {
      for (const p of depGraph.outputByTable.get(tb) ?? []) {
        related.add(p);
      }
    }
    // downstream
    const curTask = depGraph.taskByName.get(highlightedTask);
    if (curTask?.outputTable) {
      for (const tb of curTask.outputTable.split(', ').filter(Boolean)) {
        for (const c of depGraph.outputByTable.get(tb) ?? []) {
          related.add(c);
        }
      }
    }
    return related;
  }, [highlightedTask, depGraph]);

  // ── 层级关联任务（仅上游） ──
  const layerConnectedTaskNames = useMemo(() => {
    if (layerFilter === null) return null;
    const seed = new Set(safeTasks.filter((t) => t.layer === layerFilter).map((t) => t.taskName));
    if (seed.size === 0) return new Set<string>();
    const visited = new Set<string>();
    const queue = Array.from(seed);
    for (const name of queue) visited.add(name);
    let head = 0;
    while (head < queue.length) {
      const current = queue[head++];
      for (const tb of depGraph.inputsByTask.get(current) ?? []) {
        for (const producer of depGraph.outputByTable.get(tb) ?? []) {
          if (!visited.has(producer)) {
            visited.add(producer);
            queue.push(producer);
          }
        }
      }
    }
    return visited;
  }, [safeTasks, layerFilter, depGraph]);

  // ── 模糊搜索：任务名 + 输入表名 + 输出表名 + workflow 名 ──
  const tableSearchTaskNames = useMemo(() => {
    const search = tableNameSearch.trim().toLowerCase();
    if (!search) return null;
    const seed = new Set<string>();
    for (const task of safeTasks) {
      const candidates = [
        task.taskName,
        task.inputTable ?? '',
        task.outputTable ?? '',
        task.workflowName ?? '',
      ];
      const joined = candidates.join('\x00').toLowerCase();
      if (exactMatch ? joined === search : joined.includes(search)) {
        seed.add(task.taskName);
      }
    }
    if (seed.size === 0) {
      return new Set<string>(); // empty set = show no tasks
    }
    // BFS expand: include upstream + downstream
    const visited = new Set<string>();
    const queue = Array.from(seed);
    for (const name of queue) visited.add(name);
    let head = 0;
    while (head < queue.length) {
      const current = queue[head++];
      const curTask = depGraph.taskByName.get(current);
      if (curTask?.outputTable) {
        for (const tb of curTask.outputTable.split(', ').filter(Boolean)) {
          for (const c of depGraph.outputByTable.get(tb) ?? []) {
            if (!visited.has(c)) {
              visited.add(c);
              queue.push(c);
            }
          }
        }
      }
      for (const tb of depGraph.inputsByTask.get(current) ?? []) {
        for (const p of depGraph.outputByTable.get(tb) ?? []) {
          if (!visited.has(p)) {
            visited.add(p);
            queue.push(p);
          }
        }
      }
    }
    return visited;
  }, [safeTasks, tableNameSearch, exactMatch, depGraph]);

  // ── 合并关联任务（搜索 + 层级筛选取交） ──
  const connectedTaskNames = useMemo(() => {
    const l = layerConnectedTaskNames;
    const t = tableSearchTaskNames;
    if (!l && !t) return null;
    if (!l) return t;
    if (!t) return l;
    const merged = new Set<string>();
    for (const n of l) {
      if (t.has(n)) merged.add(n);
    }
    return merged;
  }, [layerConnectedTaskNames, tableSearchTaskNames]);

  // ── 过滤后的 layers / taskNames ──
  const filteredLayers = useMemo(() => {
    let lyr = safeLayers;
    if (connectedTaskNames) {
      const active = new Set<string>();
      for (const t of safeTasks) {
        if (connectedTaskNames.has(t.taskName)) active.add(t.layer);
      }
      lyr = lyr.filter((l) => active.has(l.key));
    }
    return lyr;
  }, [safeLayers, safeTasks, connectedTaskNames]);

  const filteredTaskNames = useMemo(() => {
    let names = safeTaskNames;
    if (connectedTaskNames) names = names.filter((n) => connectedTaskNames.has(n));
    return names;
  }, [safeTaskNames, connectedTaskNames]);

  const rows = useMemo(() => {
    return filteredLayers.map((layer) => {
      const cells = filteredTaskNames
        .map((name) => safeTasks.filter((t) => t.taskName === name && t.layer === layer.key))
        .filter((g) => g.length > 0);
      return { layer, cells };
    });
  }, [safeTasks, filteredLayers, filteredTaskNames]);

  const MAX_COLS = useMemo(() => Math.max(...rows.map((r) => r.cells.length), 1), [rows]);

  // ── 层级分页：始终显示所有层级，不折叠 ──
  const maxLayerNum = useMemo(() => {
    let m = 0;
    for (const l of safeLayers) {
      const n = parseInt(l.key.replace(/^L/i, ''), 10);
      if (!isNaN(n) && n > m) m = n;
    }
    return m;
  }, [safeLayers]);

  const totalLayerCount = Math.max(10, maxLayerNum);
  const visibleLayerCount = totalLayerCount;

  const layerByKey = useMemo(() => {
    const m = new Map<string, LayerDef>();
    for (const l of safeLayers) m.set(l.key, l);
    return m;
  }, [safeLayers]);

  const rowByLayer = useMemo(() => {
    const m = new Map<string, { layer: LayerDef; cells: PipelineTask[][] }>();
    for (const r of rows) m.set(r.layer.key, r);
    return m;
  }, [rows]);

  const visibleRows = useMemo(() => {
    const result: { layer: LayerDef; cells: PipelineTask[][] }[] = [];
    for (let i = 1; i <= visibleLayerCount; i++) {
      const key = `L${i}`;
      const layer = layerByKey.get(key) ?? { key, label: key, type: 'logical' as const, order: i };
      const existing = rowByLayer.get(key);
      result.push(existing ?? { layer, cells: [] });
    }
    return result;
  }, [visibleLayerCount, layerByKey, rowByLayer]);

  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement>(null);

  // ── 弹窗状态：导航历史栈（最后一项是当前显示的任务） ──
  const [navStack, setNavStack] = useState<string[]>([]);
  const selectedTaskName = navStack.length > 0 ? navStack[navStack.length - 1] : null;
  const selectedTask = selectedTaskName
    ? (depGraph.taskByName.get(selectedTaskName) ?? null)
    : null;

  const pushNav = useCallback((name: string) => {
    setNavStack((prev) => {
      // 避免重复：如果已在栈中，截断到该位置再添加
      const idx = prev.lastIndexOf(name);
      if (idx >= 0) return [...prev.slice(0, idx + 1)];
      return [...prev, name];
    });
    setHighlightedTask(name);
  }, []);

  const popNav = useCallback(() => {
    setNavStack((prev) => {
      const next = prev.slice(0, -1);
      if (next.length > 0) setHighlightedTask(next[next.length - 1]);
      return next;
    });
  }, []);

  const closeModal = useCallback(() => {
    setNavStack([]);
    setHighlightedTask(null);
  }, []);

  const handleCircleClick = useCallback(
    (task: PipelineTask) => (e: React.MouseEvent<SVGGElement>) => {
      e.stopPropagation();
      if (selectedTaskName === task.taskName) {
        closeModal();
      } else {
        pushNav(task.taskName);
      }
    },
    [selectedTaskName, pushNav, closeModal]
  );
  useEffect(() => {
    if (!selectedTaskName) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('[data-matrix-circle]')) return;
      if (target.closest('[data-matrix-detail-modal]')) return;
      closeModal();
    };
    document.addEventListener('mousedown', handler, true);
    return () => document.removeEventListener('mousedown', handler, true);
  }, [selectedTaskName, closeModal]);

  // ── 选中任务的全链条上下游子图（BFS 所有可达祖先和后代） ──
  const subgraph = useMemo(() => {
    if (!selectedTask) return null;
    const task = selectedTask;
    const upstreamNames = new Set<string>();
    const downstreamNames = new Set<string>();
    const edgeSet = new Map<string, { from: string; to: string; via: string[] }>();

    const addEdge = (from: string, to: string, tableName: string) => {
      const key = `${from}|||${to}`;
      const existing = edgeSet.get(key);
      if (existing) {
        if (!existing.via.includes(tableName)) existing.via.push(tableName);
      } else {
        edgeSet.set(key, { from, to, via: [tableName] });
      }
    };

    // BFS 上游：从所有直接上游出发，继续往上追溯
    const bfsUpQueue: string[] = [];
    const visitedUp = new Set<string>();
    visitedUp.add(task.taskName);

    // 种子：直接上游
    const ins = task.inputTable ? task.inputTable.split(', ').filter(Boolean) : [];
    for (const tb of ins) {
      const producers = depGraph.outputByTable.get(tb);
      if (!producers) continue;
      for (const p of producers) {
        if (p === task.taskName) continue;
        addEdge(p, task.taskName, tb);
        if (!visitedUp.has(p)) {
          visitedUp.add(p);
          bfsUpQueue.push(p);
          upstreamNames.add(p);
        }
      }
    }

    while (bfsUpQueue.length > 0) {
      const cur = bfsUpQueue.shift()!;
      const curTask = depGraph.taskByName.get(cur);
      if (!curTask?.inputTable) continue;
      for (const tb of curTask.inputTable.split(', ').filter(Boolean)) {
        const producers = depGraph.outputByTable.get(tb);
        if (!producers) continue;
        for (const p of producers) {
          if (p === cur) continue;
          addEdge(p, cur, tb);
          if (!visitedUp.has(p)) {
            visitedUp.add(p);
            bfsUpQueue.push(p);
            upstreamNames.add(p);
          }
        }
      }
    }

    // BFS 下游：从所有直接下游出发，继续往下追溯
    const visitedDown = new Set<string>();
    visitedDown.add(task.taskName);

    const bfsDownQueue: string[] = [];
    const outs = task.outputTable ? task.outputTable.split(', ').filter(Boolean) : [];
    for (const tb of outs) {
      const consumers = depGraph.outputByTable.get(tb);
      if (!consumers) continue;
      for (const c of consumers) {
        if (c === task.taskName) continue;
        addEdge(task.taskName, c, tb);
        if (!visitedDown.has(c)) {
          visitedDown.add(c);
          bfsDownQueue.push(c);
          downstreamNames.add(c);
        }
      }
    }

    while (bfsDownQueue.length > 0) {
      const cur = bfsDownQueue.shift()!;
      const curTask = depGraph.taskByName.get(cur);
      if (!curTask?.outputTable) continue;
      for (const tb of curTask.outputTable.split(', ').filter(Boolean)) {
        const consumers = depGraph.outputByTable.get(tb);
        if (!consumers) continue;
        for (const c of consumers) {
          if (c === cur) continue;
          addEdge(cur, c, tb);
          if (!visitedDown.has(c)) {
            visitedDown.add(c);
            bfsDownQueue.push(c);
            downstreamNames.add(c);
          }
        }
      }
    }

    const upstream = Array.from(upstreamNames).sort();
    const downstream = Array.from(downstreamNames).sort();
    const edges = Array.from(edgeSet.values());
    return {
      upstream: upstream.map((n) => depGraph.taskByName.get(n)).filter(Boolean) as PipelineTask[],
      downstream: downstream
        .map((n) => depGraph.taskByName.get(n))
        .filter(Boolean) as PipelineTask[],
      edges,
    };
  }, [selectedTask, depGraph]);

  // Compact layout
  const CELL_W = 96;
  const CELL_H = 44;
  const AXIS_W = 60;
  const AXIS_H = 8;
  const CIRCLE_R = 13;
  const PADDING = 48;

  const svgW = AXIS_W + visibleLayerCount * CELL_W + PADDING;
  const svgH = AXIS_H + Math.max(safeTaskNames.length, 10) * CELL_H + PADDING;

  // ── Coordinate map (transposed: layers = columns L→R, scripts = rows T↓B) ──
  type Coord = { cx: number; cy: number; layerIdx: number; colIdx: number; subIdx: number };
  const coordMap = useMemo(() => {
    const map = new Map<string, Coord[]>();
    // Group tasks by layer, then assign vertical positions within each layer column
    const layerScripts = new Map<string, string[]>();
    for (const task of safeTasks) {
      if (!filteredTaskNames.includes(task.taskName)) continue;
      if (!layerScripts.has(task.layer)) layerScripts.set(task.layer, []);
      const arr = layerScripts.get(task.layer)!;
      if (!arr.includes(task.taskName)) arr.push(task.taskName);
    }
    const layerKeys = filteredLayers.map((l) => l.key);
    // Assign positions: X = layer column, Y = script row within layer

    for (let li = 0; li < layerKeys.length; li++) {
      const layerKey = layerKeys[li];
      const scripts = layerScripts.get(layerKey) ?? [];
      const colX = AXIS_W + li * CELL_W + CELL_W / 2;
      scripts.forEach((scriptName, si) => {
        const cy = AXIS_H + si * CELL_H + CELL_H / 2;
        if (!map.has(scriptName)) map.set(scriptName, []);
        map.get(scriptName)!.push({
          cx: colX,
          cy,
          layerIdx: li,
          colIdx: li,
          subIdx: si,
        });
      });
    }
    return map;
  }, [safeTasks, filteredLayers, filteredTaskNames, AXIS_W, CELL_W, CELL_H, AXIS_H]);

  // ── Dependency lines with arrow markers ──
  const MAX_DEP_LINES = 2000;
  const depLines = useMemo(() => {
    const seen = new Set<string>();
    const lines: {
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      fromName: string;
      toName: string;
    }[] = [];
    for (const task of safeTasks) {
      if (lines.length >= MAX_DEP_LINES) break;
      const inputs = depGraph.inputsByTask.get(task.taskName);
      if (!inputs || inputs.size === 0) continue;
      const toCoords = coordMap.get(task.taskName);
      if (!toCoords || toCoords.length === 0) continue;
      const to = toCoords[0];
      for (const input of inputs) {
        if (lines.length >= MAX_DEP_LINES) break;
        const sourceTasks = depGraph.outputByTable.get(input);
        if (!sourceTasks) continue;
        for (const srcName of sourceTasks) {
          if (srcName === task.taskName) continue;
          const fromCoords = coordMap.get(srcName);
          if (!fromCoords || fromCoords.length === 0) continue;
          const from = fromCoords[0];
          if (from.layerIdx < to.layerIdx) {
            const key = `${from.cx}|${from.cy}|${to.cx}|${to.cy}`;
            if (!seen.has(key)) {
              seen.add(key);
              // Shorten line to stop at arrow tip
              const dx = to.cx - from.cx;
              const dy = to.cy - from.cy;
              const len = Math.sqrt(dx * dx + dy * dy);
              const trim = CIRCLE_R + 5;
              const ratio = (len - trim) / (len || 1);
              lines.push({
                x1: from.cx,
                y1: from.cy,
                x2: from.cx + dx * ratio,
                y2: from.cy + dy * ratio,
                fromName: srcName,
                toName: task.taskName,
              });
            }
          }
        }
      }
    }
    return lines;
  }, [safeTasks, coordMap, depGraph]);

  const handleZoomIn = useCallback(() => setScale((s) => Math.min(s + 0.15, 2.5)), []);
  const handleZoomOut = useCallback(() => setScale((s) => Math.max(s - 0.15, 0.4)), []);
  const handleReset = useCallback(() => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  const isDragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const offsetStart = useRef({ x: 0, y: 0 });

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('[data-matrix-circle]')) return;
      isDragging.current = true;
      dragStart.current = { x: e.clientX, y: e.clientY };
      offsetStart.current = { ...offset };
    },
    [offset]
  );

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDragging.current) return;
    const dx = e.clientX - dragStart.current.x;
    const dy = e.clientY - dragStart.current.y;
    setOffset({ x: offsetStart.current.x + dx, y: offsetStart.current.y + dy });
  }, []);

  const handleMouseUp = useCallback(() => {
    isDragging.current = false;
  }, []);

  return (
    <div className={`flex flex-col h-full w-full bg-background ${className ?? ''}`}>
      {/* 工具栏 */}
      <div className="flex items-center justify-between border-b border-border bg-muted/10 px-4 py-1.5 shrink-0 gap-2">
        <div className="flex items-center gap-2">
          <Legend />

          <select
            className="h-7 text-xs border border-border rounded bg-background px-2 text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            value={layerFilter ?? ''}
            onChange={(e) => setLayerFilter(e.target.value || null)}
          >
            <option value="">全部层级</option>
            {safeLayers.map((l) => (
              <option key={l.key} value={l.key}>
                {l.label}
              </option>
            ))}
          </select>

          {!showTableSearch ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-muted-foreground"
              onClick={() => setShowTableSearch(true)}
            >
              <Search className="h-3.5 w-3.5 mr-1" />
              搜索
            </Button>
          ) : (
            <div className="flex items-center gap-1">
              <input
                className="h-7 w-48 text-xs border border-border rounded bg-background px-2 text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                placeholder="任务名/表名..."
                value={tableNameSearch}
                onChange={(e) => setTableNameSearch(e.target.value)}
              />
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                onClick={() => {
                  setShowTableSearch(false);
                  setTableNameSearch('');
                  setExactMatch(false);
                }}
                title="清除搜索"
              >
                <span className="text-xs">&#x2715;</span>
              </Button>
            </div>
          )}
        </div>

        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={handleZoomOut}
            title="缩小"
          >
            <ZoomOut className="h-3.5 w-3.5" />
          </Button>
          <span className="text-[11px] text-muted-foreground w-10 text-center tabular-nums">
            {Math.round(scale * 100)}%
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={handleZoomIn}
            title="放大"
          >
            <ZoomIn className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={handleReset}
            title="重置"
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* 矩阵区域 */}
      <div
        ref={containerRef}
        className="flex-1 overflow-auto cursor-grab active:cursor-grabbing relative"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onWheel={(e) => {
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            const delta = -e.deltaY * 0.001;
            setScale((prev) => Math.min(3, Math.max(0.3, prev + delta * prev)));
          }
        }}
      >
        <div
          className="origin-top-left"
          style={{
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
            width: svgW,
            height: svgH,
          }}
        >
          <svg width={svgW} height={svgH} className="block">
            {/* Arrow marker definition */}
            <defs>
              <marker
                id={ARROW_MARKER_ID}
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill="hsl(var(--primary) / 40%)" />
              </marker>
            </defs>

            {/* 列背景 (layers = vertical bands) */}
            {visibleRows.map((row, x) => (
              <rect
                key={`bg-${row.layer.key}`}
                x={AXIS_W + x * CELL_W}
                y={AXIS_H}
                width={CELL_W}
                height={Math.max(safeTaskNames.length, 10) * CELL_H}
                fill={getLayerBg(row.layer.key)}
              />
            ))}

            {/* 垂直分隔线 */}
            {visibleRows.map((_, x) => (
              <line
                key={`v-${x}`}
                x1={AXIS_W + x * CELL_W}
                y1={AXIS_H}
                x2={AXIS_W + x * CELL_W}
                y2={AXIS_H + Math.max(safeTaskNames.length, 10) * CELL_H}
                stroke="hsl(var(--border))"
                strokeWidth={0.5}
              />
            ))}
            <line
              x1={AXIS_W}
              y1={AXIS_H + visibleRows.length * CELL_H}
              x2={AXIS_W + MAX_COLS * CELL_W}
              y2={AXIS_H + visibleRows.length * CELL_H}
              stroke="hsl(var(--border))"
              strokeWidth={0.5}
            />

            {/* X 轴 — 逻辑层级 (column headers, rotated) */}
            {visibleRows.map((row, x) => (
              <g key={`x-${row.layer.key}`}>
                <text
                  x={AXIS_W + x * CELL_W + CELL_W / 2}
                  y={AXIS_H - 2}
                  textAnchor="middle"
                  fontSize={11}
                  fontWeight={700}
                  fill="currentColor"
                >
                  {row.layer.label}
                </text>
              </g>
            ))}

            {/* X 轴顶部细线 */}
            <line
              x1={AXIS_W}
              y1={AXIS_H}
              x2={AXIS_W + MAX_COLS * CELL_W}
              y2={AXIS_H}
              stroke="hsl(var(--border))"
              strokeWidth={1}
            />

            {/* 依赖连线 — 带箭头，高亮相关连线 */}
            {depLines.map((line, i) => {
              const isRelated =
                highlightedRelatedNames === null ||
                (highlightedRelatedNames.has((line as any).fromName) &&
                  highlightedRelatedNames.has((line as any).toName));
              return (
                <line
                  key={`dep-${i}`}
                  x1={line.x1}
                  y1={line.y1}
                  x2={line.x2}
                  y2={line.y2}
                  stroke={`hsl(var(--primary) / ${isRelated ? '35%' : '6%'})`}
                  strokeWidth={isRelated ? 1.8 : 0.8}
                  markerEnd={isRelated ? `url(#${ARROW_MARKER_ID})` : undefined}
                />
              );
            })}

            {/* 任务圆点 */}
            {visibleRows.map((row, y) =>
              row.cells.map((cellTasks, x) => {
                const cx = AXIS_W + x * CELL_W + CELL_W / 2;
                const baseY = AXIS_H + y * CELL_H + CELL_H / 2;
                const count = cellTasks.length;

                if (count === 1) {
                  const task = cellTasks[0];
                  const dimmed =
                    highlightedRelatedNames !== null && !highlightedRelatedNames.has(task.taskName);
                  return (
                    <g key={`t-${x}-${y}`}>
                      <g transform={`translate(${cx}, ${baseY})`}>
                        <TaskCircle
                          task={task}
                          size={CIRCLE_R * 2}
                          dimmed={dimmed}
                          onClick={handleCircleClick(task)}
                        />
                      </g>
                    </g>
                  );
                }

        const spacing = CIRCLE_R * 2.4;
                const startX = -((count - 1) * spacing) / 2;
                return cellTasks.map((task, i) => {
                  const dimmed =
                    highlightedRelatedNames !== null && !highlightedRelatedNames.has(task.taskName);
                  return (
                    <g
                      key={`t-${x}-${y}-${i}`}
                      transform={`translate(${cx + startX + i * spacing}, ${baseY})`}
                    >
                      <TaskCircle
                        task={task}
                        size={CIRCLE_R * 2}
                        dimmed={dimmed}
                        onClick={handleCircleClick(task)}
                      />
                    </g>
                  );
                });
              })
            )}
          </svg>
        </div>

        {/* 详情弹窗 — 左侧上下游关系图 + 右侧任务信息 */}
        {selectedTask &&
          createPortal(
            <div
              data-matrix-detail-modal="true"
              className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/20"
              onMouseDown={(e) => {
                const target = e.target as HTMLElement;
                if (!target.closest('[data-matrix-detail-card]')) {
                  closeModal();
                }
              }}
            >
              <div
                data-matrix-detail-card="true"
                className="bg-popover text-popover-foreground rounded-lg border shadow-xl max-h-[80vh] w-[900px] max-w-[95vw] flex flex-col"
              >
                {/* 标题栏：面包屑导航 + 关闭 */}
                <div className="flex items-center justify-between px-4 py-2.5 border-b border-border shrink-0 gap-2">
                  <div className="flex items-center gap-1 min-w-0 overflow-x-auto">
                    {/* 返回按钮 */}
                    {navStack.length > 1 && (
                      <button
                        className="flex-shrink-0 rounded-sm p-0.5 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors mr-1"
                        onClick={(e) => {
                          e.stopPropagation();
                          popNav();
                        }}
                        title="返回"
                      >
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <polyline points="15 18 9 12 15 6" />
                        </svg>
                      </button>
                    )}
                    {/* 面包屑 */}
                    {navStack.map((name, idx) => {
                      const isLast = idx === navStack.length - 1;
                      return (
                        <span key={idx} className="flex items-center gap-1 min-w-0">
                          {idx > 0 && (
                            <span className="text-muted-foreground text-[10px] mx-0.5">›</span>
                          )}
                          <button
                            className={`text-xs truncate max-w-[160px] ${isLast ? 'font-semibold text-sm cursor-default' : 'text-muted-foreground hover:text-foreground hover:underline cursor-pointer'}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              if (!isLast) pushNav(name);
                            }}
                            disabled={isLast}
                          >
                            {name}
                          </button>
                        </span>
                      );
                    })}
                  </div>
                  <button
                    className="flex-shrink-0 rounded-sm p-0.5 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                    onClick={(e) => {
                      e.stopPropagation();
                      closeModal();
                    }}
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </div>

                {/* 内容区 — 左右分栏 */}
                <div className="flex flex-col sm:flex-row flex-1 min-h-0 overflow-hidden">
                  {/* 左侧：分层矩阵子图 */}
                  <div className="flex-1 min-w-0 min-h-[280px] border-b sm:border-b-0 sm:border-r border-border bg-muted/5 overflow-auto p-2">
                    <MiniTaskMatrix
                      task={selectedTask}
                      subgraph={subgraph}
                      layers={safeLayers}
                      depGraph={depGraph}
                      onClickNode={(name) => {
                        const t = depGraph.taskByName.get(name);
                        if (t) pushNav(name);
                      }}
                    />
                  </div>

                  {/* 右侧：任务详情 */}
                  <div className="w-full sm:w-72 shrink-0 overflow-y-auto px-4 py-3 text-xs space-y-2">
                    <div className="whitespace-nowrap">
                      <span className="text-muted-foreground">类型:</span>{' '}
                      <span className="font-mono font-medium">{selectedTask.taskType}</span>
                    </div>
                    <div className="whitespace-nowrap">
                      <span className="text-muted-foreground">层级:</span>{' '}
                      <span className="font-mono font-medium">{selectedTask.layer}</span>
                    </div>
                    {(() => {
                      const ins = selectedTask.inputTable
                        ? selectedTask.inputTable.split(', ').filter(Boolean)
                        : [];
                      return (
                        <div>
                          <span className="text-muted-foreground whitespace-nowrap">
                            输入表 ({ins.length}):
                          </span>
                          {ins.length === 0 ? (
                            <span className="font-mono text-[11px] ml-1 text-muted-foreground">
                              —
                            </span>
                          ) : (
                            <div className="mt-0.5 space-y-px max-h-24 overflow-y-auto">
                              {ins.map((t, i) => (
                                <div key={i} className="font-mono text-[11px] whitespace-nowrap">
                                  {t}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })()}
                    {(() => {
                      const outs = selectedTask.outputTable
                        ? selectedTask.outputTable.split(', ').filter(Boolean)
                        : [];
                      return (
                        <div>
                          <span className="text-muted-foreground whitespace-nowrap">
                            输出表 ({outs.length}):
                          </span>
                          {outs.length === 0 ? (
                            <span className="font-mono text-[11px] ml-1 text-muted-foreground">
                              —
                            </span>
                          ) : (
                            <div className="mt-0.5 space-y-px max-h-24 overflow-y-auto">
                              {outs.map((t, i) => (
                                <div key={i} className="font-mono text-[11px] whitespace-nowrap">
                                  {t}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })()}
                    {selectedTask.schedule && (
                      <>
                        <div className="border-t border-border pt-2 mt-2 space-y-1.5">
                          <div className="flex items-center gap-1.5">
                            <span className="text-muted-foreground">WeData:</span>
                            <span
                              className="font-mono text-[11px]"
                              style={{ color: STATUS_COLORS[selectedTask.schedule.wedataStatus] }}
                            >
                              {selectedTask.schedule.wedataStatus}
                            </span>
                          </div>
                          <div className="flex items-center gap-1.5">
                            <span className="text-muted-foreground">Airflow:</span>
                            <span
                              className="font-mono text-[11px]"
                              style={{ color: STATUS_COLORS[selectedTask.schedule.airflowStatus] }}
                            >
                              {selectedTask.schedule.airflowStatus}
                            </span>
                          </div>
                          <div className="whitespace-nowrap">
                            <span className="text-muted-foreground">调度:</span>{' '}
                            <span className="font-mono text-[11px]">
                              {selectedTask.schedule.wedataSchedule}
                            </span>
                          </div>
                          <div>
                            <span className="text-muted-foreground whitespace-nowrap">脚本:</span>{' '}
                            <span className="font-mono text-[11px] break-all">
                              {selectedTask.schedule.scriptPath}
                            </span>
                          </div>
                          {selectedTask.schedule.scriptChanged && (
                            <div className="text-amber-400 font-semibold">脚本已变更</div>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                </div>
              </div>
            </div>,
            document.body
          )}
      </div>
    </div>
  );
}
