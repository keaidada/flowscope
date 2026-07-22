import { BaseEdge, EdgeLabelRenderer, getBezierPath, Position, type EdgeProps, useInternalNode } from '@xyflow/react';
import type { ScriptNodeData } from '@pondpilot/flowscope-react';
import { shouldHighlightEdge, onHighlightChange } from './highlightState';
import { computeScriptNodeLayout } from './scriptNodeLayout';
import { getHandleY } from './handlePositionCache';
import { useState, useEffect, useMemo } from 'react';

export function TableEdge({ id, source, target, data, markerEnd }: EdgeProps) {
  const [, force] = useState(0);
  useEffect(() => { onHighlightChange(() => force(n => n + 1)); }, []);

  const src = useInternalNode(source);
  const tgt = useInternalNode(target);
  const tn = data?.table as string | undefined;
  const sd = src?.data as ScriptNodeData | undefined;
  const td = tgt?.data as ScriptNodeData | undefined;

  // Compute layouts as fallback when DOM measurement isn't available yet
  const srcLayout = useMemo(() => {
    if (!sd) return null;
    const og = (sd as Record<string, unknown>).outputGroups as ScriptNodeData['outputGroups'] | undefined;
    return computeScriptNodeLayout(og, sd.tableNamesRead ?? [], sd.tableNamesWritten ?? []);
  }, [sd]);

  const tgtLayout = useMemo(() => {
    if (!td) return null;
    const og = (td as Record<string, unknown>).outputGroups as ScriptNodeData['outputGroups'] | undefined;
    return computeScriptNodeLayout(og, td.tableNamesRead ?? [], td.tableNamesWritten ?? []);
  }, [td]);

  // Use DOM-measured positions from cache, fall back to computed layout
  const sx = (src?.internals?.positionAbsolute?.x ?? 0) + (src?.measured?.width ?? 240);
  const sy = getHandleY(source, 'w', tn ?? '') ?? srcLayout?.writeHandleY.get(tn ?? '') ?? 26;
  const syAbs = (src?.internals?.positionAbsolute?.y ?? 0) + sy;
  const tx = tgt?.internals?.positionAbsolute?.x ?? 0;
  const ty = getHandleY(target, 'r', tn ?? '') ?? tgtLayout?.readHandleY.get(tn ?? '') ?? 26;
  const tyAbs = (tgt?.internals?.positionAbsolute?.y ?? 0) + ty;

  // Parallel edge offset: spread curvature based on index among edges between the same pair
  const d = (data ?? {}) as Record<string, unknown>;
  const parallelIndex = typeof d._parallelIndex === 'number' ? d._parallelIndex : 0;
  const parallelTotal = typeof d._parallelTotal === 'number' ? d._parallelTotal : 1;
  const curvature = parallelTotal > 1
    ? 0.15 + (parallelIndex / (parallelTotal - 1)) * 0.3
    : 0.25;

  const [ep, lx, ly] = getBezierPath({
    sourceX: sx, sourceY: syAbs, targetX: tx, targetY: tyAbs,
    sourcePosition: Position.Right, targetPosition: Position.Left,
    curvature,
  });
  const sn = tn?.split('.').pop() ?? '';

  // 方向性高亮：读行 → 只高亮连到自己（target）的写者边；写行 → 只高亮自己（source）连出的读者边
  const srcScript = sd?.sourceName ?? '';
  const tgtScript = td?.sourceName ?? '';
  const isHL = shouldHighlightEdge(tn ?? '', srcScript, tgtScript);

  const strokeColor = isHL ? '#f59e0b' : '#b1b1b7';
  const strokeW = isHL ? 3 : 1.5;

  // Label Y offset: stagger labels for parallel edges
  const labelYOffset = parallelTotal > 1
    ? (parallelIndex - (parallelTotal - 1) / 2) * 14
    : 0;

  return (
    <>
      <BaseEdge id={id} path={ep} markerEnd={markerEnd} style={{ stroke: strokeColor, strokeWidth: strokeW, animation: 'none' }} />
      <EdgeLabelRenderer>
        <div className="absolute text-[10px] px-1 py-0.5 rounded border" style={{
          transform: `translate(-50%,-50%) translate(${lx}px,${ly + labelYOffset}px)`,
          backgroundColor: isHL ? '#fef3c7' : 'rgba(255,255,255,0.8)',
          color: isHL ? '#92400e' : '',
          borderColor: isHL ? '#f59e0b' : '',
        }}>
          {sn}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
