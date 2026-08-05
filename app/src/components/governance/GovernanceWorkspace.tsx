/**
 * GovernanceWorkspace — full-screen governance workspace with tab navigation.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Shield, LayoutDashboard, Box, BarChart3, FileText, Settings, Palette, Ruler } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useGovernanceData } from '@/hooks/useGovernanceData';
import { GovernanceDashboard } from './dashboard/GovernanceDashboard';
import { ContractManager } from './contract/ContractManager';
import { ModelManager } from './model/ModelManager';
import { MetricManager } from './metric/MetricManager';
import { DimensionManager } from './dimension/DimensionManager';
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
  { id: 'dimensions', icon: Ruler, labelKey: 'governance.dimensions' },
  { id: 'contracts', icon: FileText, labelKey: 'governance.contracts' },
  { id: 'designer', icon: Palette, labelKey: 'governance.designer' },
  { id: 'settings', icon: Settings, labelKey: 'governance.settings' },
];

export function GovernanceWorkspace({ projectId }: GovernanceWorkspaceProps) {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<GovernanceTab>('dashboard');
  const gov = useGovernanceData(projectId);

  const score = gov.report?.health_score;
  const scoreColor = score === undefined ? '' : score >= 80 ? 'text-emerald-500' : score >= 60 ? 'text-amber-500' : 'text-red-500';
  const headerGradient = score === undefined ? '' : score >= 80 ? 'from-emerald-500/8' : score >= 60 ? 'from-amber-500/8' : 'from-red-500/8';

  return (
    <div className="flex flex-col w-full h-full min-h-0">
      {/* Header bar */}
      <div className={cn('flex items-center gap-3 px-4 h-11 border-b bg-gradient-to-r to-transparent shrink-0', headerGradient)}>
        <div className="flex items-center justify-center w-7 h-7 rounded-lg bg-primary/10 shrink-0">
          <Shield className="h-4 w-4 text-primary" />
        </div>
        <span className="font-semibold text-sm shrink-0">{t('governance.title')}</span>
        {gov.report && (
          <span className="text-xs text-muted-foreground hidden md:inline">
            {gov.report.summary.total_files} files · {gov.report.summary.total_violations} violations
          </span>
        )}
        {score !== undefined && (
          <div className="ml-auto flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-card border shrink-0">
            <span className={cn('text-lg font-bold tabular-nums leading-none', scoreColor)}>{score}</span>
            <span className="text-[10px] text-muted-foreground">/100</span>
          </div>
        )}
      </div>

      {/* Tab bar */}
      <div className="flex items-center gap-0.5 px-2 h-9 border-b bg-background shrink-0 overflow-x-auto">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                'flex items-center gap-1.5 px-2.5 h-7 rounded-md text-xs font-medium transition-all whitespace-nowrap',
                isActive
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {t(tab.labelKey)}
            </button>
          );
        })}
      </div>

      {/* Content — fills remaining space */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {activeTab === 'dashboard' && <GovernanceDashboard gov={gov} projectId={projectId} />}
        {activeTab === 'contracts' && <ContractManager contracts={gov.contracts} onRefresh={gov.refreshContracts} />}
        {activeTab === 'models' && <ModelManager projectId={projectId} />}
        {activeTab === 'metrics' && <MetricManager projectId={projectId} />}
        {activeTab === 'dimensions' && <DimensionManager projectId={projectId} />}
        {activeTab === 'designer' && <VisualModelDesigner />}
        {activeTab === 'settings' && <GovernanceSettings projectId={projectId} />}
      </div>
    </div>
  );
}
