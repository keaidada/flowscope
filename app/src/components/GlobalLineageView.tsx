import { useCallback, useMemo, useEffect, useRef, type FC } from 'react';
import { Network, Rows3, LayoutGrid, Loader2, Database } from 'lucide-react';
import type { AnalyzeResult } from '@pondpilot/flowscope-core';
import {
  GraphErrorBoundary,
  GraphView,
  useLineageActions,
} from '@pondpilot/flowscope-react';
import { useTranslation } from 'react-i18next';
import { Button } from './ui/button';
import { GlobalLineageListView } from './GlobalLineageListView';
import { TaskLayerMatrix } from './TaskLayerMatrix';
import { convertToInsightsGraph, isInsightsResult } from './insights/data-mapper';
import { useGlobalLineageData } from '@/hooks/useGlobalLineageData';
import { usePipelineData } from '@/hooks/usePipelineData';
import type { LayerDef } from '@/types/pipeline-matrix';

export type GlobalLineageMode = 'graph' | 'list' | 'matrix' | 'insights';

interface GlobalLineageViewProps {
  result: AnalyzeResult | null;
  mode: GlobalLineageMode;
  onModeChange: (mode: GlobalLineageMode) => void;
  focusNodeId?: string;
  onFocusApplied?: () => void;
  className?: string;
  loading?: boolean;
}

export const GlobalLineageView: FC<GlobalLineageViewProps> = ({
  result,
  mode,
  onModeChange,
  focusNodeId,
  onFocusApplied,
  className,
  loading,
}) => {
  const { t } = useTranslation();
  const lineageActions = useLineageActions();
  const { setResult: setLineageResult } = lineageActions;

  // Shared data — computed once, consumed by list and matrix
  const { isLightweight, loadEntryDetail } = useGlobalLineageData(result);
  const { tasks: pipelineTasks, taskNames: pipelineTaskNames } = usePipelineData(result);

  // Dynamic layers L1-Ln based on actual pipeline data
  const pipelineLayers = useMemo<LayerDef[]>(() => {
    const layerMap = new Map<string, number>();
    for (const task of pipelineTasks) {
      const key = task.layer;
      layerMap.set(key, (layerMap.get(key) ?? 0) + 1);
    }
    if (layerMap.size === 0) {
      return [{ key: 'L1', label: 'L1', type: 'logical' as const, order: 0 }];
    }
    const sorted = Array.from(layerMap.entries()).sort(([a], [b]) => {
      const na = parseInt(a.slice(1));
      const nb = parseInt(b.slice(1));
      return na - nb;
    });
    return sorted.map(([key, count]) => ({
      key,
      label: `${key} (${count})`,
      type: 'logical' as const,
      order: 0,
    }));
  }, [pipelineTasks]);

  // Navigate from list → graph (focus on a specific node)
  const handleOpenGraphForNode = useCallback(
    (nodeId: string) => {
      lineageActions.selectNode(nodeId);
      onModeChange('graph');
    },
    [lineageActions, onModeChange]
  );

  // ── 数据洞察模式：转换数据并注入主 store，使 GraphView 完整复用 ──
  const insightsConvertedRef = useRef(false);
  const originalResultRef = useRef<AnalyzeResult | null>(null);

  useEffect(() => {
    if (mode === 'insights' && result && !insightsConvertedRef.current) {
      // 进入洞察模式：保存原始数据并注入转换后的数据
      if (!isInsightsResult(result)) {
        originalResultRef.current = result;
        const { result: converted } = convertToInsightsGraph(result);
        setLineageResult(converted);
      }
      insightsConvertedRef.current = true;
    } else if (mode !== 'insights' && insightsConvertedRef.current) {
      // 离开洞察模式：还原原始数据
      if (originalResultRef.current) {
        setLineageResult(originalResultRef.current);
        originalResultRef.current = null;
      }
      insightsConvertedRef.current = false;
    }
  }, [mode, result, setLineageResult]);

  return (
    <div className={`flex min-w-0 flex-1 flex-col ${className ?? ''}`}>
      {/* Toolbar */}
      <div className="flex items-center justify-between border-b border-border bg-muted/10 px-4 py-2">
        <div className="flex items-center gap-2">
          <Button
            variant={mode === 'graph' ? 'secondary' : 'ghost'}
            size="sm"
            className="h-8 gap-1.5 text-xs"
            onClick={() => onModeChange('graph')}
          >
            <Network className="h-3.5 w-3.5" />
            {t('globalLineageList.graphView')}
          </Button>
          <Button
            variant={mode === 'list' ? 'secondary' : 'ghost'}
            size="sm"
            className="h-8 gap-1.5 text-xs"
            onClick={() => onModeChange('list')}
          >
            <Rows3 className="h-3.5 w-3.5" />
            {t('globalLineageList.listView')}
          </Button>
          <Button
            variant={mode === 'matrix' ? 'secondary' : 'ghost'}
            size="sm"
            className="h-8 gap-1.5 text-xs"
            onClick={() => onModeChange('matrix')}
          >
            <LayoutGrid className="h-3.5 w-3.5" />
            Matrix
          </Button>
          <Button
            variant={mode === 'insights' ? 'secondary' : 'ghost'}
            size="sm"
            className="h-8 gap-1.5 text-xs"
            onClick={() => onModeChange('insights')}
          >
            <Database className="h-3.5 w-3.5" />
            {t('globalLineageList.insightsView', '数据洞察')}
          </Button>
        </div>
        {result && (
          <div className="text-xs text-muted-foreground">
            {t('globalLineageList.summary', {
              tables: result.summary.tableCount,
              flows: result.globalLineage?.edges?.length ?? 0,
            })}
          </div>
        )}
      </div>

      {/* Content */}
      <div className="min-h-0 flex-1 relative">
        {loading && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
            <div className="flex flex-col items-center gap-3">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
              <p className="text-sm text-muted-foreground">
                {t('app.loading', '加载血缘数据中...')}
              </p>
            </div>
          </div>
        )}
        {(mode === 'graph' || mode === 'insights') && (
          <GraphErrorBoundary>
            <GraphView
              className="h-full w-full"
              focusNodeId={focusNodeId}
              onFocusApplied={onFocusApplied}
            />
          </GraphErrorBoundary>
        )}
        {mode === 'list' && (
          <GlobalLineageListView
            result={result}
            onOpenGraphForNode={handleOpenGraphForNode}
            isLightweight={isLightweight}
            loadEntryDetail={loadEntryDetail}
          />
        )}
        {mode === 'matrix' && (
          <TaskLayerMatrix
            className="h-full w-full"
            tasks={pipelineTasks}
            taskNames={pipelineTaskNames}
            layers={pipelineLayers}
          />
        )}
      </div>
    </div>
  );
};
