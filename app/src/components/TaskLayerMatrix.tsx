import { useMemo, useState, useRef, useCallback } from 'react';
import { ZoomIn, ZoomOut, Maximize2 } from 'lucide-react';
import { Button } from './ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from './ui/tooltip';
import { buildPipelineTasks } from '@/data/mock-pipeline';
import type { PipelineTask } from '@/types/pipeline-matrix';

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
  L4: 'rgba(245, 158, 11, 0.06)',
  L3: 'rgba(34, 197, 94, 0.06)',
  L2: 'rgba(59, 130, 246, 0.06)',
  L1: 'rgba(139, 92, 246, 0.06)',
  L0: 'rgba(236, 72, 153, 0.06)',
};

// ============================================================================
// 单个任务圆点
// ============================================================================
function TaskCircle({ task, size }: { task: PipelineTask; size: number }) {
  const color = TASK_TYPE_COLORS[task.taskType] || '#6b7280';
  const statusColor = task.schedule
    ? STATUS_COLORS[task.schedule.wedataStatus] || '#9ca3af'
    : '#9ca3af';

  return (
    <TooltipProvider delayDuration={100}>
      <Tooltip>
        <TooltipTrigger asChild>
          <g
            className="cursor-pointer transition-transform hover:scale-125"
            style={{ transformOrigin: 'center' }}
          >
            <circle
              cx={0}
              cy={0}
              r={size / 2 + 2}
              fill="none"
              stroke={statusColor}
              strokeWidth={2}
              opacity={0.8}
            />
            <circle cx={0} cy={0} r={size / 2} fill={color} opacity={0.85} />
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
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs text-xs p-3 space-y-1.5">
          <div className="font-semibold text-sm">{task.taskName}</div>
          <div className="text-[11px] text-muted-foreground">{task.workflowName}</div>
          <div className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-muted-foreground">
            <span>类型:</span>
            <span className="font-mono">{task.taskType}</span>
            <span>层级:</span>
            <span className="font-mono">{task.layer}</span>
            <span>输入:</span>
            <span className="font-mono text-[11px] truncate max-w-[180px]">
              {task.inputTable}
            </span>
            <span>输出:</span>
            <span className="font-mono text-[11px] truncate max-w-[180px]">
              {task.outputTable}
            </span>
            {task.schedule && (
              <>
                <span>WeData:</span>
                <span
                  className="font-mono"
                  style={{ color: STATUS_COLORS[task.schedule.wedataStatus] }}
                >
                  {task.schedule.wedataStatus}
                </span>
                <span>Airflow:</span>
                <span
                  className="font-mono"
                  style={{ color: STATUS_COLORS[task.schedule.airflowStatus] }}
                >
                  {task.schedule.airflowStatus}
                </span>
                <span>调度:</span>
                <span className="font-mono text-[11px]">
                  {task.schedule.wedataSchedule}
                </span>
                <span>脚本:</span>
                <span className="font-mono text-[11px] truncate max-w-[180px]">
                  {task.schedule.scriptPath}
                </span>
                {task.schedule.scriptChanged && (
                  <>
                    <span />
                    <span className="text-amber-400 font-semibold">⚠ 脚本已变更</span>
                  </>
                )}
              </>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
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
// 主组件
// ============================================================================
export function TaskLayerMatrix({ className }: { className?: string }) {
  const { tasks, layers, taskNames } = useMemo(() => buildPipelineTasks(), []);

  // 按层级分组：每个 (taskName, layer) 组合一个 cell
  const rows = useMemo(() => {
    return layers.map((layer) => {
      // 该层级下所有任务，按 taskName 排序 → 每任务一列
      const cells = taskNames
        .map((name) => tasks.filter((t) => t.taskName === name && t.layer === layer.key))
        .filter((group) => group.length > 0);
      return { layer, cells };
    });
  }, [tasks, layers, taskNames]);

  const MAX_COLS = useMemo(
    () => Math.max(...rows.map((r) => r.cells.length), 1),
    [rows]
  );

  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement>(null);

  const CELL_W = 46;
  const CELL_H = 44;
  const AXIS_W = 68;
  const AXIS_H = 12; // minimal header, no labels
  const CIRCLE_R = 10;
  const PADDING = 20;

  const svgW = AXIS_W + MAX_COLS * CELL_W + PADDING;
  const svgH = AXIS_H + layers.length * CELL_H + PADDING;

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
      <div className="flex items-center justify-between border-b border-border bg-muted/10 px-4 py-1.5 shrink-0">
        <Legend />
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={handleZoomOut} title="缩小">
            <ZoomOut className="h-3.5 w-3.5" />
          </Button>
          <span className="text-[11px] text-muted-foreground w-10 text-center tabular-nums">
            {Math.round(scale * 100)}%
          </span>
          <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={handleZoomIn} title="放大">
            <ZoomIn className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={handleReset} title="重置">
            <Maximize2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* 矩阵区域 */}
      <div
        ref={containerRef}
        className="flex-1 overflow-hidden cursor-grab active:cursor-grabbing"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        <div
          className="origin-top-left"
          style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})` }}
        >
          <svg
            width={svgW}
            height={svgH}
            className="block"
            style={{ minWidth: svgW, minHeight: svgH }}
          >
            {/* 行背景 */}
            {layers.map((layer, y) => (
              <rect
                key={`bg-${layer.key}`}
                x={AXIS_W}
                y={AXIS_H + y * CELL_H}
                width={MAX_COLS * CELL_W}
                height={CELL_H}
                fill={LAYER_BG_COLORS[layer.key] || 'transparent'}
              />
            ))}

            {/* 水平分隔线 */}
            {layers.map((_, y) => (
              <line
                key={`h-${y}`}
                x1={AXIS_W}
                y1={AXIS_H + y * CELL_H}
                x2={AXIS_W + MAX_COLS * CELL_W}
                y2={AXIS_H + y * CELL_H}
                stroke="hsl(var(--border))"
                strokeWidth={0.5}
              />
            ))}
            <line
              x1={AXIS_W}
              y1={AXIS_H + layers.length * CELL_H}
              x2={AXIS_W + MAX_COLS * CELL_W}
              y2={AXIS_H + layers.length * CELL_H}
              stroke="hsl(var(--border))"
              strokeWidth={0.5}
            />

            {/* 垂直分隔线（均匀宽度） */}
            {Array.from({ length: MAX_COLS + 1 }, (_, x) => (
              <line
                key={`v-${x}`}
                x1={AXIS_W + x * CELL_W}
                y1={AXIS_H}
                x2={AXIS_W + x * CELL_W}
                y2={AXIS_H + layers.length * CELL_H}
                stroke="hsl(var(--border))"
                strokeWidth={0.5}
              />
            ))}

            {/* Y 轴 — 逻辑层级 */}
            {layers.map((layer, y) => (
              <g key={`y-${layer.key}`}>
                <text
                  x={AXIS_W / 2}
                  y={AXIS_H + y * CELL_H + CELL_H / 2}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize={13}
                  fontWeight={700}
                  fill="currentColor"
                >
                  {layer.key}
                </text>
              </g>
            ))}

            {/* X 轴 — 无标签，仅顶部细线 */}
            <line
              x1={AXIS_W}
              y1={AXIS_H}
              x2={AXIS_W + MAX_COLS * CELL_W}
              y2={AXIS_H}
              stroke="hsl(var(--border))"
              strokeWidth={1}
            />

            {/* 任务圆点 */}
            {rows.map((row, y) =>
              row.cells.map((cellTasks, x) => {
                const cx = AXIS_W + x * CELL_W + CELL_W / 2;
                const cy = AXIS_H + y * CELL_H + CELL_H / 2;
                const count = cellTasks.length;

                if (count === 1) {
                  return (
                    <g key={`t-${x}-${y}`} transform={`translate(${cx}, ${cy})`}>
                      <TaskCircle task={cellTasks[0]} size={CIRCLE_R * 2} />
                    </g>
                  );
                }

                const spacing = CIRCLE_R * 2.6;
                const startX = -((count - 1) * spacing) / 2;
                return cellTasks.map((task, i) => (
                  <g
                    key={`t-${x}-${y}-${i}`}
                    transform={`translate(${cx + startX + i * spacing}, ${cy})`}
                  >
                    <TaskCircle task={task} size={CIRCLE_R * 2} />
                  </g>
                ));
              })
            )}
          </svg>
        </div>
      </div>
    </div>
  );
}
