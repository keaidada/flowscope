import { useCallback, useMemo, type FC } from 'react';
import { Network, Rows3, LayoutGrid } from 'lucide-react';
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
import { useGlobalLineageData } from '@/hooks/useGlobalLineageData';
import { usePipelineData } from '@/hooks/usePipelineData';
import type { LayerDef } from '@/types/pipeline-matrix';

export type GlobalLineageMode = 'graph' | 'list' | 'matrix';

interface GlobalLineageViewProps {
  result: AnalyzeResult | null;
  mode: GlobalLineageMode;
  onModeChange: (mode: GlobalLineageMode) => void;
  focusNodeId?: string;
  onFocusApplied?: () => void;
  className?: string;
}

export const GlobalLineageView: FC<GlobalLineageViewProps> = ({
  result,
  mode,
  onModeChange,
  focusNodeId,
  onFocusApplied,
  className,
}) => {
  const { t } = useTranslation();
  const lineageActions = useLineageActions();

  // Shared data — computed once, consumed by list and matrix
  useGlobalLineageData(result);
  const { tasks: pipelineTasks, taskNames: pipelineTaskNames } = usePipelineData(result);

  // Dynamic layers from actual data
  const pipelineLayers = useMemo<LayerDef[]>(() => {
    const seen = new Map<string, number>();
    for (const t of pipelineTasks) {
      const key = t.layer;
      if (!seen.has(key)) seen.set(key, seen.size);
    }
    return [...seen.entries()]
      .sort(([, a], [, b]) => b - a)
      .map(([key]) => ({
        key,
        label: key,
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
      <div className="min-h-0 flex-1">
        {mode === 'graph' && (
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
