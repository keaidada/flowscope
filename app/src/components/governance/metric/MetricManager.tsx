/**
 * MetricManager — script-centric metric view + analysis toggle.
 *
 * Left panel: script list (grouped by source script, sorted by metric count).
 * Right panel: selected script's tables as collapsible sections,
 *   each section shows that table's metrics with inline-expandable rows.
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChevronDown, ChevronRight, Database, FileCode, GitBranch, LayoutGrid, Package, Search, Sparkles,
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

function extractScript(contractId: string): { name: string; full: string } {
  if (!contractId) return { name: '(auto)', full: '' };
  const path = contractId.startsWith('lineage:') ? contractId.slice(8) : contractId;
  const parts = path.split('/');
  return { name: parts[parts.length - 1] || path, full: path };
}

interface TableGroup {
  table: string;
  metrics: MetricEntry[];
  aggs: string[];
  layer: string;
  sources: string[];
}

interface ScriptGroup {
  script: string;
  scriptFull: string;
  metrics: MetricEntry[];
  tables: TableGroup[];
}

export function MetricManager({ projectId }: { projectId: string | null }) {
  const { t } = useTranslation();
  const [view, setView] = useState<'script' | 'analysis'>('script');
  const [metrics, setMetrics] = useState<MetricEntry[]>([]);
  const [conflicts, setConflicts] = useState<MetricConflict[]>([]);
  const [stats, setStats] = useState<MetricStats | null>(null);
  const [selectedScript, setSelectedScript] = useState<string | null>(null);
  const [expandedMetric, setExpandedMetric] = useState<number | null>(null);
  const [collapsedTables, setCollapsedTables] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [importMsg, setImportMsg] = useState<string | null>(null);

  // Ref to avoid cascading re-renders when selectedScript changes
  const selectedScriptRef = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    if (!projectId) return;
    try {
      let ms = await governanceApi.listMetrics(new URLSearchParams({ project_id: projectId }).toString());

      // Auto-extract from lineage if project has no metrics yet
      if (ms.length === 0) {
        setImportMsg(t('governance.autoExtracting', '正在从血缘提取指标...'));
        try {
          const r = await governanceApi.extractLineageMetrics(projectId);
          if (r.extracted > 0) {
            setImportMsg(`${t('governance.extractLineageDone', '从血缘提取')} ${r.extracted} ${t('governance.metrics', '个指标')}`);
            ms = await governanceApi.listMetrics(new URLSearchParams({ project_id: projectId }).toString());
          } else {
            setImportMsg(null);
          }
        } catch (e) {
          console.error('Auto-extract failed:', e);
          setImportMsg(null);
        }
      }

      setMetrics(ms);
      if (ms.length > 0 && !selectedScriptRef.current) {
        const first = extractScript(ms[0].contract_id).name;
        selectedScriptRef.current = first;
        setSelectedScript(first);
      }
      setConflicts(await governanceApi.metricConflicts(projectId));
      setStats(await governanceApi.metricStats(projectId));
    } catch (e) { console.error('Metric list failed:', e); }
  }, [projectId, t]);

  useEffect(() => {
    selectedScriptRef.current = null;
    setSelectedScript(null);
    setExpandedMetric(null);
    refresh();
  }, [projectId]); // Only re-run when project changes

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

  // --- Group by script → table ---
  const scriptGroups: ScriptGroup[] = useMemo(() => {
    const scriptMap = new Map<string, MetricEntry[]>();
    for (const m of metrics) {
      const { name } = extractScript(m.contract_id);
      const arr = scriptMap.get(name) ?? [];
      arr.push(m);
      scriptMap.set(name, arr);
    }
    return Array.from(scriptMap.entries())
      .map(([script, ms]) => {
        const { full } = extractScript(ms[0]?.contract_id ?? '');
        // Sub-group by bound_model
        const tableMap = new Map<string, MetricEntry[]>();
        for (const m of ms) {
          const key = m.bound_model || '(unknown)';
          const arr = tableMap.get(key) ?? [];
          arr.push(m);
          tableMap.set(key, arr);
        }
        const tables: TableGroup[] = Array.from(tableMap.entries())
          .map(([table, tms]) => ({
            table,
            metrics: tms,
            aggs: Array.from(new Set(tms.map((m) => m.aggregation).filter(Boolean))),
            layer: tms[0]?.layer ?? '',
            sources: Array.from(new Set(tms.flatMap((m) => m.source_tables.split(',').map((s) => s.trim()).filter(Boolean)))),
          }))
          .sort((a, b) => b.metrics.length - a.metrics.length);
        return { script, scriptFull: full, metrics: ms, tables };
      })
      .sort((a, b) => b.metrics.length - a.metrics.length);
  }, [metrics]);

  const filteredScripts = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return scriptGroups;
    return scriptGroups.filter(
      (g) => g.script.toLowerCase().includes(q) || g.tables.some((tg) => tg.table.toLowerCase().includes(q)),
    );
  }, [scriptGroups, search]);

  const selectedGroup = useMemo(
    () => scriptGroups.find((g) => g.script === selectedScript) ?? null,
    [scriptGroups, selectedScript],
  );

  const toggleTable = (table: string) => {
    setCollapsedTables((prev) => {
      const next = new Set(prev);
      if (next.has(table)) next.delete(table);
      else next.add(table);
      return next;
    });
  };

  if (!projectId) {
    return <div className="flex items-center justify-center h-full text-muted-foreground text-sm">{t('governance.selectProject', '请先选择项目')}</div>;
  }

  return (
    <div className="flex flex-col h-full">
      {/* === Toolbar === */}
      <div className="flex items-center justify-between px-2 py-1.5 border-b shrink-0">
        <div className="flex items-center gap-0.5">
          <Button variant={view === 'script' ? 'secondary' : 'ghost'} size="sm" onClick={() => setView('script')} className="h-6 px-2 text-xs">
            <FileCode className="h-3 w-3 mr-1" />{t('governance.byScript', '按脚本')}
          </Button>
          <Button variant={view === 'analysis' ? 'secondary' : 'ghost'} size="sm" onClick={() => setView('analysis')} className="h-6 px-2 text-xs">
            <LayoutGrid className="h-3 w-3 mr-1" />{t('governance.analysisView', '分析')}
          </Button>
        </div>
        {view === 'script' && (
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

      {importMsg && view === 'script' && (
        <div className="px-3 py-1 border-b text-xs text-muted-foreground shrink-0">{importMsg}</div>
      )}

      {/* === Content === */}
      {view === 'analysis' ? (
        <MetricAnalysisView projectId={projectId} />
      ) : (
        <div className="flex flex-1 min-h-0">
          {/* --- Left: script list --- */}
          <div className="w-72 border-r flex flex-col shrink-0">
            <div className="relative px-2 py-1.5 border-b">
              <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
              <input
                type="text"
                placeholder={t('governance.searchScripts', '搜索脚本/表名...')}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full pl-6 pr-2 py-1 text-xs rounded border bg-transparent focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>

            {stats && (
              <div className="px-3 py-1 border-b bg-muted/20 text-[10px] text-muted-foreground">
                {scriptGroups.length} {t('governance.scripts', '个脚本')} · {stats.total} {t('governance.metrics', '个指标')}
                {conflicts.length > 0 && <span className="text-yellow-600 ml-2">⚠ {conflicts.length}</span>}
              </div>
            )}

            <div className="flex-1 overflow-auto">
              {filteredScripts.map((g) => (
                <button
                  key={g.script}
                  onClick={() => { setSelectedScript(g.script); setExpandedMetric(null); }}
                  className={cn(
                    'w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-accent/50 border-b',
                    selectedScript === g.script && 'bg-accent',
                  )}
                  title={g.scriptFull || g.script}
                >
                  <FileCode className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium truncate">{g.script}</div>
                    <div className="text-[10px] text-muted-foreground">
                      {g.tables.length} {t('governance.tables', '表')} · {g.tables.map((tg) => tg.table).slice(0, 3).join(', ')}
                      {g.tables.length > 3 ? '...' : ''}
                    </div>
                  </div>
                  <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-primary/10 text-primary shrink-0">
                    {g.metrics.length}
                  </span>
                </button>
              ))}
              {filteredScripts.length === 0 && (
                <div className="text-center py-8 text-sm text-muted-foreground">
                  {metrics.length === 0 ? t('governance.noMetrics', '暂无指标') : t('governance.noMatch', '无匹配')}
                </div>
              )}
            </div>
          </div>

          {/* --- Right: script's tables + metrics --- */}
          <div className="flex-1 overflow-auto">
            {selectedGroup ? (
              <div className="p-4 space-y-3">
                {/* Script header */}
                <div className="flex items-center gap-2">
                  <FileCode className="h-4 w-4 text-muted-foreground" />
                  <h2 className="text-sm font-semibold break-all">{selectedGroup.scriptFull || selectedGroup.script}</h2>
                </div>

                {/* Table sections */}
                {selectedGroup.tables.map((tg) => {
                  const collapsed = collapsedTables.has(tg.table);
                  const filterCount = tg.metrics.filter((m) => m.business_filter).length;
                  return (
                    <div key={tg.table} className="border rounded-lg overflow-hidden">
                      {/* Table section header */}
                      <button
                        onClick={() => toggleTable(tg.table)}
                        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-accent/50 bg-muted/30 border-b"
                      >
                        {collapsed ? <ChevronRight className="h-3.5 w-3.5 shrink-0" /> : <ChevronDown className="h-3.5 w-3.5 shrink-0" />}
                        <Package className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span className="flex-1 text-sm font-medium text-left truncate">{tg.table}</span>
                        <div className="flex items-center gap-1 shrink-0">
                          {tg.aggs.map((a) => (
                            <span key={a} className={cn('px-1 rounded text-[9px] font-medium', aggBadge(a))}>{a}</span>
                          ))}
                          {tg.layer && tg.layer !== 'unknown' && (
                            <span className="px-1 rounded text-[9px] bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400">{tg.layer}</span>
                          )}
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-primary/10 text-primary">
                            {tg.metrics.length}
                          </span>
                        </div>
                      </button>

                      {/* Table metrics */}
                      {!collapsed && (
                        <div>
                          {/* Column headers */}
                          <div className="flex items-center gap-2 px-3 py-1 border-b text-[10px] font-medium text-muted-foreground uppercase bg-muted/10">
                            <span className="w-5 shrink-0" />
                            <span className="flex-1">{t('governance.field', '字段')}</span>
                            <span className="w-20 shrink-0">{t('governance.aggregation', '聚合')}</span>
                            <span className="w-40 shrink-0">{t('governance.businessFilter', '业务限定')}</span>
                            <span className="w-20 shrink-0 text-right">{t('governance.period', '周期')}</span>
                          </div>

                          {tg.metrics.map((m) => (
                            <MetricRow
                              key={m.id}
                              metric={m}
                              expanded={expandedMetric === m.id}
                              onToggle={() => setExpandedMetric(expandedMetric === m.id ? null : m.id)}
                            />
                          ))}

                          {/* Table footer */}
                          <div className="px-3 py-1 text-[10px] text-muted-foreground border-t bg-muted/5">
                            {filterCount}/{tg.metrics.length} {t('governance.hasFilter', '有业务限定')}
                            {tg.sources.length > 0 && <span className="ml-3">{t('governance.sourceTables', '源表')}: {tg.sources.slice(0, 5).join(', ')}{tg.sources.length > 5 ? '...' : ''}</span>}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
                {t('governance.selectScript', '选择左侧脚本查看指标')}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================
// Metric Row — inline expandable with rich detail
// ============================================================

/// Extract column references from a SQL expression.
function extractSourceColumns(expr: string): string[] {
  const keywords = new Set([
    'case', 'when', 'then', 'else', 'end', 'and', 'or', 'not', 'null', 'is',
    'in', 'like', 'between', 'distinct', 'all', 'as', 'cast', 'true', 'false',
    'sum', 'count', 'avg', 'average', 'max', 'min', 'median', 'round', 'coalesce',
    'nvl', 'if', 'iff', 'concat', 'substring', 'length', 'trim', 'lower', 'upper',
    'replace', 'cast', 'convert', 'parse', 'extract', 'date', 'timestamp', 'string',
    'integer', 'int', 'float', 'double', 'decimal', 'boolean', 'partition', 'over',
    'row_number', 'rank', 'dense_rank', 'lag', 'lead', 'first_value', 'last_value',
    'interval', 'day', 'month', 'year', 'week', 'hour', 'minute', 'second',
    'current_date', 'now', 'today', 'format', 'from_unixtime', 'to_unixtime',
  ]);
  const tokens = expr.match(/[`a-zA-Z_][`a-zA-Z0-9_.]*/g) ?? [];
  const cols = new Set<string>();
  for (const raw of tokens) {
    const token = raw.replace(/`/g, '');
    // Strip table prefix: tab.col → col
    const col = token.includes('.') ? token.split('.').pop() ?? token : token;
    const lower = col.toLowerCase();
    if (!keywords.has(lower) && col.length > 1 && !/^\d+$/.test(col)) {
      cols.add(col);
    }
  }
  return Array.from(cols);
}

/// Deduplicate dimension names.
function dedupDimensions(dims: string[] | undefined): string[] {
  if (!dims || dims.length === 0) return [];
  return Array.from(new Set(dims.map(d => d.replace(/`/g, '').trim()).filter(Boolean)));
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

  // Derived detail data
  const sourceCols = expanded ? extractSourceColumns(metric.expression) : [];
  const dims = expanded ? dedupDimensions(metric.dimensions) : [];
  const sourceTables = metric.source_tables ? metric.source_tables.split(',').map(s => s.trim()).filter(Boolean) : [];

  return (
    <div className="border-b last:border-b-0">
      {/* Summary row */}
      <button onClick={onToggle} className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-accent/40">
        {expanded ? <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />}
        <span className="flex-1 text-sm truncate font-medium">{metric.bound_column || metric.metric_name}</span>
        <span className="w-20 shrink-0">
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
        <span className="w-20 shrink-0 text-right text-xs text-muted-foreground">{metric.period || '-'}</span>
      </button>

      {/* Expanded detail — structured sections */}
      {expanded && (
        <div className="px-3 pb-3 pl-9 space-y-2.5">

          {/* Section 1: 计算逻辑 */}
          <DetailSection label={t('governance.computation', '计算逻辑')} icon="🔧">
            <div className="flex items-center gap-1.5 mb-1.5">
              {metric.aggregation && (
                <span className={cn('px-1.5 py-0.5 rounded text-[10px] font-medium', aggBadge(metric.aggregation))}>
                  {metric.aggregation}
                </span>
              )}
              <span className="px-1.5 py-0.5 rounded text-[10px] bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400">
                {metric.metric_type || 'atomic'}
              </span>
            </div>
            <pre className="text-xs font-mono p-2 bg-muted rounded overflow-auto max-h-32 whitespace-pre-wrap break-all">{metric.expression}</pre>
          </DetailSection>

          {/* Section 2: 业务限定 */}
          {metric.business_filter && (
            <DetailSection label={t('governance.businessFilter', '业务限定')} icon="⚡">
              <div className="space-y-1">
                {metric.business_filter.split(';').map((cond, i) => {
                  const c = cond.trim();
                  if (!c) return null;
                  return (
                    <div key={i} className="flex items-start gap-1.5 text-xs">
                      <span className="text-amber-500 shrink-0">▸</span>
                      <code className="text-amber-900 dark:text-amber-100 break-all">{c}</code>
                    </div>
                  );
                })}
              </div>
            </DetailSection>
          )}

          {/* Section 3: 数据来源 */}
          <DetailSection label={t('governance.dataLineage', '数据来源')} icon="🔗">
            <div className="space-y-1 text-xs">
              {sourceCols.length > 0 && (
                <div className="flex items-start gap-2">
                  <span className="text-muted-foreground shrink-0 w-14">{t('governance.sourceFields', '源字段')}:</span>
                  <div className="flex flex-wrap gap-1">
                    {sourceCols.map(col => (
                      <span key={col} className="px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300 text-[10px] font-mono">
                        {col}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {sourceTables.length > 0 && (
                <div className="flex items-start gap-2">
                  <span className="text-muted-foreground shrink-0 w-14">{t('governance.sourceTables', '源表')}:</span>
                  <div className="flex flex-wrap gap-1">
                    {sourceTables.slice(0, 8).map(tbl => (
                      <span key={tbl} className="px-1.5 py-0.5 rounded bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-300 text-[10px] font-mono">
                        {tbl}
                      </span>
                    ))}
                    {sourceTables.length > 8 && <span className="text-[10px] text-muted-foreground">+{sourceTables.length - 8}</span>}
                  </div>
                </div>
              )}
              <div className="flex items-start gap-2">
                <span className="text-muted-foreground shrink-0 w-14">{t('governance.output', '产出')}:</span>
                <code className="text-[10px] font-mono">{metric.bound_model}.{metric.bound_column}</code>
              </div>
            </div>
          </DetailSection>

          {/* Section 4: 统计维度 */}
          {dims.length > 0 && (
            <DetailSection label={t('governance.dimensions', '统计维度')} icon="📊">
              <div className="flex flex-wrap gap-1">
                {dims.map(dim => (
                  <span key={dim} className="px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 dark:bg-purple-900/50 dark:text-purple-300 text-[10px] font-mono">
                    {dim}
                  </span>
                ))}
              </div>
            </DetailSection>
          )}

          {/* Section 5: 元数据 */}
          <DetailSection label={t('governance.metadata', '元数据')} icon="ℹ️">
            <div className="grid grid-cols-3 gap-x-4 gap-y-1 text-xs">
              <MetaItem label={t('governance.layer', '层级')} value={metric.layer} />
              <MetaItem label={t('governance.period', '周期')} value={metric.period} />
              <MetaItem label={t('governance.owner', '负责人')} value={metric.owner} />
              <MetaItem label={t('governance.lifecycle', '生命周期')} value={metric.lifecycle} />
              <MetaItem label={t('governance.definition', '定义')} value={metric.definition} span={3} />
              <div className="col-span-3">
                <span className="text-muted-foreground">{t('governance.signature', '签名')}: </span>
                <code className="text-[10px] font-mono text-muted-foreground break-all">{metric.sql_signature.slice(0, 32)}...</code>
              </div>
            </div>
          </DetailSection>

        </div>
      )}
    </div>
  );
}

function DetailSection({ label, icon, children }: { label: string; icon: string; children: React.ReactNode }) {
  return (
    <div className="border-l-2 border-muted pl-3">
      <div className="text-[10px] font-medium text-muted-foreground uppercase mb-1">{icon} {label}</div>
      {children}
    </div>
  );
}

function MetaItem({ label, value, span }: { label: string; value: string; span?: number }) {
  if (!value) return null;
  return (
    <div className={span === 3 ? 'col-span-3' : ''}>
      <span className="text-muted-foreground">{label}: </span>
      <span className="font-medium">{value}</span>
    </div>
  );
}
