/**
 * GovernanceSettings — scan schedule, alert threshold, webhook, contract templates.
 */

import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Save, FileText, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { governanceApi } from '@/lib/governance-api';

interface GovSettings {
  scan_cron: string;
  alert_threshold: number;
  webhook_url: string;
  notify_emails: string[];
}

interface TemplateInfo {
  name: string;
  description: string;
  content: string;
}

export function GovernanceSettings({ projectId }: { projectId: string | null }) {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<GovSettings>({ scan_cron: '', alert_threshold: 60, webhook_url: '', notify_emails: [] });
  const [emailsText, setEmailsText] = useState('');
  const [templates, setTemplates] = useState<TemplateInfo[]>([]);
  const [saved, setSaved] = useState(false);

  const loadSettings = useCallback(async () => {
    if (!projectId) return;
    try {
      const s = await governanceApi['getSettings'](projectId) as unknown as GovSettings;
      setSettings(s);
      setEmailsText(s.notify_emails.join(', '));
    } catch (e) {
      console.error('Settings load failed:', e);
    }
  }, [projectId]);

  const loadTemplates = useCallback(async () => {
    try {
      const t = await governanceApi['contractTemplates']();
      setTemplates(t);
    } catch (e) {
      console.error('Templates load failed:', e);
    }
  }, []);

  useEffect(() => { loadSettings(); loadTemplates(); }, [loadSettings, loadTemplates]);

  const handleSave = async () => {
    if (!projectId) return;
    try {
      const emails = emailsText.split(',').map(e => e.trim()).filter(Boolean);
      await governanceApi['updateSettings'](projectId, {
        scan_cron: settings.scan_cron,
        alert_threshold: settings.alert_threshold,
        webhook_url: settings.webhook_url,
        notify_emails: emails,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      console.error('Settings save failed:', e);
    }
  };

  const handleCreateFromTemplate = async (template: TemplateInfo) => {
    const name = prompt(t('governance.contractName', '契约名称'), template.name);
    if (!name) return;
    try {
      await governanceApi.createContract(name, template.content);
      await loadTemplates();
    } catch (e) {
      console.error('Create from template failed:', e);
    }
  };

  if (!projectId) {
    return <div className="flex items-center justify-center h-full text-muted-foreground text-sm">{t('governance.selectProject', '请先选择项目')}</div>;
  }

  return (
    <div className="p-4 space-y-6 max-w-2xl overflow-auto">
      {/* Scan Configuration */}
      <section className="space-y-3">
        <h3 className="text-sm font-semibold">{t('governance.scanConfig', '扫描配置')}</h3>
        <div className="space-y-2">
          <label className="text-xs text-muted-foreground">{t('governance.scanCron', '定时扫描 Cron 表达式')}</label>
          <input
            value={settings.scan_cron}
            onChange={(e) => setSettings({ ...settings, scan_cron: e.target.value })}
            placeholder="0 9 * * * (每天9点)"
            className="w-full px-3 py-2 border rounded text-sm font-mono"
          />
          <p className="text-xs text-muted-foreground">留空则不启用定时扫描</p>
        </div>
        <div className="space-y-2">
          <label className="text-xs text-muted-foreground">{t('governance.alertThreshold', '告警阈值（健康分低于此值时告警）')}</label>
          <input
            type="number"
            value={settings.alert_threshold}
            onChange={(e) => setSettings({ ...settings, alert_threshold: parseInt(e.target.value) || 0 })}
            className="w-32 px-3 py-2 border rounded text-sm"
            min={0}
            max={100}
          />
        </div>
      </section>

      {/* Notification */}
      <section className="space-y-3">
        <h3 className="text-sm font-semibold">{t('governance.notification', '通知配置')}</h3>
        <div className="space-y-2">
          <label className="text-xs text-muted-foreground">Webhook URL</label>
          <input
            value={settings.webhook_url}
            onChange={(e) => setSettings({ ...settings, webhook_url: e.target.value })}
            placeholder="https://hooks.slack.com/..."
            className="w-full px-3 py-2 border rounded text-sm font-mono"
          />
        </div>
        <div className="space-y-2">
          <label className="text-xs text-muted-foreground">{t('governance.notifyEmails', '通知邮箱（逗号分隔）')}</label>
          <input
            value={emailsText}
            onChange={(e) => setEmailsText(e.target.value)}
            placeholder="data-team@company.com"
            className="w-full px-3 py-2 border rounded text-sm"
          />
        </div>
      </section>

      <Button onClick={handleSave} size="sm">
        <Save className="h-4 w-4 mr-1" />
        {saved ? t('governance.saved', '已保存 ✓') : t('governance.save', '保存')}
      </Button>

      {/* Contract Templates */}
      <section className="space-y-3 pt-4 border-t">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <FileText className="h-4 w-4" />
          {t('governance.contractTemplates', '契约模板库')}
        </h3>
        <div className="grid grid-cols-2 gap-2">
          {templates.map((tpl) => (
            <button
              key={tpl.name}
              onClick={() => handleCreateFromTemplate(tpl)}
              className="text-left p-3 border rounded-lg hover:bg-accent/50 transition-colors group"
            >
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{tpl.name}</span>
                <Plus className="h-3.5 w-3.5 text-muted-foreground group-hover:text-primary" />
              </div>
              <p className="text-xs text-muted-foreground mt-1">{tpl.description}</p>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
