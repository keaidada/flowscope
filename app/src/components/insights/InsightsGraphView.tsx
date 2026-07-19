import { useEffect, useRef, useState, type JSX } from 'react';
import type { AnalyzeResult } from '@pondpilot/flowscope-core';
import { GraphErrorBoundary, GraphView, useLineageActions } from '@pondpilot/flowscope-react';
import { convertToInsightsGraph, isInsightsResult } from './data-mapper';

export interface InsightsGraphViewProps {
  /** 原始血缘分析结果 */
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
 * 功能与关系图（GraphView）完全一致：搜索、布局切换、展开/折叠、
 * 高亮路径、缩略图、导出等全部保留。
 *
 * 区别仅在于数据：通过 data-mapper 将「脚本→表」关系映射为
 * GraphView 可渲染的「表→字段」结构（脚本=table节点，表=column节点）。
 *
 * 实现原理：
 * 1. 挂载时捕获原始 result，转换为洞察格式
 * 2. 注入主 store（GraphView 从 store 读取，所有功能自然继承）
 * 3. 卸载时还原原始 result
 *
 * 反馈循环防护：
 * - 使用 useState 初始化器确保转换只执行一次
 * - 使用 useRef 捕获挂载时的原始 result
 * - isInsightsResult() 防止重复转换
 */
export function InsightsGraphView({
  result,
  focusNodeId,
  onFocusApplied,
  className,
}: InsightsGraphViewProps): JSX.Element {
  const { setResult: setLineageResult } = useLineageActions();

  // 捕获挂载时的原始 result（防止反馈循环）
  const originalResultRef = useRef<AnalyzeResult | null>(null);
  if (originalResultRef.current === null && result !== null && !isInsightsResult(result)) {
    originalResultRef.current = result;
  }

  // 数据转换：只在首次渲染时执行一次
  const [conversion] = useState(() => {
    const source = originalResultRef.current ?? result;
    if (!source || isInsightsResult(source)) return null;
    return convertToInsightsGraph(source);
  });

  // 挂载时注入转换数据，卸载时还原原始数据
  useEffect(() => {
    if (!conversion) return;

    setLineageResult(conversion.result);

    return () => {
      if (originalResultRef.current) {
        setLineageResult(originalResultRef.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 渲染 GraphView（完全复用，所有功能保留）
  return (
    <div className={className}>
      <GraphErrorBoundary>
        <GraphView
          className="h-full w-full"
          focusNodeId={focusNodeId}
          onFocusApplied={onFocusApplied}
        />
      </GraphErrorBoundary>
    </div>
  );
}
