import { useCallback, type FC } from 'react';
import { Network, Rows3, LayoutGrid } from 'lucide-react';
import type { AnalyzeResult } from '@pondpilot/flowscope-core';
import {
  GraphErrorBoundary,
  GraphView,
  MatrixView,
  useLineageActions,
} from '@pondpilot/flowscope-react';
import { useTranslation } from 'react-i18next';
import { Button } from './ui/button';
import { GlobalLineageListView } from './GlobalLineageListView';
import { usePersistedMatrixState } from '@/hooks/usePersistedMatrixState';
import { useProject } from '@/lib/project-store';
import { useGlobalLineageData } from '@/hooks/useGlobalLineageData';

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
  const { activeProjectId } = useProject();
  const matrixState = usePersistedMatrixState(activeProjectId);

  // Shared data — computed once, consumed by list and potentially matrix
  useGlobalLineageData(result);

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
          <MatrixView
            className="h-full w-full"
            controlledState={matrixState.controlledState}
            onStateChange={matrixState.onStateChange}
          />
        )}
      </div>
    </div>
  );
};
