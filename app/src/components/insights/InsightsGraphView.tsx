import { useEffect, useMemo, useRef, type JSX } from 'react';
import { Database } from 'lucide-react';
import type { AnalyzeResult } from '@pondpilot/flowscope-core';
import {
  GraphErrorBoundary,
  GraphView,
  useLineageActions,
  useLineageState,
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
 * 本组件复用现有 GraphView，通过数据映射将「脚本 → 表」的关系
 * 转换为 GraphView 可渲染的「表 → 字段」结构。
 *
 * 生命周期：
 * - 挂载时：将转换后的 result 注入 lineage store
 * - 卸载时：还原原始 result
 *
 * 注意：GraphView 不接收 result prop，而是从 lineage store 中读取。
 * 因此本组件通过 setResult action 注入转换后的数据。
 */
export function InsightsGraphView({
  result,
  focusNodeId,
  onFocusApplied,
  className,
}: InsightsGraphViewProps): JSX.Element {
  const { t } = useTranslation();
  const { setResult: setLineageResult } = useLineageActions();
  const { result: storeResult } = useLineageState();

  // 缓存原始 result，用于卸载时还原
  const originalResultRef = useRef<AnalyzeResult | null>(storeResult);

  // 执行数据转换
  const conversion = useMemo(() => {
    if (!result) return null;
    return convertToInsightsGraph(result);
  }, [result]);

  // 注入转换后的 result 到 store；卸载时还原
  useEffect(() => {
    if (!conversion) return;

    // 记录注入前的原始 result（仅首次）
    if (originalResultRef.current === null || !isOriginalTrackable(originalResultRef.current)) {
      originalResultRef.current = storeResult;
    }

    setLineageResult(conversion.result);

    return () => {
      // 还原原始 result
      setLineageResult(originalResultRef.current);
    };
  }, [conversion, setLineageResult]);

  // 空状态
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

  if (!conversion || conversion.stats.scriptCount === 0) {
    return (
      <div className="flex h-full w-full items-center justify-center text-muted-foreground">
        <div className="flex flex-col items-center gap-3">
          <Database className="h-10 w-10 opacity-40" />
          <p className="text-sm">
            {t('insights.noScripts', '未发现任何脚本与表的关联关系')}
          </p>
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

      {/* 复用 GraphView 渲染 */}
      <div className="relative min-h-0 flex-1">
        <GraphErrorBoundary>
          <GraphView
            className="h-full w-full"
            focusNodeId={focusNodeId}
            onFocusApplied={onFocusApplied}
          />
        </GraphErrorBoundary>
      </div>
    </div>
  );
}

/**
 * 判断 result 是否可作为「原始」result 被追踪。
 * 数据洞察转换后的 result 含有特定 metadata 标记，不应被当作原始数据。
 */
function isOriginalTrackable(result: AnalyzeResult | null): boolean {
  if (!result?.globalLineage?.nodes) return true;
  // 检查是否为洞察视图自身生成的 result
  return !result.globalLineage.nodes.some(
    (n) => n.metadata?.isInsightsScriptNode || n.metadata?.isInsightsTableNode
  );
}
