import { BaseEdge, EdgeLabelRenderer, getBezierPath, Position, type EdgeProps, useInternalNode } from '@xyflow/react';
import type { ScriptNodeData } from '@pondpilot/flowscope-react';
import { getHighlightedTable, onHighlightChange } from './highlightState';
import { useState, useEffect } from 'react';

const ROW = 22;

function rowY(idx: number, readsLen: number, isWrite: boolean): number {
  if (isWrite) {
    return 95 + Math.max(readsLen, 1) * ROW + 34 + idx * ROW;
  }
  return 95 + idx * ROW;
}

/**
 * 数据洞察边：完全不用 React Flow 传的 sourceX/Y（Handle bug 时会错误回退到节点中心）。
 * 自己用 useInternalNode 拿到真实宽高计算连接点。
 */
export function TableEdge({ id, source, target, data, markerEnd }: EdgeProps) {
  const [, force] = useState(0);
  useEffect(() => { onHighlightChange(() => force(n => n + 1)); }, []);

  const src = useInternalNode(source);
  const tgt = useInternalNode(target);
  const tn = data?.table as string | undefined;
  const sd = src?.data as ScriptNodeData | undefined;
  const td = tgt?.data as ScriptNodeData | undefined;

  const si = (sd?.tableNamesWritten ?? []).indexOf(tn ?? '');
  const ti = (td?.tableNamesRead ?? []).indexOf(tn ?? '');

  // 用 internal node 的真实位置（避免 React Flow Handle bug 的错误回退位置）
  const sx = (src?.internals?.positionAbsolute?.x ?? 0) + (src?.measured?.width ?? 240);
  const sy = (src?.internals?.positionAbsolute?.y ?? 0) + (si >= 0 ? rowY(si, (sd?.tableNamesRead ?? []).length, true) : 26);
  const tx = tgt?.internals?.positionAbsolute?.x ?? 0;
  const ty = (tgt?.internals?.positionAbsolute?.y ?? 0) + (ti >= 0 ? rowY(ti, 0, false) : 26);

  const [ep, lx, ly] = getBezierPath({
    sourceX: sx, sourceY: sy, targetX: tx, targetY: ty,
    sourcePosition: Position.Right, targetPosition: Position.Left,
    curvature: 0.25,
  });
  const sn = tn?.split('.').pop() ?? '';
  const hl = getHighlightedTable();
  const isHL = hl === tn;
  const strokeColor = isHL ? '#f59e0b' : '#b1b1b7';
  const strokeW = isHL ? 3 : 1.5;

  return (
    <>
      <BaseEdge id={id} path={ep} markerEnd={markerEnd} style={{ stroke: strokeColor, strokeWidth: strokeW }} />
      <EdgeLabelRenderer>
        <div className="absolute text-[10px] px-1 py-0.5 rounded border" style={{
          transform: `translate(-50%,-50%) translate(${lx}px,${ly}px)`,
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
