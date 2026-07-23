import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import { Search, X, Database, Loader2, ArrowUp, ArrowDown, Minus, Plus } from 'lucide-react';
import {
  GraphErrorBoundary,
  GraphView,
  createLineageStore,
  LineageStoreProvider,
} from '@pondpilot/flowscope-react';
import { useProject } from '@/lib/project-store';
import { searchLineageForInsights } from '@/lib/analysis-cache';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { InsightsScriptNode } from './InsightsScriptNode';
import { TableEdge } from './TableEdge';

function DepthControl({
  label, icon: Icon, value, onChange,
}: { label: string; icon: typeof ArrowUp; value: number; onChange: (v: number) => void; }) {
  return (
    <div className="flex items-center gap-1 rounded-md border bg-background p-0.5">
      <div className="flex items-center gap-1 pl-1.5 text-xs font-medium text-muted-foreground">
        <Icon className="h-3 w-3" />{label}
      </div>
      <button onClick={() => onChange(Math.max(0, value - 1))} className="flex h-6 w-5 items-center justify-center rounded text-muted-foreground hover:text-foreground"><Minus className="h-3 w-3" /></button>
      <input type="number" min={0} max={99} value={value}
        onChange={(e) => { const v = parseInt(e.target.value, 10); if (!isNaN(v) && v >= 0) onChange(v); }}
        className="h-6 w-7 border-0 bg-transparent text-center text-xs font-medium outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none" />
      <button onClick={() => onChange(Math.min(99, value + 1))} className="flex h-6 w-5 items-center justify-center rounded text-muted-foreground hover:text-foreground"><Plus className="h-3 w-3" /></button>
    </div>
  );
}

export interface InsightsGraphViewProps {
  focusNodeId?: string;
  onFocusApplied?: () => void;
  className?: string;
}

export function InsightsGraphView({
  focusNodeId,
  onFocusApplied,
  className,
}: InsightsGraphViewProps): JSX.Element {
  const { activeProjectId } = useProject();

  // 独立 store，不共享关系图的 store
  const insightsStore = useMemo(() => createLineageStore({}, { defaultLayoutAlgorithm: 'elk' as const }), []);

  const [searchTerm, setSearchTerm] = useState('');
  const [hasSearched, setHasSearched] = useState(false);
  const [hasResult, setHasResult] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [upstreamDepth, setUpstreamDepth] = useState(1);
  const [downstreamDepth, setDownstreamDepth] = useState(1);

  const runSearch = useCallback(async (upDepth: number, dnDepth: number) => {
    const term = searchTerm.trim();
    if (!term || !activeProjectId) return;
    setIsSearching(true);
    setSearchError(null);
    setHasSearched(true);
    try {
      const filtered = await searchLineageForInsights(activeProjectId, term, upDepth, dnDepth);
      if (filtered) {
        setHasResult(true);
        insightsStore.getState().setViewMode('script');
        insightsStore.getState().setSearchTerm(term);
        insightsStore.getState().setResult(filtered);
        // 默认展开
        if (!insightsStore.getState().showScriptTables) {
          insightsStore.getState().toggleShowScriptTables();
        }
      } else {
        setHasResult(false);
        insightsStore.getState().setResult(null);
      }
    } catch (err) {
      console.error('[InsightsGraphView] Search failed:', err);
      setSearchError(err instanceof Error ? err.message : '搜索失败');
    } finally {
      setIsSearching(false);
    }
  }, [searchTerm, activeProjectId, insightsStore]);

  const handleSearch = useCallback(() => runSearch(upstreamDepth, downstreamDepth), [runSearch, upstreamDepth, downstreamDepth]);

  useEffect(() => {
    if (hasSearched && searchTerm.trim() && activeProjectId) {
      runSearch(upstreamDepth, downstreamDepth);
    }
  }, [upstreamDepth, downstreamDepth]); // eslint-disable-line

  const handleClear = useCallback(() => {
    setSearchTerm('');
    setHasSearched(false);
    setHasResult(false);
    setSearchError(null);
    insightsStore.getState().setResult(null);
    insightsStore.getState().setSearchTerm('');
  }, [insightsStore]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter') handleSearch(); }, [handleSearch]);

  const showGraph = hasSearched && hasResult && !searchError;

  return (
    <div className={`flex min-w-0 flex-1 flex-col ${className ?? ''}`}>
      <div className="flex items-center gap-2 border-b border-border bg-muted/10 px-4 py-2">
        <div className="relative min-w-0 flex-1">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-8 pr-8" placeholder="搜索脚本名或表名..." value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)} onKeyDown={handleKeyDown} />
          {searchTerm && (
            <button className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" onClick={() => setSearchTerm('')} tabIndex={-1}>
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <DepthControl label="上游" icon={ArrowUp} value={upstreamDepth} onChange={setUpstreamDepth} />
        <DepthControl label="下游" icon={ArrowDown} value={downstreamDepth} onChange={setDownstreamDepth} />
        <Button variant="secondary" size="sm" className="h-8 gap-1.5 text-xs" onClick={handleSearch} disabled={!searchTerm.trim() || isSearching}>
          {isSearching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
          搜索
        </Button>
        {hasSearched && (
          <Button variant="ghost" size="sm" className="h-8 gap-1.5 text-xs" onClick={handleClear}>
            <X className="h-3.5 w-3.5" />清除
          </Button>
        )}
      </div>
      <div className="relative min-h-0 flex-1">
        {isSearching && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/50 backdrop-blur-[1px] transition-opacity">
            <div className="flex flex-col items-center gap-3">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
              <span className="text-sm text-muted-foreground">正在搜索...</span>
            </div>
          </div>
        )}
        {!showGraph && !isSearching && (
          <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
            <div className="rounded-full bg-muted p-4"><Database className="h-8 w-8 text-muted-foreground" /></div>
            <div>
              <h3 className="text-base font-medium">数据洞察</h3>
              <p className="mt-1 text-sm text-muted-foreground">输入脚本名或表名，探索数据血缘关系</p>
            </div>
            {hasSearched && !searchError && !hasResult && (
              <p className="text-sm text-muted-foreground">未找到匹配的结果，请尝试其他关键词</p>
            )}
            {searchError && <p className="text-sm text-destructive">{searchError}</p>}
          </div>
        )}
        {showGraph && (
          <LineageStoreProvider store={insightsStore}>
            <GraphErrorBoundary>
              <GraphView
                className="h-full w-full"
                focusNodeId={focusNodeId}
                onFocusApplied={onFocusApplied}
                customNodeTypes={{ scriptNode: InsightsScriptNode }}
                customEdgeTypes={{ animated: TableEdge }}
                scriptOnly
              />
            </GraphErrorBoundary>
          </LineageStoreProvider>
        )}
      </div>
    </div>
  );
}
