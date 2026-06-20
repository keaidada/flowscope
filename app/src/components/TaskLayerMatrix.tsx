import { useMemo, useState, useRef, useCallback } from 'react';
import { ZoomIn, ZoomOut, Maximize2 } from 'lucide-react';
import { Button } from './ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from './ui/tooltip';
import {
  buildPipelineTasks,
  buildMatrixGrid,
} from '@/data/mock-pipeline';
import type { PipelineTask } from '@/types/pipeline-matrix';

// ============================================================================
// 颜色映射
// ============================================================================
const TASK_TYPE_COLORS: Record<string, string> = {
  pyspark: '#3b82f6', // blue
  spark_sql: '#8b5cf6', // violet
  python: '#10b981', // emerald
  shell: '#f59e0b', // amber
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
            {/* 外环 — 状态 */}
            <circle
              cx={0}
              cy={0}
              r={size / 2 + 2}
              fill="none"
              stroke={statusColor}
              strokeWidth={2}
              opacity={0.8}
            />
            {/* 主体圆 */}
            <circle cx={0} cy={0} r={size / 2} fill={color} opacity={0.85} />
            {/* 类型首字母 */}
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
          <div className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-muted-foreground">
            <span>类型:</span>
            <span className="font-mono">{task.taskType}</span>
            <span>工作流:</span>
            <span>{task.workflowName}</span>
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
  const grid = useMemo(
    () => buildMatrixGrid(tasks, taskNames, layers),
    [tasks, taskNames, layers]
  );

  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement>(null);

  // 布局参数
  const CELL_W = 86;
  const CELL_H = 62;
  const AXIS_W = 120; // Y 轴标签宽度
  const AXIS_H = 36; // X 轴标签高度
  const CIRCLE_R = 11;
  const PADDING = 20;

  const svgW = AXIS_W + taskNames.length * CELL_W + PADDING;
  const svgH = AXIS_H + layers.length * CELL_H + PADDING;

  // 缩放
  const handleZoomIn = useCallback(() => setScale((s) => Math.min(s + 0.15, 2.5)), []);
  const handleZoomOut = useCallback(() => setScale((s) => Math.max(s - 0.15, 0.4)), []);
  const handleReset = useCallback(() => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  // 鼠标拖拽平移
  const isDragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const offsetStart = useRef({ x: 0, y: 0 });

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    isDragging.current = true;
    dragStart.current = { x: e.clientX, y: e.clientY };
    offsetStart.current = { ...offset };
  }, [offset]);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!isDragging.current) return;
      const dx = e.clientX - dragStart.current.x;
      const dy = e.clientY - dragStart.current.y;
      setOffset({ x: offsetStart.current.x + dx, y: offsetStart.current.y + dy });
    },
    []
  );

  const handleMouseUp = useCallback(() => {
    isDragging.current = false;
  }, []);

  return (
    <div className={`flex flex-col h-full w-full bg-background ${className ?? ''}`}>
      {/* 工具栏 */}
      <div className="flex items-center justify-between border-b border-border bg-muted/10 px-4 py-1.5 shrink-0">
        <Legend />
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
        className="flex-1 overflow-hidden cursor-grab active:cursor-grabbing"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        <div
          className="origin-top-left"
          style={{
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
          }}
        >
          <svg
            width={svgW}
            height={svgH}
            className="block"
            style={{ minWidth: svgW, minHeight: svgH }}
          >
            {/* 行背景（层级底色） */}
            {layers.map((layer, y) => (
              <rect
                key={`bg-${layer.key}`}
                x={AXIS_W}
                y={AXIS_H + y * CELL_H}
                width={taskNames.length * CELL_W}
                height={CELL_H}
                fill={LAYER_BG_COLORS[layer.key] || 'transparent'}
              />
            ))}

            {/* 网格线 */}
            {layers.map((_, y) => (
              <line
                key={`h-${y}`}
                x1={AXIS_W}
                y1={AXIS_H + y * CELL_H}
                x2={AXIS_W + taskNames.length * CELL_W}
                y2={AXIS_H + y * CELL_H}
                stroke="hsl(var(--border))"
                strokeWidth={0.5}
              />
            ))}
            {taskNames.map((_, x) => (
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

            {/* X 轴标签（脚本名） */}
            {taskNames.map((name, x) => (
              <g key={`x-${x}`}>
                <text
                  x={AXIS_W + x * CELL_W + CELL_W / 2}
                  y={AXIS_H - 10}
                  textAnchor="start"
                  dominantBaseline="auto"
                  fontSize={12}
                  fontWeight={500}
                  fill="currentColor"
                  transform={`rotate(-30, ${AXIS_W + x * CELL_W + CELL_W / 2}, ${AXIS_H - 10})`}
                >
                  {name.length > 20 ? name.slice(0, 18) + '…' : name}
                </text>
              </g>
            ))}

            {/* Y 轴标签（层级） */}
            {layers.map((layer, y) => (
              <g key={`y-${layer.key}`}>
                <rect
                  x={4}
                  y={AXIS_H + y * CELL_H + 6}
                  width={AXIS_W - 12}
                  height={CELL_H - 12}
                  rx={4}
                  fill={LAYER_BG_COLORS[layer.key] || 'transparent'}
                  stroke="hsl(var(--border))"
                  strokeWidth={0.5}
                />
                <text
                  x={AXIS_W / 2}
                  y={AXIS_H + y * CELL_H + CELL_H / 2}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize={12}
                  fontWeight={600}
                  fill="currentColor"
                >
                  {layer.label}
                </text>
              </g>
            ))}

            {/* 任务圆点 */}
            <TooltipProvider delayDuration={100}>
              {grid.map((row, y) =>
                row.map((cell, x) => {
                  if (cell.tasks.length === 0) return null;
                  const cx = AXIS_W + x * CELL_W + CELL_W / 2;
                  const cy = AXIS_H + y * CELL_H + CELL_H / 2;
                  const count = cell.tasks.length;

                  if (count === 1) {
                    return (
                      <g
                        key={`t-${x}-${y}`}
                        transform={`translate(${cx}, ${cy})`}
                      >
                        <TaskCircle task={cell.tasks[0]} size={CIRCLE_R * 2} />
                      </g>
                    );
                  }

                  // 多任务并排
                  const spacing = CIRCLE_R * 2.8;
                  const startX = -((count - 1) * spacing) / 2;
                  return cell.tasks.map((task, i) => (
                    <g
                      key={`t-${x}-${y}-${i}`}
                      transform={`translate(${cx + startX + i * spacing}, ${cy})`}
                    >
                      <TaskCircle task={task} size={CIRCLE_R * 2} />
                    </g>
                  ));
                })
              )}

              {/* 数据流箭头（输入→输出 连线，仅同一层级内展示） */}
              {tasks.map((task) => {
                // 找到 input → 当前 task 的数据流
                const inputTask = tasks.find(
                  (t) =>
                    t.outputTable === task.inputTable &&
                    t.taskName !== task.taskName
                );
                if (!inputTask) return null;

                const fromX = taskNames.indexOf(inputTask.taskName);
                const toX = taskNames.indexOf(task.taskName);
                const layerY = layers.findIndex((l) => l.key === task.layer);
                if (fromX < 0 || toX < 0 || layerY < 0) return null;
                // 只在相邻列之间画箭头
                if (Math.abs(toX - fromX) > 3 || fromX === toX) return null;

                const cy = AXIS_H + layerY * CELL_H + CELL_H / 2;
                const x1 = AXIS_W + fromX * CELL_W + CELL_W;
                const x2 = AXIS_W + toX * CELL_W;
                const mx = (x1 + x2) / 2;
                const path = `M${x1},${cy} C${mx},${cy - 8} ${mx},${cy - 8} ${x2},${cy}`;

                return (
                  <g key={`flow-${inputTask.id}-${task.id}`}>
                    <path
                      d={path}
                      fill="none"
                      stroke="hsl(var(--muted-foreground) / 0.25)"
                      strokeWidth={1}
                      markerEnd="url(#arrowhead)"
                    />
                  </g>
                );
              })}
            </TooltipProvider>

            {/* 箭头标记 */}
            <defs>
              <marker
                id="arrowhead"
                viewBox="0 0 10 10"
                refX={8}
                refY={5}
                markerWidth={6}
                markerHeight={6}
                orient="auto-start-reverse"
              >
                <path
                  d="M0,0 L10,5 L0,10 Z"
                  fill="hsl(var(--muted-foreground) / 0.3)"
                />
              </marker>
            </defs>
          </svg>
        </div>
      </div>
    </div>
  );
}
