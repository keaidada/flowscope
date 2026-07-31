/**
 * GovernanceDashboard — redesigned with circular score + dimension cards + grouped violations.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw, Download, AlertCircle, ChevronDown, ChevronRight, Activity, Shield, Code2, Database, Lock, Boxes } from 'lucide-react';
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
    <div className="p-5 space-y-5 max-w-6xl">
      {/* Action bar */}
      <div className="flex items-center gap-2">
        <div className="flex gap-1 ml-auto">
          <Button variant="outline" size="sm" onClick={() => handleExport('html')} disabled={!report} className="rounded-lg">
            <Download className="h-3.5 w-3.5 mr-1.5" />
            {t('governance.export')}
          </Button>
          <Button size="sm" onClick={() => scan()} disabled={scanning} className="rounded-lg">
            <RefreshCw className={cn('h-3.5 w-3.5 mr-1.5', scanning && 'animate-spin')} />
            {scanning ? t('governance.scanning') : t('governance.rescan')}
          </Button>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 p-3 bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900 rounded-xl text-sm text-red-700 dark:text-red-400">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {!report ? (
        <EmptyState onScan={() => scan()} scanning={scanning} />
      ) : (
        <>
          {/* Score + Dimensions row */}
          <div className="grid grid-cols-[auto_1fr] gap-5 items-center">
            <ScoreRing score={report.health_score} />
            <DimensionGrid scores={report.dimension_scores} summary={report.summary} />
          </div>

          {/* Violations */}
          {report.violations.length > 0 && (
            <ViolationGroups violations={report.violations} />
          )}

          {/* Pending runtime */}
          {report.pending_runtime.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-sm font-semibold text-muted-foreground flex items-center gap-1.5">
                <Activity className="h-3.5 w-3.5" />
                {t('governance.pendingRuntime')} ({report.pending_runtime.length})
              </h3>
              {report.pending_runtime.map((p, i) => (
                <div key={i} className="flex items-center gap-2 p-2.5 bg-muted/40 rounded-lg text-sm">
                  <span className="px-2 py-0.5 bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-400 rounded text-xs font-mono">
                    {p.check_type}
                  </span>
                  <span className="text-muted-foreground">{p.description}</span>
                  <span className="ml-auto text-xs text-muted-foreground/60">Tier 3</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Circular progress ring for health score. */
function ScoreRing({ score }: { score: number }) {
  const { t } = useTranslation();
  const radius = 52;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (score / 100) * circumference;
  const color = score >= 80 ? '#10b981' : score >= 60 ? '#f59e0b' : '#ef4444';

  return (
    <div className="relative w-32 h-32 shrink-0">
      <svg className="w-full h-full -rotate-90" viewBox="0 0 120 120">
        <circle cx="60" cy="60" r={radius} fill="none" stroke="currentColor" strokeWidth="8" className="text-muted/30" />
        <circle
          cx="60" cy="60" r={radius} fill="none" stroke={color} strokeWidth="8"
          strokeLinecap="round" strokeDasharray={circumference} strokeDashoffset={offset}
          className="transition-all duration-700"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-4xl font-bold tabular-nums" style={{ color }}>{score}</span>
        <span className="text-[10px] text-muted-foreground mt-0.5">{t('governance.healthScore')}</span>
      </div>
    </div>
  );
}

/** Dimension score cards with icons. */
function DimensionGrid({ scores, summary }: { scores: Record<string, number>; summary: { p0_count: number; p1_count: number; p2_count: number } }) {
  const { t } = useTranslation();

  const dims = [
    { key: 'storage', icon: Database, label: t('governance.dim.storage') },
    { key: 'compute', icon: Activity, label: t('governance.dim.compute') },
    { key: 'dev', icon: Code2, label: t('governance.dim.dev') },
    { key: 'security', icon: Lock, label: t('governance.dim.security') },
    { key: 'modeling', icon: Boxes, label: t('governance.dim.modeling') },
  ];

  return (
    <div className="space-y-3 w-full">
      {/* Severity pills */}
      <div className="flex gap-2">
        <SeverityPill label="P0" count={summary.p0_count} className="bg-red-500/10 text-red-600 dark:text-red-400" />
        <SeverityPill label="P1" count={summary.p1_count} className="bg-amber-500/10 text-amber-600 dark:text-amber-400" />
        <SeverityPill label="P2" count={summary.p2_count} className="bg-blue-500/10 text-blue-600 dark:text-blue-400" />
      </div>
      {/* Dimension bars */}
      <div className="grid grid-cols-5 gap-2">
        {dims.map(({ key, icon: Icon, label }) => {
          const val = scores[key] ?? 100;
          const color = val >= 80 ? '#10b981' : val >= 60 ? '#f59e0b' : '#ef4444';
          return (
            <div key={key} className="flex flex-col items-center gap-1.5 p-2.5 rounded-xl bg-card border">
              <Icon className="h-4 w-4 text-muted-foreground" />
              <span className="text-[11px] text-muted-foreground text-center leading-tight">{label}</span>
              <span className="text-lg font-bold tabular-nums" style={{ color }}>{val}</span>
              <div className="w-full h-1 bg-muted rounded-full overflow-hidden">
                <div className="h-full rounded-full transition-all duration-500" style={{ width: `${val}%`, background: color }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SeverityPill({ label, count, className }: { label: string; count: number; className: string }) {
  return (
    <div className={cn('flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold', className)}>
      <span>{label}</span>
      <span className="tabular-nums">{count}</span>
    </div>
  );
}

/** Collapsible violation groups by severity. */
function ViolationGroups({ violations }: { violations: ContractViolation[] }) {
  const { t } = useTranslation();
  const groups: Array<{ severity: Severity; items: ContractViolation[] }> = ([
    { severity: 'P0' as Severity, items: violations.filter(v => v.severity === 'P0') },
    { severity: 'P1' as Severity, items: violations.filter(v => v.severity === 'P1') },
    { severity: 'P2' as Severity, items: violations.filter(v => v.severity === 'P2') },
  ]).filter(g => g.items.length > 0);

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold flex items-center gap-1.5">
        <AlertCircle className="h-4 w-4" />
        {t('governance.violations')} ({violations.length})
      </h3>
      {groups.map(group => (
        <ViolationSection key={group.severity} severity={group.severity} items={group.items} />
      ))}
    </div>
  );
}

function ViolationSection({ severity, items }: { severity: Severity; items: ContractViolation[] }) {
  const [open, setOpen] = useState(severity === 'P0');
  const colors: Record<Severity, { dot: string; text: string; bg: string }> = {
    P0: { dot: 'bg-red-500', text: 'text-red-600 dark:text-red-400', bg: 'bg-red-500/5' },
    P1: { dot: 'bg-amber-500', text: 'text-amber-600 dark:text-amber-400', bg: 'bg-amber-500/5' },
    P2: { dot: 'bg-blue-500', text: 'text-blue-600 dark:text-blue-400', bg: 'bg-blue-500/5' },
  };
  const c = colors[severity];

  return (
    <div className={cn('rounded-xl border overflow-hidden', c.bg)}>
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-accent/30 transition-colors"
      >
        {open ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
        <span className={cn('w-2 h-2 rounded-full', c.dot)} />
        <span className={cn('text-sm font-semibold', c.text)}>{severity}</span>
        <span className="text-xs text-muted-foreground">·</span>
        <span className="text-sm text-muted-foreground">{items.length} issues</span>
      </button>
      {open && (
        <div className="divide-y">
          {items.map((v, i) => (
            <div key={i} className="flex items-start gap-3 px-3 py-2.5 pl-10 hover:bg-accent/30 transition-colors">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium leading-snug">{v.title}</div>
                <div className="flex items-center gap-1.5 mt-0.5 text-xs text-muted-foreground">
                  <code className="px-1 py-0.5 bg-muted rounded font-mono text-[11px]">{v.rule_id}</code>
                  <span>·</span>
                  <span>{v.rule_section}</span>
                  {v.file_paths.length > 0 && (
                    <>
                      <span>·</span>
                      <span className="truncate">{v.file_paths.join(', ')}</span>
                    </>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function EmptyState({ onScan, scanning }: { onScan: () => void; scanning: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center justify-center py-20 gap-4">
      <div className="relative">
        <Shield className="h-16 w-16 text-muted-foreground/20" />
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
            <Activity className="h-6 w-6 text-primary/60" />
          </div>
        </div>
      </div>
      <div className="text-center space-y-1">
        <p className="text-sm font-medium">{t('governance.noReport')}</p>
        <p className="text-xs text-muted-foreground">ODCS contracts will be evaluated against your SQL lineage</p>
      </div>
      <Button onClick={onScan} disabled={scanning} className="rounded-xl">
        <RefreshCw className={cn('h-4 w-4 mr-1.5', scanning && 'animate-spin')} />
        {t('governance.runFirstScan')}
      </Button>
    </div>
  );
}
