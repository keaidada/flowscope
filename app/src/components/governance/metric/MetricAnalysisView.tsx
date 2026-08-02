/**
 * MetricAnalysisView — global metric intelligence dashboard.
 *
 * Shows: quality scorecard, duplicate detection, metric families,
 * model load analysis, and optimization tips.
 *
 * Performance: limits rendered items per section to avoid browser freeze
 * on large projects (e.g., 293 duplicate groups). Uses "show more" buttons.
 */

import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle, ChevronDown, ChevronRight, Copy, Layers, Lightbulb, TrendingDown,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { governanceApi, type MetricAnalysis } from '@/lib/governance-api';

const MAX_DUPS = 15;
const MAX_LOADS = 15;
const MAX_NAMES_IN_CARD = 20;

export function MetricAnalysisView({ projectId }: { projectId: string | null }) {
  const { t } = useTranslation();
  const [analysis, setAnalysis] = useState<MetricAnalysis | null>(null);
  const [loading, setLoading] = useState(false);
  const [showAllDups, setShowAllDups] = useState(false);
  const [showAllLoads, setShowAllLoads] = useState(false);

  const refresh = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const a = await governanceApi.metricAnalysis(projectId);
      setAnalysis(a);
    } catch (e) {
      console.error('Metric analysis failed:', e);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { refresh(); }, [refresh]);

  if (!projectId) {
    return <div className="flex items-center justify-center h-full text-muted-foreground text-sm">{t('governance.selectProject', '请先选择项目')}</div>;
  }

  if (loading && !analysis) {
    return <div className="flex items-center justify-center h-full text-muted-foreground text-sm">{t('governance.loading', '加载中...')}</div>;
  }

  if (!analysis) {
    return <div className="flex items-center justify-center h-full text-muted-foreground text-sm">{t('governance.analysisFailed', '分析失败')}</div>;
  }

  const { quality, duplicates, families, model_loads, tips } = analysis;

  // Sort duplicates by group size (largest first) for priority display
  const crossModelDups = duplicates
    .filter((d) => d.dup_type === 'cross_model')
    .sort((a, b) => b.metric_names.length - a.metric_names.length);
  const sameModelDups = duplicates
    .filter((d) => d.dup_type === 'same_model')
    .sort((a, b) => b.metric_names.length - a.metric_names.length);

  const visibleCross = showAllDups ? crossModelDups : crossModelDups.slice(0, MAX_DUPS);
  const visibleSame = showAllDups ? sameModelDups : sameModelDups.slice(0, MAX_DUPS);
  const visibleLoads = showAllLoads ? model_loads : model_loads.slice(0, MAX_LOADS);
  const hiddenDupCount = crossModelDups.length + sameModelDups.length - visibleCross.length - visibleSame.length;

  return (
    <div className="flex-1 overflow-auto p-4 space-y-4">
      {/* === Quality Scorecard === */}
      <section>
        <h3 className="text-sm font-semibold mb-2">{t('governance.qualityScore', '指标质量评分')}</h3>
        <div className="grid grid-cols-2 gap-3">
          <ScoreBar label={t('governance.hasFilter', '有业务限定')} pct={quality.filter_pct} color="amber" />
          <ScoreBar label={t('governance.hasOwner', '有负责人')} pct={quality.owner_pct} color="blue" />
          <ScoreBar label={t('governance.hasPeriod', '有周期')} pct={quality.period_pct} color="green" />
          <div className="p-3 bg-muted/50 rounded-lg flex items-center justify-between">
            <span className="text-xs text-muted-foreground">{t('governance.totalMetrics', '指标总数')}</span>
            <span className="text-2xl font-bold">{quality.total}</span>
          </div>
        </div>
        {(quality.duplicate_metric_count > 0 || quality.conflict_count > 0) && (
          <div className="flex gap-3 mt-2 text-xs">
            {quality.duplicate_metric_count > 0 && (
              <span className="text-yellow-600 flex items-center gap-1">
                <Copy className="h-3 w-3" /> {quality.duplicate_metric_count} {t('governance.duplicateMetrics', '个指标涉及重复')}
              </span>
            )}
            {quality.conflict_count > 0 && (
              <span className="text-red-600 flex items-center gap-1">
                <AlertTriangle className="h-3 w-3" /> {quality.conflict_count} {t('governance.conflicts', '口径冲突')}
              </span>
            )}
          </div>
        )}
      </section>

      {/* === Optimization Tips === */}
      {tips.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold mb-2 flex items-center gap-1">
            <Lightbulb className="h-4 w-4 text-yellow-500" />
            {t('governance.optimizationTips', '优化建议')} ({tips.length})
          </h3>
          <div className="space-y-2">
            {tips.map((tip, i) => (
              <div
                key={i}
                className={cn(
                  'p-3 rounded-lg border text-sm',
                  tip.severity === 'high' && 'bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-800',
                  tip.severity === 'medium' && 'bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-800',
                  tip.severity === 'low' && 'bg-blue-50 dark:bg-blue-950/30 border-blue-200 dark:border-blue-800',
                )}
              >
                <div className="flex items-center gap-2">
                  <span className={cn(
                    'px-1.5 py-0.5 rounded text-[10px] font-bold uppercase',
                    tip.severity === 'high' && 'bg-red-200 text-red-800 dark:bg-red-800 dark:text-red-200',
                    tip.severity === 'medium' && 'bg-amber-200 text-amber-800 dark:bg-amber-800 dark:text-amber-200',
                    tip.severity === 'low' && 'bg-blue-200 text-blue-800 dark:bg-blue-800 dark:text-blue-200',
                  )}>
                    {tip.tip_type}
                  </span>
                  <span className="font-medium">{tip.title}</span>
                </div>
                <p className="text-xs text-muted-foreground mt-1">{tip.description}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* === Cross-model Duplicates === */}
      {crossModelDups.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold mb-2 flex items-center gap-1">
            <TrendingDown className="h-4 w-4 text-red-500" />
            {t('governance.crossModelDup', '跨模型重复计算')} ({crossModelDups.length})
          </h3>
          <div className="space-y-2">
            {visibleCross.map((dup, i) => (
              <ExpandableCard
                key={i}
                title={`${dup.aggregation.toUpperCase()} — ${dup.metric_names.length} ${t('governance.metrics', '个指标')}`}
                subtitle={`${t('governance.models', '模型')}: ${dup.bound_models.join(' vs ')}`}
                suggestion={dup.suggestion}
                metricNames={dup.metric_names}
                normalizedExpr={dup.normalized_expr}
              />
            ))}
          </div>
          {crossModelDups.length > MAX_DUPS && (
            <ShowMoreButton
              showAll={showAllDups}
              count={hiddenDupCount}
              onClick={() => setShowAllDups(!showAllDups)}
            />
          )}
        </section>
      )}

      {/* === Metric Families === */}
      {families.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold mb-2 flex items-center gap-1">
            <Layers className="h-4 w-4 text-purple-500" />
            {t('governance.metricFamilies', '指标族（相同模式）')} ({families.length})
          </h3>
          <div className="space-y-2">
            {families.map((fam, i) => (
              <ExpandableCard
                key={i}
                title={`${fam.bound_model} — ${fam.count} ${t('governance.metrics', '个同模式指标')}`}
                subtitle={fam.suggestion}
                columnBadges={fam.columns}
                normalizedExpr={fam.pattern}
              />
            ))}
          </div>
        </section>
      )}

      {/* === Model Load Analysis === */}
      {model_loads.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold mb-2 flex items-center gap-1">
            <AlertTriangle className="h-4 w-4 text-orange-500" />
            {t('governance.modelLoad', '模型负载分析')} ({model_loads.length})
          </h3>
          <div className="space-y-1">
            {visibleLoads.map((ml) => (
              <div key={ml.table_name} className="flex items-center gap-3 p-2 rounded border text-sm">
                <span className={cn(
                  'px-1.5 py-0.5 rounded text-[10px] font-bold shrink-0',
                  ml.load_level === 'heavy' && 'bg-red-200 text-red-800 dark:bg-red-800 dark:text-red-200',
                  ml.load_level === 'moderate' && 'bg-amber-200 text-amber-800 dark:bg-amber-800 dark:text-amber-200',
                )}>
                  {ml.load_level.toUpperCase()}
                </span>
                <span className="flex-1 truncate font-medium" title={ml.table_name}>{ml.table_name}</span>
                <span className="text-xs text-muted-foreground shrink-0">
                  {ml.metric_count} {t('governance.metrics', '指标')} · {ml.source_count} {t('governance.sourceTables', '源表')}
                </span>
              </div>
            ))}
          </div>
          {model_loads.length > MAX_LOADS && (
            <ShowMoreButton
              showAll={showAllLoads}
              count={model_loads.length - MAX_LOADS}
              onClick={() => setShowAllLoads(!showAllLoads)}
            />
          )}
        </section>
      )}

      {/* === Same-model Duplicates === */}
      {visibleSame.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold mb-2 flex items-center gap-1">
            <Copy className="h-4 w-4 text-yellow-500" />
            {t('governance.sameModelDup', '模型内重复')} ({sameModelDups.length})
          </h3>
          <div className="space-y-2">
            {visibleSame.map((dup, i) => (
              <ExpandableCard
                key={i}
                title={`${dup.aggregation.toUpperCase()} — ${dup.metric_names.length} ${t('governance.metrics', '个指标')}`}
                subtitle={dup.bound_models.join(', ')}
                metricNames={dup.metric_names}
                normalizedExpr={dup.normalized_expr}
              />
            ))}
          </div>
          {sameModelDups.length > MAX_DUPS && !showAllDups && (
            <ShowMoreButton
              showAll={false}
              count={sameModelDups.length - MAX_DUPS}
              onClick={() => setShowAllDups(true)}
            />
          )}
        </section>
      )}

      {tips.length === 0 && duplicates.length === 0 && families.length === 0 && model_loads.length === 0 && (
        <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
          <Lightbulb className="h-8 w-8 mb-2 text-green-500" />
          <p className="text-sm">{t('governance.noIssues', '暂无发现问题，指标状况良好')}</p>
        </div>
      )}
    </div>
  );
}

// ============================================================
// Sub-components
// ============================================================

function ScoreBar({ label, pct, color }: { label: string; pct: number; color: string }) {
  const colorClass = {
    amber: 'bg-amber-500',
    blue: 'bg-blue-500',
    green: 'bg-green-500',
  }[color] ?? 'bg-gray-500';

  return (
    <div className="p-3 bg-muted/50 rounded-lg">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className="text-sm font-bold">{pct}%</span>
      </div>
      <div className="h-2 bg-muted rounded-full overflow-hidden">
        <div className={cn('h-full rounded-full transition-all', colorClass)} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function ShowMoreButton({ showAll, count, onClick }: { showAll: boolean; count: number; onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      onClick={onClick}
      className="mt-2 px-3 py-1 text-xs text-primary hover:underline"
    >
      {showAll
        ? t('governance.showLess', '收起')
        : `${t('governance.showMore', '显示更多')} (+${count})`}
    </button>
  );
}

function ExpandableCard({
  title, subtitle, suggestion, metricNames, columnBadges, normalizedExpr,
}: {
  title: string;
  subtitle?: string;
  suggestion?: string;
  metricNames?: string[];
  columnBadges?: string[];
  normalizedExpr?: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  // Limit names shown inside the card
  const names = metricNames ?? [];
  const visibleNames = names.slice(0, MAX_NAMES_IN_CARD);
  const hiddenCount = names.length - visibleNames.length;

  const badges = columnBadges ?? [];
  const visibleBadges = badges.slice(0, MAX_NAMES_IN_CARD);
  const hiddenBadgeCount = badges.length - visibleBadges.length;

  return (
    <div className="border rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-accent/50"
      >
        {open ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium truncate">{title}</div>
          {subtitle && <div className="text-xs text-muted-foreground truncate">{subtitle}</div>}
        </div>
      </button>
      {open && (
        <div className="px-3 pb-3 space-y-2">
          {suggestion && (
            <div className="text-xs p-2 bg-blue-50 dark:bg-blue-950/30 rounded text-blue-700 dark:text-blue-300">
              {suggestion}
            </div>
          )}
          {visibleBadges.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {visibleBadges.map((col) => (
                <span key={col} className="px-1.5 py-0.5 rounded text-[10px] bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300">
                  {col}
                </span>
              ))}
              {hiddenBadgeCount > 0 && <span className="text-[10px] text-muted-foreground">+{hiddenBadgeCount}</span>}
            </div>
          )}
          {visibleNames.length > 0 && (
            <div className="space-y-0.5">
              {visibleNames.map((name) => (
                <div key={name} className="text-xs font-mono flex items-center gap-1">
                  <ChevronRight className="h-3 w-3 text-muted-foreground" /> {name}
                </div>
              ))}
              {hiddenCount > 0 && (
                <div className="text-xs text-muted-foreground pl-4">+{hiddenCount} {t('governance.more', '更多')}</div>
              )}
            </div>
          )}
          {normalizedExpr && (
            <div className="mt-1 p-2 bg-muted rounded text-xs font-mono break-all line-clamp-3">
              {normalizedExpr}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
