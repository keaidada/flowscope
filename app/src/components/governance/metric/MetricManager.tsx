/**
 * MetricManager — lazy script-centric view.
 *
 * Phase 1: Load script list (lightweight — names + counts only).
 * Phase 2: When user selects a script, load THAT script's metrics only.
 *
 * Never loads all metrics at once → no browser freeze on large projects.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChevronDown, ChevronRight, Database, FileCode, GitBranch, LayoutGrid, Package, Search, Sparkles,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  governanceApi,
  type MetricEntry,
  type ScriptSummary,
} from '@/lib/governance-api';
import { MetricAnalysisView } from './MetricAnalysisView';

const AGG_COLORS: Record<string, string> = {
  sum: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
  count: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
  count_distinct: 'bg-teal-100 text-teal-700 dark:bg-teal-900 dark:text-teal-300',
  avg: 'bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300',
  max: 'bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300',
  min: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300',
};

function aggBadge(agg: string): string {
  return AGG_COLORS[agg.toLowerCase()] ?? 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400';
}

export function MetricManager({ projectId }: { projectId: string | null }) {
  const { t } = useTranslation();
  const [view, setView] = useState<'script' | 'analysis'>('script');

  // Phase 1: script list (lightweight)
  const [scripts, setScripts] = useState<ScriptSummary[]>([]);
  const [selectedCid, setSelectedCid] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [importMsg, setImportMsg] = useState<string | null>(null);

  // Phase 2: selected script's metrics (lazy loaded)
  const [scriptMetrics, setScriptMetrics] = useState<MetricEntry[]>([]);
  const [loadingMetrics, setLoadingMetrics] = useState(false);
  const [expandedMetric, setExpandedMetric] = useState<number | null>(null);
  const [collapsedTables, setCollapsedTables] = useState<Set<string>>(new Set());

  const projectIdRef = useRef(projectId);
  const selectedCidRef = useRef<string | null>(null);

  // --- Load script list (lightweight) ---
  const loadScripts = useCallback(async () => {
    if (!projectId) return;
    try {
      let list = await governanceApi.listScriptSummaries(projectId);
      // Auto-extract if empty
      if (list.length === 0) {
        setImportMsg('正在从血缘提取指标...');
        try {
          const r = await governanceApi.extractLineageMetrics(projectId);
          if (r.extracted > 0) {
            setImportMsg(`从血缘提取 ${r.extracted} 个指标`);
            list = await governanceApi.listScriptSummaries(projectId);
          } else {
            setImportMsg(null);
          }
        } catch (e) {
          console.error('Auto-extract failed:', e);
          setImportMsg(null);
        }
      }
      setScripts(list);
      // Auto-select first script
      if (list.length > 0 && !selectedCidRef.current) {
        selectedCidRef.current = list[0].contract_id;
        setSelectedCid(list[0].contract_id);
      }
    } catch (e) { console.error('Script list failed:', e); }
  }, [projectId]);

  useEffect(() => {
    // Reset state on project change
    if (projectIdRef.current !== projectId) {
      projectIdRef.current = projectId;
      selectedCidRef.current = null;
      setSelectedCid(null);
      setScriptMetrics([]);
      setScripts([]);
    }
    loadScripts();
  }, [projectId, loadScripts]);

  // --- Load metrics for ONE script (lazy) ---
  useEffect(() => {
    if (!projectId || !selectedCid) { setScriptMetrics([]); return; }
    setLoadingMetrics(true);
    setExpandedMetric(null);
    governanceApi.listMetrics(
      new URLSearchParams({ project_id: projectId, contract_id: selectedCid }).toString()
    )
      .then(ms => setScriptMetrics(ms))
      .catch(e => { console.error('Load script metrics failed:', e); setScriptMetrics([]); })
      .finally(() => setLoadingMetrics(false));
  }, [projectId, selectedCid]);

  const filteredScripts = search.trim()
    ? scripts.filter(s => s.script_name.toLowerCase().includes(search.toLowerCase()))
    : scripts;

  const totalMetrics = scripts.reduce((sum, s) => sum + s.metric_count, 0);

  const handleAutoDetect = async () => {
    if (!projectId) return;
    const r = await governanceApi.autoDetectMetrics(projectId);
    setImportMsg(`${t('governance.autoDetectDone', '自动检测')} ${r.detected} 个指标`);
    await loadScripts();
  };
  const handleImportDbt = async () => {
    if (!projectId) return;
    const r = await governanceApi.importDbtMetrics(projectId);
    setImportMsg(r.imported > 0 ? `${t('governance.importDbtDone', '已导入')} ${r.imported} 个指标` : t('governance.importDbtEmpty', '未发现 dbt MetricFlow 定义'));
    await loadScripts();
  };
  const handleExtractLineage = async () => {
    if (!projectId) return;
    const r = await governanceApi.extractLineageMetrics(projectId);
    setImportMsg(`${t('governance.extractLineageDone', '从血缘提取')} ${r.extracted} 个指标`);
    await loadScripts();
  };

  const toggleTable = (name: string) => {
    setCollapsedTables(prev => {
      const n = new Set(prev);
      if (n.has(name)) { n.delete(name); } else { n.add(name); }
      return n;
    });
  };

  if (!projectId) {
    return <div className="flex items-center justify-center h-full text-muted-foreground text-sm">{t('governance.selectProject', '请先选择项目')}</div>;
  }

  // Group loaded metrics by table
  const tableGroups = groupByTable(scriptMetrics);

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
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
            <Button variant="ghost" size="sm" onClick={handleAutoDetect} className="h-6 px-2 text-xs"><Sparkles className="h-3 w-3 mr-1" />Auto</Button>
            <Button variant="ghost" size="sm" onClick={handleImportDbt} className="h-6 px-2 text-xs"><Database className="h-3 w-3 mr-1" />dbt</Button>
            <Button variant="ghost" size="sm" onClick={handleExtractLineage} className="h-6 px-2 text-xs"><GitBranch className="h-3 w-3 mr-1" />Lineage</Button>
          </div>
        )}
      </div>

      {importMsg && view === 'script' && (
        <div className="px-3 py-1 border-b text-xs text-muted-foreground shrink-0">{importMsg}</div>
      )}

      {view === 'analysis' ? (
        <MetricAnalysisView projectId={projectId} />
      ) : (
        <div className="flex flex-1 min-h-0">
          {/* Left: script list */}
          <div className="w-72 border-r flex flex-col shrink-0">
            <div className="relative px-2 py-1.5 border-b">
              <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
              <input type="text" placeholder={t('governance.searchScripts', '搜索脚本/表名...')} value={search} onChange={e => setSearch(e.target.value)}
                className="w-full pl-6 pr-2 py-1 text-xs rounded border bg-transparent focus:outline-none focus:ring-1 focus:ring-ring" />
            </div>
            <div className="px-3 py-1 border-b bg-muted/20 text-[10px] text-muted-foreground">
              {scripts.length} {t('governance.scripts', '个脚本')} · {totalMetrics} {t('governance.metrics', '个指标')}
            </div>
            <div className="flex-1 overflow-auto">
              {filteredScripts.map(s => (
                <button key={s.contract_id} onClick={() => { selectedCidRef.current = s.contract_id; setSelectedCid(s.contract_id); }}
                  className={cn('w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-accent/50 border-b', selectedCid === s.contract_id && 'bg-accent')}
                  title={s.script_name}>
                  <FileCode className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium truncate">{s.script_name}</div>
                    <div className="text-[10px] text-muted-foreground">{s.table_count} {t('governance.tables', '表')}</div>
                  </div>
                  <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-primary/10 text-primary shrink-0">{s.metric_count}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Right: selected script's tables + metrics (lazy loaded) */}
          <div className="flex-1 overflow-auto">
            {loadingMetrics ? (
              <div className="flex items-center justify-center h-full text-muted-foreground text-sm">{t('governance.loading', '加载中...')}</div>
            ) : tableGroups.length === 0 ? (
              <div className="flex items-center justify-center h-full text-muted-foreground text-sm">{t('governance.selectScript', '选择左侧脚本查看指标')}</div>
            ) : (
              <div className="p-4 space-y-3">
                {tableGroups.map(tg => {
                  const collapsed = collapsedTables.has(tg.table);
                  return (
                    <div key={tg.table} className="border rounded-lg overflow-hidden">
                      <button onClick={() => toggleTable(tg.table)} className="w-full flex items-center gap-2 px-3 py-2 hover:bg-accent/50 bg-muted/30 border-b">
                        {collapsed ? <ChevronRight className="h-3.5 w-3.5 shrink-0" /> : <ChevronDown className="h-3.5 w-3.5 shrink-0" />}
                        <Package className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span className="flex-1 text-sm font-medium text-left truncate">{tg.table}</span>
                        <div className="flex items-center gap-1 shrink-0">
                          {tg.aggs.slice(0, 3).map(a => <span key={a} className={cn('px-1 rounded text-[9px] font-medium', aggBadge(a))}>{a}</span>)}
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-primary/10 text-primary">{tg.metrics.length}</span>
                        </div>
                      </button>
                      {!collapsed && tg.metrics.map(m => (
                        <MetricRow key={m.id} metric={m} expanded={expandedMetric === m.id} onToggle={() => setExpandedMetric(expandedMetric === m.id ? null : m.id)} />
                      ))}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================
// Helpers
// ============================================================

function groupByTable(metrics: MetricEntry[]) {
  const map = new Map<string, { table: string; metrics: MetricEntry[]; aggs: string[] }>();
  for (const m of metrics) {
    const key = m.bound_model || '(unknown)';
    const entry = map.get(key) ?? { table: key, metrics: [], aggs: [] };
    entry.metrics.push(m);
    if (m.aggregation && !entry.aggs.includes(m.aggregation)) entry.aggs.push(m.aggregation);
    map.set(key, entry);
  }
  return Array.from(map.values()).sort((a, b) => b.metrics.length - a.metrics.length);
}

function extractSourceColumns(expr: string): string[] {
  const keywords = new Set(['case','when','then','else','end','and','or','not','null','is','in','like','between','distinct','all','as','cast','true','false','sum','count','avg','average','max','min','median','round','coalesce','nvl','if','iff','concat','substring','length','trim','lower','upper','replace','convert','parse','extract','date','timestamp','string','integer','int','float','double','decimal','boolean','partition','over','row_number','rank','dense_rank','lag','lead','interval','day','month','year','week','hour','current_date','now','today','format']);
  const tokens = expr.match(/[`a-zA-Z_][`a-zA-Z0-9_.]*/g) ?? [];
  const cols = new Set<string>();
  for (const raw of tokens) {
    const token = raw.replace(/`/g, '');
    const col = token.includes('.') ? token.split('.').pop() ?? token : token;
    if (!keywords.has(col.toLowerCase()) && col.length > 1 && !/^\d+$/.test(col)) cols.add(col);
  }
  return Array.from(cols);
}

// ============================================================
// Metric Row — rich detail with 5 sections
// ============================================================

function MetricRow({ metric, expanded, onToggle }: { metric: MetricEntry; expanded: boolean; onToggle: () => void }) {
  const filterPreview = metric.business_filter ? metric.business_filter.split(';')[0].trim() : '';
  const sourceCols = expanded ? extractSourceColumns(metric.expression) : [];
  const dims = expanded && metric.dimensions?.length ? Array.from(new Set(metric.dimensions.map(d => d.replace(/`/g, '').trim()).filter(Boolean))) : [];
  const sourceTables = metric.source_tables ? metric.source_tables.split(',').map(s => s.trim()).filter(Boolean) : [];

  return (
    <div className="border-b last:border-b-0">
      <button onClick={onToggle} className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-accent/40">
        {expanded ? <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />}
        <span className="flex-1 text-sm truncate font-medium">{metric.bound_column || metric.metric_name}</span>
        <span className="w-20 shrink-0">{metric.aggregation && <span className={cn('px-1.5 py-0.5 rounded text-[10px] font-medium', aggBadge(metric.aggregation))}>{metric.aggregation}</span>}</span>
        <span className="w-40 shrink-0 text-xs truncate" title={metric.business_filter}>{filterPreview ? <span className="text-amber-600 dark:text-amber-400">⚡ {filterPreview}</span> : <span className="text-muted-foreground">-</span>}</span>
        <span className="w-20 shrink-0 text-right text-xs text-muted-foreground">{metric.period || '-'}</span>
      </button>
      {expanded && (
        <div className="px-3 pb-3 pl-9 space-y-2.5">
          {/* 计算逻辑 */}
          <div className="border-l-2 border-muted pl-3">
            <div className="text-[10px] font-medium text-muted-foreground uppercase mb-1">🔧 计算逻辑</div>
            <div className="flex items-center gap-1.5 mb-1.5">
              {metric.aggregation && <span className={cn('px-1.5 py-0.5 rounded text-[10px] font-medium', aggBadge(metric.aggregation))}>{metric.aggregation}</span>}
              <span className="px-1.5 py-0.5 rounded text-[10px] bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400">{metric.metric_type || 'atomic'}</span>
            </div>
            <pre className="text-xs font-mono p-2 bg-muted rounded overflow-auto max-h-32 whitespace-pre-wrap break-all">{metric.expression}</pre>
          </div>
          {/* 业务限定 */}
          {metric.business_filter && (
            <div className="border-l-2 border-amber-300 pl-3">
              <div className="text-[10px] font-medium text-muted-foreground uppercase mb-1">⚡ 业务限定</div>
              <div className="space-y-1">
                {metric.business_filter.split(';').map((cond, i) => { const c = cond.trim(); return c ? <div key={i} className="flex items-start gap-1.5 text-xs"><span className="text-amber-500 shrink-0">▸</span><code className="text-amber-900 dark:text-amber-100 break-all">{c}</code></div> : null; })}
              </div>
            </div>
          )}
          {/* 数据来源 */}
          <div className="border-l-2 border-blue-300 pl-3">
            <div className="text-[10px] font-medium text-muted-foreground uppercase mb-1">🔗 数据来源</div>
            <div className="space-y-1 text-xs">
              {sourceCols.length > 0 && (
                <div className="flex items-start gap-2"><span className="text-muted-foreground shrink-0 w-14">源字段:</span><div className="flex flex-wrap gap-1">{sourceCols.map(c => <span key={c} className="px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300 text-[10px] font-mono">{c}</span>)}</div></div>
              )}
              {sourceTables.length > 0 && (
                <div className="flex items-start gap-2"><span className="text-muted-foreground shrink-0 w-14">源表:</span><div className="flex flex-wrap gap-1">{sourceTables.slice(0, 6).map(tb => <span key={tb} className="px-1.5 py-0.5 rounded bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-300 text-[10px] font-mono">{tb}</span>)}{sourceTables.length > 6 && <span className="text-[10px] text-muted-foreground">+{sourceTables.length - 6}</span>}</div></div>
              )}
              <div className="flex items-start gap-2"><span className="text-muted-foreground shrink-0 w-14">产出:</span><code className="text-[10px] font-mono">{metric.bound_model}.{metric.bound_column}</code></div>
            </div>
          </div>
          {/* 统计维度 */}
          {dims.length > 0 && (
            <div className="border-l-2 border-purple-300 pl-3">
              <div className="text-[10px] font-medium text-muted-foreground uppercase mb-1">📊 统计维度</div>
              <div className="flex flex-wrap gap-1">{dims.map(d => <span key={d} className="px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 dark:bg-purple-900/50 dark:text-purple-300 text-[10px] font-mono">{d}</span>)}</div>
            </div>
          )}
          {/* 元数据 */}
          <div className="border-l-2 border-gray-300 pl-3">
            <div className="text-[10px] font-medium text-muted-foreground uppercase mb-1">ℹ️ 元数据</div>
            <div className="grid grid-cols-3 gap-x-4 gap-y-0.5 text-xs">
              {metric.layer && metric.layer !== 'unknown' && <div><span className="text-muted-foreground">层级: </span><span className="font-medium">{metric.layer}</span></div>}
              {metric.period && <div><span className="text-muted-foreground">周期: </span><span className="font-medium">{metric.period}</span></div>}
              {metric.owner && <div><span className="text-muted-foreground">负责人: </span><span className="font-medium">{metric.owner}</span></div>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
