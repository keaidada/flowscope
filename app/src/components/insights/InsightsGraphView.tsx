import { useMemo, type JSX } from 'react';
import { Database } from 'lucide-react';
import type { AnalyzeResult } from '@pondpilot/flowscope-core';
import {
  GraphErrorBoundary,
  GraphView,
  LineageProvider,
} from '@pondpilot/flowscope-react';
import { useTranslation } from 'react-i18next';
import { convertToInsightsGraph } from './data-mapper';

interface InsightsGraphViewProps {
  /** 原始血缘分析结果（来自当前项目全局血缘） */
  result: AnalyzeResult | null;
  /** 聚焦节点 ID */
  focusNodeId?: string;
  /** 聚焦完成回调 */
  onFocusApplied?: () => void;
  /** 附加 className */
  className?: string;
}

/**
 * 数据洞察图视图
 *
 * 通过嵌套 LineageProvider 创建隔离的 store，将转换后的数据注入
 * 给 GraphView，不影响全局 store 状态。
 *
 * 数据映射：脚本 → table 节点，表 → column 节点，
 * ownership 边表示包含关系，data_flow 边表示跨脚本依赖。
 */
export function InsightsGraphView({
  result,
  focusNodeId,
  onFocusApplied,
  className,
}: InsightsGraphViewProps): JSX.Element {
  const { t } = useTranslation();

  // 执行数据转换（仅在 result 引用变化时重新计算）
  const conversion = useMemo(() => {
    if (!result) return null;
    return convertToInsightsGraph(result);
  }, [result]);

  // 空状态：无 result
  if (!result) {
    return (
      <div className="flex h-full w-full items-center justify-center text-muted-foreground">
        <div className="flex flex-col items-center gap-3">
          <Database className="h-10 w-10 opacity-40" />
          <p className="text-sm">{t('insights.emptyState', '请先分析 SQL 脚本以查看数据洞察')}</p>
        </div>
      </div>
    );
  }

  // 空状态：无脚本数据
  if (!conversion || conversion.stats.scriptCount === 0) {
    return (
      <div className="flex h-full w-full items-center justify-center text-muted-foreground">
        <div className="flex flex-col items-center gap-3">
          <Database className="h-10 w-10 opacity-40" />
          <p className="text-sm">{t('insights.noScripts', '未发现任何脚本与表的关联关系')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className={`flex h-full w-full flex-col ${className ?? ''}`}>
      {/* 统计信息条 */}
      <div className="flex items-center gap-4 border-b border-border bg-muted/10 px-4 py-1.5 text-xs text-muted-foreground">
        <span>
          {t('insights.stats.scripts', '脚本')}: <strong>{conversion.stats.scriptCount}</strong>
        </span>
        <span>
          {t('insights.stats.tables', '表')}: <strong>{conversion.stats.uniqueTableCount}</strong>
        </span>
        <span>
          {t('insights.stats.flows', '跨脚本关系')}:{' '}
          <strong>{conversion.stats.dataFlowEdgeCount}</strong>
        </span>
      </div>

      {/* 隔离的 store + 复用 GraphView 渲染 */}
      <div className="relative min-h-0 flex-1">
        <LineageProvider
          initialResult={conversion.result}
          defaultLayoutAlgorithm="dagre"
        >
          <GraphErrorBoundary>
            <GraphView
              className="h-full w-full"
              focusNodeId={focusNodeId}
              onFocusApplied={onFocusApplied}
            />
          </GraphErrorBoundary>
        </LineageProvider>
      </div>
    </div>
  );
}
