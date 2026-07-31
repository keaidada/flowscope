/**
 * GovernanceWorkspace — redesigned top-level container.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Shield, LayoutDashboard, Box, BarChart3, FileText, Settings, Palette } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useGovernanceData } from '@/hooks/useGovernanceData';
import { GovernanceDashboard } from './dashboard/GovernanceDashboard';
import { ContractManager } from './contract/ContractManager';
import { ModelManager } from './model/ModelManager';
import { MetricManager } from './metric/MetricManager';
import { VisualModelDesigner } from './designer/VisualModelDesigner';
import { GovernanceSettings } from './settings/GovernanceSettings';
import type { GovernanceTab } from '@/lib/governance-api';

interface GovernanceWorkspaceProps {
  projectId: string | null;
}

const TABS: Array<{ id: GovernanceTab; icon: React.ElementType; labelKey: string }> = [
  { id: 'dashboard', icon: LayoutDashboard, labelKey: 'governance.dashboard' },
  { id: 'models', icon: Box, labelKey: 'governance.models' },
  { id: 'metrics', icon: BarChart3, labelKey: 'governance.metrics' },
  { id: 'contracts', icon: FileText, labelKey: 'governance.contracts' },
  { id: 'designer', icon: Palette, labelKey: 'governance.designer' },
  { id: 'settings', icon: Settings, labelKey: 'governance.settings' },
];

export function GovernanceWorkspace({ projectId }: GovernanceWorkspaceProps) {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<GovernanceTab>('dashboard');
  const gov = useGovernanceData(projectId);

  const score = gov.report?.health_score;
  const scoreColor = score === undefined ? null : score >= 80 ? 'text-emerald-500' : score >= 60 ? 'text-amber-500' : 'text-red-500';
  const scoreBg = score === undefined ? null : score >= 80 ? 'from-emerald-500/10' : score >= 60 ? 'from-amber-500/10' : 'from-red-500/10';

  return (
    <div className="flex flex-col h-full bg-gradient-to-b from-muted/40 to-background">
      {/* Header */}
      <div className={cn('flex items-center gap-3 px-5 py-3 bg-gradient-to-r to-transparent border-b', scoreBg ?? '')}>
        <div className="flex items-center justify-center w-9 h-9 rounded-xl bg-primary/10">
          <Shield className="h-5 w-5 text-primary" />
        </div>
        <div className="flex flex-col">
          <span className="font-bold text-base leading-tight">{t('governance.title')}</span>
          {gov.report && (
            <span className="text-xs text-muted-foreground">
              {gov.report.summary.total_files} files · {gov.report.summary.total_violations} violations
            </span>
          )}
        </div>
        {score !== undefined && (
          <div className="ml-auto flex items-center gap-2">
            <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-card border shadow-sm">
              <span className={cn('text-2xl font-bold tabular-nums', scoreColor)}>{score}</span>
              <span className="text-xs text-muted-foreground">/100</span>
            </div>
          </div>
        )}
      </div>

      {/* Tab bar */}
      <div className="flex items-center gap-0.5 px-4 py-1.5 border-b bg-background/60 backdrop-blur-sm">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] font-medium transition-all',
                isActive
                  ? 'bg-primary/10 text-primary shadow-sm'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {t(tab.labelKey)}
            </button>
          );
        })}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {activeTab === 'dashboard' && <GovernanceDashboard gov={gov} projectId={projectId} />}
        {activeTab === 'contracts' && <ContractManager contracts={gov.contracts} onRefresh={gov.refreshContracts} />}
        {activeTab === 'models' && <ModelManager projectId={projectId} />}
        {activeTab === 'metrics' && <MetricManager projectId={projectId} />}
        {activeTab === 'designer' && <VisualModelDesigner />}
        {activeTab === 'settings' && <GovernanceSettings projectId={projectId} />}
      </div>
    </div>
  );
}
