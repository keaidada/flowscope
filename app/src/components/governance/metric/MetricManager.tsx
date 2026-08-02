/**
 * MetricManager — table-centric metric view + analysis toggle.
 *
 * Left panel: table list (grouped by bound_model, sorted by metric count).
 * Right panel: selected table's metric profile with inline-expandable rows.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChevronDown, ChevronRight, Database, GitBranch, LayoutGrid, Package, Search, Sparkles,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  governanceApi,
  type MetricEntry,
  type MetricConflict,
  type MetricStats,
} from '@/lib/governance-api';
import { MetricAnalysisView } from './MetricAnalysisView';

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

function aggBadge(agg: string): string {
  return AGG_COLORS[agg.toLowerCase()] ?? 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400';
}

interface TableGroup {
  table: string;
  metrics: MetricEntry[];
  aggs: string[];
  layer: string;
  sources: string[];
  owner: string;
}

export function MetricManager({ projectId }: { projectId: string | null }) {
  const { t } = useTranslation();
  const [view, setView] = useState<'table' | 'analysis'>('table');
  const [metrics, setMetrics] = useState<MetricEntry[]>([]);
  const [conflicts, setConflicts] = useState<MetricConflict[]>([]);
  const [stats, setStats] = useState<MetricStats | null>(null);
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [expandedMetric, setExpandedMetric] = useState<number | null>(null);
  const [tableSearch, setTableSearch] = useState('');
  const [importMsg, setImportMsg] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!projectId) return;
    try {
      const ms = await governanceApi.listMetrics(new URLSearchParams({ project_id: projectId }).toString());
      setMetrics(ms);
      // Auto-select first table if none selected
      if (ms.length > 0 && !selectedTable) {
        const firstTable = ms.find((m) => m.bound_model)?.bound_model ?? null;
        setSelectedTable(firstTable);
      }
      const cs = await governanceApi.metricConflicts(projectId);
      setConflicts(cs);
      const s = await governanceApi.metricStats(projectId);
      setStats(s);
    } catch (e) { console.error('Metric list failed:', e); }
  }, [projectId, selectedTable]);

  useEffect(() => { refresh(); }, [refresh]);

  // --- Action handlers ---
  const handleAutoDetect = async () => {
    if (!projectId) return;
    try {
      const r = await governanceApi.autoDetectMetrics(projectId);
      setImportMsg(`${t('governance.autoDetectDone', '自动检测')} ${r.detected} ${t('governance.metrics', '个指标')}`);
      await refresh();
    } catch (e) { console.error(e); setImportMsg(String(e)); }
  };

  const handleImportDbt = async () => {
    if (!projectId) return;
    try {
      setImportMsg(null);
      const r = await governanceApi.importDbtMetrics(projectId);
      setImportMsg(r.imported > 0
        ? `${t('governance.importDbtDone', '已导入')} ${r.imported} ${t('governance.metrics', '个指标')}`
        : t('governance.importDbtEmpty', '未发现 dbt MetricFlow 定义'));
      await refresh();
    } catch (e) { console.error(e); setImportMsg(String(e)); }
  };

  const handleExtractLineage = async () => {
    if (!projectId) return;
    try {
      setImportMsg(null);
      const r = await governanceApi.extractLineageMetrics(projectId);
      setImportMsg(`${t('governance.extractLineageDone', '从血缘提取')} ${r.extracted} ${t('governance.metrics', '个指标')}`);
      await refresh();
    } catch (e) { console.error(e); setImportMsg(String(e)); }
  };

  // --- Group metrics by bound_model ---
  const tableGroups: TableGroup[] = useMemo(() => {
    const map = new Map<string, MetricEntry[]>();
    for (const m of metrics) {
      const key = m.bound_model || '(unknown)';
      const arr = map.get(key) ?? [];
      arr.push(m);
      map.set(key, arr);
    }
    return Array.from(map.entries())
      .map(([table, ms]) => ({
        table,
        metrics: ms,
        aggs: Array.from(new Set(ms.map((m) => m.aggregation).filter(Boolean))),
        layer: ms[0]?.layer ?? '',
        sources: Array.from(new Set(ms.flatMap((m) => m.source_tables.split(',').map((s) => s.trim()).filter(Boolean)))),
        owner: ms[0]?.owner ?? '',
      }))
      .sort((a, b) => b.metrics.length - a.metrics.length);
  }, [metrics]);

  const filteredTables = useMemo(() => {
    const q = tableSearch.toLowerCase().trim();
    if (!q) return tableGroups;
    return tableGroups.filter((g) => g.table.toLowerCase().includes(q));
  }, [tableGroups, tableSearch]);

  // Selected table's metrics
  const selectedGroup = useMemo(
    () => tableGroups.find((g) => g.table === selectedTable) ?? null,
    [tableGroups, selectedTable],
  );

  if (!projectId) {
    return <div className="flex items-center justify-center h-full text-muted-foreground text-sm">{t('governance.selectProject', '请先选择项目')}</div>;
  }

  return (
    <div className="flex flex-col h-full">
      {/* === Top toolbar === */}
      <div className="flex items-center justify-between px-2 py-1.5 border-b shrink-0">
        <div className="flex items-center gap-0.5">
          <Button variant={view === 'table' ? 'secondary' : 'ghost'} size="sm" onClick={() => setView('table')} className="h-6 px-2 text-xs">
            <Package className="h-3 w-3 mr-1" />{t('governance.byTable', '按表')}
          </Button>
          <Button variant={view === 'analysis' ? 'secondary' : 'ghost'} size="sm" onClick={() => setView('analysis')} className="h-6 px-2 text-xs">
            <LayoutGrid className="h-3 w-3 mr-1" />{t('governance.analysisView', '分析')}
          </Button>
        </div>
        {view === 'table' && (
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" onClick={handleAutoDetect} className="h-6 px-2 text-xs">
              <Sparkles className="h-3 w-3 mr-1" />Auto
            </Button>
            <Button variant="ghost" size="sm" onClick={handleImportDbt} className="h-6 px-2 text-xs">
              <Database className="h-3 w-3 mr-1" />dbt
            </Button>
            <Button variant="ghost" size="sm" onClick={handleExtractLineage} className="h-6 px-2 text-xs">
              <GitBranch className="h-3 w-3 mr-1" />Lineage
            </Button>
          </div>
        )}
      </div>

      {importMsg && view === 'table' && (
        <div className="px-3 py-1 border-b text-xs text-muted-foreground shrink-0">{importMsg}</div>
      )}

      {/* === Content === */}
      {view === 'analysis' ? (
        <MetricAnalysisView projectId={projectId} />
      ) : (
        <div className="flex flex-1 min-h-0">
          {/* --- Left: table list --- */}
          <div className="w-72 border-r flex flex-col shrink-0">
            {/* Search */}
            <div className="relative px-2 py-1.5 border-b">
              <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
              <input
                type="text"
                placeholder={t('governance.searchTables', '搜索表名...')}
                value={tableSearch}
                onChange={(e) => setTableSearch(e.target.value)}
                className="w-full pl-6 pr-2 py-1 text-xs rounded border bg-transparent focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>

            {/* Stats */}
            {stats && (
              <div className="px-3 py-1 border-b bg-muted/20 text-[10px] text-muted-foreground">
                {tableGroups.length} {t('governance.tables', '张表')} · {stats.total} {t('governance.metrics', '个指标')}
                {conflicts.length > 0 && <span className="text-yellow-600 ml-2">⚠ {conflicts.length}</span>}
              </div>
            )}

            {/* Table list */}
            <div className="flex-1 overflow-auto">
              {filteredTables.map((g) => (
                <button
                  key={g.table}
                  onClick={() => { setSelectedTable(g.table); setExpandedMetric(null); }}
                  className={cn(
                    'w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-accent/50 border-b',
                    selectedTable === g.table && 'bg-accent',
                  )}
                >
                  <Package className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium truncate">{g.table}</div>
                    <div className="flex items-center gap-1 mt-0.5">
                      {g.aggs.slice(0, 3).map((a) => (
                        <span key={a} className={cn('px-1 rounded text-[9px] font-medium', aggBadge(a))}>{a}</span>
                      ))}
                      {g.aggs.length > 3 && <span className="text-[9px] text-muted-foreground">+{g.aggs.length - 3}</span>}
                    </div>
                  </div>
                  <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-primary/10 text-primary shrink-0">
                    {g.metrics.length}
                  </span>
                </button>
              ))}
              {filteredTables.length === 0 && (
                <div className="text-center py-8 text-sm text-muted-foreground">
                  {metrics.length === 0 ? t('governance.noMetrics', '暂无指标') : t('governance.noMatch', '无匹配')}
                </div>
              )}
            </div>
          </div>

          {/* --- Right: table metric profile --- */}
          <div className="flex-1 overflow-auto">
            {selectedGroup ? (
              <TableMetricProfile
                group={selectedGroup}
                expandedMetric={expandedMetric}
                onToggleExpand={(id) => setExpandedMetric(expandedMetric === id ? null : id)}
              />
            ) : (
              <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
                {t('governance.selectTable', '选择左侧表查看指标')}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================
// Table Metric Profile — right panel
// ============================================================

function TableMetricProfile({
  group, expandedMetric, onToggleExpand,
}: {
  group: TableGroup;
  expandedMetric: number | null;
  onToggleExpand: (id: number) => void;
}) {
  const { t } = useTranslation();
  const { table, metrics, aggs, layer, sources, owner } = group;

  const filterCount = metrics.filter((m) => m.business_filter).length;
  const periodCount = metrics.filter((m) => m.period).length;

  return (
    <div className="p-4 space-y-3">
      {/* Header */}
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <h2 className="text-lg font-semibold break-all">{table}</h2>
          <div className="flex flex-wrap items-center gap-2 mt-1 text-xs text-muted-foreground">
            <span>{metrics.length} {t('governance.metrics', '个指标')}</span>
            <span>·</span>
            <span>{sources.length} {t('governance.sourceTables', '源表')}: {sources.slice(0, 5).join(', ')}{sources.length > 5 ? '...' : ''}</span>
            {owner && <><span>·</span><span>{owner}</span></>}
          </div>
        </div>
        <div className="flex gap-1 shrink-0">
          {layer && layer !== 'unknown' && (
            <span className="px-2 py-0.5 rounded text-xs bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300">{layer}</span>
          )}
          {aggs.map((a) => (
            <span key={a} className={cn('px-2 py-0.5 rounded text-xs font-medium', aggBadge(a))}>{a}</span>
          ))}
        </div>
      </div>

      {/* Quick stats */}
      <div className="flex gap-4 text-xs">
        <span className="text-muted-foreground">
          {t('governance.hasFilter', '业务限定')}: <b className="text-foreground">{filterCount}/{metrics.length}</b>
        </span>
        <span className="text-muted-foreground">
          {t('governance.hasPeriod', '周期')}: <b className="text-foreground">{periodCount}/{metrics.length}</b>
        </span>
      </div>

      {/* Metric rows */}
      <div className="border rounded-lg overflow-hidden">
        {/* Column headers */}
        <div className="flex items-center gap-2 px-3 py-1.5 bg-muted/50 border-b text-[10px] font-medium text-muted-foreground uppercase">
          <span className="w-5 shrink-0" />
          <span className="flex-1">{t('governance.field', '字段')}</span>
          <span className="w-24 shrink-0">{t('governance.aggregation', '聚合')}</span>
          <span className="w-40 shrink-0">{t('governance.businessFilter', '业务限定')}</span>
          <span className="w-32 shrink-0 text-right">{t('governance.period', '周期')}</span>
        </div>

        {metrics.map((m) => (
          <MetricRow
            key={m.id}
            metric={m}
            expanded={expandedMetric === m.id}
            onToggle={() => onToggleExpand(m.id)}
          />
        ))}
      </div>
    </div>
  );
}

function MetricRow({
  metric, expanded, onToggle,
}: {
  metric: MetricEntry;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const filterPreview = metric.business_filter
    ? metric.business_filter.split(';')[0].trim()
    : '';

  return (
    <div className="border-b last:border-b-0">
      {/* Summary row */}
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-accent/50"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="flex-1 text-sm font-medium truncate">{metric.bound_column || metric.metric_name}</span>
        <span className="w-24 shrink-0">
          {metric.aggregation && (
            <span className={cn('px-1.5 py-0.5 rounded text-[10px] font-medium', aggBadge(metric.aggregation))}>
              {metric.aggregation}
            </span>
          )}
        </span>
        <span className="w-40 shrink-0 text-xs truncate" title={metric.business_filter}>
          {filterPreview ? (
            <span className="text-amber-600 dark:text-amber-400">⚡ {filterPreview}</span>
          ) : (
            <span className="text-muted-foreground">-</span>
          )}
        </span>
        <span className="w-32 shrink-0 text-right text-xs text-muted-foreground">{metric.period || '-'}</span>
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div className="px-3 pb-3 pl-9 space-y-2">
          {/* Definition */}
          {metric.definition && (
            <div>
              <label className="text-[10px] text-muted-foreground uppercase">{t('governance.definition', '定义')}</label>
              <p className="text-xs mt-0.5">{metric.definition}</p>
            </div>
          )}

          {/* Full business filter */}
          {metric.business_filter && (
            <div>
              <label className="text-[10px] text-amber-600 dark:text-amber-400 uppercase">{t('governance.businessFilter', '业务限定')}</label>
              <p className="text-xs mt-0.5 font-mono text-amber-900 dark:text-amber-100 whitespace-pre-wrap break-all">
                {metric.business_filter}
              </p>
            </div>
          )}

          {/* Full expression */}
          <div>
            <label className="text-[10px] text-muted-foreground uppercase">{t('governance.expression', '表达式')}</label>
            <pre className="text-xs font-mono mt-0.5 p-2 bg-muted rounded overflow-auto max-h-40 whitespace-pre-wrap break-all">
              {metric.expression}
            </pre>
          </div>

          {/* Metadata */}
          <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
            {metric.source_tables && (
              <span>{t('governance.sourceTables', '来源表')}: <b className="text-foreground">{metric.source_tables}</b></span>
            )}
            {metric.metric_type && (
              <span>{t('governance.metricType', '类型')}: <b className="text-foreground">{metric.metric_type}</b></span>
            )}
            {metric.sql_signature && (
              <span className="font-mono text-[10px]">sig: {metric.sql_signature.slice(0, 16)}...</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
