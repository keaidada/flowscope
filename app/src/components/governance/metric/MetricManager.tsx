/**
 * MetricManager — metric list + conflicts + stats.
 */

import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, BarChart3, Database, GitBranch, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { governanceApi, type MetricEntry, type MetricConflict, type MetricStats } from '@/lib/governance-api';

export function MetricManager({ projectId }: { projectId: string | null }) {
  const { t } = useTranslation();
  const [metrics, setMetrics] = useState<MetricEntry[]>([]);
  const [conflicts, setConflicts] = useState<MetricConflict[]>([]);
  const [stats, setStats] = useState<MetricStats | null>(null);
  const [selected, setSelected] = useState<MetricEntry | null>(null);

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

  if (!projectId) {
    return <div className="flex items-center justify-center h-full text-muted-foreground text-sm">{t('governance.selectProject', '请先选择项目')}</div>;
  }

  return (
    <div className="flex h-full">
      {/* Left: list */}
      <div className="w-80 border-r flex flex-col">
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
        {stats && (
          <div className="flex gap-3 px-3 py-2 border-b bg-muted/20 text-xs text-muted-foreground">
            <span>{t('governance.total', '总计')}: <b className="text-foreground">{stats.total}</b></span>
            {stats.conflict_count > 0 && (
              <span className="text-red-600">⚠ {stats.conflict_count} {t('governance.conflicts', '冲突')}</span>
            )}
          </div>
        )}
        <div className="flex-1 overflow-auto">
          {metrics.map((m) => (
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
                <div className="text-xs text-muted-foreground truncate">{m.aggregation}({m.expression})</div>
              </div>
              {m.layer && <span className="px-1 rounded text-[10px] bg-muted">{m.layer}</span>}
            </button>
          ))}
          {metrics.length === 0 && (
            <div className="text-center py-8 text-sm text-muted-foreground">
              {t('governance.noMetrics', '暂无指标，通过 ODCS 契约的 schema.metric 定义导入')}
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
              <div key={i} className="p-3 bg-yellow-50 border border-yellow-200 rounded-lg">
                <div className="flex items-center gap-2 text-sm">
                  <span className="px-1.5 py-0.5 bg-yellow-200 text-yellow-800 rounded text-xs font-medium">
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
          <div className="space-y-3">
            <h2 className="text-lg font-semibold">{selected.metric_name}</h2>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('governance.definition', '定义')} value={selected.definition} />
              <Field label={t('governance.aggregation', '聚合')} value={selected.aggregation} />
              <Field label={t('governance.metricType', '指标类型')} value={selected.metric_type || 'atomic'} />
              <Field label={t('governance.expression', '表达式')} value={selected.expression} mono />
              <Field label={t('governance.businessFilter', '业务限定')} value={selected.business_filter} />
              <Field label={t('governance.period', '周期')} value={selected.period} />
              <Field label={t('governance.sourceTables', '来源表')} value={selected.source_tables} />
              <Field label={t('governance.layer', '层级')} value={selected.layer} />
              <Field label={t('governance.owner', '负责人')} value={selected.owner} />
              <Field label={t('governance.boundModel', '绑定模型')} value={`${selected.bound_model}.${selected.bound_column}`} />
              <Field label={t('governance.lifecycle', '生命周期')} value={selected.lifecycle} />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">SQL Signature</label>
              <div className="text-xs font-mono mt-1 px-2 py-1 bg-muted rounded break-all">
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
