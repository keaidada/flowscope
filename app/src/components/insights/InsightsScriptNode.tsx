import { memo, useCallback, useRef, useState, type JSX } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { FileCode, Copy, Check, ChevronDown, ChevronUp } from 'lucide-react';
import { useLineageStore, useColors } from '@pondpilot/flowscope-react';
import type { ScriptNodeData } from '@pondpilot/flowscope-react';

// 全局高亮表名：用模块级变量共享给所有 InsightsScriptNode 实例
let highlightedTable: string | null = null;
const listeners = new Set<() => void>();
function setHighlightedTable(name: string | null) {
  highlightedTable = highlightedTable === name ? null : name;
  listeners.forEach((fn) => fn());
}

function InsightsScriptNodeComponent({ data, selected }: NodeProps): JSX.Element {
  const colors = useColors();
  const scriptColors = colors.nodes.script;
  const nodeData = data as ScriptNodeData;
  const { label, tableNamesRead, tableNamesWritten, isSelected, isHighlighted } = nodeData;
  const readNames = tableNamesRead ?? [];
  const writeNames = tableNamesWritten ?? [];

  const [copied, setCopied] = useState(false);
  const [, forceUpdate] = useState(0);
  useRef(0);
  // 订阅全局高亮变化
  if (!useRef(false).current) {
    useRef(false).current = true;
    listeners.add(() => forceUpdate((n) => n + 1));
  }

  const showScriptTables = useLineageStore((state) => state.showScriptTables);
  const [localOverride, setLocalOverride] = useState<boolean | null>(null);
  const prev = useRef(showScriptTables);
  if (prev.current !== showScriptTables) {
    if (localOverride !== null) setLocalOverride(null);
    prev.current = showScriptTables;
  }
  const expanded = localOverride ?? showScriptTables;

  const handleCopy = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(label).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  }, [label]);

  const toggleExpand = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setLocalOverride((v) => (v === null ? !showScriptTables : !v));
  }, [showScriptTables]);

  const active = selected || isSelected;

  const renderTableRow = (t: string, dotColor: string, type: 'r' | 'w') => {
    const isHighlightedRow = highlightedTable === t;
    return (
      <div
        key={type + t}
        className="text-xs flex items-center cursor-pointer rounded transition-colors relative"
        style={{
          color: isHighlightedRow ? colors.interactive.selection : scriptColors.textSecondary,
          backgroundColor: isHighlightedRow ? colors.interactive.hover : 'transparent',
          fontWeight: isHighlightedRow ? 600 : 400,
          padding: '3px 6px',
        }}
        onClick={(e) => { e.stopPropagation(); setHighlightedTable(t); }}
        title={t}
      >
        {type === 'r' && (
          <Handle id={`r:${t}`} type="target" position={Position.Left}
            style={{ opacity: 0, width: 6, height: 6, left: -3, top: '50%', transform: 'translateY(-50%)', border: 'none', background: 'transparent' }} />
        )}
        <span className="w-1.5 h-1.5 rounded-full shrink-0 mr-1.5" style={{ backgroundColor: dotColor }} />
        <span className="truncate">{t}</span>
        {type === 'w' && (
          <Handle id={`w:${t}`} type="source" position={Position.Right}
            style={{ opacity: 0, width: 6, height: 6, right: -3, top: '50%', transform: 'translateY(-50%)', border: 'none', background: 'transparent' }} />
        )}
      </div>
    );
  };

  return (
    <div
      style={{
        backgroundColor: isHighlighted ? colors.interactive.related : scriptColors.bg,
        borderColor: active ? colors.interactive.selection : isHighlighted ? colors.interactive.selection : scriptColors.border,
        boxShadow: active ? `0 0 0 2px ${colors.interactive.selectionRing}` : isHighlighted ? `0 0 0 2px ${colors.interactive.selectionRing}` : undefined,
      }}
      className="min-w-[220px] max-w-[380px] rounded-lg border-2 shadow-xs transition-all duration-200"
    >
      <Handle type="target" position={Position.Left} className="bg-transparent! border-none!" />

      <div className="flex items-center gap-2 px-3 py-2.5">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded" style={{ backgroundColor: scriptColors.headerBg, color: scriptColors.accent }}>
          <FileCode className="h-4 w-4" strokeWidth={1.5} />
        </div>
        <div className="flex-1 overflow-hidden">
          <div className="flex items-center gap-1">
            <div className="truncate text-sm font-semibold" style={{ color: scriptColors.text }} title={label}>{label}</div>
            <button onClick={handleCopy} className="shrink-0 p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 transition-colors">
              {copied ? <Check className="h-3 w-3" style={{ color: colors.status.success }} /> : <Copy className="h-3 w-3" style={{ color: scriptColors.textSecondary }} />}
            </button>
          </div>
          <div className="flex items-center gap-2 mt-0.5 text-xs" style={{ color: scriptColors.textSecondary }}>
            <span>入 {readNames.length}</span><span>出 {writeNames.length}</span>
          </div>
        </div>
        <button onClick={toggleExpand} className="shrink-0 p-1 rounded hover:bg-black/10 dark:hover:bg-white/10 transition-colors">
          {expanded ? <ChevronUp className="h-4 w-4" style={{ color: scriptColors.textSecondary }} /> : <ChevronDown className="h-4 w-4" style={{ color: scriptColors.textSecondary }} />}
        </button>
      </div>

      {expanded && (
        <div className="border-t max-h-[300px] overflow-y-auto" style={{ borderColor: scriptColors.border }}>
          {readNames.length > 0 && (
            <div className="px-2 py-1.5">
              <div className="text-xs font-semibold mb-1 px-1" style={{ color: colors.status.success }}>输入 ({readNames.length})</div>
              {readNames.map((t) => renderTableRow(t, colors.status.success, 'r'))}
            </div>
          )}
          {writeNames.length > 0 && (
            <div className="px-2 py-1.5 border-t" style={{ borderColor: `${scriptColors.border}44` }}>
              <div className="text-xs font-semibold mb-1 px-1" style={{ color: colors.status.info }}>输出 ({writeNames.length})</div>
              {writeNames.map((t) => renderTableRow(t, colors.status.info, 'w'))}
            </div>
          )}
          {readNames.length === 0 && writeNames.length === 0 && (
            <div className="px-3 py-2 text-xs italic" style={{ color: scriptColors.textSecondary }}>无表依赖</div>
          )}
        </div>
      )}

      <Handle type="source" position={Position.Right} className="bg-transparent! border-none!" />
    </div>
  );
}

export const InsightsScriptNode = memo(InsightsScriptNodeComponent);
