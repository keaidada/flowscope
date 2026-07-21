import { memo, useCallback, useRef, useState, type JSX } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { FileCode, Copy, Check, ChevronDown, ChevronUp } from 'lucide-react';
import { useLineageStore, useColors } from '@pondpilot/flowscope-react';
import type { ScriptNodeData } from '@pondpilot/flowscope-react';

function InsightsScriptNodeComponent({ data, selected }: NodeProps): JSX.Element {
  const c = useColors();
  const s = c.nodes.script;
  const { label, tableNamesRead, tableNamesWritten, isSelected, isHighlighted } = data as ScriptNodeData;
  const reads = tableNamesRead ?? [];
  const writes = tableNamesWritten ?? [];

  const [copied, setCopied] = useState(false);
  const showScriptTables = useLineageStore((state) => state.showScriptTables);
  const [localExpand, setLocalExpand] = useState<boolean | null>(null);
  const prevGlobal = useRef(showScriptTables);
  if (prevGlobal.current !== showScriptTables) {
    if (localExpand !== null) setLocalExpand(null);
    prevGlobal.current = showScriptTables;
  }
  const expanded = localExpand ?? showScriptTables;

  const handleCopy = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(label).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  }, [label]);

  const active = selected || isSelected;

  return (
    <div style={{
      backgroundColor: isHighlighted ? c.interactive.related : s.bg,
      borderColor: active ? c.interactive.selection : isHighlighted ? c.interactive.selection : s.border,
      boxShadow: active ? `0 0 0 2px ${c.interactive.selectionRing}` : isHighlighted ? `0 0 0 2px ${c.interactive.selectionRing}` : undefined,
    }} className="min-w-[240px] max-w-[380px] rounded-lg border-2 shadow-xs transition-all duration-200">

      <Handle type="target" position={Position.Left} className="bg-transparent! border-none!" />
      <Handle type="source" position={Position.Right} className="bg-transparent! border-none!" />

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
        <button
          onClick={(e) => { e.stopPropagation(); setLocalExpand((v) => (v === null ? !showScriptTables : !v)); }}
          className="shrink-0 p-1 rounded hover:bg-black/10 dark:hover:bg-white/10 transition-colors"
        >
          {expanded ? <ChevronUp className="h-4 w-4" style={{ color: s.textSecondary }} /> : <ChevronDown className="h-4 w-4" style={{ color: s.textSecondary }} />}
        </button>
      </div>

      {expanded && (
        <div className="border-t max-h-[300px] overflow-y-auto" style={{ borderColor: s.border }}>
          {reads.length > 0 && (
            <div className="px-2 py-1.5">
              <div className="text-xs font-semibold mb-1 px-1" style={{ color: c.status.success }}>输入 ({reads.length})</div>
              {reads.map((t) => (
                <div key={t} className="text-xs flex items-center rounded py-0.5 px-1.5" style={{ color: s.textSecondary }}>
                  <span className="w-1.5 h-1.5 rounded-full shrink-0 mr-1.5" style={{ backgroundColor: c.status.success }} />
                  <span className="truncate" title={t}>{t}</span>
                </div>
              ))}
            </div>
          )}
          {writes.length > 0 && (
            <div className="px-2 py-1.5 border-t" style={{ borderColor: `${s.border}44` }}>
              <div className="text-xs font-semibold mb-1 px-1" style={{ color: c.status.info }}>输出 ({writes.length})</div>
              {writes.map((t) => (
                <div key={t} className="text-xs flex items-center rounded py-0.5 px-1.5" style={{ color: s.textSecondary }}>
                  <span className="w-1.5 h-1.5 rounded-full shrink-0 mr-1.5" style={{ backgroundColor: c.status.info }} />
                  <span className="truncate" title={t}>{t}</span>
                </div>
              ))}
            </div>
          )}
          {reads.length === 0 && writes.length === 0 && (
            <div className="px-3 py-2 text-xs italic" style={{ color: s.textSecondary }}>无表依赖</div>
          )}
        </div>
      )}
    </div>
  );
}

export const InsightsScriptNode = memo(InsightsScriptNodeComponent);
