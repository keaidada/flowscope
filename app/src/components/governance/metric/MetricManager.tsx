/**
 * MetricManager — metric list + search + filters + conflicts + detail.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, BarChart3, Database, GitBranch, Search, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { governanceApi, type MetricEntry, type MetricConflict, type MetricStats } from '@/lib/governance-api';

const AGG_COLORS: Record<string, string> = {
  sum: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
  count: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
  count_distinct: 'bg-teal-100 text-teal-700 dark:bg-teal-900 dark:text-teal-300',
  avg: 'bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300',
  average: 'bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300',
  max: 'bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300',
  min: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300',
  median: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900 dark:text-indigo-300',
};

function aggBadgeClass(agg: string): string {
  return AGG_COLORS[agg.toLowerCase()] ?? 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400';
}

export function MetricManager({ projectId }: { projectId: string | null }) {
  const { t } = useTranslation();
  const [metrics, setMetrics] = useState<MetricEntry[]>([]);
  const [conflicts, setConflicts] = useState<MetricConflict[]>([]);
  const [stats, setStats] = useState<MetricStats | null>(null);
  const [selected, setSelected] = useState<MetricEntry | null>(null);

  // Filters
  const [searchText, setSearchText] = useState('');
  const [aggFilter, setAggFilter] = useState<string>('');
  const [layerFilter, setLayerFilter] = useState<string>('');

  const refresh = useCallback(async () => {
    if (!projectId) return;
    try {
      const ms = await governanceApi.listMetrics(new URLSearchParams({ project_id: projectId }).toString());
      setMetrics(ms);
      const cs = await governanceApi.metricConflicts(projectId);
      setConflicts(cs);
      const s = await governanceApi.metricStats(projectId);
      setStats(s);
    } catch (e) { console.error('Metric list failed:', e); }
  }, [projectId]);

  useEffect(() => { refresh(); }, [refresh]);

  const handleAutoDetect = async () => {
    if (!projectId) return;
    try {
      const r = await governanceApi.autoDetectMetrics(projectId);
      console.log(`Auto-detected ${r.detected} metrics`);
      await refresh();
    } catch (e) { console.error('Auto-detect failed:', e); }
  };

  const [importMsg, setImportMsg] = useState<string | null>(null);

  const handleImportDbt = async () => {
    if (!projectId) return;
    try {
      setImportMsg(null);
      const r = await governanceApi.importDbtMetrics(projectId);
      const msg = r.imported > 0
        ? `${t('governance.importDbtDone', '已导入')} ${r.imported} ${t('governance.metrics', '个指标')}${r.skipped.length > 0 ? `（跳过 ${r.skipped.length}）` : ''}`
        : t('governance.importDbtEmpty', '未发现 dbt MetricFlow 定义（semantic_models.yml / metrics.yml）');
      setImportMsg(msg);
      await refresh();
    } catch (e) {
      console.error('dbt import failed:', e);
      setImportMsg(String(e));
    }
  };

  const handleExtractLineage = async () => {
    if (!projectId) return;
    try {
      setImportMsg(null);
      const r = await governanceApi.extractLineageMetrics(projectId);
      setImportMsg(`${t('governance.extractLineageDone', '从血缘提取')} ${r.extracted} ${t('governance.metrics', '个指标')}`);
      await refresh();
    } catch (e) {
      console.error('Lineage extraction failed:', e);
      setImportMsg(String(e));
    }
  };

  // Derived filter options from metrics data
  const aggOptions = useMemo(() => {
    const set = new Set<string>();
    metrics.forEach((m) => { if (m.aggregation) set.add(m.aggregation); });
    return Array.from(set).sort();
  }, [metrics]);

  const layerOptions = useMemo(() => {
    const set = new Set<string>();
    metrics.forEach((m) => { if (m.layer) set.add(m.layer); });
    return Array.from(set).sort();
  }, [metrics]);

  // Filtered metrics
  const filtered = useMemo(() => {
    const lower = searchText.toLowerCase().trim();
    return metrics.filter((m) => {
      if (aggFilter && m.aggregation.toLowerCase() !== aggFilter.toLowerCase()) return false;
      if (layerFilter && m.layer !== layerFilter) return false;
      if (lower) {
        const haystack = `${m.metric_name} ${m.expression} ${m.business_filter} ${m.definition} ${m.source_tables}`.toLowerCase();
        if (!haystack.includes(lower)) return false;
      }
      return true;
    });
  }, [metrics, searchText, aggFilter, layerFilter]);

  if (!projectId) {
    return <div className="flex items-center justify-center h-full text-muted-foreground text-sm">{t('governance.selectProject', '请先选择项目')}</div>;
  }

  return (
    <div className="flex h-full">
      {/* Left: list + filters */}
      <div className="w-80 border-r flex flex-col">
        {/* Action buttons */}
        <div className="flex items-center gap-1 px-2 py-1.5 border-b">
          <Button variant="ghost" size="sm" onClick={handleAutoDetect} className="h-6 px-2 text-xs">
            <Sparkles className="h-3 w-3 mr-1" />Auto-detect
          </Button>
          <Button variant="ghost" size="sm" onClick={handleImportDbt} className="h-6 px-2 text-xs" title="从 dbt MetricFlow (semantic_models.yml / metrics.yml) 导入指标">
            <Database className="h-3 w-3 mr-1" />Import dbt
          </Button>
          <Button variant="ghost" size="sm" onClick={handleExtractLineage} className="h-6 px-2 text-xs" title="从字段级血缘提取指标（覆盖全部文件）">
            <GitBranch className="h-3 w-3 mr-1" />From Lineage
          </Button>
        </div>

        {importMsg && (
          <div className="px-3 py-1.5 border-b text-xs text-muted-foreground">{importMsg}</div>
        )}

        {/* Search + filters */}
        <div className="px-2 py-1.5 border-b space-y-1.5">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
            <input
              type="text"
              placeholder={t('governance.searchMetrics', '搜索指标名/表达式/业务限定...')}
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              className="w-full pl-7 pr-2 py-1 text-xs rounded border bg-transparent focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
          <div className="flex gap-1">
            <select
              value={aggFilter}
              onChange={(e) => setAggFilter(e.target.value)}
              className="flex-1 text-xs px-1 py-0.5 rounded border bg-transparent"
            >
              <option value="">{t('governance.allAggs', '全部聚合')}</option>
              {aggOptions.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
            <select
              value={layerFilter}
              onChange={(e) => setLayerFilter(e.target.value)}
              className="flex-1 text-xs px-1 py-0.5 rounded border bg-transparent"
            >
              <option value="">{t('governance.allLayers', '全部层级')}</option>
              {layerOptions.map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
          </div>
        </div>

        {/* Stats bar */}
        {stats && (
          <div className="flex gap-3 px-3 py-1.5 border-b bg-muted/20 text-xs text-muted-foreground">
            <span>{t('governance.total', '总计')}: <b className="text-foreground">{filtered.length}</b>{filtered.length !== stats.total && `/${stats.total}`}</span>
            {stats.conflict_count > 0 && (
              <span className="text-yellow-600">⚠ {stats.conflict_count} {t('governance.conflicts', '冲突')}</span>
            )}
          </div>
        )}

        {/* Metric list */}
        <div className="flex-1 overflow-auto">
          {filtered.map((m) => (
            <button
              key={m.id}
              onClick={() => setSelected(m)}
              className={cn(
                'w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-accent/50 border-b',
                selected?.id === m.id && 'bg-accent'
              )}
            >
              <BarChart3 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium truncate">{m.metric_name}</div>
                <div className="flex items-center gap-1 mt-0.5">
                  {m.aggregation && (
                    <span className={cn('px-1 rounded text-[10px] font-medium', aggBadgeClass(m.aggregation))}>
                      {m.aggregation}
                    </span>
                  )}
                  {m.business_filter && (
                    <span className="text-[10px] text-amber-600 dark:text-amber-400 truncate">⚡ {m.business_filter.split(';')[0].trim()}</span>
                  )}
                </div>
              </div>
              {m.layer && m.layer !== 'unknown' && (
                <span className="px-1 rounded text-[10px] bg-muted shrink-0">{m.layer}</span>
              )}
            </button>
          ))}
          {filtered.length === 0 && (
            <div className="text-center py-8 text-sm text-muted-foreground">
              {metrics.length === 0
                ? t('governance.noMetrics', '暂无指标，点击上方按钮提取')
                : t('governance.noMatch', '无匹配指标')}
            </div>
          )}
        </div>
      </div>

      {/* Right: detail */}
      <div className="flex-1 overflow-auto p-4 space-y-4">
        {/* Conflicts */}
        {conflicts.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-sm font-semibold flex items-center gap-1">
              <AlertTriangle className="h-4 w-4 text-yellow-500" />
              {t('governance.metricConflicts', '口径冲突')} ({conflicts.length})
            </h3>
            {conflicts.map((c, i) => (
              <div key={i} className="p-3 bg-yellow-50 dark:bg-yellow-950/30 border border-yellow-200 dark:border-yellow-800 rounded-lg">
                <div className="flex items-center gap-2 text-sm">
                  <span className="px-1.5 py-0.5 bg-yellow-200 text-yellow-800 dark:bg-yellow-800 dark:text-yellow-200 rounded text-xs font-medium">
                    {c.conflict_type}
                  </span>
                  <span>{c.metric_names.join(' ≈ ')}</span>
                </div>
                {c.detail.expression ? (
                  <div className="text-xs text-muted-foreground mt-1 font-mono">
                    {typeof c.detail.expression === 'string' ? c.detail.expression : JSON.stringify(c.detail.expression)}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}

        {/* Detail */}
        {selected ? (
          <div className="space-y-4">
            {/* Header with badges */}
            <div className="flex items-start gap-3">
              <h2 className="text-lg font-semibold flex-1 break-all">{selected.metric_name}</h2>
              <div className="flex flex-wrap gap-1 shrink-0">
                <span className={cn('px-2 py-0.5 rounded text-xs font-medium',
                  selected.metric_type === 'atomic' ? 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300' : 'bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300')}>
                  {selected.metric_type || 'atomic'}
                </span>
                {selected.aggregation && (
                  <span className={cn('px-2 py-0.5 rounded text-xs font-medium', aggBadgeClass(selected.aggregation))}>
                    {selected.aggregation}
                  </span>
                )}
                {selected.layer && selected.layer !== 'unknown' && (
                  <span className="px-2 py-0.5 rounded text-xs bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300">{selected.layer}</span>
                )}
              </div>
            </div>

            {/* Definition */}
            {selected.definition && (
              <div className="p-3 bg-muted/50 rounded-lg">
                <label className="text-xs text-muted-foreground">{t('governance.definition', '定义')}</label>
                <p className="text-sm mt-1">{selected.definition}</p>
              </div>
            )}

            {/* Business filter highlighted */}
            {selected.business_filter && (
              <div className="p-3 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg">
                <label className="text-xs text-amber-700 dark:text-amber-400 font-medium">⚡ {t('governance.businessFilter', '业务限定')}</label>
                <p className="text-sm mt-1 font-mono text-amber-900 dark:text-amber-100 whitespace-pre-wrap">{selected.business_filter}</p>
              </div>
            )}

            {/* Expression */}
            <div>
              <label className="text-xs text-muted-foreground">{t('governance.expression', '表达式')}</label>
              <pre className="text-xs font-mono mt-1 p-3 bg-muted rounded-lg overflow-auto max-h-48 whitespace-pre-wrap break-all">{selected.expression}</pre>
            </div>

            {/* Metadata grid */}
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('governance.period', '周期')} value={selected.period} />
              <Field label={t('governance.sourceTables', '来源表')} value={selected.source_tables} />
              <Field label={t('governance.owner', '负责人/域')} value={selected.owner} />
              <Field label={t('governance.boundModel', '绑定模型')} value={`${selected.bound_model}.${selected.bound_column}`} />
              <Field label={t('governance.lifecycle', '生命周期')} value={selected.lifecycle} />
              {selected.dimensions.length > 0 && (
                <Field label={t('governance.dimensions', '维度')} value={selected.dimensions.join(', ')} />
              )}
            </div>

            {/* SQL Signature */}
            <div>
              <label className="text-xs text-muted-foreground">SQL Signature</label>
              <div className="text-xs font-mono mt-1 px-2 py-1 bg-muted rounded break-all text-muted-foreground">
                {selected.sql_signature}
              </div>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
            {t('governance.selectMetric', '选择左侧指标查看详情')}
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <label className="text-xs text-muted-foreground">{label}</label>
      <p className={cn('text-sm mt-1 font-medium', mono && 'font-mono text-xs')}>{value || '-'}</p>
    </div>
  );
}
