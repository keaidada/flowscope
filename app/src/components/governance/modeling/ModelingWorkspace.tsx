/**
 * ModelingWorkspace — Dataphin-style 规范建模 (data modeling) workspace.
 *
 * Layout mirrors Dataphin's modeling studio:
 * - Left: 主题域 (domain) tree → business areas
 * - Top: object category tabs (维度 / 原子指标 / 业务限定 / 派生指标 / 汇总逻辑表 / 模型)
 * - Center: object cards grouped by category (Dataphin-style layered color)
 * - Right: object detail panel
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  FolderTree, Sparkles, Search, Database, Ruler, FunctionSquare,
  Filter, Layers, Table2, Box, Loader2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { governanceApi } from '@/lib/governance-api';

type ModelingView = 'dimension' | 'atomic' | 'qualifier' | 'derived' | 'summary' | 'model';

interface ModelingWorkspaceProps {
  projectId: string | null;
}

const VIEW_META: Array<{ id: ModelingView; labelKey: string; icon: React.ElementType; color: string }> = [
  { id: 'dimension', labelKey: 'governance.dimension', icon: Ruler, color: 'bg-purple-500/10 text-purple-600' },
  { id: 'atomic', labelKey: 'governance.atomicMetric', icon: FunctionSquare, color: 'bg-blue-500/10 text-blue-600' },
  { id: 'qualifier', labelKey: 'governance.businessQualifier', icon: Filter, color: 'bg-amber-500/10 text-amber-600' },
  { id: 'derived', labelKey: 'governance.derivedMetric', icon: Layers, color: 'bg-emerald-500/10 text-emerald-600' },
  { id: 'summary', labelKey: 'governance.summaryTable', icon: Table2, color: 'bg-orange-500/10 text-orange-600' },
  { id: 'model', labelKey: 'governance.model', icon: Box, color: 'bg-sky-500/10 text-sky-600' },
];

export function ModelingWorkspace({ projectId }: ModelingWorkspaceProps) {
  const { t } = useTranslation();
  const [view, setView] = useState<ModelingView>('dimension');
  const [domains, setDomains] = useState<Array<{ id: number; domain_name: string; description: string; model_count: number }>>([]);
  const [overview, setOverview] = useState<any>(null);
  const [selectedDomain, setSelectedDomain] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [discovering, setDiscovering] = useState(false);
  const [loading, setLoading] = useState(false);
  const [selectedObj, setSelectedObj] = useState<any>(null);

  const loadDomains = useCallback(async () => {
    if (!projectId) return;
    try {
      const d = await governanceApi.listDomains(projectId);
      setDomains(d);
      if (d.length > 0 && !selectedDomain) setSelectedDomain(d[0].domain_name);
    } catch (e) { console.error('domains failed', e); }
  }, [projectId, selectedDomain]);

  const loadOverview = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const o = await governanceApi.modelingOverview(projectId);
      setOverview(o);
    } catch (e) { console.error('overview failed', e); }
    finally { setLoading(false); }
  }, [projectId]);

  useEffect(() => { loadDomains(); }, [loadDomains]);
  useEffect(() => { loadOverview(); }, [loadOverview]);

  const handleDiscover = async () => {
    if (!projectId) return;
    setDiscovering(true);
    try {
      const r = await governanceApi.discoverDomains(projectId);
      console.log('discovered', r.discovered);
      await loadDomains();
      await loadOverview();
    } catch (e) { console.error('discover failed', e); }
    finally { setDiscovering(false); }
  };

  const stats = useMemo(() => {
    const s: Array<{ labelKey: string; value: number; icon: React.ElementType; color: string }> = [
      { labelKey: 'governance.totalModels', value: overview?.total_models ?? 0, icon: Database, color: 'bg-blue-500/10 text-blue-600' },
      { labelKey: 'governance.totalDimensions', value: overview?.total_dimensions ?? 0, icon: Ruler, color: 'bg-purple-500/10 text-purple-600' },
      { labelKey: 'governance.totalAtomic', value: overview?.total_atomic_metrics ?? 0, icon: FunctionSquare, color: 'bg-sky-500/10 text-sky-600' },
      { labelKey: 'governance.totalQualifiers', value: overview?.total_qualifiers ?? 0, icon: Filter, color: 'bg-amber-500/10 text-amber-600' },
      { labelKey: 'governance.totalDerived', value: overview?.total_derived_metrics ?? 0, icon: Layers, color: 'bg-emerald-500/10 text-emerald-600' },
      { labelKey: 'governance.totalSummary', value: overview?.total_summary_tables ?? 0, icon: Table2, color: 'bg-orange-500/10 text-orange-600' },
    ];
    return s;
  }, [overview]);

  if (!projectId) {
    return <div className="flex items-center justify-center h-full text-muted-foreground text-sm">{t('governance.selectProject')}</div>;
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b shrink-0">
        <div className="flex items-center gap-1">
          <span className="text-xs font-semibold text-muted-foreground mr-1">{t('governance.modelingDesc')}</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
            <input type="text" placeholder={t('governance.searchModeling')} value={search} onChange={e => setSearch(e.target.value)}
              className="w-44 pl-7 pr-2 py-1 text-xs rounded border bg-transparent focus:outline-none focus:ring-1 focus:ring-ring" />
          </div>
          <Button size="sm" onClick={handleDiscover} disabled={discovering} className="h-6 gap-1 text-xs px-2.5">
            {discovering ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
            {discovering ? t('governance.discoveringDomains') : t('governance.discoverDomains')}
          </Button>
        </div>
      </div>

      {/* Object category tabs */}
      <div className="flex items-center gap-1 px-3 py-1 border-b bg-background shrink-0 overflow-x-auto">
        {VIEW_META.map(v => {
          const Icon = v.icon;
          const active = view === v.id;
          return (
            <button key={v.id} onClick={() => { setView(v.id); setSelectedObj(null); }}
              className={cn('flex items-center gap-1.5 px-2.5 h-7 rounded-md text-xs font-medium whitespace-nowrap transition-colors',
                active ? cn(v.color, 'ring-1 ring-current/20') : 'text-muted-foreground hover:text-foreground hover:bg-muted/50')}>
              <Icon className="h-3.5 w-3.5" />{t(v.labelKey)}
            </button>
          );
        })}
      </div>

      {/* Overview stats bar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/20 shrink-0">
        {stats.map(s => {
          const Icon = s.icon;
          return (
            <div key={s.labelKey} className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-card border">
              <Icon className={cn('h-3.5 w-3.5', s.color)} />
              <span className="text-xs font-semibold tabular-nums">{s.value}</span>
              <span className="text-[10px] text-muted-foreground">{t(s.labelKey)}</span>
            </div>
          );
        })}
      </div>

      {/* Main: left domains + center content + right detail */}
      <div className="flex flex-1 min-h-0">
        {/* Left: domain tree */}
        <div className="w-52 border-r flex flex-col shrink-0">
          <div className="px-3 py-1.5 border-b bg-muted/20 text-[10px] font-semibold text-muted-foreground flex items-center gap-1">
            <FolderTree className="h-3 w-3" />{t('governance.domains')} ({domains.length})
          </div>
          <div className="flex-1 overflow-auto">
            {domains.length === 0 ? (
              <div className="p-3 text-[10px] text-muted-foreground">{t('governance.modelingEmpty')}</div>
            ) : (
              domains.map(d => (
                <button key={d.domain_name} onClick={() => setSelectedDomain(d.domain_name)}
                  className={cn('w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-accent/50 border-b',
                    selectedDomain === d.domain_name && 'bg-accent')}>
                  <FolderTree className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-medium truncate">{d.domain_name}</div>
                    <div className="text-[9px] text-muted-foreground">{d.model_count} 模型</div>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>

        {/* Center: object cards */}
        <div className="flex-1 min-w-0 overflow-auto p-3">
          {loading ? (
            <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />{t('governance.loading')}
            </div>
          ) : (
            <ViewContent
              projectId={projectId}
              view={view}
              domain={selectedDomain}
              search={search}
              onSelect={setSelectedObj}
              selectedObj={selectedObj}
            />
          )}
        </div>

        {/* Right: detail panel */}
        <div className="w-80 border-l flex flex-col shrink-0">
          <div className="px-3 py-1.5 border-b bg-muted/20 text-[10px] font-semibold text-muted-foreground">
            {t('governance.objectDetail')}
          </div>
          <div className="flex-1 overflow-auto p-3">
            {selectedObj ? (
              <ObjectDetail obj={selectedObj} view={view} />
            ) : (
              <div className="flex items-center justify-center h-full text-muted-foreground text-xs p-4 text-center">
                {t('governance.selectObject')}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// View content: loads + renders objects for the active category
// ============================================================

function ViewContent({
  projectId, view, domain, search, onSelect, selectedObj,
}: {
  projectId: string;
  view: ModelingView;
  domain: string | null;
  search: string;
  onSelect: (obj: any) => void;
  selectedObj: any;
}) {
  const { t } = useTranslation();
  const [data, setData] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const load = async () => {
      let rows: any[] = [];
      try {
        switch (view) {
          case 'dimension': {
            const r = await governanceApi.listDimensions(projectId, undefined, 200, 0);
            rows = r.items.map(i => ({ name: i.dim_name, column: i.dim_column, master: i.master_table, refs: i.ref_count, attrs: i.attributes, status: i.status, type: 'dimension' }));
            break;
          }
          case 'atomic': {
            const m = await governanceApi.listAtomicMetrics(projectId);
            rows = m.map(i => ({ name: i.metric_name, expr: i.expression, agg: i.agg_func, column: i.source_column, table: i.source_table, type: 'atomic' }));
            break;
          }
          case 'qualifier': {
            const q = await governanceApi.listQualifiers(projectId);
            rows = q.map(i => ({ name: i.qualifier_name, expr: i.qualifier_expr, field: i.field_name, refs: i.ref_count, type: 'qualifier' }));
            break;
          }
          case 'derived': {
            const d = await governanceApi.listDerivedMetrics(projectId);
            rows = d.map(i => ({ name: i.metric_name, atomic: i.atomic_metric_name, quals: i.qualifier_names, period: i.time_period, gran: i.stat_granularity, sql: i.full_sql, type: 'derived' }));
            break;
          }
          case 'summary': {
            const r = await governanceApi.listSummaryRecs(projectId);
            rows = r.map(i => ({ name: i.recommended_table_name, layer: i.recommended_layer, gran: i.stat_granularity, metrics: i.metric_count, sql: i.suggested_sql, savings: i.potential_savings, type: 'summary' }));
            break;
          }
          case 'model': {
            const m = await governanceApi.listModels(`project_id=${encodeURIComponent(projectId)}`);
            rows = m.map(i => ({ name: i.table_name, layer: i.model_layer, modelType: i.model_type, domain: i.business_domain, type: 'model' }));
            break;
          }
        }
      } catch (e) { console.error('load failed', e); }
      if (!cancelled) {
        setData(rows);
        setLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [projectId, view]);

  // Apply domain + search filters.
  const filtered = data.filter(o => {
    if (domain && o.domain && o.domain !== domain) return false;
    if (search.trim()) {
      const s = search.toLowerCase();
      return JSON.stringify(o).toLowerCase().includes(s);
    }
    return true;
  });

  if (loading) return <div className="flex items-center justify-center h-full text-muted-foreground text-sm"><Loader2 className="h-4 w-4 mr-2 animate-spin" />{t('governance.loading')}</div>;
  if (filtered.length === 0) return <div className="flex items-center justify-center h-full text-muted-foreground text-sm">暂无数据</div>;

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
      {filtered.map((o, i) => (
        <button key={`${o.name}-${i}`} onClick={() => onSelect(o)}
          className={cn('text-left p-3 rounded-lg border bg-card hover:border-primary/40 transition-colors',
            selectedObj?.name === o.name && 'border-primary/60 ring-1 ring-primary/30')}>
          <ObjectCard obj={o} view={view} />
        </button>
      ))}
    </div>
  );
}

// ============================================================
// Object card renderer
// ============================================================

function ObjectCard({ obj, view }: { obj: any; view: ModelingView }) {
  if (view === 'dimension') {
    return (
      <div>
        <div className="flex items-center gap-1.5 mb-1">
          <Ruler className="h-3.5 w-3.5 text-purple-500" />
          <span className="text-sm font-medium truncate">{obj.name}</span>
          {obj.status === 'candidate' && <span className="ml-auto px-1 py-0.5 rounded text-[9px] bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300 shrink-0">候选</span>}
          {obj.status === 'confirmed' && <span className="ml-auto px-1 py-0.5 rounded text-[9px] bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300 shrink-0">已确认</span>}
        </div>
        <div className="text-[10px] text-muted-foreground font-mono mb-1">col: {obj.column}</div>
        <div className="flex items-center gap-1 text-[10px]">
          <span className="px-1.5 py-0.5 rounded bg-primary/10 text-primary font-medium">{obj.refs} 表引用</span>
          <span className="px-1.5 py-0.5 rounded bg-muted text-muted-foreground truncate">{obj.master}</span>
        </div>
      </div>
    );
  }
  if (view === 'atomic') {
    return (
      <div>
        <div className="flex items-center gap-1.5 mb-1">
          <FunctionSquare className="h-3.5 w-3.5 text-sky-500" />
          <span className="text-sm font-medium truncate">{obj.name}</span>
        </div>
        <div className="text-[10px] font-mono text-muted-foreground mb-1 break-all">{obj.expr}</div>
        <div className="flex items-center gap-1 text-[10px]">
          <span className="px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300 font-medium">{obj.agg}</span>
          <span className="px-1.5 py-0.5 rounded bg-muted text-muted-foreground truncate">{obj.column}</span>
        </div>
      </div>
    );
  }
  if (view === 'qualifier') {
    return (
      <div>
        <div className="flex items-center gap-1.5 mb-1">
          <Filter className="h-3.5 w-3.5 text-amber-500" />
          <span className="text-sm font-medium truncate">{obj.name}</span>
        </div>
        <div className="text-[10px] font-mono text-amber-600 dark:text-amber-400 break-all mb-1">{obj.expr}</div>
        <div className="text-[10px] text-muted-foreground">field: {obj.field} · {obj.refs} 次引用</div>
      </div>
    );
  }
  if (view === 'derived') {
    return (
      <div>
        <div className="flex items-center gap-1.5 mb-1">
          <Layers className="h-3.5 w-3.5 text-emerald-500" />
          <span className="text-sm font-medium truncate">{obj.name}</span>
        </div>
        <div className="text-[10px] text-muted-foreground mb-1 truncate">原子: {obj.atomic}</div>
        <div className="flex flex-wrap gap-1 text-[10px]">
          {obj.quals?.slice(0, 3).map((q: string, i: number) => (
            <span key={i} className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300">{q}</span>
          ))}
          {obj.gran?.length > 0 && <span className="px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300">粒度: {obj.gran.join(',')}</span>}
        </div>
      </div>
    );
  }
  if (view === 'summary') {
    return (
      <div>
        <div className="flex items-center gap-1.5 mb-1">
          <Table2 className="h-3.5 w-3.5 text-orange-500" />
          <span className="text-sm font-medium truncate">{obj.name}</span>
        </div>
        <div className="flex items-center gap-1 text-[10px] mb-1">
          <span className="px-1.5 py-0.5 rounded bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300 font-medium">{obj.layer}</span>
          <span className="px-1.5 py-0.5 rounded bg-primary/10 text-primary">{obj.metrics} 个指标</span>
        </div>
        <div className="text-[10px] text-muted-foreground truncate">{obj.savings}</div>
      </div>
    );
  }
  // model
  return (
    <div>
      <div className="flex items-center gap-1.5 mb-1">
        <Box className="h-3.5 w-3.5 text-sky-500" />
        <span className="text-sm font-medium truncate">{obj.name}</span>
      </div>
      <div className="flex items-center gap-1 text-[10px]">
        <span className={cn('px-1.5 py-0.5 rounded font-medium',
          obj.layer === 'ODS' && 'bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300',
          obj.layer === 'DWD' && 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
          obj.layer === 'DWS' && 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
          obj.layer === 'ADS' && 'bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300',
          obj.layer === 'DIM' && 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-400',
          !['ODS','DWD','DWS','ADS','DIM'].includes(obj.layer) && 'bg-muted text-muted-foreground')}>{obj.layer}</span>
        <span className="px-1.5 py-0.5 rounded bg-muted text-muted-foreground">{obj.modelType}</span>
      </div>
    </div>
  );
}

// ============================================================
// Object detail panel
// ============================================================

function ObjectDetail({ obj, view }: { obj: any; view: ModelingView }) {
  const rows: Array<[string, string]> = [];

  if (view === 'dimension') {
    rows.push(['dim_name', obj.name], ['dim_column', obj.column], ['master_table', obj.master], ['ref_count', String(obj.refs)], ['status', obj.status]);
  } else if (view === 'atomic') {
    rows.push(['metric_name', obj.name], ['expression', obj.expr], ['agg_func', obj.agg], ['source_column', obj.column], ['source_table', obj.table]);
  } else if (view === 'qualifier') {
    rows.push(['qualifier_name', obj.name], ['qualifier_expr', obj.expr], ['field_name', obj.field], ['ref_count', String(obj.refs)]);
  } else if (view === 'derived') {
    rows.push(['metric_name', obj.name], ['atomic_metric', obj.atomic], ['qualifiers', (obj.quals || []).join(', ')], ['time_period', obj.period], ['granularity', (obj.gran || []).join(', ')]);
  } else if (view === 'summary') {
    rows.push(['table_name', obj.name], ['layer', obj.layer], ['granularity', (obj.gran || []).join(', ')], ['metrics', String(obj.metrics)], ['savings', obj.savings]);
  } else {
    rows.push(['table_name', obj.name], ['layer', obj.layer], ['model_type', obj.modelType]);
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        {rows.map(([k, v]) => (
          <div key={k} className="flex flex-col gap-0.5">
            <span className="text-[9px] uppercase text-muted-foreground">{k}</span>
            <code className="text-[11px] font-mono break-all bg-muted rounded px-1.5 py-1">{v || '-'}</code>
          </div>
        ))}
      </div>
      {view === 'dimension' && obj.attrs?.length > 0 && (
        <div>
          <div className="text-[9px] uppercase text-muted-foreground mb-1">attributes</div>
          <div className="flex flex-wrap gap-1">
            {obj.attrs.map((a: string, i: number) => (
              <span key={i} className="px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300 text-[10px] font-mono">{a}</span>
            ))}
          </div>
        </div>
      )}
      {view === 'derived' && obj.sql && (
        <div>
          <div className="text-[9px] uppercase text-muted-foreground mb-1">full_sql</div>
          <pre className="text-[10px] font-mono bg-muted rounded p-2 overflow-auto max-h-40 whitespace-pre-wrap break-all">{obj.sql}</pre>
        </div>
      )}
      {view === 'summary' && obj.sql && (
        <div>
          <div className="text-[9px] uppercase text-muted-foreground mb-1">suggested_sql</div>
          <pre className="text-[10px] font-mono bg-muted rounded p-2 overflow-auto max-h-40 whitespace-pre-wrap break-all">{obj.sql}</pre>
        </div>
      )}
    </div>
  );
}
