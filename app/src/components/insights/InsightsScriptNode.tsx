import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react';
import { Handle, Position, useUpdateNodeInternals, type NodeProps } from '@xyflow/react';
import { FileCode, Copy, Check, ChevronDown, ChevronUp, ClipboardList } from 'lucide-react';
import { useLineageStore, useColors } from '@pondpilot/flowscope-react';
import type { ScriptNodeData } from '@pondpilot/flowscope-react';
import { shouldHighlightRow, toggleHighlight, onHighlightChange } from './highlightState';
import { computeScriptNodeLayout } from './scriptNodeLayout';
import { getHandleY, setHandleY, clearNodeHandleY } from './handlePositionCache';

/**
 * Walk offsetTop chain from `el` up to `container`, returning cumulative offset.
 * With position:relative on the node root, el.offsetParent === container,
 * so el.offsetTop already gives the correct value (no walking needed).
 */
function rowOffsetTop(el: HTMLElement, container: HTMLElement): number {
  // Fast path: container is the direct offsetParent
  if (el.offsetParent === container) return el.offsetTop;
  // Fallback: walk the chain
  let top = 0;
  let cur: HTMLElement | null = el;
  while (cur && cur !== container) {
    top += cur.offsetTop;
    cur = cur.offsetParent as HTMLElement | null;
  }
  return top;
}

function InsightsScriptNodeComponent({ id, data, selected }: NodeProps): JSX.Element {
  const c = useColors();
  const s = c.nodes.script;
  const { label, sourceName, tableNamesRead, tableNamesWritten, isSelected, isHighlighted } = data as ScriptNodeData;
  const outputGroups = (data as Record<string, unknown>).outputGroups as ScriptNodeData['outputGroups'] | undefined;
  const updateNodeInternals = useUpdateNodeInternals();

  const [copied, setCopied] = useState(false);
  const [copiedAll, setCopiedAll] = useState(false);
  const showScriptTables = useLineageStore((state) => state.showScriptTables);
  const [local, setLocal] = useState<boolean | null>(null);
  const prev = useRef(showScriptTables);
  if (prev.current !== showScriptTables) { if (local !== null) setLocal(null); prev.current = showScriptTables; }
  const expanded = local ?? showScriptTables;

  // 订阅高亮
  const [, force] = useState(0);
  const inited = useRef(false);
  if (!inited.current) { inited.current = true; onHighlightChange(() => force((n) => n + 1)); }

  const reads = tableNamesRead ?? [];
  const writes = tableNamesWritten ?? [];

  // Compute layout (fallback / initial estimate)
  const layout = useMemo(
    () => computeScriptNodeLayout(outputGroups, reads, writes),
    [outputGroups, reads, writes],
  );

  // ── DOM measurement: use offsetTop chain (immune to zoom/pan transforms) ──
  const nodeRef = useRef<HTMLDivElement>(null);
  const [, setMeasuredY] = useState(false);

  // Re-measure when expanded toggle or table lists change
  const readsKey = reads.join(',');
  const writesKey = writes.join(',');
  const groupsKey = outputGroups?.map(g => `${g.inputs.join('|')}:${g.outputs.join('|')}`).join(';') ?? '';

  const measure = useCallback(() => {
    if (!expanded || !nodeRef.current) return;
    const nodeEl = nodeRef.current;
    let changed = false;

    for (const rowEl of nodeEl.querySelectorAll<HTMLElement>('[data-read-qname],[data-write-qname]')) {
      const rq = rowEl.getAttribute('data-read-qname');
      const wq = rowEl.getAttribute('data-write-qname');
      const qname = rq ?? wq;
      const type = rq ? 'r' : 'w';
      if (!qname) continue;
      // With position:relative on node root, offsetTop is correct and immune to transforms
      const y = Math.round(rowOffsetTop(rowEl, nodeEl) + rowEl.offsetHeight / 2);
      const old = getHandleY(id as string, type, qname);
      if (old !== y) {
        setHandleY(id as string, type, qname, y);
        changed = true;
      }
    }

    if (changed) {
      setMeasuredY(true);
      requestAnimationFrame(() => updateNodeInternals(id as string));
    }
  }, [expanded, id, updateNodeInternals]);

  // Double-RAF: first frame lays out the DOM, second frame measures after settle
  useLayoutEffect(() => {
    if (!expanded) return;
    const raf1 = requestAnimationFrame(() => {
      requestAnimationFrame(() => measure());
    });
    return () => cancelAnimationFrame(raf1);
  }, [expanded, readsKey, writesKey, groupsKey, measure]);

  // Re-measure on resize (content height changes, scrollbar appears, etc.)
  useEffect(() => {
    if (!expanded || !nodeRef.current) return;
    const ro = new ResizeObserver(() => { measure(); });
    ro.observe(nodeRef.current);
    return () => ro.disconnect();
  }, [expanded, measure]);

  // Clear cache on collapse or unmount
  useEffect(() => {
    if (!expanded) clearNodeHandleY(id as string);
  }, [expanded, id]);

  useEffect(() => {
    if (!expanded) return;
    requestAnimationFrame(() => updateNodeInternals(id as string));
  }, [id, expanded, layout, updateNodeInternals]);

  const active = selected || isSelected;
  const isGrouped = !!(outputGroups && outputGroups.length > 1);

  const handleCopy = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(label).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  }, [label]);

  const handleCopyAll = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const lines: string[] = [];
    lines.push(`${sourceName}`);
    if (isGrouped && outputGroups) {
      for (let gi = 0; gi < outputGroups.length; gi++) {
        const g = outputGroups[gi];
        if (gi > 0) lines.push('---');
        if (g.inputs.length > 0) {
          lines.push(`输入 (${g.inputs.length}):`);
          for (const t of g.inputs) lines.push(`  ${t}`);
        }
        if (g.outputs.length > 0) {
          lines.push(`输出 (${g.outputs.length}):`);
          for (const t of g.outputs) lines.push(`  ${t}`);
        }
      }
    } else {
      if (reads.length > 0) {
        lines.push(`输入 (${reads.length}):`);
        for (const t of reads) lines.push(`  ${t}`);
      }
      if (writes.length > 0) {
        lines.push(`输出 (${writes.length}):`);
        for (const t of writes) lines.push(`  ${t}`);
      }
    }
    navigator.clipboard.writeText(lines.join('\n')).then(() => { setCopiedAll(true); setTimeout(() => setCopiedAll(false), 1500); });
  }, [sourceName, isGrouped, outputGroups, reads, writes]);

  const toggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setLocal((v) => (v === null ? !showScriptTables : !v));
  }, [showScriptTables]);

  return (
    <div ref={nodeRef} style={{
      position: 'relative',
      backgroundColor: isHighlighted ? c.interactive.related : s.bg,
      borderColor: active ? c.interactive.selection : isHighlighted ? c.interactive.selection : s.border,
      boxShadow: active ? `0 0 0 2px ${c.interactive.selectionRing}` : isHighlighted ? `0 0 0 2px ${c.interactive.selectionRing}` : undefined,
    }} className="min-w-[240px] rounded-lg border-2 shadow-xs transition-all duration-200">

      {!expanded && (
        <>
          <Handle type="target" position={Position.Left} className="bg-transparent! border-none!" style={{ top: '26px' }} />
          <Handle type="source" position={Position.Right} className="bg-transparent! border-none!" style={{ top: '26px' }} />
        </>
      )}

      {expanded && (
        <>
          {reads.map((t) => {
            const y = getHandleY(id as string, 'r', t) ?? layout.readHandleY.get(t);
            return y != null ? (
              <Handle key={`rh-${t}`} id={`r:${t}`} type="target" position={Position.Left}
                style={{ top: y, width: 6, height: 6, left: -3, border: '2px solid #22c55e', background: '#22c55e', borderRadius: '50%' }} />
            ) : null;
          })}
          {writes.map((t) => {
            const y = getHandleY(id as string, 'w', t) ?? layout.writeHandleY.get(t);
            return y != null ? (
              <Handle key={`wh-${t}`} id={`w:${t}`} type="source" position={Position.Right}
                style={{ top: y, width: 6, height: 6, right: -3, border: '2px solid #3b82f6', background: '#3b82f6', borderRadius: '50%' }} />
            ) : null;
          })}
        </>
      )}

      <div className="flex items-center gap-2 px-3 py-2.5">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded" style={{ backgroundColor: s.headerBg, color: s.accent }}>
          <FileCode className="h-4 w-4" strokeWidth={1.5} />
        </div>
        <div className="flex-1 overflow-hidden">
          <div className="flex items-center gap-1">
            <div className="truncate text-sm font-semibold" style={{ color: s.text }} title={label}>{label}</div>
            <button onClick={handleCopy} className="shrink-0 p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10">
              {copied ? <Check className="h-3 w-3" style={{ color: c.status.success }} /> : <Copy className="h-3 w-3" style={{ color: s.textSecondary }} />}
            </button>
          </div>
          <div className="flex items-center gap-2 mt-0.5 text-xs" style={{ color: s.textSecondary }}>
            <span>入 {reads.length}</span><span>出 {writes.length}</span>
          </div>
        </div>
        <button onClick={handleCopyAll} className="shrink-0 p-1 rounded hover:bg-black/10 dark:hover:bg-white/10 transition-colors" title="复制所有表">
          {copiedAll ? <Check className="h-3.5 w-3.5" style={{ color: c.status.success }} /> : <ClipboardList className="h-3.5 w-3.5" style={{ color: s.textSecondary }} />}
        </button>
        <button onClick={toggle} className="shrink-0 p-1 rounded hover:bg-black/10 dark:hover:bg-white/10 transition-colors">
          {expanded ? <ChevronUp className="h-4 w-4" style={{ color: s.textSecondary }} /> : <ChevronDown className="h-4 w-4" style={{ color: s.textSecondary }} />}
        </button>
      </div>

      {expanded && (
        <div className="border-t" style={{ borderColor: s.border }}>
          {isGrouped ? (
            <GroupedTables
              groups={layout.groups}
              sourceName={sourceName}
              c={c}
              s={s}
            />
          ) : (
            <FlatTables
              reads={reads}
              writes={writes}
              sourceName={sourceName}
              c={c}
              s={s}
            />
          )}
          {reads.length === 0 && writes.length === 0 && (
            <div className="px-3 py-2 text-xs italic" style={{ color: s.textSecondary }}>无表依赖</div>
          )}
        </div>
      )}
    </div>
  );
}

interface TableListProps {
  reads: string[];
  writes: string[];
  sourceName: string;
  c: ReturnType<typeof useColors>;
  s: ReturnType<typeof useColors>['nodes']['script'];
}

function FlatTables({ reads, writes, sourceName, c, s }: TableListProps) {
  return (
    <>
      {reads.length > 0 && (
        <div className="px-2 py-1.5">
          <div className="text-xs font-semibold mb-1 px-1" style={{ color: c.status.success }}>输入 ({reads.length})</div>
          {reads.map((t) => {
            const isHL = shouldHighlightRow(t, 'read', sourceName);
            return (
              <div key={t} data-read-qname={t} className="text-xs flex items-center cursor-pointer rounded transition-colors"
                style={{ color: isHL ? c.interactive.selection : s.textSecondary, backgroundColor: isHL ? c.interactive.hover : 'transparent', fontWeight: isHL ? 600 : 400, padding: '3px 6px' }}
                onClick={(e) => { e.stopPropagation(); toggleHighlight(t, 'read', sourceName); }} title={t}>
                <span className="w-1.5 h-1.5 rounded-full shrink-0 mr-1.5" style={{ backgroundColor: c.status.success }} />
                <span className="break-all flex-1">{t}</span>
                {isHL && <span className="text-[10px] font-semibold px-1 rounded shrink-0 ml-1" style={{ backgroundColor: `${c.accent}20`, color: c.accent }}>关联</span>}
                <button onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(t); }} className="shrink-0 p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 ml-1" title="复制"><Copy className="h-3 w-3" style={{ color: s.textSecondary }} /></button>
              </div>
            );
          })}
        </div>
      )}
      {writes.length > 0 && (
        <div className="px-2 py-1.5 border-t" style={{ borderColor: `${s.border}44` }}>
          <div className="text-xs font-semibold mb-1 px-1" style={{ color: c.status.info }}>输出 ({writes.length})</div>
          {writes.map((t) => {
            const isHL = shouldHighlightRow(t, 'write', sourceName);
            return (
              <div key={t} data-write-qname={t} className="text-xs flex items-center cursor-pointer rounded transition-colors"
                style={{ color: isHL ? c.interactive.selection : s.textSecondary, backgroundColor: isHL ? c.interactive.hover : 'transparent', fontWeight: isHL ? 600 : 400, padding: '3px 6px' }}
                onClick={(e) => { e.stopPropagation(); toggleHighlight(t, 'write', sourceName); }} title={t}>
                <span className="w-1.5 h-1.5 rounded-full shrink-0 mr-1.5" style={{ backgroundColor: c.status.info }} />
                <span className="break-all flex-1">{t}</span>
                {isHL && <span className="text-[10px] font-semibold px-1 rounded shrink-0 ml-1" style={{ backgroundColor: `${c.accent}20`, color: c.accent }}>关联</span>}
                <button onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(t); }} className="shrink-0 p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 ml-1" title="复制"><Copy className="h-3 w-3" style={{ color: s.textSecondary }} /></button>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

interface GroupedTablesProps {
  groups: Array<{ inputs: Array<{ qname: string; y: number }>; outputs: Array<{ qname: string; y: number }>; startY: number }>;
  sourceName: string;
  c: ReturnType<typeof useColors>;
  s: ReturnType<typeof useColors>['nodes']['script'];
}

function GroupedTables({ groups, sourceName, c, s }: GroupedTablesProps) {
  return (
    <>
      {groups.map((group, gi) => (
        <div key={gi}>
          {gi > 0 && (
            <div className="border-t my-0.5" style={{ borderColor: `${s.border}88` }} />
          )}
          {group.inputs.length > 0 && (
            <div className="px-2 py-1.5">
              <div className="text-xs font-semibold mb-1 px-1" style={{ color: c.status.success }}>输入 ({group.inputs.length})</div>
              {group.inputs.map(({ qname: t }) => {
                const isHL = shouldHighlightRow(t, 'read', sourceName);
                return (
                  <div key={t} data-read-qname={t} className="text-xs flex items-center cursor-pointer rounded transition-colors"
                    style={{ color: isHL ? c.interactive.selection : s.textSecondary, backgroundColor: isHL ? c.interactive.hover : 'transparent', fontWeight: isHL ? 600 : 400, padding: '3px 6px' }}
                    onClick={(e) => { e.stopPropagation(); toggleHighlight(t, 'read', sourceName); }} title={t}>
                    <span className="w-1.5 h-1.5 rounded-full shrink-0 mr-1.5" style={{ backgroundColor: c.status.success }} />
                    <span className="break-all flex-1">{t}</span>
                    {isHL && <span className="text-[10px] font-semibold px-1 rounded shrink-0 ml-1" style={{ backgroundColor: `${c.accent}20`, color: c.accent }}>关联</span>}
                    <button onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(t); }} className="shrink-0 p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 ml-1" title="复制"><Copy className="h-3 w-3" style={{ color: s.textSecondary }} /></button>
                  </div>
                );
              })}
            </div>
          )}
          {group.outputs.length > 0 && (
            <div className="px-2 py-1.5">
              <div className="text-xs font-semibold mb-1 px-1" style={{ color: c.status.info }}>输出 ({group.outputs.length})</div>
              {group.outputs.map(({ qname: t }) => {
                const isHL = shouldHighlightRow(t, 'write', sourceName);
                return (
                  <div key={t} data-write-qname={t} className="text-xs flex items-center cursor-pointer rounded transition-colors"
                    style={{ color: isHL ? c.interactive.selection : s.textSecondary, backgroundColor: isHL ? c.interactive.hover : 'transparent', fontWeight: isHL ? 600 : 400, padding: '3px 6px' }}
                    onClick={(e) => { e.stopPropagation(); toggleHighlight(t, 'write', sourceName); }} title={t}>
                    <span className="w-1.5 h-1.5 rounded-full shrink-0 mr-1.5" style={{ backgroundColor: c.status.info }} />
                    <span className="break-all flex-1">{t}</span>
                    {isHL && <span className="text-[10px] font-semibold px-1 rounded shrink-0 ml-1" style={{ backgroundColor: `${c.accent}20`, color: c.accent }}>关联</span>}
                    <button onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(t); }} className="shrink-0 p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 ml-1" title="复制"><Copy className="h-3 w-3" style={{ color: s.textSecondary }} /></button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ))}
    </>
  );
}

export const InsightsScriptNode = InsightsScriptNodeComponent;
