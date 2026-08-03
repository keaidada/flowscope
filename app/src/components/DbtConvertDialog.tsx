/**
 * DbtConvertDialog — SQL → dbt conversion preview dialog.
 *
 * Left: original SQL. Right: converted dbt SQL.
 * Top-right: "确认保存" button to persist dbt_content.
 */

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { convertToDbt, saveDbtContent } from '@/lib/file-storage';

interface DbtConvertDialogProps {
  open: boolean;
  onClose: () => void;
  projectId: string;
  filePath: string;
  originalSql: string;
  onSaved: (dbtContent: string) => void;
}

export function DbtConvertDialog({
  open, onClose, projectId, filePath, originalSql, onSaved,
}: DbtConvertDialogProps) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const [dbtContent, setDbtContent] = useState('');
  const [stats, setStats] = useState({ model_count: 0, source_count: 0, warnings: [] as string[] });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setSaved(false);
    convertToDbt(projectId, filePath)
      .then(result => {
        setDbtContent(result.dbt_content);
        setStats({ model_count: result.model_count, source_count: result.source_count, warnings: result.warnings });
      })
      .catch(e => {
        console.error('Convert failed:', e);
        setDbtContent(`-- Conversion failed: ${e}`);
      })
      .finally(() => setLoading(false));
  }, [open, projectId, filePath]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await saveDbtContent(projectId, filePath, dbtContent);
      onSaved(dbtContent);
      setSaved(true);
      setTimeout(() => { onClose(); }, 800);
    } catch (e) {
      console.error('Save failed:', e);
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-background border rounded-lg shadow-xl w-[90vw] max-w-7xl h-[85vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b shrink-0">
          <h2 className="text-sm font-semibold">📦 {t('editor.convertDbt', '转换为 dbt 模型')}</h2>
          <div className="flex items-center gap-2">
            {saved ? (
              <span className="text-xs text-green-600 flex items-center gap-1"><Check className="h-3 w-3" /> {t('editor.saved', '已保存')}</span>
            ) : (
              <Button size="sm" className="h-7 text-xs" onClick={handleSave} disabled={saving || loading || !dbtContent}>
                {saving ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Check className="h-3 w-3 mr-1" />}
                {t('editor.confirmSave', '确认保存')}
              </Button>
            )}
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose}><X className="h-4 w-4" /></Button>
          </div>
        </div>

        {/* Stats bar */}
        {!loading && dbtContent && (
          <div className="px-4 py-1.5 border-b bg-muted/30 text-xs text-muted-foreground shrink-0">
            {stats.model_count > 0 && <span className="mr-3">📦 {stats.model_count} {t('editor.modelRefs', '个模型引用')}</span>}
            {stats.source_count > 0 && <span className="mr-3">🔗 {stats.source_count} {t('editor.sourceRefs', '个 source 引用')}</span>}
            {stats.warnings.length > 0 && <span className="text-yellow-600">⚠ {stats.warnings.length} {t('editor.warnings', '个警告')}</span>}
          </div>
        )}

        {/* Split view */}
        <div className="flex flex-1 min-h-0">
          {/* Left: original */}
          <div className="flex-1 border-r flex flex-col min-w-0">
            <div className="px-3 py-1 border-b bg-muted/20 text-[10px] font-medium text-muted-foreground uppercase">{t('editor.originalSql', '原始 SQL')}</div>
            <pre className="flex-1 overflow-auto p-3 text-xs font-mono whitespace-pre-wrap break-all">{originalSql}</pre>
          </div>
          {/* Right: dbt */}
          <div className="flex-1 flex flex-col min-w-0">
            <div className="px-3 py-1 border-b bg-muted/20 text-[10px] font-medium text-muted-foreground uppercase">{t('editor.dbtModel', 'dbt 模型 SQL')}</div>
            {loading ? (
              <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
                <Loader2 className="h-5 w-5 animate-spin mr-2" /> {t('editor.converting', '转换中...')}
              </div>
            ) : (
              <pre className="flex-1 overflow-auto p-3 text-xs font-mono whitespace-pre-wrap break-all bg-blue-50/30 dark:bg-blue-950/10">{dbtContent}</pre>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
