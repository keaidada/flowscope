/**
 * GovernanceWorkspace — top-level container with tab navigation.
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
  { id: 'contracts', icon: FileText, labelKey: 'governance.contracts' },
  { id: 'models', icon: Box, labelKey: 'governance.models' },
  { id: 'metrics', icon: BarChart3, labelKey: 'governance.metrics' },
  { id: 'designer', icon: Palette, labelKey: 'governance.designer' },
  { id: 'settings', icon: Settings, labelKey: 'governance.settings' },
];

export function GovernanceWorkspace({ projectId }: GovernanceWorkspaceProps) {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<GovernanceTab>('dashboard');
  const gov = useGovernanceData(projectId);

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2 border-b bg-muted/30">
        <Shield className="h-5 w-5 text-primary" />
        <span className="font-semibold text-sm">{t('governance.title', '数据治理')}</span>
        {gov.report && (
          <span
            className={cn(
              'ml-2 px-2 py-0.5 rounded text-xs font-bold',
              gov.report.health_score >= 80
                ? 'bg-green-100 text-green-700'
                : gov.report.health_score >= 60
                  ? 'bg-yellow-100 text-yellow-700'
                  : 'bg-red-100 text-red-700'
            )}
          >
            {gov.report.health_score}/100
          </span>
        )}
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 px-4 border-b bg-muted/20">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                'flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 transition-colors',
                isActive
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              )}
            >
              <Icon className="h-4 w-4" />
              {t(tab.labelKey, tab.id)}
            </button>
          );
        })}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {activeTab === 'dashboard' && (
          <GovernanceDashboard gov={gov} projectId={projectId} />
        )}
        {activeTab === 'contracts' && <ContractManager contracts={gov.contracts} onRefresh={gov.refreshContracts} />}
        {activeTab === 'models' && (
          <ModelManager projectId={projectId} />
        )}
        {activeTab === 'metrics' && (
          <MetricManager projectId={projectId} />
        )}
        {activeTab === 'designer' && (
          <VisualModelDesigner />
        )}
        {activeTab === 'settings' && (
          <GovernanceSettings projectId={projectId} />
        )}
      </div>
    </div>
  );
}
