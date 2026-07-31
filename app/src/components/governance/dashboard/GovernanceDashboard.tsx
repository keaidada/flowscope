/**
 * GovernanceDashboard — health score ring + dimension cards + grouped violations.
 * Fills full available space, scrolls internally.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  RefreshCw, Download, AlertCircle, ChevronDown, ChevronRight,
  Activity, Shield, Code2, Database, Lock, Boxes, Clock,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import type { useGovernanceData } from '@/hooks/useGovernanceData';
import type { ContractViolation, Severity } from '@/lib/governance-api';
import { governanceApi } from '@/lib/governance-api';

interface DashboardProps {
  gov: ReturnType<typeof useGovernanceData>;
  projectId: string | null;
}

export function GovernanceDashboard({ gov, projectId }: DashboardProps) {
  const { t } = useTranslation();
  const { report, scanning, error, scan } = gov;

  const handleExport = async (format: 'html' | 'json') => {
    if (!projectId) return;
    try {
      const blob = await governanceApi.exportReport(projectId, format);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `governance-report.${format}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) { console.error('Export failed:', e); }
  };

  if (!projectId) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
        <Database className="h-10 w-10 opacity-30" />
        <p className="text-sm">{t('governance.selectProject')}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Action bar */}
      <div className="flex items-center gap-2 px-4 py-2 border-b shrink-0">
        <div className="flex gap-1.5 ml-auto">
          <Button variant="outline" size="sm" onClick={() => handleExport('html')} disabled={!report} className="h-7 text-xs rounded-md">
            <Download className="h-3 w-3 mr-1" />{t('governance.export')}
          </Button>
          <Button size="sm" onClick={() => scan()} disabled={scanning} className="h-7 text-xs rounded-md">
            <RefreshCw className={cn('h-3 w-3 mr-1', scanning && 'animate-spin')} />
            {scanning ? t('governance.scanning') : t('governance.rescan')}
          </Button>
        </div>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-auto p-4">
        {error && (
          <div className="flex items-center gap-2 p-3 mb-4 bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900 rounded-xl text-sm text-red-700 dark:text-red-400">
            <AlertCircle className="h-4 w-4 shrink-0" />{error}
          </div>
        )}

        {!report ? (
          <EmptyState onScan={() => scan()} scanning={scanning} />
        ) : (
          <div className="space-y-4">
            {/* Score row: ring + dimensions side by side */}
            <div className="flex items-center gap-6 p-4 rounded-xl border bg-card">
              <ScoreRing score={report.health_score} />
              <div className="flex-1 min-w-0">
                {/* Severity pills */}
                <div className="flex gap-2 mb-3">
                  <SeverityPill label="P0" count={report.summary.p0_count} className="bg-red-500/10 text-red-600 dark:text-red-400" />
                  <SeverityPill label="P1" count={report.summary.p1_count} className="bg-amber-500/10 text-amber-600 dark:text-amber-400" />
                  <SeverityPill label="P2" count={report.summary.p2_count} className="bg-blue-500/10 text-blue-600 dark:text-blue-400" />
                </div>
                {/* Dimension bars */}
                <div className="grid grid-cols-5 gap-2">
                  {[
                    { key: 'storage', icon: Database, label: t('governance.dim.storage') },
                    { key: 'compute', icon: Activity, label: t('governance.dim.compute') },
                    { key: 'dev', icon: Code2, label: t('governance.dim.dev') },
                    { key: 'security', icon: Lock, label: t('governance.dim.security') },
                    { key: 'modeling', icon: Boxes, label: t('governance.dim.modeling') },
                  ].map(({ key, icon: Icon, label }) => {
                    const val = report.dimension_scores[key] ?? 100;
                    const color = val >= 80 ? '#10b981' : val >= 60 ? '#f59e0b' : '#ef4444';
                    return (
                      <div key={key} className="flex flex-col items-center gap-1 p-2 rounded-lg bg-muted/30">
                        <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className="text-[10px] text-muted-foreground text-center leading-tight">{label}</span>
                        <span className="text-base font-bold tabular-nums" style={{ color }}>{val}</span>
                        <div className="w-full h-1 bg-muted rounded-full overflow-hidden">
                          <div className="h-full rounded-full transition-all duration-500" style={{ width: `${val}%`, background: color }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Violations */}
            {report.violations.length > 0 && (
              <ViolationGroups violations={report.violations} />
            )}

            {/* Pending runtime */}
            {report.pending_runtime.length > 0 && (
              <div className="space-y-1.5">
                <h3 className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5 uppercase tracking-wide">
                  <Clock className="h-3.5 w-3.5" />
                  {t('governance.pendingRuntime')} ({report.pending_runtime.length})
                </h3>
                {report.pending_runtime.map((p, i) => (
                  <div key={i} className="flex items-center gap-2 p-2 bg-muted/40 rounded-lg text-xs">
                    <span className="px-1.5 py-0.5 bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-400 rounded font-mono">{p.check_type}</span>
                    <span className="text-muted-foreground">{p.description}</span>
                    <span className="ml-auto text-muted-foreground/50">Tier 3</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ScoreRing({ score }: { score: number }) {
  const { t } = useTranslation();
  const r = 44;
  const c = 2 * Math.PI * r;
  const offset = c - (score / 100) * c;
  const color = score >= 80 ? '#10b981' : score >= 60 ? '#f59e0b' : '#ef4444';

  return (
    <div className="relative w-24 h-24 shrink-0">
      <svg className="w-full h-full -rotate-90" viewBox="0 0 104 104">
        <circle cx="52" cy="52" r={r} fill="none" stroke="currentColor" strokeWidth="7" className="text-muted/20" />
        <circle cx="52" cy="52" r={r} fill="none" stroke={color} strokeWidth="7" strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={offset} className="transition-all duration-700" />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-3xl font-bold tabular-nums leading-none" style={{ color }}>{score}</span>
        <span className="text-[8px] text-muted-foreground mt-0.5">{t('governance.healthScore')}</span>
      </div>
    </div>
  );
}

function SeverityPill({ label, count, className }: { label: string; count: number; className: string }) {
  return (
    <div className={cn('flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold', className)}>
      {label}<span className="tabular-nums">{count}</span>
    </div>
  );
}

function ViolationGroups({ violations }: { violations: ContractViolation[] }) {
  const { t } = useTranslation();
  const sevList: Severity[] = ['P0', 'P1', 'P2'];
  const groups = sevList.map(s => ({ severity: s, items: violations.filter(v => v.severity === s) })).filter(g => g.items.length > 0);

  return (
    <div className="space-y-2">
      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
        <AlertCircle className="h-3.5 w-3.5" />
        {t('governance.violations')} ({violations.length})
      </h3>
      {groups.map(g => <ViolationSection key={g.severity} severity={g.severity} items={g.items} />)}
    </div>
  );
}

function ViolationSection({ severity, items }: { severity: Severity; items: ContractViolation[] }) {
  const [groupOpen, setGroupOpen] = useState(severity === 'P0');
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
  const styles: Record<Severity, { dot: string; text: string; bg: string; border: string }> = {
    P0: { dot: 'bg-red-500', text: 'text-red-600 dark:text-red-400', bg: 'bg-red-500/5', border: 'border-red-500/20' },
    P1: { dot: 'bg-amber-500', text: 'text-amber-600 dark:text-amber-400', bg: 'bg-amber-500/5', border: 'border-amber-500/20' },
    P2: { dot: 'bg-blue-500', text: 'text-blue-600 dark:text-blue-400', bg: 'bg-blue-500/5', border: 'border-blue-500/20' },
  };
  const s = styles[severity];

  return (
    <div className={cn('rounded-xl border overflow-hidden', s.bg, s.border)}>
      <button onClick={() => setGroupOpen(!groupOpen)} className="w-full flex items-center gap-2 px-3 py-2 hover:bg-accent/30 transition-colors">
        {groupOpen ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
        <span className={cn('w-2 h-2 rounded-full', s.dot)} />
        <span className={cn('text-sm font-bold', s.text)}>{severity}</span>
        <span className="text-xs text-muted-foreground">· {items.length} issues</span>
      </button>
      {groupOpen && (
        <div className="divide-y divide-border/50">
          {items.map((v, i) => {
            const isExpanded = expandedIdx === i;
            return (
              <div key={i}>
                <button
                  onClick={() => setExpandedIdx(isExpanded ? null : i)}
                  className="w-full flex items-start gap-3 px-3 py-2 pl-9 hover:bg-accent/20 transition-colors text-left"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium leading-snug">{v.title}</div>
                    <div className="flex items-center gap-1.5 mt-0.5 text-xs text-muted-foreground">
                      <code className="px-1 py-0.5 bg-muted rounded font-mono text-[10px]">{v.rule_id}</code>
                      <span>·</span><span>{v.rule_section}</span>
                      {v.file_paths.length > 0 && (<><span>·</span><span className="truncate">{v.file_paths.join(', ')}</span></>)}
                    </div>
                  </div>
                  <ChevronRight className={cn('h-3.5 w-3.5 mt-0.5 text-muted-foreground shrink-0 transition-transform', isExpanded && 'rotate-90')} />
                </button>
                {isExpanded && (
                  <div className="px-3 py-3 pl-9 bg-background/50 border-t space-y-3">
                    <ViolationInterpretation v={v} />
                    <ViolationDetail detail={v.detail} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Plain-language explanation of what this violation means. */
function ViolationInterpretation({ v }: { v: ContractViolation }) {
  const d = v.detail || {};
  const scripts = (Array.isArray(d.scripts) ? d.scripts as string[] : []).filter(Boolean);
  const tables = (Array.isArray(d.orphan_tables) ? d.orphan_tables as unknown[] : [])
    .concat(Array.isArray(d.table) ? [String(d.table)] : d.table ? [String(d.table)] : [] as string[])
    .filter(Boolean);
  const files = (Array.isArray(d.file) ? d.file as string[] : d.file ? [String(d.file)] : [])
    .concat(scripts).filter((f, i, a) => a.indexOf(f) === i);

  switch (v.rule_id) {
    case 'no_duplicate_computation': {
      const sim = typeof d.similarity === 'number' ? d.similarity : 1;
      const sqlMap = (d.script_sqls as Record<string, string>) || {};
      const scriptList = scripts.filter(s => sqlMap[s]);
      return (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-foreground">
            {sim >= 1
              ? `${scripts.length} 个脚本计算逻辑完全相同`
              : `${scripts.length} 个脚本计算逻辑相似（${Math.round(sim * 100)}%）`}
          </p>
          {scriptList.length >= 2 ? (
            <div className="grid grid-cols-2 gap-2">
              {scriptList.slice(0, 2).map((script, idx) => (
                <div key={idx} className="rounded border overflow-hidden">
                  <div className="px-2 py-1 bg-muted/50 border-b text-[11px] font-mono font-semibold truncate">
                    {sim >= 1 ? (idx === 0 ? '脚本 A' : '脚本 B') : '▶'} {script}
                  </div>
                  <pre className="p-2 text-[11px] font-mono whitespace-pre-wrap break-all max-h-48 overflow-auto leading-relaxed text-foreground/80">
                    {sqlMap[script] || '(content not available)'}
                  </pre>
                </div>
              ))}
              {scriptList.length > 2 && (
                <div className="col-span-2 text-[11px] text-muted-foreground">
                  + {scriptList.length - 2} more scripts
                </div>
              )}
            </div>
          ) : (
            <ul className="text-xs space-y-0.5 mt-1">
              {scripts.map((s, i) => <li key={i} className="font-mono text-[11px] pl-3 border-l-2 border-amber-300">▸ {s}</li>)}
            </ul>
          )}
        </div>
      );
    }
    case 'no_write_conflict':
      return (
        <div className="space-y-1">
          <p className="text-xs font-semibold text-foreground">{scripts.length} 个脚本写入同一个表</p>
          <p className="text-xs text-muted-foreground">
            {tables.join(', ')} 被 {scripts.length} 个不同的脚本写入，可能导致数据覆盖或不一致。
          </p>
          {scripts.length > 0 && (
            <ul className="text-xs space-y-0.5 mt-1">
              {scripts.map((s, i) => <li key={i} className="font-mono text-[11px] pl-3 border-l-2 border-amber-300">▸ {s}</li>)}
            </ul>
          )}
        </div>
      );
    case 'no_orphan_output':
      return (
        <div className="space-y-1">
          <p className="text-xs font-semibold text-foreground">{tables.length} 个表没有下游消费</p>
          <p className="text-xs text-muted-foreground">这些表被写入但没有任何脚本读取，可能是废弃的 ETL 产出。</p>
        </div>
      );
    case 'lineage_completeness':
      return (
        <div className="space-y-1">
          <p className="text-xs font-semibold text-foreground">文件缺少血缘关系</p>
          <p className="text-xs text-muted-foreground">
            {files.join(', ')} 包含表操作但在 table_level_edges 中没有对应的血缘记录。
          </p>
        </div>
      );
    case 'no_hardcoded_secrets':
      return (
        <div className="space-y-1">
          <p className="text-xs font-semibold text-foreground">SQL 中疑似硬编码敏感信息</p>
          <p className="text-xs text-muted-foreground">
            {files.join(', ')} 匹配了敏感模式 "{String(d.pattern ?? 'N/A')}"。请改用环境变量或密钥管理服务。
          </p>
        </div>
      );
    case 'no_select_star':
      return (
        <div className="space-y-1">
          <p className="text-xs font-semibold text-foreground">使用了 SELECT *</p>
          <p className="text-xs text-muted-foreground">{files.join(', ')} 中使用了 SELECT *，应显式指定列名。</p>
        </div>
      );
    case 'max_complexity':
      return (
        <div className="space-y-1">
          <p className="text-xs font-semibold text-foreground">复杂度超标</p>
          <p className="text-xs text-muted-foreground">
            {files.join(', ')} 的复杂度 ({String(d.complexity_score ?? '?')}) 超过阈值 ({String(d.threshold ?? '?')})。建议拆分或简化查询。
          </p>
        </div>
      );
    default:
      return null;
  }
}

/** Show key-value details — clean format, skip interpreted fields. */
function ViolationDetail({ detail }: { detail: Record<string, unknown> }) {
  const skipKeys = new Set(['scripts', 'file', 'orphan_tables', 'table', 'threshold', 'complexity_score', 'pattern', 'similarity', 'script_sqls']);
  const entries = Object.entries(detail).filter(([k, v]) => v != null && !skipKeys.has(k));
  if (entries.length === 0) return null;

  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-muted-foreground hover:text-foreground select-none">Technical details</summary>
      <div className="mt-1.5 space-y-1.5">
        {entries.map(([key, val]) => {
          const str = Array.isArray(val) ? (val as unknown[]).join(', ') : typeof val === 'object' ? JSON.stringify(val) : String(val);
          const isCode = key === 'normalized_sql' || key === 'hash' || str.length > 100;
          return (
            <div key={key}>
              <span className="text-muted-foreground">{key}</span>
              {isCode ? (
                <pre className="mt-0.5 p-1.5 bg-muted/50 rounded text-[10px] font-mono whitespace-pre-wrap break-all max-h-24 overflow-auto text-foreground/70">
                  {str}
                </pre>
              ) : (
                <span className="ml-1.5 font-mono text-[11px] break-all text-foreground/70">{str}</span>
              )}
            </div>
          );
        })}
      </div>
    </details>
  );
}

function EmptyState({ onScan, scanning }: { onScan: () => void; scanning: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center justify-center py-24 gap-4">
      <div className="w-14 h-14 rounded-2xl bg-primary/10 flex items-center justify-center">
        <Shield className="h-7 w-7 text-primary/50" />
      </div>
      <div className="text-center space-y-1">
        <p className="text-sm font-medium">{t('governance.noReport')}</p>
        <p className="text-xs text-muted-foreground">ODCS contracts → SQL lineage evaluation</p>
      </div>
      <Button onClick={onScan} disabled={scanning} size="sm" className="rounded-lg">
        <RefreshCw className={cn('h-3.5 w-3.5 mr-1.5', scanning && 'animate-spin')} />
        {t('governance.runFirstScan')}
      </Button>
    </div>
  );
}
