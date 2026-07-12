import { useEffect, useRef, useCallback, useMemo, useState, type JSX } from 'react';
import { Graph } from '@antv/g6';
import type { AnalyzeResult } from '@pondpilot/flowscope-core';
import { Button } from './ui/button';
import {
  ZoomIn, ZoomOut, Maximize2, Search, X,
  FileCode, LayoutGrid, Network, Minimize2, Route, GitBranch,
  FileCode2, Table2, LayoutList,
  Filter, ChevronUp, ChevronDown, Eye, Layers, ArrowLeftRight,
  ArrowUp, ArrowDown, Check, Copy, CheckCheck,
} from 'lucide-react';
import { cn } from '../lib/utils';

/**
 * G6GraphView — G6 Canvas‑rendered global lineage graph.
 *
 * Full feature parity with React Flow GraphView:
 *   • View mode: Table / Script  (ViewModeSelector)
 *   • Layout:    dagre / ELK    (LayoutSelector)
 *   • Table filter: search, type groups, direction, hide CTEs
 *   • Legend, expand/collapse all, column edges toggle
 *   • Search (Ctrl+F) + focus mode
 *   • Hover/click → highlight neighbours (no grey)
 *   • Pinch/Ctrl‑wheel → zoom, scroll → pan
 *   • MiniMap, dots background, tooltip
 */

type ViewMode = 'table' | 'script';
type LayoutAlgo = 'dagre' | 'elk';
type FilterDirection = 'both' | 'upstream' | 'downstream';

interface G6GraphViewProps {
  result: AnalyzeResult;
  focusNodeId?: string;
  onFocusApplied?: () => void;
  className?: string;
  debug?: boolean;
}

// ── Node colours ──
const NODE_STYLE: Record<string, { bg: string; stroke: string; text: string }> = {
  table:             { bg: '#DBEAFE', stroke: '#3B82F6', text: '#1E40AF' },
  view:              { bg: '#D1FAE5', stroke: '#10B981', text: '#065F46' },
  cte:               { bg: '#FEF3C7', stroke: '#F59E0B', text: '#92400E' },
  materialized_view: { bg: '#E0E7FF', stroke: '#6366F1', text: '#3730A3' },
  external:          { bg: '#F3F4F6', stroke: '#9CA3AF', text: '#374151' },
  script:            { bg: '#EDE9FE', stroke: '#8B5CF6', text: '#5B21B6' },
};

function nc(t: string) { return NODE_STYLE[t] ?? NODE_STYLE.table; }

function dispLabel(n: any): string {
  const cn = n.canonicalName || n.canonical_name;
  if (cn?.name) {
    const s = cn.schema ? `${cn.schema}.` : '';
    const f = `${s}${cn.name}`;
    return f.length > 34 ? f.slice(0, 32) + '\u2026' : f;
  }
  const r = n.label || '';
  return r.length > 34 ? r.slice(0, 32) + '\u2026' : r;
}

function sid(id: string): string { return id.replace(/[.:]/g, '_'); }

// ═══════════ Toolbar button ═══════════
function Tb({ active, onClick, title, children }: {
  active?: boolean; onClick: () => void; title: string; children: JSX.Element;
}) {
  return <Button variant={active ? 'secondary' : 'outline'} size="sm" className="h-7 w-7 p-0" onClick={onClick} title={title}>{children}</Button>;
}

// ═══════════ View mode selector ═══════════
function ViewModeSelector({ mode, onChange }: { mode: ViewMode; onChange: (m: ViewMode) => void }) {
  return (
    <div className="flex rounded-md border bg-background/95 overflow-hidden h-7">
      <button onClick={() => onChange('table')} className={`flex items-center gap-1 px-2 text-xs transition-colors ${mode === 'table' ? 'bg-secondary text-secondary-foreground' : 'hover:bg-muted'}`} title="Table lineage view">
        <Table2 className="h-3 w-3" />Table
      </button>
      <button onClick={() => onChange('script')} className={`flex items-center gap-1 px-2 text-xs transition-colors border-l ${mode === 'script' ? 'bg-secondary text-secondary-foreground' : 'hover:bg-muted'}`} title="Script lineage view">
        <FileCode2 className="h-3 w-3" />Script
      </button>
    </div>
  );
}

// ═══════════ Table filter dropdown (full parity with React Flow) ═══════════
interface TableItem { id: string; label: string; type: 'table' | 'view' | 'cte'; refCount: number; }

const DIRECTION_OPTIONS: { value: FilterDirection; label: string; icon: typeof ArrowLeftRight }[] = [
  { value: 'both', label: 'Both', icon: ArrowLeftRight },
  { value: 'upstream', label: 'Upstream', icon: ArrowUp },
  { value: 'downstream', label: 'Downstream', icon: ArrowDown },
];

function TableFilterDropdown({
  selectedTables, onToggleTable, onClear, hideCTEs, onToggleHideCTEs,
  direction, onDirectionChange, allNodes,
}: {
  selectedTables: Set<string>; onToggleTable: (label: string) => void;
  onClear: () => void; hideCTEs: boolean; onToggleHideCTEs: () => void;
  direction: FilterDirection; onDirectionChange: (d: FilterDirection) => void;
  allNodes: any[];
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);

  const allTables = useMemo((): TableItem[] => {
    const m = new Map<string, TableItem>();
    for (const n of allNodes) {
      const t = n.data?.nodeType || 'table';
      if (t !== 'table' && t !== 'view' && t !== 'cte') continue;
      const lbl = n.data?.label;
      if (!lbl) continue;
      const existing = m.get(lbl.toLowerCase());
      if (existing) { existing.refCount++; } else {
        m.set(lbl.toLowerCase(), { id: n.id, label: lbl, type: t as TableItem['type'], refCount: 1 });
      }
    }
    return [...m.values()].sort((a, b) => {
      const o = { table: 0, view: 1, cte: 2 };
      const c = o[a.type] - o[b.type];
      return c !== 0 ? c : a.label.localeCompare(b.label);
    });
  }, [allNodes]);

  const filtered = useMemo(() => {
    if (!q.trim()) {
      // Apply hideCTEs implicit filter
      return hideCTEs ? allTables.filter((t) => t.type !== 'cte') : allTables;
    }
    const lo = q.toLowerCase();
    return (hideCTEs ? allTables.filter((t) => t.type !== 'cte') : allTables)
      .filter((t) => t.label.toLowerCase().includes(lo));
  }, [allTables, q, hideCTEs]);

  useEffect(() => {
    const h = (e: MouseEvent) => { if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h, true);
    return () => document.removeEventListener('mousedown', h, true);
  }, []);

  const hasActive = selectedTables.size > 0 || hideCTEs;
  const typeIcon = (t: TableItem['type']) => t === 'view' ? <Eye className="h-3 w-3 text-slate-400" /> : t === 'cte' ? <Layers className="h-3 w-3 text-slate-400" /> : <Table2 className="h-3 w-3 text-slate-400" />;

  return (
    <div ref={containerRef} className="relative">
      <Tb active={hasActive} onClick={() => { setOpen(!open); setQ(''); }} title="Filter tables">
        <Filter className="h-3.5 w-3.5" strokeWidth={hasActive ? 2.5 : 1.5} />
      </Tb>
      {open && (
        <div className="absolute left-0 top-9 w-72 rounded-xl border bg-background/98 shadow-xl backdrop-blur z-30 overflow-hidden">
          {/* Header */}
          <div className="px-3 py-2 border-b">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium">Filter by Tables</span>
              {hasActive && <button onClick={() => { onClear(); setOpen(false); }} className="text-[10px] text-muted-foreground hover:text-foreground flex items-center gap-1"><X className="h-3 w-3" />Clear</button>}
            </div>
            <input autoFocus className="w-full rounded border px-2 py-1 text-xs bg-muted/30 outline-none" placeholder="Search tables..." value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          {/* Quick Filters */}
          <div className="px-3 py-2 border-b">
            <div className="text-[10px] text-muted-foreground mb-1.5">Quick Filters</div>
            <button onClick={onToggleHideCTEs} className={cn('w-full flex items-center gap-2 px-2 py-1.5 text-xs rounded-md transition-colors', hideCTEs ? 'bg-amber-50 dark:bg-amber-950/30 text-amber-700' : 'text-muted-foreground hover:bg-muted')}>
              <div className={cn('size-3.5 rounded border flex items-center justify-center shrink-0', hideCTEs ? 'bg-amber-500 border-amber-500' : 'border-slate-300')}>
                {hideCTEs && <Check className="h-2.5 w-2.5 text-white" />}
              </div>
              <Layers className="h-3 w-3 text-slate-400" />
              <span>Hide all CTEs</span>
            </button>
          </div>
          {/* Direction */}
          <div className="px-3 py-2 border-b">
            <div className="text-[10px] text-muted-foreground mb-1.5">Direction</div>
            <div className="flex gap-1">
              {DIRECTION_OPTIONS.map((opt) => {
                const isActive = direction === opt.value;
                const Icon = opt.icon;
                return (
                  <button key={opt.value} onClick={() => onDirectionChange(opt.value)}
                    className={cn('flex-1 flex items-center justify-center gap-1 px-2 py-1.5 text-[10px] rounded-md transition-colors', isActive ? 'bg-secondary text-secondary-foreground' : 'text-muted-foreground hover:bg-muted')}>
                    <Icon className="h-3 w-3" />{opt.label}
                  </button>
                );
              })}
            </div>
          </div>
          {/* Table list */}
          <div className="max-h-52 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <div className="px-3 py-3 text-center text-xs text-muted-foreground">No tables found</div>
            ) : filtered.map((t) => {
              const sel = selectedTables.has(t.label);
              return (
                <button key={t.label} onClick={() => onToggleTable(t.label)}
                  className={cn('w-full text-left px-3 py-1.5 text-xs transition-colors flex items-center gap-2', sel ? 'bg-blue-50 dark:bg-blue-950/50 text-blue-700' : 'text-foreground/80 hover:bg-muted')}>
                  <div className={cn('size-3.5 rounded border flex items-center justify-center shrink-0', sel ? 'bg-blue-500 border-blue-500' : 'border-slate-300')}>
                    {sel && <Check className="h-2.5 w-2.5 text-white" />}
                  </div>
                  {typeIcon(t.type)}
                  <span className="truncate">{t.label}</span>
                  <span className="ml-auto text-[10px] text-muted-foreground/50">{t.refCount}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

const DBG_FN = (tag: string, ...args: any[]) => console.log(`[G6:${tag}]`, ...args);
const NODBG = () => {};

// ═══════════ Main component ═══════════
export function G6GraphView({ result, focusNodeId, onFocusApplied, className = '', debug }: G6GraphViewProps) {
  const DBG = debug ? DBG_FN : NODBG;
  DBG('mount', 'result=', !!result, 'glNodes=', result?.globalLineage?.nodes?.length, 'glEdges=', result?.globalLineage?.edges?.length, 'stmts=', result?.statements?.length);

  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<Graph | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  const [loading, setLoading] = useState(true);
  const [layoutMsg, setLayoutMsg] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [searchVisible, setSearchVisible] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [legendVisible, setLegendVisible] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [layoutAlgo, setLayoutAlgo] = useState<LayoutAlgo>('dagre');
  const [defaultCollapsed, setDefaultCollapsed] = useState(false);
  const [showColumnEdges, setShowColumnEdges] = useState(false);
  const [selectedTables, setSelectedTables] = useState<Set<string>>(new Set());
  const [hideCTEs, setHideCTEs] = useState(false);
  const [filterDirection, setFilterDirection] = useState<FilterDirection>('both');
  const [viewMode, setViewMode] = useState<ViewMode>('table');
  const [showScriptTables, setShowScriptTables] = useState(false);
  const [depthUp, setDepthUp] = useState<number | undefined>(undefined);
  const [depthDown, setDepthDown] = useState<number | undefined>(undefined);
  const [depthFocusNodeId, setDepthFocusNodeId] = useState<string | null>(null);

  // Node context panel (copy + depth filter) — appears near clicked node
  const [ctxPanel, setCtxPanel] = useState<{ nodeId: string; label: string; fullLabel: string; x: number; y: number; visible: boolean; subMenu: 'up' | 'down' | null }>({ nodeId: '', label: '', fullLabel: '', x: 0, y: 0, visible: false, subMenu: null });
  const [copiedNode, setCopiedNode] = useState(false);

  const searchRef = useRef<HTMLInputElement>(null);
  const layoutTaskRef = useRef(0);

  // ── original ID map ──
  const origIds = useMemo(() => {
    const m = new Map<string, string>();
    result.globalLineage?.nodes.forEach((n: any) => m.set(sid(n.id as string), n.id as string));
    return m;
  }, [result]);

  // ═══════════ Table view graph data ═══════════
  const tableGraphData = useMemo(() => {
    const gl = result.globalLineage;
    if (!gl) { DBG('tableGraphData', 'no globalLineage'); return { nodes: [] as any[], edges: [] as any[] }; }
    DBG('tableGraphData', 'building from', gl.nodes.length, 'nodes +', gl.edges.length, 'edges');
    // Build label lookup once — avoid O(n) find() per edge
    const labelMap = new Map<string, string>();
    const nm = new Map<string, any>();
    for (const n of gl.nodes) {
      const id = sid(n.id as string);
      const lab = dispLabel(n);
      labelMap.set(id, (n.label as string) || '');
      nm.set(id, { id, data: { label: lab, fullLabel: n.label as string, nodeType: ((n as any).nodeType || (n as any).type || 'table') as string, origId: n.id as string } });
    }
    const es = new Set<string>();
    const eds: any[] = [];
    for (const e of gl.edges) {
      const fr = sid(e.from as string), to = sid(e.to as string);
      if (!nm.has(fr) || !nm.has(to)) continue;
      const eType = (e as any).edgeType || (e as any).type || '';
      const k = `${fr}__${to}__${eType}`;
      if (es.has(k)) continue;
      es.add(k);
      const rl = labelMap.get(fr) || '';
      eds.push({ id: k, source: fr, target: to, data: { label: rl.length > 22 ? rl.slice(0, 20) + '\u2026' : rl, edgeType: eType } });
    }
    DBG('tableGraphData', 'done:', nm.size, 'nodes +', eds.length, 'edges');
    return { nodes: Array.from(nm.values()), edges: eds };
  }, [result]);

  // ═══════════ Script view graph data ═══════════
  const scriptGraphData = useMemo(() => {
    if (!result || !result.statements || result.statements.length === 0) {
      return { nodes: [] as any[], edges: [] as any[] };
    }
    const gl = result.globalLineage;
    const stmtSources = new Map<number, string>();
    for (let i = 0; i < result.statements.length; i++) {
      const sn = result.statements[i].sourceName || '';
      if (sn) stmtSources.set(i, sn);
    }
    const fileTables = new Map<string, Set<string>>();
    const tableToFile = new Map<string, string>();
    if (gl) {
      for (const edge of gl.edges) {
        if (edge.producerStatement) {
          const src = stmtSources.get(edge.producerStatement.statementIndex);
          if (src) {
            if (!fileTables.has(src)) fileTables.set(src, new Set());
            fileTables.get(src)!.add(sid(edge.from as string));
            tableToFile.set(sid(edge.from as string), src);
          }
        }
      }
    }
    const allFiles = new Set<string>();
    for (const [_i, sn] of stmtSources) allFiles.add(sn);
    for (const [fn] of fileTables) allFiles.add(fn);
    const scriptNodesMap = new Map<string, any>();
    let fileId = 0;
    for (const fn of allFiles) {
      const shortName = fn.split('/').pop() || fn;
      const label = shortName.length > 34 ? shortName.slice(0, 32) + '\u2026' : shortName;
      const id = `script_${fileId++}`;
      scriptNodesMap.set(fn, { id, data: { label: `\u{1F4C4} ${label}`, fullLabel: fn, nodeType: 'script', origId: fn, sourceName: fn } });
    }
    const tableNodes: any[] = [];
    const tableNodeMap = new Map<string, any>();
    if (showScriptTables && gl) {
      for (const n of gl.nodes) {
        const id = sid(n.id as string);
        const lab = dispLabel(n);
        const tbl = { id, data: { label: lab, fullLabel: n.label as string, nodeType: ((n as any).nodeType || 'table') as string, origId: n.id as string } };
        tableNodeMap.set(id, tbl);
        tableNodes.push(tbl);
      }
    }
    const edgeSet = new Set<string>();
    const tableEdges: any[] = [];
    if (gl) {
      for (const e of gl.edges) {
        const fr = sid(e.from as string), to = sid(e.to as string);
        const eType = (e as any).edgeType || (e as any).type || '';
        const key = `${fr}__${to}__${eType}`;
        if (edgeSet.has(key)) continue;
        edgeSet.add(key);
        const fn = gl.nodes.find((n: any) => sid(n.id as string) === fr);
        const rl = (fn?.label as string) || '';
        tableEdges.push({ id: key, source: fr, target: to, data: { label: rl.length > 22 ? rl.slice(0, 20) + '\u2026' : rl, edgeType: eType } });
      }
    }
    const fileEdgeSet = new Set<string>();
    const fileEdges: any[] = [];
    for (const e of tableEdges) {
      const fileA = tableToFile.get(e.source as string);
      const fileB = tableToFile.get(e.target as string);
      if (fileA && fileB && fileA !== fileB) {
        const nodeA = scriptNodesMap.get(fileA);
        const nodeB = scriptNodesMap.get(fileB);
        if (nodeA && nodeB) {
          const fk = `${nodeA.id}__${nodeB.id}`;
          if (!fileEdgeSet.has(fk)) { fileEdgeSet.add(fk); fileEdges.push({ id: fk, source: nodeA.id, target: nodeB.id, data: { label: '' } }); }
        }
      }
    }
    const ownershipEdges: any[] = [];
    if (showScriptTables) {
      for (const [tblId, file] of tableToFile) {
        const sn = scriptNodesMap.get(file);
        const tn = tableNodeMap.get(tblId);
        if (sn && tn) ownershipEdges.push({ id: `own_${sn.id}_${tblId}`, source: sn.id, target: tblId, data: { label: 'contains' } });
      }
    }
    const allNodes = showScriptTables ? [...Array.from(scriptNodesMap.values()), ...tableNodes] : Array.from(scriptNodesMap.values());
    const allEdges = showScriptTables ? [...fileEdges, ...tableEdges, ...ownershipEdges] : fileEdges;
    return { nodes: allNodes, edges: allEdges };
  }, [result, showScriptTables]);

  // ── Select data source ──
  const { nodes: rawNodes, edges: rawEdges } = viewMode === 'script' ? scriptGraphData : tableGraphData;

  // ── Filtered graph data ──
  const graphData = useMemo(() => {
    DBG('graphData', 'filtering', rawNodes.length, 'nodes +', rawEdges.length, 'edges', 'selectedTables=', selectedTables.size, 'hideCTEs=', hideCTEs, 'depthUp=', depthUp, 'depthDown=', depthDown);
    let ns = rawNodes;
    let es = rawEdges;

    // Table filter
    if (selectedTables.size > 0) {
      if (filterDirection === 'both') {
        const keep = new Set<string>();
        for (const n of ns) { if (selectedTables.has(n.data.label) || selectedTables.has(n.data.fullLabel)) keep.add(n.id); }
        ns = ns.filter((n: any) => keep.has(n.id));
        es = es.filter((e: any) => keep.has(e.source) && keep.has(e.target));
      } else {
        // upstream / downstream: trace from selected tables
        const reachable = new Set<string>();
        const selectedIds = new Set<string>();
        for (const n of ns) { if (selectedTables.has(n.data.label) || selectedTables.has(n.data.fullLabel)) { reachable.add(n.id); selectedIds.add(n.id); } }
        // BFS from selected nodes
        const queue = [...selectedIds];
        while (queue.length > 0) {
          const cur = queue.shift()!;
          for (const e of es) {
            if (filterDirection === 'upstream' && e.target === cur && !reachable.has(e.source as string)) { reachable.add(e.source as string); queue.push(e.source as string); }
            if (filterDirection === 'downstream' && e.source === cur && !reachable.has(e.target as string)) { reachable.add(e.target as string); queue.push(e.target as string); }
          }
        }
        ns = ns.filter((n: any) => reachable.has(n.id));
        es = es.filter((e: any) => reachable.has(e.source) && reachable.has(e.target));
      }
    }

    // Hide CTEs
    if (hideCTEs && viewMode !== 'script') {
      const cteIds = new Set<string>();
      for (const n of ns) { if (n.data?.nodeType === 'cte') cteIds.add(n.id); }
      if (cteIds.size > 0) {
        ns = ns.filter((n: any) => !cteIds.has(n.id));
        es = es.filter((e: any) => !cteIds.has(e.source) && !cteIds.has(e.target));
      }
    }

    // Depth filter — BFS with level limits from a focus node
    if (depthFocusNodeId && (depthUp !== undefined || depthDown !== undefined)) {
      const adjOut = new Map<string, string[]>(); // source -> targets
      const adjIn = new Map<string, string[]>();  // target -> sources
      for (const e of es) {
        const s = e.source as string;
        const t = e.target as string;
        if (!adjOut.has(s)) adjOut.set(s, []);
        adjOut.get(s)!.push(t);
        if (!adjIn.has(t)) adjIn.set(t, []);
        adjIn.get(t)!.push(s);
      }
      const reachable = new Set<string>();
      reachable.add(depthFocusNodeId);
      // BFS upstream
      if (depthUp !== undefined) {
        const visited = new Map<string, number>();
        visited.set(depthFocusNodeId, 0);
        const queue: string[] = [depthFocusNodeId];
        while (queue.length > 0) {
          const cur = queue.shift()!;
          const curDist = visited.get(cur)!;
          if (curDist >= depthUp) continue;
          for (const src of adjIn.get(cur) || []) {
            if (!visited.has(src)) { visited.set(src, curDist + 1); reachable.add(src); queue.push(src); }
          }
        }
      }
      // BFS downstream
      if (depthDown !== undefined) {
        const visited = new Map<string, number>();
        visited.set(depthFocusNodeId, 0);
        const queue: string[] = [depthFocusNodeId];
        while (queue.length > 0) {
          const cur = queue.shift()!;
          const curDist = visited.get(cur)!;
          if (curDist >= depthDown) continue;
          for (const tgt of adjOut.get(cur) || []) {
            if (!visited.has(tgt)) { visited.set(tgt, curDist + 1); reachable.add(tgt); queue.push(tgt); }
          }
        }
      }
      ns = ns.filter((n: any) => reachable.has(n.id));
      es = es.filter((e: any) => reachable.has(e.source) && reachable.has(e.target));
    }

    // Focus mode
    if (searchTerm.trim() && focusMode) {
      const lo = searchTerm.toLowerCase();
      const keep = new Set<string>();
      for (const n of ns) { const l = (n.data.label || '').toLowerCase(), f = (n.data.fullLabel || '').toLowerCase(); if (l.includes(lo) || f.includes(lo)) keep.add(n.id); }
      ns = ns.filter((n: any) => keep.has(n.id));
      es = es.filter((e: any) => keep.has(e.source) && keep.has(e.target));
    }

    DBG('graphData', 'done:', ns.length, 'nodes +', es.length, 'edges');
    return { nodes: ns, edges: es };
  }, [rawNodes, rawEdges, selectedTables, hideCTEs, filterDirection, searchTerm, focusMode, viewMode, depthUp, depthDown, depthFocusNodeId]);

  // ── Search matches ──
  const matchedNodeIds = useMemo(() => {
    if (!searchTerm.trim()) return new Set<string>();
    const lo = searchTerm.toLowerCase();
    const ids = new Set<string>();
    for (const n of rawNodes) { const l = (n.data.label || '').toLowerCase(), f = (n.data.fullLabel || '').toLowerCase(); if (l.includes(lo) || f.includes(lo)) ids.add(n.id); }
    return ids;
  }, [rawNodes, searchTerm]);

  // ── Layout ──
  const doLayout = useCallback(async (g: Graph, algo: LayoutAlgo) => {
    const mounted = () => graphRef.current === g;
    layoutTaskRef.current += 1; const tid = layoutTaskRef.current;
    if (!mounted()) return;
    setLoading(true); setLayoutMsg(`Layouting ${graphData.nodes.length} nodes\u2026`);
    try {
    if (algo === 'dagre') {
      g.setLayout({ type: 'dagre', rankdir: 'LR', nodesep: 40, ranksep: 120 });
      if (!mounted()) return;
      await g.layout();
      if (!mounted()) return;
    } else {
      try {
        const d = g.getData();
        if (!mounted()) return;
        const nodes = d.nodes || [];
        const edges = (d.edges || []) as any[];
        const layoutId = tid;

        // Run ELK layout in a Web Worker to keep UI responsive
        const positions = await new Promise<Record<string, { x: number; y: number }>>((resolve) => {
          let settled = false;
          const done = (result: Record<string, { x: number; y: number }>) => {
            if (settled) return;
            settled = true;
            clearTimeout(to);
            worker.terminate();
            resolve(result);
          };
          const worker = new Worker(
            new URL('../workers/elk-layout.worker.ts', import.meta.url),
            { type: 'module' },
          );
          worker.onmessage = (e: MessageEvent<{ id: number; positions: Record<string, { x: number; y: number }> }>) => {
            done(e.data.positions);
          };
          worker.onerror = () => { done({}); };
          const to = setTimeout(() => { done({}); }, 15_000);
          worker.postMessage({
            id: layoutId,
            nodes: nodes.map((n: any) => ({ id: n.id, width: 180, height: 38 })),
            edges: edges.map((e: any, i: number) => ({ id: `e${i}`, sources: [e.source], targets: [e.target] })),
          });
        });

        if (tid !== layoutTaskRef.current || !mounted()) return;
        if (!positions || Object.keys(positions).length === 0) {
          g.setLayout({ type: 'dagre', rankdir: 'LR', nodesep: 40, ranksep: 120 });
          if (mounted()) await g.layout();
        } else {
          const un = nodes.map((n: any) => {
            const p = positions[n.id];
            return p ? { ...n, style: { ...n.style, x: p.x, y: p.y } } : n;
          });
          if (!mounted()) return;
          g.setData({ nodes: un, edges: d.edges });
          if (mounted()) await g.render();
        }
      } catch (err) { if (tid === layoutTaskRef.current && mounted()) { console.error('ELK failed:', err); g.setLayout({ type: 'dagre', rankdir: 'LR', nodesep: 40, ranksep: 120 }); await g.layout(); } }
    }
    if (tid === layoutTaskRef.current && mounted()) { try { g.fitView({}, { duration: 300 }); } catch {} setLoading(false); setLayoutMsg(''); }
    } catch { /* graph destroyed, ignore */ }
  }, [graphData]);

  // ── Init G6 ──
  useEffect(() => {
    DBG('init', 'container=', !!containerRef.current, 'graphData.nodes.length=', graphData.nodes.length);
    if (!containerRef.current || graphData.nodes.length === 0) { DBG('init', 'SKIP — no container or no nodes'); return; }
    if (graphRef.current) { DBG('init', 'destroying previous graph'); graphRef.current.destroy(); graphRef.current = null; }
    const c = containerRef.current;
    DBG('init', 'creating new Graph with', graphData.nodes.length, 'nodes +', graphData.edges.length, 'edges');
    setLoading(true);

    const isScriptView = viewMode === 'script';
    const isLite = graphData.nodes.length > 3000;
    const g = new Graph({
      container: c, width: c.clientWidth || 1000, height: c.clientHeight || 700,
      data: graphData,
      layout: layoutAlgo === 'dagre' ? { type: 'dagre', rankdir: 'LR', nodesep: isLite ? 16 : 40, ranksep: isLite ? 60 : 120 } : undefined,
      node: {
        type: 'rect',
        style: {
          size: (d: any) => {
            const w = isLite ? 90 : Math.min(260, Math.max(100, (d.data?.label || '').length * 7.5 + 40));
            return [w, isLite ? 24 : 38];
          },
          radius: isScriptView ? 12 : (isLite ? 4 : 7),
          fill: (d: any) => nc(d.data?.nodeType || 'table').bg,
          stroke: (d: any) => nc(d.data?.nodeType || 'table').stroke,
          lineWidth: isLite ? 1.0 : 1.8,
          labelText: (d: any) => isLite ? '' : (d.data?.label || ''),
          labelFill: (d: any) => nc(d.data?.nodeType || 'table').text,
          labelFontSize: 12, labelFontWeight: 500, labelPlacement: 'center',
          cursor: 'pointer',
          ...(isLite ? {} : { shadowBlur: 3, shadowColor: 'rgba(0,0,0,0.05)', shadowOffsetY: 1 }),
        },
        state: {
          selected:    { stroke: '#6366F1', lineWidth: 3, shadowBlur: isLite ? 0 : 10, shadowColor: 'rgba(99,102,241,0.4)' },
          highlighted: { stroke: '#6366F1', lineWidth: 3, shadowBlur: isLite ? 0 : 12, shadowColor: 'rgba(99,102,241,0.5)' },
        },
      },
      edge: {
        type: isLite ? 'line' : 'cubic-horizontal',
        style: {
          stroke: 'rgba(148,163,184,0.35)', lineWidth: isLite ? 0.6 : 1.1, endArrow: !isLite,
          ...(isLite ? {} : {
            labelText: (d: any) => (d.data?.label as string) || '',
            labelFontSize: 9, labelFill: '#94A3B8',
            labelBackground: true, labelBackgroundFill: 'rgba(255,255,255,0.88)', labelBackgroundRadius: 2, labelBackgroundPadding: [1, 3],
            labelMaxLines: 1, labelWordWrapWidth: 120,
          }),
        },
        state: { highlighted: { stroke: '#6366F1', lineWidth: 2.5 } },
      },
      behaviors: ['drag-canvas', 'click-select'],
      plugins: [
        ...(isLite ? [] : [{ type: 'minimap' as const, size: [180, 130], position: 'right-bottom' as const, padding: 10, offset: [10, 10] }]),
        { type: 'background', background: 'dots' },
      ],
      animation: false,
    });
    graphRef.current = g;

    const renderPromise = (layoutAlgo === 'dagre' ? g.render() : doLayout(g, layoutAlgo));
    renderPromise.then(() => {
      if (graphRef.current !== g) return;
      DBG('init', 'render done, setting loading false');
      if (layoutAlgo === 'dagre') setLoading(false);
    }).catch(() => {
      // silently ignore — graph was destroyed mid-render
    });

    // Wheel
    const hw = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) { const dz = -e.deltaY * 0.005; const z = g.getZoom(); g.zoomTo(Math.min(3, Math.max(0.08, z + dz * z)), undefined, [e.offsetX, e.offsetY]); }
      else { g.translateBy([-e.deltaX, -e.deltaY], false); }
    };
    c.addEventListener('wheel', hw, { passive: false });

    // Click → select + highlight + context panel
    g.on('node:click', (evt: any) => {
      const nid = evt.target?.id as string;
      if (nid) {
        setSelectedNodeId(origIds.get(nid) || nid);
        hi(g, nid);
        // Position context panel near clicked node
        const td = evt.target?.getData?.() || evt.data;
        const label = td?.data?.label || '';
        const fullLabel = td?.data?.fullLabel || label;
        const rect = c.getBoundingClientRect();
        const cx = (evt.client?.x ?? evt.clientX) - rect.left;
        const cy = (evt.client?.y ?? evt.clientY) - rect.top;
        setCtxPanel({ nodeId: nid, label, fullLabel, x: cx, y: cy - 50, visible: true, subMenu: null });
        setCopiedNode(false);
        setDepthUp(undefined);
        setDepthDown(undefined);
        setDepthFocusNodeId(null);
      }
    });
    g.on('canvas:click', () => {
      setSelectedNodeId(null);
      clr(g);
      setCtxPanel((p) => ({ ...p, visible: false }));
    });

    // Hover → highlight neighbours + tooltip
    g.on('node:pointerenter', (evt: any) => {
      const nid = evt.target?.id as string; if (!nid) return;
      const conn = new Set<string>([nid]); const d = g.getData();
      for (const e of d.edges as any[]) { if (e.source === nid) conn.add(e.target); if (e.target === nid) conn.add(e.source); }
      const sm: Record<string, string[]> = {};
      for (const n of d.nodes || []) sm[n.id as string] = conn.has(n.id as string) ? ['highlighted'] : [];
      for (const e of (d.edges as any[]) || []) { const eid = e.id || `${e.source}-${e.target}`; sm[eid] = conn.has(e.source) && conn.has(e.target) ? ['highlighted'] : []; }
      g.setElementState(sm);
      const td = evt.target?.getData?.() || evt.data;
      if (td?.data && tooltipRef.current) { const tt = tooltipRef.current; tt.innerHTML = `<div style="font-size:12px;font-weight:600;margin-bottom:2px">${td.data.label}</div><div style="font-size:10px;color:#94a3b8">type: ${td.data.nodeType}</div><div style="font-size:10px;color:#94a3b8;max-width:200px;word-break:break-all">${td.data.fullLabel}</div>`; tt.style.opacity = '1'; }
    });
    g.on('node:pointerleave', () => { clr(g); if (tooltipRef.current) tooltipRef.current.style.opacity = '0'; });
    g.on('node:pointermove', (evt: any) => { if (tooltipRef.current) { tooltipRef.current.style.left = `${evt.clientX + 14}px`; tooltipRef.current.style.top = `${evt.clientY + 8}px`; } });

    // Keyboard
    const hk = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key === 'f') { e.preventDefault(); setSearchVisible(true); setTimeout(() => searchRef.current?.focus(), 50); } if (e.key === 'Escape') { setSearchVisible(false); setSearchTerm(''); clr(g); setSelectedNodeId(null); setCtxPanel((p) => ({ ...p, visible: false })); } };
    window.addEventListener('keydown', hk);

    return () => { DBG('init', 'cleanup — destroying graph'); g.destroy(); graphRef.current = null; c.removeEventListener('wheel', hw); window.removeEventListener('keydown', hk); };
  }, [graphData]); // eslint-disable-line

  useEffect(() => {
    if (!graphRef.current || !focusNodeId) return;
    try { graphRef.current.focusElement(sid(focusNodeId), { duration: 500 }); hi(graphRef.current, sid(focusNodeId)); setSelectedNodeId(focusNodeId); onFocusApplied?.(); } catch {}
  }, [focusNodeId]); // eslint-disable-line

  // Close context panel on outside click
  useEffect(() => {
    if (!ctxPanel.visible) return;
    const h = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      // Don't close if clicking inside the panel or on a node
      if (t.closest('[data-ctx-panel]') || t.closest('canvas')) return;
      setCtxPanel((p) => ({ ...p, visible: false }));
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [ctxPanel.visible]);

  const doSearch = useCallback(() => {
    if (!graphRef.current || matchedNodeIds.size === 0) return; if (focusMode) return;
    const g = graphRef.current; const data = g.getData(); const sm: Record<string, string[]> = {};
    for (const n of data.nodes || []) sm[n.id as string] = matchedNodeIds.has(n.id as string) ? ['highlighted'] : [];
    for (const e of (data.edges as any[]) || []) { const eid = e.id || `${e.source}-${e.target}`; sm[eid] = matchedNodeIds.has(e.source) && matchedNodeIds.has(e.target) ? ['highlighted'] : []; }
    g.setElementState(sm); const first = [...matchedNodeIds][0];
    if (first) { g.focusElement(first, { duration: 400 }); setSelectedNodeId(origIds.get(first) || first); }
  }, [matchedNodeIds, origIds, focusMode]);

  const clearSearch = useCallback(() => { setSearchTerm(''); setSearchVisible(false); if (graphRef.current) clr(graphRef.current); setSelectedNodeId(null); }, []);

  const zi = () => { const g = graphRef.current, el = containerRef.current; if (g && el) g.zoomTo(g.getZoom() * 1.3, undefined, [el.clientWidth / 2, el.clientHeight / 2]); };
  const zo = () => { const g = graphRef.current, el = containerRef.current; if (g && el) g.zoomTo(g.getZoom() / 1.3, undefined, [el.clientWidth / 2, el.clientHeight / 2]); };
  const fit = () => graphRef.current?.fitView({}, { duration: 400 });

  const resize = useCallback(() => { const c = containerRef.current, g = graphRef.current; if (c && g) g.setSize(c.clientWidth, c.clientHeight); }, []);
  useEffect(() => { const c = containerRef.current; if (!c) return; const o = new ResizeObserver(resize); o.observe(c); return () => o.disconnect(); }, [resize]);

  const legend = [{ k: 'table', l: 'Table' }, { k: 'view', l: 'View' }, { k: 'cte', l: 'CTE' }, { k: 'materialized_view', l: 'M.View' }, { k: 'external', l: 'External' }, { k: 'script', l: 'Script' }];

  return (
    <div className={`relative ${className}`}>
      <div ref={tooltipRef} className="fixed z-50 pointer-events-none opacity-0 rounded-md border bg-background/95 px-2.5 py-1.5 shadow-lg backdrop-blur text-xs transition-opacity duration-100" style={{ maxWidth: 260 }} />

      {/* Node context panel — copy + depth filter */}
      {ctxPanel.visible && (
        <div
          data-ctx-panel
          className="absolute z-40 rounded-lg border bg-background/98 shadow-xl backdrop-blur overflow-hidden"
          style={{ left: ctxPanel.x, top: ctxPanel.y, transform: 'translate(-50%, -100%)' }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {/* Node name header */}
          <div className="px-3 py-2 border-b text-xs font-medium max-w-[200px] truncate" title={ctxPanel.fullLabel}>
            {ctxPanel.label}
          </div>
          {/* Copy button */}
          <button
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted transition-colors text-left"
            onClick={() => {
              const name = ctxPanel.fullLabel || ctxPanel.label;
              navigator.clipboard.writeText(name).then(() => {
                setCopiedNode(true);
                setTimeout(() => setCopiedNode(false), 1500);
              });
            }}
          >
            {copiedNode ? <CheckCheck className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
            <span className={copiedNode ? 'text-emerald-500' : ''}>{copiedNode ? 'Copied!' : 'Copy name'}</span>
          </button>
          <div className="h-px bg-border mx-3" />
          {/* Depth filter section */}
          <div className="px-3 py-1.5">
            <div className="text-[10px] text-muted-foreground mb-1">Depth Filter</div>
            <div className="flex gap-2">
              {/* Upstream */}
              <div className="relative flex-1">
                <button
                  className="w-full flex items-center justify-between gap-1 px-2 py-1 text-[10px] rounded border hover:bg-muted transition-colors"
                  onClick={() => setCtxPanel((p) => ({ ...p, subMenu: p.subMenu === 'up' ? null : 'up' }))}
                >
                  <span className="flex items-center gap-1"><ChevronUp className="h-3 w-3" />上游</span>
                  <span className="text-muted-foreground">{depthUp !== undefined ? depthUp : '\u221E'}</span>
                </button>
                {ctxPanel.subMenu === 'up' && (
                  <div className="absolute bottom-full mb-1 left-0 w-32 rounded-md border bg-background/98 shadow-lg p-1 z-50 flex flex-col gap-0.5" onMouseDown={(e) => e.stopPropagation()}>
                    <button className="w-full text-[10px] py-1 rounded hover:bg-muted" onClick={() => { setDepthUp(undefined); setDepthFocusNodeId(ctxPanel.nodeId); }}>全部</button>
                    {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => (
                      <button key={d} className={`w-full text-[10px] py-1 rounded ${depthUp === d ? 'bg-blue-100 dark:bg-blue-900/50 text-blue-700 font-semibold' : 'hover:bg-muted'}`} onClick={() => { setDepthUp(d); setDepthFocusNodeId(ctxPanel.nodeId); }}>{d}</button>
                    ))}
                  </div>
                )}
              </div>
              {/* Downstream */}
              <div className="relative flex-1">
                <button
                  className="w-full flex items-center justify-between gap-1 px-2 py-1 text-[10px] rounded border hover:bg-muted transition-colors"
                  onClick={() => setCtxPanel((p) => ({ ...p, subMenu: p.subMenu === 'down' ? null : 'down' }))}
                >
                  <span className="flex items-center gap-1"><ChevronDown className="h-3 w-3" />下游</span>
                  <span className="text-muted-foreground">{depthDown !== undefined ? depthDown : '\u221E'}</span>
                </button>
                {ctxPanel.subMenu === 'down' && (
                  <div className="absolute bottom-full mb-1 left-0 w-32 rounded-md border bg-background/98 shadow-lg p-1 z-50 flex flex-col gap-0.5" onMouseDown={(e) => e.stopPropagation()}>
                    <button className="w-full text-[10px] py-1 rounded hover:bg-muted" onClick={() => { setDepthDown(undefined); setDepthFocusNodeId(ctxPanel.nodeId); }}>全部</button>
                    {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => (
                      <button key={d} className={`w-full text-[10px] py-1 rounded ${depthDown === d ? 'bg-blue-100 dark:bg-blue-900/50 text-blue-700 font-semibold' : 'hover:bg-muted'}`} onClick={() => { setDepthDown(d); setDepthFocusNodeId(ctxPanel.nodeId); }}>{d}</button>
                    ))}
                  </div>
                )}
              </div>
            </div>
            {/* Clear depth filter */}
            {(depthUp !== undefined || depthDown !== undefined) && (
              <button
                className="w-full mt-1.5 text-[10px] py-1 text-red-500 hover:bg-red-50 dark:hover:bg-red-950/20 rounded transition-colors"
                onClick={() => { setDepthUp(undefined); setDepthDown(undefined); setDepthFocusNodeId(null); }}
              >
                清除层级筛选
              </button>
            )}
          </div>
        </div>
      )}

      {loading && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/50 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-2 rounded-lg bg-background/80 px-4 py-3 shadow">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            <span className="text-xs text-muted-foreground">{layoutMsg || `Layouting ${graphData.nodes.length} nodes\u2026`}</span>
          </div>
        </div>
      )}

      <div ref={containerRef} className="h-full w-full" />

      {/* Top‑left toolbar */}
      <div className="absolute left-3 top-3 flex gap-1">
        <ViewModeSelector mode={viewMode} onChange={setViewMode} />
        {viewMode === 'script' && (
          <Tb active={showScriptTables} onClick={() => setShowScriptTables(!showScriptTables)} title={showScriptTables ? 'Hide table details' : 'Show table details'}>
            <LayoutList className="h-3.5 w-3.5" />
          </Tb>
        )}
        <Tb active={searchVisible} onClick={() => { setSearchVisible(true); setTimeout(() => searchRef.current?.focus(), 50); }} title="Search (Ctrl+F)">
          <Search className="h-3.5 w-3.5" />
        </Tb>
        <Tb active={legendVisible} onClick={() => setLegendVisible(!legendVisible)} title="Legend">
          <FileCode className="h-3.5 w-3.5" />
        </Tb>
        {viewMode !== 'script' && (
          <TableFilterDropdown
            selectedTables={selectedTables}
            onToggleTable={(label) => setSelectedTables((prev) => { const next = new Set(prev); if (next.has(label)) next.delete(label); else next.add(label); return next; })}
            onClear={() => setSelectedTables(new Set())}
            hideCTEs={hideCTEs}
            onToggleHideCTEs={() => setHideCTEs(!hideCTEs)}
            direction={filterDirection}
            onDirectionChange={setFilterDirection}
            allNodes={rawNodes}
          />
        )}
        {viewMode !== 'script' && (
          <Tb active={!defaultCollapsed} onClick={() => setDefaultCollapsed(!defaultCollapsed)} title={defaultCollapsed ? 'Expand all' : 'Collapse all'}>
            {defaultCollapsed ? <Maximize2 className="h-3.5 w-3.5" /> : <Minimize2 className="h-3.5 w-3.5" />}
          </Tb>
        )}
        {viewMode !== 'script' && (
          <Tb active={showColumnEdges} onClick={() => setShowColumnEdges(!showColumnEdges)} title={showColumnEdges ? 'Table connections' : 'Column lineage'}>
            {showColumnEdges ? <GitBranch className="h-3.5 w-3.5" /> : <Route className="h-3.5 w-3.5" />}
          </Tb>
        )}
      </div>

      {/* Top‑right */}
      <div className="absolute right-3 top-3">
        <Tb active={layoutAlgo === 'dagre'} onClick={() => setLayoutAlgo((p) => (p === 'dagre' ? 'elk' : 'dagre'))} title={`Layout: ${layoutAlgo.toUpperCase()}`}>
          {layoutAlgo === 'dagre' ? <LayoutGrid className="h-3.5 w-3.5" /> : <Network className="h-3.5 w-3.5" />}
        </Tb>
      </div>

      {/* Search bar */}
      <div className={`absolute left-1/2 top-3 -translate-x-1/2 transition-all duration-200 ${searchVisible ? 'opacity-100 scale-100' : 'opacity-0 scale-95 pointer-events-none'}`}>
        <div className="flex items-center gap-1.5 rounded-lg border bg-background/95 px-2 py-1 shadow-lg backdrop-blur">
          <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <input ref={searchRef} type="text" value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && doSearch()} placeholder="Search table..." className="w-48 bg-transparent text-xs outline-none placeholder:text-muted-foreground/60" />
          {searchTerm && <button onClick={clearSearch} className="p-0.5 hover:bg-muted rounded"><X className="h-3 w-3 text-muted-foreground" /></button>}
          <span className="text-[10px] text-muted-foreground/50">{matchedNodeIds.size}</span>
          <Tb active={focusMode} onClick={() => setFocusMode(!focusMode)} title="Focus mode"><Maximize2 className="h-3 w-3" /></Tb>
        </div>
      </div>

      {/* Legend */}
      {legendVisible && (
        <div className="absolute left-3 top-11 rounded-lg border bg-background/95 px-2.5 py-2 shadow-lg backdrop-blur z-20 text-xs">
          <div className="font-semibold text-muted-foreground mb-1">Node Types</div>
          {legend.map(({ k, l }) => (
            <div key={k} className="flex items-center gap-2 py-0.5">
              <div className="h-3 w-3 rounded-sm border" style={{ backgroundColor: nc(k).bg, borderColor: nc(k).stroke }} /><span className="text-foreground/75">{l}</span>
            </div>
          ))}
        </div>
      )}

      {/* Bottom‑left info */}
      <div className="absolute bottom-3 left-3 flex items-center gap-2">
        <div className="rounded bg-background/80 px-2 py-1 text-[10px] text-muted-foreground backdrop-blur font-mono">{graphData.nodes.length}N {graphData.edges.length}E</div>
        {selectedNodeId && <div className="max-w-[260px] truncate rounded bg-background/80 px-2 py-1 text-[10px] text-primary backdrop-blur font-mono" title={selectedNodeId}>{selectedNodeId}</div>}
      </div>

      {/* Bottom‑right controls */}
      <div className="absolute bottom-3 right-3 flex gap-1">
        <Button variant="outline" size="sm" className="h-7 w-7 p-0" onClick={zi} title="Zoom in"><ZoomIn className="h-3.5 w-3.5" /></Button>
        <Button variant="outline" size="sm" className="h-7 w-7 p-0" onClick={zo} title="Zoom out"><ZoomOut className="h-3.5 w-3.5" /></Button>
        <Button variant="outline" size="sm" className="h-7 w-7 p-0" onClick={fit} title="Fit view"><Maximize2 className="h-3.5 w-3.5" /></Button>
      </div>
    </div>
  );
}

function hi(g: Graph, nodeId: string) {
  clr(g);
  const conn = new Set<string>([nodeId]); const d = g.getData();
  for (const e of d.edges as any[]) { if (e.source === nodeId) conn.add(e.target); if (e.target === nodeId) conn.add(e.source); }
  const sm: Record<string, string[]> = {};
  for (const n of d.nodes || []) sm[n.id as string] = conn.has(n.id as string) ? ['highlighted'] : [];
  for (const e of (d.edges as any[]) || []) { const eid = e.id || `${e.source}-${e.target}`; sm[eid] = conn.has(e.source) && conn.has(e.target) ? ['highlighted'] : []; }
  sm[nodeId] = ['highlighted', 'selected'];
  g.setElementState(sm);
}

function clr(g: Graph) {
  const d = g.getData(); const sm: Record<string, string[]> = {};
  for (const n of d.nodes || []) sm[n.id as string] = [];
  for (const e of (d.edges as any[]) || []) sm[e.id || `${e.source}-${e.target}`] = [];
  g.setElementState(sm);
}
