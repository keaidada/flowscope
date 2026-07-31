/**
 * GovernanceDashboard — health score + violation list.
 */

import { useTranslation } from 'react-i18next';
import { RefreshCw, Download, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import type { useGovernanceData } from '@/hooks/useGovernanceData';
import type { ContractViolation, Severity } from '@/lib/governance-api';
import { governanceApi } from '@/lib/governance-api';

interface DashboardProps {
  gov: ReturnType<typeof useGovernanceData>;
  projectId: string | null;
}

const SEVERITY_STYLES: Record<Severity, { bg: string; text: string; label: string }> = {
  P0: { bg: 'bg-red-100', text: 'text-red-700', label: 'P0' },
  P1: { bg: 'bg-yellow-100', text: 'text-yellow-700', label: 'P1' },
  P2: { bg: 'bg-blue-100', text: 'text-blue-700', label: 'P2' },
};

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
    } catch (e) {
      console.error('Export failed:', e);
    }
  };

  if (!projectId) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        {t('governance.selectProject', '请先选择项目')}
      </div>
    );
  }

  return (
    <div className="p-4 space-y-4 max-w-5xl">
      {/* Health Score Card */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">
          {t('governance.healthScore', '数据资产健康分')}
        </h2>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => handleExport('html')}
            disabled={!report}
          >
            <Download className="h-4 w-4 mr-1" />
            {t('governance.export', '导出')}
          </Button>
          <Button variant="default" size="sm" onClick={() => scan()} disabled={scanning}>
            <RefreshCw className={cn('h-4 w-4 mr-1', scanning && 'animate-spin')} />
            {scanning ? t('governance.scanning', '扫描中...') : t('governance.rescan', '重新扫描')}
          </Button>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {report ? (
        <ScoreCard report={report} />
      ) : (
        <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
          <p className="text-sm mb-2">{t('governance.noReport', '暂无治理报告')}</p>
          <Button variant="outline" size="sm" onClick={() => scan()} disabled={scanning}>
            {t('governance.runFirstScan', '运行首次扫描')}
          </Button>
        </div>
      )}

      {/* Violations */}
      {report && report.violations.length > 0 && (
        <ViolationList violations={report.violations} />
      )}

      {/* Pending runtime checks */}
      {report && report.pending_runtime.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-muted-foreground">
            {t('governance.pendingRuntime', '待运行时验证')} ({report.pending_runtime.length})
          </h3>
          {report.pending_runtime.map((p, i) => (
            <div
              key={i}
              className="flex items-center gap-2 p-2 bg-muted/30 rounded text-sm text-muted-foreground"
            >
              <span className="px-1.5 py-0.5 bg-slate-200 text-slate-600 rounded text-xs font-mono">
                {p.check_type}
              </span>
              <span>{p.description}</span>
              <span className="ml-auto text-xs">{t('governance.tier3', 'Tier 3')}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ScoreCard({ report }: { report: NonNullable<DashboardProps['gov']['report']> }) {
  const { t } = useTranslation();
  const score = report.health_score;
  const scoreColor =
    score >= 80 ? 'text-green-600' : score >= 60 ? 'text-yellow-600' : 'text-red-600';
  const dims = report.dimension_scores || {};
  const dimLabels: Record<string, string> = {
    storage: t('governance.dim.storage', '存储'),
    compute: t('governance.dim.compute', '计算'),
    dev: t('governance.dim.dev', '研发'),
    security: t('governance.dim.security', '安全'),
    modeling: t('governance.dim.modeling', '建模'),
  };

  return (
    <div className="space-y-3">
      {/* Score */}
      <div className="flex items-center gap-6 p-4 bg-card border rounded-lg">
        <div className={cn('text-5xl font-bold', scoreColor)}>{score}</div>
        <div className="text-sm text-muted-foreground">
          <div>/ 100</div>
          <div className="flex gap-3 mt-1">
            <span className="text-red-600">P0: {report.summary.p0_count}</span>
            <span className="text-yellow-600">P1: {report.summary.p1_count}</span>
            <span className="text-blue-600">P2: {report.summary.p2_count}</span>
          </div>
        </div>
      </div>

      {/* Dimension scores */}
      <div className="grid grid-cols-5 gap-2">
        {Object.entries(dimLabels).map(([key, label]) => {
          const val = dims[key] ?? 100;
          const color = val >= 80 ? 'bg-green-500' : val >= 60 ? 'bg-yellow-500' : 'bg-red-500';
          return (
            <div key={key} className="text-center">
              <div className="text-xs text-muted-foreground mb-1">{label}</div>
              <div className="h-2 bg-muted rounded-full overflow-hidden">
                <div className={cn('h-full rounded-full transition-all', color)} style={{ width: `${val}%` }} />
              </div>
              <div className="text-xs mt-1 font-medium">{val}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ViolationList({ violations }: { violations: ContractViolation[] }) {
  const { t } = useTranslation();
  const sorted = [...violations].sort((a, b) => {
    const order: Record<Severity, number> = { P0: 0, P1: 1, P2: 2 };
    return order[a.severity] - order[b.severity];
  });

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold">
        {t('governance.violations', '违规清单')} ({violations.length})
      </h3>
      {sorted.map((v, i) => {
        const style = SEVERITY_STYLES[v.severity];
        return (
          <div
            key={i}
            className="flex items-start gap-2 p-3 bg-card border rounded-lg hover:bg-accent/50 transition-colors cursor-default"
          >
            <span className={cn('px-1.5 py-0.5 rounded text-xs font-bold shrink-0', style.bg, style.text)}>
              {style.label}
            </span>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium truncate">{v.title}</div>
              <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-2">
                <span className="font-mono">{v.rule_id}</span>
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
        );
      })}
    </div>
  );
}
