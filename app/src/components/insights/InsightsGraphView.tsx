import { useCallback, useRef, useState, type JSX } from 'react';
import { Search, X, Database, Layers, Loader2 } from 'lucide-react';
import type { AnalyzeResult } from '@pondpilot/flowscope-core';
import {
  GraphErrorBoundary,
  GraphView,
  useLineageStore,
} from '@pondpilot/flowscope-react';
import { useProject } from '@/lib/project-store';
import { searchLineageForInsights } from '@/lib/analysis-cache';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

const DEPTH_OPTIONS = [1, 2, 3] as const;

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
  const setResult = useLineageStore((state) => state.setResult);
  const setViewMode = useLineageStore((state) => state.setViewMode);
  const storeResult = useLineageStore((state) => state.result);

  const [searchTerm, setSearchTerm] = useState('');
  const [hasSearched, setHasSearched] = useState(false);
  const [searchResult, setSearchResult] = useState<AnalyzeResult | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [depth, setDepth] = useState<number>(1);

  // Capture the original tableLevelResult for restoring on unmount.
  const originalResult = useRef<AnalyzeResult | null>(null);
  const captured = useRef(false);
  if (!captured.current && storeResult) {
    originalResult.current = storeResult;
    captured.current = true;
  }

  const runSearch = useCallback(
    async (searchDepth: number) => {
      const term = searchTerm.trim();
      if (!term || !activeProjectId) return;

      setIsSearching(true);
      setSearchError(null);
      setHasSearched(true);

      try {
        const filtered = await searchLineageForInsights(activeProjectId, term, searchDepth);
        setSearchResult(filtered);
        setViewMode('script');
        setResult(filtered);
      } catch (err) {
        console.error('[InsightsGraphView] Search failed:', err);
        setSearchError(err instanceof Error ? err.message : '搜索失败');
      } finally {
        setIsSearching(false);
      }
    },
    [searchTerm, activeProjectId, setResult, setViewMode],
  );

  const handleSearch = useCallback(() => { runSearch(depth); }, [runSearch, depth]);

  // Re-run search when depth changes (if already searched)
  const prevDepth = useRef(depth);
  if (prevDepth.current !== depth) {
    prevDepth.current = depth;
    if (hasSearched && searchTerm.trim() && activeProjectId) {
      runSearch(depth);
    }
  }

  const handleClear = useCallback(() => {
    setSearchTerm('');
    setHasSearched(false);
    setSearchResult(null);
    setSearchError(null);
    setResult(null);
  }, [setResult]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') handleSearch();
    },
    [handleSearch],
  );

  const showGraph = hasSearched && searchResult && !searchError;

  return (
    <div className={`flex min-w-0 flex-1 flex-col ${className ?? ''}`}>
      {/* Search toolbar */}
      <div className="flex items-center gap-2 border-b border-border bg-muted/10 px-4 py-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-8 pr-8"
            placeholder="搜索脚本名或表名..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          {searchTerm && (
            <button
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              onClick={() => setSearchTerm('')}
              tabIndex={-1}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {/* Depth selector */}
        <div className="flex items-center gap-1 rounded-md border bg-background p-0.5">
          <Layers className="ml-1 h-3 w-3 text-muted-foreground" />
          {DEPTH_OPTIONS.map((d) => (
            <button
              key={d}
              onClick={() => setDepth(d)}
              className={`flex h-6 w-7 items-center justify-center rounded text-xs font-medium transition-colors ${
                depth === d
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {d}
            </button>
          ))}
        </div>

        <Button
          variant="secondary"
          size="sm"
          className="h-8 gap-1.5 text-xs"
          onClick={handleSearch}
          disabled={!searchTerm.trim() || isSearching}
        >
          {isSearching ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Search className="h-3.5 w-3.5" />
          )}
          搜索
        </Button>
        {hasSearched && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-1.5 text-xs"
            onClick={handleClear}
          >
            <X className="h-3.5 w-3.5" />
            清除
          </Button>
        )}
      </div>

      {/* Content area */}
      <div className="relative min-h-0 flex-1">
        {/* Empty / initial state */}
        {!showGraph && (
          <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
            <div className="rounded-full bg-muted p-4">
              <Database className="h-8 w-8 text-muted-foreground" />
            </div>
            <div>
              <h3 className="text-base font-medium">数据洞察</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                输入脚本名或表名，探索数据血缘关系
              </p>
            </div>
            {hasSearched && !searchError && !searchResult && (
              <p className="text-sm text-muted-foreground">
                未找到匹配的结果，请尝试其他关键词
              </p>
            )}
            {searchError && (
              <p className="text-sm text-destructive">{searchError}</p>
            )}
          </div>
        )}

        {/* Graph */}
        {showGraph && (
          <GraphErrorBoundary>
            <GraphView
              className="h-full w-full"
              focusNodeId={focusNodeId}
              onFocusApplied={onFocusApplied}
            />
          </GraphErrorBoundary>
        )}
      </div>
    </div>
  );
}
