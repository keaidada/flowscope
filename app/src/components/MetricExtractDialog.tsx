/**
 * MetricExtractDialog — 从单个脚本提取指标（mock 数据演示）。
 *
 * 对当前打开的脚本，展示从血缘中提取的指标体系：
 * - 原子指标（sum/count 聚合）
 * - 业务限定（CASE WHEN 条件）
 * - 派生指标（原子 + 限定 + 粒度 组装）
 *
 * 全部 mock 数据（基于脚本文件名生成），后续可接真实 API。
 */

import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuRadioGroup, DropdownMenuRadioItem,
} from '@/components/ui/dropdown-menu';
import { SqlView } from '@pondpilot/capybara-react';
import {
  FunctionSquare, Filter, Layers, BarChart3, Check, Copy, ArrowRight,
  RefreshCw, Loader2, FileCode2, Clock, Grid3x3, Sparkles, Bot, ChevronDown,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { extractScriptMetrics } from '@/lib/file-storage';

interface MetricExtractDialogProps {
  open: boolean;
  onClose: () => void;
  projectId: string;
  filePath: string;
  sqlContent?: string;
}

// ── Display types (derived from real extracted metrics) ───────────

interface MockAtomic {
  name: string;
  expr: string;
  agg: string;
  column: string;
  sourceTable: string;
}
interface MockQualifier {
  name: string;
  expr: string;
  field: string;
}
interface MockPeriod {
  name: string;
  expr: string;
  unit: string;
  label: string;
}
interface MockDerived {
  name: string;
  atomic: string;
  qualifiers: string[];
  period: string;
  periodExpr: string;
  gran: string;
}
interface MockDimension {
  name: string;
  desc: string;
  type: string;
}

// Standard time periods (周期限定)
const PERIOD_POOL: MockPeriod[] = [
  { name: '昨日', expr: `data_dt = date_sub('${'${bizdate}'}', 1)`, unit: 'daily', label: '按日' },
  { name: '近7日', expr: `data_dt >= date_sub('${'${bizdate}'}', 7)`, unit: 'rolling_7d', label: '近7日' },
  { name: '近30日', expr: `data_dt >= date_sub('${'${bizdate}'}', 30)`, unit: 'rolling_30d', label: '近30日' },
  { name: '本月', expr: `data_dt >= trunc('${'${bizdate}'}', 'MM')`, unit: 'monthly', label: '按月' },
  { name: '自然周', expr: `data_dt >= date_sub('${'${bizdate}'}', 6)`, unit: 'weekly', label: '按周' },
  { name: '累计', expr: `data_dt <= '${'${bizdate}'}'`, unit: 'cumulative', label: '累计' },
];

/** Derive display data (atomics/qualifiers/periods/derived) from real extracted metrics. */
function deriveFromMetrics(ms: Array<{
  name: string; expression: string; agg_func: string; distinct: boolean;
  source_table: string; column: string; business_filter: string; period: string;
  dimensions: string[];
}>): { atomics: MockAtomic[]; qualifiers: MockQualifier[]; periods: MockPeriod[]; dimensions: MockDimension[]; derived: MockDerived[] } {
  const atomics: MockAtomic[] = ms.map(m => ({
    name: m.name,
    expr: m.expression,
    agg: m.distinct && m.agg_func === 'count' ? 'count_distinct' : m.agg_func,
    column: m.column,
    sourceTable: m.source_table,
  }));

  // Qualifiers from business filters (deduplicated).
  const qualifiers: MockQualifier[] = [];
  const seenQ = new Set<string>();
  for (const m of ms) {
    if (!m.business_filter) continue;
    const parts = m.business_filter.split(' AND ');
    for (const p of parts) {
      const t = p.trim();
      if (!t || seenQ.has(t)) continue;
      seenQ.add(t);
      const field = (t.split(/[=<>!]+/)[0] || t).trim();
      qualifiers.push({ name: `${field}_q${qualifiers.length + 1}`, expr: t, field });
    }
  }

  // Periods: derive from the script's real period; fall back to a fixed subset.
  const realPeriod = ms.find(m => m.period)?.period || '';
  const periods: MockPeriod[] = realPeriod === 'daily'
    ? PERIOD_POOL.filter(p => p.unit === 'daily' || p.unit === 'rolling_7d' || p.unit === 'rolling_30d')
    : realPeriod === 'monthly'
      ? PERIOD_POOL.filter(p => p.unit === 'monthly' || p.unit === 'daily')
      : realPeriod === 'weekly'
        ? PERIOD_POOL.filter(p => p.unit === 'weekly' || p.unit === 'daily')
        : PERIOD_POOL.slice(0, 3);

  // Dimensions (统计粒度) from GROUP BY.
  const dims: string[] = ms.length > 0 ? ms[0].dimensions : [];
  const dimensions: MockDimension[] = dims.map((d, i) => ({
    name: d,
    desc: d,
    type: i === 0 ? '主维度' : '属性',
  }));

  // Derived: atomic × qualifier × period, granularity from real dimensions.
  const derived: MockDerived[] = [];
  const maxD = Math.min(6, atomics.length, Math.max(1, qualifiers.length));
  for (let i = 0; i < maxD; i++) {
    const a = atomics[i];
    const q = qualifiers[i % (qualifiers.length || 1)];
    const p = periods[i % periods.length];
    const gran = dims[i % (dims.length || 1)] || q?.field || 'all';
    derived.push({
      name: `${a.name}_${(q?.field || 'total')}_${p.label}`,
      atomic: a.expr,
      qualifiers: q ? [q.expr] : [],
      period: p.unit,
      periodExpr: p.expr,
      gran: `${p.label}·${gran}`,
    });
  }

  return { atomics, qualifiers, periods, dimensions, derived };
}

function apiBase(): string {
  if (typeof window !== 'undefined') {
    const port = (window as unknown as { __FSCOPE_PORT__?: number }).__FSCOPE_PORT__;
    if (port) return `http://localhost:${port}`;
  }
  return '';
}

const AI_MODEL_PRESETS = [
  { label: 'Ollama · qwen2.5:3b', provider: 'ollama', model: 'qwen2.5:3b', endpoint: 'http://localhost:11434', api_key: 'ollama' },
  { label: 'DeepSeek · deepseek-chat', provider: 'deepseek', model: 'deepseek-chat', endpoint: 'https://api.deepseek.com', api_key: '' },
  { label: 'DeepSeek · deepseek-reasoner', provider: 'deepseek', model: 'deepseek-reasoner', endpoint: 'https://api.deepseek.com', api_key: '' },
] as const;

/** AI-extracted metric system: 5 categories (mirrors the rule-based tabs). */
interface AiMetricSet {
  atomics: Array<{ name: string; expression: string; agg_func: string; distinct: boolean; source_table: string; column: string }>;
  qualifiers: Array<{ name: string; expr: string; field: string }>;
  periods: Array<{ name: string; expr: string; unit: string; label: string }>;
  dimensions: Array<{ name: string; type: string; desc: string }>;
  derived: Array<{ name: string; atomic: string; qualifiers: string[]; periodExpr: string; gran: string }>;
}

/** Request metric extraction from the backend (non-streaming LLM call). */
async function requestAiExtract(projectId: string, filePath: string, sql: string): Promise<AiMetricSet> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 150_000);
  try {
    const res = await fetch(`${apiBase()}/api/ai/extract-metrics`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({ project_id: projectId, file_path: filePath, sql }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || `AI 请求失败: ${res.status}`);
    const obj: Record<string, unknown> = data.metrics ?? data;
    const arr = (v: unknown) => (Array.isArray(v) ? v : []) as Array<Record<string, unknown>>;
    const s = (m: Record<string, unknown>, ...keys: string[]) => {
      for (const k of keys) {
        const v = m[k];
        if (typeof v === 'string') return v;
      }
      return '';
    };
    const b = (m: Record<string, unknown>, k: string) => Boolean(m[k]);
    return {
      atomics: arr(obj.atomics).map(m => ({
        name: s(m, 'name') || 'metric',
        expression: s(m, 'expression', 'expr'),
        agg_func: s(m, 'agg_func', 'agg') || 'sum',
        distinct: b(m, 'distinct'),
        source_table: s(m, 'source_table', 'sourceTable'),
        column: s(m, 'column'),
      })),
      qualifiers: arr(obj.qualifiers).map(m => ({
        name: s(m, 'name'),
        expr: s(m, 'expr', 'expression'),
        field: s(m, 'field'),
      })),
      periods: arr(obj.periods).map(m => ({
        name: s(m, 'name'),
        expr: s(m, 'expr', 'expression'),
        unit: s(m, 'unit'),
        label: s(m, 'label'),
      })),
      dimensions: arr(obj.dimensions).map(m => ({
        name: s(m, 'name'),
        type: s(m, 'type'),
        desc: s(m, 'desc'),
      })),
      derived: arr(obj.derived).map(m => ({
        name: s(m, 'name'),
        atomic: s(m, 'atomic'),
        qualifiers: Array.isArray(m.qualifiers) ? m.qualifiers.map(String) : [],
        periodExpr: s(m, 'periodExpr', 'period_expr'),
        gran: s(m, 'gran'),
      })),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Collapsible section for one AI-extracted metric category. */
function AiSection({ title, count, open, onToggle, children }: {
  title: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-md border bg-muted/20 overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-left hover:bg-muted/40 transition-colors"
      >
        <ChevronDown className={cn('h-3 w-3 text-muted-foreground transition-transform', !open && '-rotate-90')} />
        <span className="flex-1 text-[11px] font-semibold text-foreground">{title}</span>
        <span className="text-[10px] bg-primary/10 text-primary px-1.5 py-0.5 rounded-full">{count}</span>
      </button>
      {open && <div className="px-2.5 pb-2">{children}</div>}
    </div>
  );
}

function AiAtomicsList({ metrics }: { metrics: AiMetricSet }) {
  return (
    <ol className="space-y-1.5">
      {metrics.atomics.map((a, i) => (
        <li key={i} className="text-[11px] leading-snug">
          <span className="font-medium">{a.name}</span>
          {a.expression && <span className="text-muted-foreground"> — {a.expression}</span>}
          {a.source_table && (
            <span className="block text-[10px] text-muted-foreground">来源 {a.source_table}{a.column ? ` · ${a.column}` : ''}</span>
          )}
        </li>
      ))}
    </ol>
  );
}

function AiQualifiersList({ metrics }: { metrics: AiMetricSet }) {
  return (
    <ol className="space-y-1">
      {metrics.qualifiers.map((q, i) => (
        <li key={i} className="text-[11px] leading-snug">
          <span className="font-medium">{q.name || q.expr}</span>
          {q.expr && q.name !== q.expr && <span className="text-muted-foreground">：{q.expr}</span>}
          {q.field && <span className="text-[10px] text-muted-foreground">（字段 {q.field}）</span>}
        </li>
      ))}
    </ol>
  );
}

function AiPeriodsList({ metrics }: { metrics: AiMetricSet }) {
  return (
    <ol className="space-y-1">
      {metrics.periods.map((p, i) => (
        <li key={i} className="text-[11px] leading-snug">
          <span className="font-medium">{p.name || p.expr}</span>
          {p.expr && p.name !== p.expr && <span className="text-muted-foreground">：{p.expr}</span>}
          {p.label && <span className="text-[10px] text-muted-foreground">（{p.label}）</span>}
        </li>
      ))}
    </ol>
  );
}

function AiDimensionsList({ metrics }: { metrics: AiMetricSet }) {
  return (
    <ol className="space-y-1">
      {metrics.dimensions.map((d, i) => (
        <li key={i} className="text-[11px] leading-snug">
          <span className="font-medium">{d.name}</span>
          {d.type && <span className="text-muted-foreground">（{d.type}）</span>}
          {d.desc && <span className="text-[10px] text-muted-foreground"> — {d.desc}</span>}
        </li>
      ))}
    </ol>
  );
}

function AiDerivedList({ metrics }: { metrics: AiMetricSet }) {
  return (
    <ol className="space-y-1.5">
      {metrics.derived.map((d, i) => (
        <li key={i} className="text-[11px] leading-snug">
          <span className="font-medium">{d.name}</span>
          <span className="text-muted-foreground"> — 原子 {d.atomic}</span>
          {d.qualifiers.length > 0 && <span className="text-muted-foreground">；限定 {d.qualifiers.join('、')}</span>}
          {d.periodExpr && <span className="text-muted-foreground">；周期 {d.periodExpr}</span>}
          {d.gran && <span className="text-muted-foreground">；粒度 {d.gran}</span>}
        </li>
      ))}
    </ol>
  );
}

export function MetricExtractDialog({ open, onClose, projectId, filePath, sqlContent }: MetricExtractDialogProps) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiModelKey, setAiModelKey] = useState('ollama|qwen2.5:3b');
  const [aiSavedModels, setAiSavedModels] = useState<Record<string, { provider: string; model: string; endpoint?: string }>>({});
  const [tab, setTab] = useState<'atomic' | 'qualifier' | 'period' | 'dimension' | 'derived'>('atomic');
  const [selected, setSelected] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [showSql, setShowSql] = useState(false);
  const [err, setErr] = useState('');
  const [aiErr, setAiErr] = useState('');
  const [aiResult, setAiResult] = useState<AiMetricSet | null>(null);
  const [aiOpen, setAiOpen] = useState<Record<string, boolean>>({});
  const [mock, setMock] = useState<{ atomics: MockAtomic[]; qualifiers: MockQualifier[]; periods: MockPeriod[]; dimensions: MockDimension[]; derived: MockDerived[] }>({
    atomics: [], qualifiers: [], periods: [], dimensions: [], derived: [],
  });

  const scriptName = filePath.split('/').pop() || filePath;

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setTab('atomic');
    setSelected(null);
    setErr('');
    extractScriptMetrics(projectId, filePath)
      .then(r => setMock(deriveFromMetrics(r.metrics)))
      .catch(e => setErr(String(e)))
      .finally(() => setLoading(false));
  }, [open, projectId, filePath]);

  // Load saved model configs + active model for the AI extract model picker.
  useEffect(() => {
    if (!open || !projectId) return;
    fetch(`${apiBase()}/api/ai/config?project_id=${projectId}`)
      .then(r => r.json())
      .then(c => {
        const map: Record<string, { provider: string; model: string; endpoint?: string }> = {};
        for (const item of c.models || []) {
          map[`${item.provider}|${item.model}`] = {
            provider: item.provider,
            model: item.model,
            endpoint: item.endpoint || '',
          };
        }
        setAiSavedModels(map);
        if (c.active?.provider && c.active?.model) {
          setAiModelKey(`${c.active.provider}|${c.active.model}`);
        }
      })
      .catch(() => {});
  }, [open, projectId]);

  /** Switch the active model pointer (same semantics as the chat panel's quick switch). */
  const switchAiModel = (key: string) => {
    const [p, m] = key.split('|');
    setAiModelKey(key);
    fetch(`${apiBase()}/api/ai/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: projectId, provider: p, model: m }),
    }).catch(e => console.error('[ai] switch failed', e));
  };

  const totalAtomic = mock.atomics.length;
  const totalQualifier = mock.qualifiers.length;
  const totalPeriod = mock.periods.length;
  const totalDimension = mock.dimensions.length;
  const totalDerived = mock.derived.length;

  const handleAiExtract = async () => {
    if (!sqlContent) return;
    setAiLoading(true);
    setAiErr('');
    setAiResult(null);
    setAiOpen({});
    try {
      const metrics = await requestAiExtract(projectId, filePath, sqlContent);
      if (metrics.atomics.length === 0 && metrics.qualifiers.length === 0
        && metrics.periods.length === 0 && metrics.dimensions.length === 0
        && metrics.derived.length === 0) {
        throw new Error('AI 未提取到任何指标');
      }
      setAiResult(metrics);
    } catch (e) {
      setAiErr(String(e instanceof Error ? e.message : e));
    } finally {
      setAiLoading(false);
    }
  };

  /** Merge saved models + presets into one deduplicated list (saved first). */
  const aiModelOptions = useMemo(() => {
    const options: { key: string; label: string }[] = [];
    const seen = new Set<string>();
    for (const sm of Object.values(aiSavedModels)) {
      const key = `${sm.provider}|${sm.model}`;
      if (seen.has(key)) continue;
      seen.add(key);
      options.push({
        key,
        label: AI_MODEL_PRESETS.find(x => x.provider === sm.provider && x.model === sm.model)?.label
          ?? `${sm.provider} · ${sm.model}`,
      });
    }
    for (const p of AI_MODEL_PRESETS) {
      const key = `${p.provider}|${p.model}`;
      if (seen.has(key)) continue;
      seen.add(key);
      options.push({ key, label: p.label });
    }
    return options;
  }, [aiSavedModels]);

  const handleCopy = () => {
    const lines = tab === 'atomic'
      ? mock.atomics.map(a => `-- ${a.name}\n--   ${a.expr}`).join('\n')
      : tab === 'qualifier'
        ? mock.qualifiers.map(q => `-- ${q.name}: ${q.expr}`).join('\n')
        : tab === 'period'
          ? mock.periods.map(p => `-- ${p.name}: ${p.expr}`).join('\n')
          : tab === 'dimension'
            ? mock.dimensions.map(d => `-- 维度: ${d.name} (${d.type})`).join('\n')
            : mock.derived.map(d => `-- ${d.name} = ${d.atomic} WHERE ${d.qualifiers.join(' AND ')} AND ${d.periodExpr} GROUP BY ${d.gran}`).join('\n');
    navigator.clipboard.writeText(lines).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <Dialog open={open} onOpenChange={() => onClose()}>
      <DialogContent size="full">
        <DialogHeader className="px-3 pt-3 pb-0 shrink-0">
          <div className="flex items-center gap-1.5">
            <div className="flex items-center justify-center w-6 h-6 rounded-md bg-sky-500/10">
              <BarChart3 className="h-3.5 w-3.5 text-sky-500" />
            </div>
            <DialogTitle>{t('editor.extractMetrics', '提取指标')}</DialogTitle>
            <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded-full">
              {totalAtomic} 原子 · {totalQualifier} 限定 · {totalPeriod} 周期 · {totalDimension} 维度 · {totalDerived} 派生
            </span>
          </div>
          <DialogDescription className="leading-tight flex items-center gap-1.5">
            <FileCode2 className="h-3 w-3 shrink-0" />
            {filePath}
          </DialogDescription>
        </DialogHeader>

        {/* Action bar */}
        <div className="flex items-center justify-between px-3 py-1.5 border-b shrink-0 bg-muted/20">
          {/* Tab toggle */}
          <div className="flex items-center rounded-md border bg-background p-0.5">
            {([
              { id: 'atomic' as const, label: `原子指标 (${totalAtomic})`, icon: FunctionSquare, color: 'text-sky-500' },
              { id: 'qualifier' as const, label: `业务限定 (${totalQualifier})`, icon: Filter, color: 'text-amber-500' },
              { id: 'period' as const, label: `周期限定 (${totalPeriod})`, icon: Clock, color: 'text-violet-500' },
              { id: 'dimension' as const, label: `维度 (${totalDimension})`, icon: Grid3x3, color: 'text-purple-500' },
              { id: 'derived' as const, label: `派生指标 (${totalDerived})`, icon: Layers, color: 'text-emerald-500' },
            ]).map(x => {
              const Icon = x.icon;
              return (
                <button key={x.id} onClick={() => { setTab(x.id); setSelected(null); }}
                  className={cn('flex items-center gap-1 h-7 px-2.5 rounded text-[11px] font-medium transition-colors',
                    tab === x.id ? cn('bg-primary/10', x.color) : 'text-muted-foreground hover:text-foreground')}>
                  <Icon className="h-3.5 w-3.5" />{x.label}
                </button>
              );
            })}
          </div>
          <div className="flex items-center gap-1.5">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="flex items-center gap-1 px-2 py-1 rounded-lg border bg-background hover:bg-accent transition-colors text-[11px] text-foreground">
                  <Bot className="h-3 w-3 text-primary" />
                  <span className="max-w-[130px] truncate">
                    {(() => {
                      const [p, m] = aiModelKey.split('|');
                      return AI_MODEL_PRESETS.find(x => x.provider === p && x.model === m)?.label
                        ?? `${p}/${m}`;
                    })()}
                  </span>
                  <ChevronDown className="h-3 w-3 text-muted-foreground" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64">
                <DropdownMenuLabel>选择 AI 提取模型</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuRadioGroup value={aiModelKey} onValueChange={switchAiModel}>
                  {aiModelOptions.map(o => (
                    <DropdownMenuRadioItem key={o.key} value={o.key}>
                      {o.label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button size="sm" variant="ghost" className="h-7 text-[11px]" onClick={() => {
              setLoading(true); setErr('');
              extractScriptMetrics(projectId, filePath)
                .then(r => setMock(deriveFromMetrics(r.metrics)))
                .catch(e => setErr(String(e)))
                .finally(() => setLoading(false));
            }}>
              <RefreshCw className="h-3 w-3 mr-1" />重新提取
            </Button>
            <Button size="sm" disabled={!sqlContent || aiLoading}
              onClick={handleAiExtract}
              className={cn('h-7 text-[11px] gap-1 bg-gradient-to-r from-sky-500 to-violet-500 hover:from-sky-600 hover:to-violet-600 text-white border-0 shadow-sm')}>
              {aiLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
              AI 提取
            </Button>
            <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={handleCopy}>
              {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
              {copied ? '已复制' : '复制'}
            </Button>
          </div>
        </div>

        {/* Content: left list + right detail */}
        <div className="flex flex-1 min-h-0 overflow-hidden">
          <div className="flex-1 min-w-0 overflow-auto bg-sky-50/10 dark:bg-sky-950/5">
            {loading ? (
              <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
                <Loader2 className="h-5 w-5 mr-2 animate-spin" />
                {t('editor.generating', '生成中...')}
              </div>
            ) : err ? (
              <div className="p-4 text-sm text-destructive">
                <p className="font-medium mb-1">提取失败</p>
                <pre className="whitespace-pre-wrap text-xs">{err}</pre>
              </div>
            ) : mock.atomics.length === 0 ? (
              <div className="flex items-center justify-center h-full text-muted-foreground text-sm p-6 text-center">
                未从脚本中解析到聚合指标（SUM/COUNT/AVG/MIN/MAX）
              </div>
            ) : tab === 'atomic' ? (
              <div className="p-3 space-y-1.5">
                {mock.atomics.map(a => (
                  <button key={a.name} onClick={() => setSelected(a.name)}
                    className={cn('w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg border bg-card hover:border-sky-400/50 transition-colors text-left',
                      selected === a.name && 'border-sky-500/60 ring-1 ring-sky-500/30')}>
                    <FunctionSquare className="h-4 w-4 shrink-0 text-sky-500" />
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-medium truncate">{a.name}</div>
                      <div className="text-[10px] text-muted-foreground">来源: {a.sourceTable || scriptName.replace(/\.HQL$/i, '')}</div>
                    </div>
                    <Badge className="text-[10px] bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-400 shrink-0">{a.agg}</Badge>
                  </button>
                ))}
              </div>
            ) : tab === 'qualifier' ? (
              <div className="p-3 space-y-1.5">
                {mock.qualifiers.map(q => (
                  <button key={q.name} onClick={() => setSelected(q.name)}
                    className={cn('w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg border bg-card hover:border-amber-400/50 transition-colors text-left',
                      selected === q.name && 'border-amber-500/60 ring-1 ring-amber-500/30')}>
                    <Filter className="h-4 w-4 shrink-0 text-amber-500" />
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-medium truncate">{q.name}</div>
                      <div className="text-[10px] font-mono text-amber-600 dark:text-amber-400 truncate">{q.expr}</div>
                    </div>
                    <Badge variant="outline" className="text-[10px] shrink-0">field: {q.field}</Badge>
                  </button>
                ))}
              </div>
            ) : tab === 'period' ? (
              <div className="p-3 space-y-1.5">
                {mock.periods.map(p => (
                  <button key={p.name} onClick={() => setSelected(p.name)}
                    className={cn('w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg border bg-card hover:border-violet-400/50 transition-colors text-left',
                      selected === p.name && 'border-violet-500/60 ring-1 ring-violet-500/30')}>
                    <Clock className="h-4 w-4 shrink-0 text-violet-500" />
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-medium truncate">{p.name}</div>
                      <div className="text-[10px] font-mono text-violet-600 dark:text-violet-400 truncate">{p.expr}</div>
                    </div>
                    <Badge className="text-[10px] bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-400 shrink-0">{p.label}</Badge>
                  </button>
                ))}
              </div>
            ) : tab === 'dimension' ? (
              <div className="p-3 space-y-1.5">
                {mock.dimensions.map(d => (
                  <button key={d.name} onClick={() => setSelected(d.name)}
                    className={cn('w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg border bg-card hover:border-purple-400/50 transition-colors text-left',
                      selected === d.name && 'border-purple-500/60 ring-1 ring-purple-500/30')}>
                    <Grid3x3 className="h-4 w-4 shrink-0 text-purple-500" />
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-medium truncate">{d.name}</div>
                      <div className="text-[10px] text-muted-foreground">{d.desc}</div>
                    </div>
                    <Badge className="text-[10px] bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-400 shrink-0">{d.type}</Badge>
                  </button>
                ))}
              </div>
            ) : (
              <div className="p-3 space-y-1.5">
                {mock.derived.map(d => (
                  <button key={d.name} onClick={() => setSelected(d.name)}
                    className={cn('w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg border bg-card hover:border-emerald-400/50 transition-colors text-left',
                      selected === d.name && 'border-emerald-500/60 ring-1 ring-emerald-500/30')}>
                    <Layers className="h-4 w-4 shrink-0 text-emerald-500" />
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-medium truncate">{d.name}</div>
                      <div className="flex items-center gap-1 text-[10px] text-muted-foreground mt-0.5">
                        <span className="font-mono text-sky-600 dark:text-sky-400">{d.atomic}</span>
                        <ArrowRight className="h-2.5 w-2.5" />
                        {d.qualifiers.map((q, i) => (
                          <span key={i} className="px-1 py-0.5 rounded bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400 font-mono">{q}</span>
                        ))}
                        <span className="px-1 py-0.5 rounded bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-400 font-mono">{d.periodExpr}</span>
                      </div>
                    </div>
                    <Badge className="text-[10px] bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400 shrink-0">{d.gran}</Badge>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Right detail panel */}
          <div className="w-80 border-l flex flex-col shrink-0">
            <div className="px-3 py-1.5 border-b bg-muted/20 text-[10px] font-semibold text-muted-foreground">指标详情</div>
            <div className="flex-1 overflow-auto p-3">
              {selected ? (
                <DetailPanel tab={tab} selected={selected} mock={mock} />
              ) : (
                <div className="flex items-center justify-center h-full text-muted-foreground text-xs text-center p-4">
                  选择左侧指标查看表达式与完整 SQL
                </div>
              )}
            </div>
          </div>

          {/* AI extract panel — only appears once AI extract is triggered */}
          {(aiLoading || aiErr || aiResult !== null) && (
          <div className="w-80 border-l flex flex-col shrink-0">
            <div className="flex items-center gap-1.5 px-3 py-1.5 border-b bg-muted/20 text-[10px] font-semibold text-muted-foreground">
              <Sparkles className="h-3 w-3 text-primary" />
              AI 提取结果
              {aiResult !== null && (
                <span className="text-[10px] bg-primary/10 text-primary px-1.5 py-0.5 rounded-full">
                  {aiResult.atomics.length + aiResult.qualifiers.length + aiResult.periods.length
                    + aiResult.dimensions.length + aiResult.derived.length} 项
                </span>
              )}
            </div>
            <div className="flex-1 overflow-auto p-2.5 space-y-2">
              {aiLoading ? (
                <div className="flex items-center justify-center h-full text-muted-foreground text-xs text-center p-4">
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  AI 提取中...（依赖 LLM 响应，请稍候）
                </div>
              ) : aiErr ? (
                <div className="text-xs text-destructive">
                  <p className="font-medium mb-1">AI 提取失败</p>
                  <pre className="whitespace-pre-wrap text-[10px]">{aiErr}</pre>
                </div>
              ) : aiResult !== null ? (
                <>
                  <AiSection title="原子指标" count={aiResult.atomics.length}
                    open={aiOpen.atomics ?? true}
                    onToggle={() => setAiOpen(v => ({ ...v, atomics: !(v.atomics ?? true) }))}>
                    <AiAtomicsList metrics={aiResult} />
                  </AiSection>
                  <AiSection title="业务限定" count={aiResult.qualifiers.length}
                    open={aiOpen.qualifiers ?? true}
                    onToggle={() => setAiOpen(v => ({ ...v, qualifiers: !(v.qualifiers ?? true) }))}>
                    <AiQualifiersList metrics={aiResult} />
                  </AiSection>
                  <AiSection title="周期限定" count={aiResult.periods.length}
                    open={aiOpen.periods ?? true}
                    onToggle={() => setAiOpen(v => ({ ...v, periods: !(v.periods ?? true) }))}>
                    <AiPeriodsList metrics={aiResult} />
                  </AiSection>
                  <AiSection title="维度" count={aiResult.dimensions.length}
                    open={aiOpen.dimensions ?? true}
                    onToggle={() => setAiOpen(v => ({ ...v, dimensions: !(v.dimensions ?? true) }))}>
                    <AiDimensionsList metrics={aiResult} />
                  </AiSection>
                  <AiSection title="派生指标" count={aiResult.derived.length}
                    open={aiOpen.derived ?? true}
                    onToggle={() => setAiOpen(v => ({ ...v, derived: !(v.derived ?? true) }))}>
                    <AiDerivedList metrics={aiResult} />
                  </AiSection>
                </>
              ) : (
                <div className="flex items-center justify-center h-full text-muted-foreground text-xs text-center p-4">
                  点击「AI 提取」生成指标体系
                </div>
              )}
            </div>
          </div>
          )}
        </div>

        {/* ===== Bottom: full SQL script ===== */}
        {sqlContent && (
          <div className="border-t shrink-0 flex flex-col">
            <button onClick={() => setShowSql(v => !v)}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-muted/20 hover:bg-muted/40 text-[11px] font-medium text-muted-foreground transition-colors">
              <FileCode2 className="h-3.5 w-3.5" />
              完整脚本 SQL
              <span className="text-[10px] text-muted-foreground/70">（{sqlContent.split('\n').length} 行）</span>
              <span className="ml-auto">{showSql ? '收起 ▲' : '展开 ▼'}</span>
            </button>
            {showSql && (
              <div className="shrink-0 border-t">
                <SqlView
                  value={sqlContent}
                  editable={false}
                  lineWrapping
                  className="h-56"
                />
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function DetailPanel({ tab, selected, mock }: {
  tab: 'atomic' | 'qualifier' | 'period' | 'dimension' | 'derived';
  selected: string;
  mock: { atomics: MockAtomic[]; qualifiers: MockQualifier[]; periods: MockPeriod[]; dimensions: MockDimension[]; derived: MockDerived[] };
}) {
  if (tab === 'atomic') {
    const a = mock.atomics.find(x => x.name === selected);
    if (!a) return null;
    return (
      <div className="space-y-3">
        <DetailRow k="指标名" v={a.name} />
        <DetailRow k="聚合函数" v={a.agg} mono />
        <DetailRow k="来源字段" v={a.column} mono />
        <DetailRow k="表达式" v={a.expr} mono code />
        <div>
          <div className="text-[9px] uppercase text-muted-foreground mb-1">完整 SQL</div>
          <pre className="text-[10px] font-mono bg-muted rounded p-2 overflow-auto whitespace-pre-wrap">{`SELECT\n  ${a.expr} AS ${a.name}\nFROM <源表>`}</pre>
        </div>
      </div>
    );
  }
  if (tab === 'qualifier') {
    const q = mock.qualifiers.find(x => x.name === selected);
    if (!q) return null;
    return (
      <div className="space-y-3">
        <DetailRow k="限定名" v={q.name} />
        <DetailRow k="条件字段" v={q.field} mono />
        <DetailRow k="条件表达式" v={q.expr} mono code />
        <div>
          <div className="text-[9px] uppercase text-muted-foreground mb-1">WHERE 片段</div>
          <pre className="text-[10px] font-mono bg-muted rounded p-2 overflow-auto whitespace-pre-wrap">{`WHERE ${q.expr}`}</pre>
        </div>
      </div>
    );
  }
  if (tab === 'period') {
    const p = mock.periods.find(x => x.name === selected);
    if (!p) return null;
    return (
      <div className="space-y-3">
        <DetailRow k="周期限定" v={p.name} />
        <DetailRow k="时间单位" v={p.unit} mono />
        <DetailRow k="周期标签" v={p.label} />
        <DetailRow k="周期表达式" v={p.expr} mono code />
        <div>
          <div className="text-[9px] uppercase text-muted-foreground mb-1">WHERE 片段</div>
          <pre className="text-[10px] font-mono bg-muted rounded p-2 overflow-auto whitespace-pre-wrap">{`WHERE ${p.expr}`}</pre>
        </div>
      </div>
    );
  }
  if (tab === 'dimension') {
    const d = mock.dimensions.find(x => x.name === selected);
    if (!d) return null;
    return (
      <div className="space-y-3">
        <DetailRow k="维度" v={d.name} />
        <DetailRow k="类型" v={d.type} mono />
        <DetailRow k="说明" v={d.desc} />
        <div>
          <div className="text-[9px] uppercase text-muted-foreground mb-1">GROUP BY 片段</div>
          <pre className="text-[10px] font-mono bg-muted rounded p-2 overflow-auto whitespace-pre-wrap">{`GROUP BY ${d.name}`}</pre>
        </div>
      </div>
    );
  }
  const d = mock.derived.find(x => x.name === selected);
  if (!d) return null;
  return (
    <div className="space-y-3">
      <DetailRow k="派生指标" v={d.name} />
      <DetailRow k="原子指标" v={d.atomic} mono />
      <DetailRow k="业务限定" v={d.qualifiers.join(' AND ')} mono />
      <DetailRow k="周期限定" v={d.periodExpr} mono />
      <DetailRow k="统计粒度" v={d.gran} />
      <DetailRow k="时间周期" v={d.period} mono />
      <div>
        <div className="text-[9px] uppercase text-muted-foreground mb-1">完整 SQL</div>
        <pre className="text-[10px] font-mono bg-muted rounded p-2 overflow-auto whitespace-pre-wrap">{`SELECT\n  ${d.gran.split('·')[1] ?? 'dt'},\n  ${d.atomic} AS ${d.name}\nFROM <源表>\nWHERE ${d.qualifiers.join(' AND ')}\n  AND ${d.periodExpr}\nGROUP BY ${d.gran.split('·')[1] ?? 'dt'}`}</pre>
      </div>
    </div>
  );
}

function DetailRow({ k, v, mono, code }: { k: string; v: string; mono?: boolean; code?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[9px] uppercase text-muted-foreground">{k}</span>
      {code ? (
        <pre className="text-[10px] font-mono bg-muted rounded px-1.5 py-1 whitespace-pre-wrap break-all">{v}</pre>
      ) : (
        <div className={cn('text-[11px] break-all', mono && 'font-mono bg-muted rounded px-1.5 py-1')}>{v}</div>
      )}
    </div>
  );
}