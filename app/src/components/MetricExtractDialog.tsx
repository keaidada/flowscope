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

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  FunctionSquare, Filter, Layers, Sparkles, Check, Copy, ArrowRight,
  RefreshCw, Loader2, FileCode2, Clock,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';

interface MetricExtractDialogProps {
  open: boolean;
  onClose: () => void;
  filePath: string;
  sqlContent?: string;
}

// ── Mock data generators (deterministic by file name) ───────────

interface MockAtomic {
  name: string;
  expr: string;
  agg: string;
  column: string;
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

function seedFromPath(fp: string): number {
  let h = 0;
  for (let i = 0; i < fp.length; i++) h = (h * 31 + fp.charCodeAt(i)) >>> 0;
  return h;
}

// Standard time periods (周期限定): name / SQL condition / unit / label
const PERIOD_POOL: MockPeriod[] = [
  { name: '昨日', expr: `data_dt = date_sub('${'${bizdate}'}', 1)`, unit: 'daily', label: '按日' },
  { name: '近7日', expr: `data_dt >= date_sub('${'${bizdate}'}', 7)`, unit: 'rolling_7d', label: '近7日' },
  { name: '近30日', expr: `data_dt >= date_sub('${'${bizdate}'}', 30)`, unit: 'rolling_30d', label: '近30日' },
  { name: '本月', expr: `data_dt >= trunc('${'${bizdate}'}', 'MM')`, unit: 'monthly', label: '按月' },
  { name: '自然周', expr: `data_dt >= date_sub('${'${bizdate}'}', 6)`, unit: 'weekly', label: '按周' },
  { name: '累计', expr: `data_dt <= '${'${bizdate}'}'`, unit: 'cumulative', label: '累计' },
];

function buildMock(fp: string): { atomics: MockAtomic[]; qualifiers: MockQualifier[]; periods: MockPeriod[]; derived: MockDerived[] } {
  const s = seedFromPath(fp);
  const cols = ['usr_id', 'vid', 'play_duration', 'dau', 'vv', 'pv', 'pay_amount', 'order_cnt', 'actv_time', 'exp_uv'];
  const aggFns = ['sum', 'count', 'count_distinct', 'avg', 'max', 'min'];
  const qualFields = ['video_side', 'video_ctgy', 'channel_id', 'app_id', 'is_vip', 'source'];

  // 4-6 atomic metrics
  const atomicCount = 4 + (s % 3);
  const atomics: MockAtomic[] = [];
  for (let i = 0; i < atomicCount; i++) {
    const agg = aggFns[(s + i) % aggFns.length];
    const col = cols[(s + i * 3) % cols.length];
    const distinct = agg === 'count' && (s + i) % 3 === 0 ? 'distinct ' : '';
    atomics.push({
      name: `${agg}${distinct ? '_distinct' : ''}_${col}`,
      expr: `${agg}(${distinct}${col})`,
      agg,
      column: col,
    });
  }

  // 3-4 qualifiers
  const qCount = 3 + (s % 2);
  const qualifiers: MockQualifier[] = [];
  for (let i = 0; i < qCount; i++) {
    const field = qualFields[(s + i) % qualFields.length];
    const val = `'${['APP', '端内', '端外', 'OLYL', 'VIDE', '1080', '1'][(s + i) % 7]}'`;
    qualifiers.push({
      name: `${field}_${val.replace(/'/g, '')}`,
      expr: `${field} = ${val}`,
      field,
    });
  }

  // 3-4 period qualifiers (deterministic subset of PERIOD_POOL)
  const pCount = 3 + (s % 2);
  const periods: MockPeriod[] = [];
  for (let i = 0; i < pCount; i++) {
    const p = PERIOD_POOL[(s + i) % PERIOD_POOL.length];
    if (!periods.some(x => x.name === p.name)) periods.push(p);
  }

  // derived = atomics × qualifiers × period (subset)
  const derived: MockDerived[] = [];
  for (let i = 0; i < Math.min(6, atomics.length); i++) {
    const a = atomics[(i + 1) % atomics.length];
    const q = qualifiers[i % qualifiers.length];
    const p = periods[i % periods.length];
    const gran = ['video_side', 'video_ctgy', 'channel_id', 'usr_id'][i % 4];
    derived.push({
      name: `${a.name}_${p.name}_${q.field}`,
      atomic: a.expr,
      qualifiers: [q.expr],
      period: p.unit,
      periodExpr: p.expr,
      gran: `${p.label}·${gran}`,
    });
  }

  return { atomics, qualifiers, periods, derived };
}

export function MetricExtractDialog({ open, onClose, filePath, sqlContent }: MetricExtractDialogProps) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'atomic' | 'qualifier' | 'period' | 'derived'>('atomic');
  const [selected, setSelected] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [showSql, setShowSql] = useState(false);

  // Deterministic mock data for this file.
  const mock = open ? buildMock(filePath) : { atomics: [], qualifiers: [], periods: [], derived: [] };
  const scriptName = filePath.split('/').pop() || filePath;

  useEffect(() => {
    if (open) {
      setLoading(true);
      setTab('atomic');
      setSelected(null);
      const timer = setTimeout(() => setLoading(false), 400);
      return () => clearTimeout(timer);
    }
  }, [open, filePath]);

  const totalAtomic = mock.atomics.length;
  const totalQualifier = mock.qualifiers.length;
  const totalPeriod = mock.periods.length;
  const totalDerived = mock.derived.length;

  const handleCopy = () => {
    const lines = tab === 'atomic'
      ? mock.atomics.map(a => `-- ${a.name}\n--   ${a.expr}`).join('\n')
      : tab === 'qualifier'
        ? mock.qualifiers.map(q => `-- ${q.name}: ${q.expr}`).join('\n')
        : tab === 'period'
          ? mock.periods.map(p => `-- ${p.name}: ${p.expr}`).join('\n')
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
              <Sparkles className="h-3.5 w-3.5 text-sky-500" />
            </div>
            <DialogTitle>{t('editor.extractMetrics', '提取指标')}</DialogTitle>
            <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded-full">
              {totalAtomic} 原子 · {totalQualifier} 限定 · {totalPeriod} 周期 · {totalDerived} 派生
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
            <Button size="sm" variant="ghost" className="h-7 text-[11px]" onClick={() => { setLoading(true); setTimeout(() => setLoading(false), 400); }}>
              <RefreshCw className="h-3 w-3 mr-1" />重新提取
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
                <Loader2 className="h-5 w-5 mr-2 animate-spin" />{t('editor.generating', '生成中...')}
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
                      <div className="text-[10px] text-muted-foreground">来源: {scriptName.replace(/\.HQL$/i, '')}</div>
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
              <div className="h-56 shrink-0 overflow-auto bg-background">
                <pre className="text-[11px] font-mono p-3 leading-relaxed whitespace-pre">
                  {highlightSql(sqlContent)}
                </pre>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function DetailPanel({ tab, selected, mock }: {
  tab: 'atomic' | 'qualifier' | 'period' | 'derived';
  selected: string;
  mock: { atomics: MockAtomic[]; qualifiers: MockQualifier[]; periods: MockPeriod[]; derived: MockDerived[] };
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

// ── Lightweight SQL syntax highlighter (keyword / comment / string / number) ──
const SQL_KEYWORDS = new Set([
  'select', 'from', 'where', 'insert', 'into', 'overwrite', 'table', 'partition',
  'create', 'temporary', 'as', 'join', 'left', 'right', 'inner', 'full', 'on',
  'group', 'by', 'order', 'having', 'limit', 'union', 'all', 'distinct', 'case',
  'when', 'then', 'else', 'end', 'and', 'or', 'not', 'in', 'is', 'null', 'between',
  'like', 'if', 'elseif', 'for', 'while', 'return', 'set', 'declare', 'begin',
  'select', 'sum', 'count', 'avg', 'max', 'min', 'coalesce', 'nvl', 'date_sub',
  'date_add', 'from_unixtime', 'unix_timestamp', 'split', 'substr', 'concat',
  'round', 'trunc', 'row_number', 'over', 'partition', 'rank', 'dense_rank',
]);

function highlightSql(sql: string): React.ReactNode[] {
  const lines = sql.split('\n');
  const out: React.ReactNode[] = [];
  let inBlock = false;

  lines.forEach((line, li) => {
    const nodes: React.ReactNode[] = [];
    let i = 0;
    while (i < line.length) {
      const ch = line[i];
      const rest = line.slice(i);

      // block comment /* ... */
      if (!inBlock && rest.startsWith('/*')) { inBlock = true; nodes.push(<span key={i} className="text-muted-foreground/70 italic">{'/*'}</span>); i += 2; continue; }
      if (inBlock) {
        const end = rest.indexOf('*/');
        if (end >= 0) { nodes.push(<span key={i} className="text-muted-foreground/70 italic">{rest.slice(0, end + 2)}</span>); i += end + 2; inBlock = false; }
        else { nodes.push(<span key={i} className="text-muted-foreground/70 italic">{rest}</span>); i = line.length; }
        continue;
      }
      // line comment --
      if (rest.startsWith('--')) { nodes.push(<span key={i} className="text-emerald-600/70 dark:text-emerald-500/70 italic">{rest}</span>); i = line.length; continue; }
      // string literal
      if (ch === "'" || ch === '"' || ch === '`') {
        const quote = ch;
        let j = i + 1;
        while (j < line.length && line[j] !== quote) j++;
        if (j < line.length) j++;
        nodes.push(<span key={i} className="text-orange-600 dark:text-orange-400">{line.slice(i, j)}</span>);
        i = j; continue;
      }
      // identifier / keyword / number
      if (/[a-zA-Z_]/.test(ch)) {
        let j = i;
        while (j < line.length && /[a-zA-Z0-9_$]/.test(line[j])) j++;
        const word = line.slice(i, j);
        const lower = word.toLowerCase();
        if (SQL_KEYWORDS.has(lower)) {
          nodes.push(<span key={i} className="text-blue-600 font-medium dark:text-blue-400">{word}</span>);
        } else {
          nodes.push(<span key={i}>{word}</span>);
        }
        i = j; continue;
      }
      // number
      if (/[0-9]/.test(ch)) {
        let j = i;
        while (j < line.length && /[0-9.]/.test(line[j])) j++;
        nodes.push(<span key={i} className="text-purple-600 dark:text-purple-400">{line.slice(i, j)}</span>);
        i = j; continue;
      }
      // template var ${...}
      if (ch === '$' && line[i + 1] === '{') {
        const end = line.indexOf('}', i);
        if (end >= 0) { nodes.push(<span key={i} className="text-pink-600 dark:text-pink-400">{line.slice(i, end + 1)}</span>); i = end + 1; continue; }
      }
      // punctuation / space
      nodes.push(<span key={i}>{ch}</span>);
      i++;
    }
    out.push(<div key={li}>{nodes}</div>);
  });
  return out;
}
