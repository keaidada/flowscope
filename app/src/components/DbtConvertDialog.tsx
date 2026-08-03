/**
 * DbtConvertDialog — SQL → dbt conversion dialog.
 *
 * Styled like ProcedureRepairDialog: split original | converted SQL with
 * line numbers, top action bar (re-convert / copy), and "应用" (Apply)
 * button that persists the dbt content.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Check, Copy, Loader2, RotateCcw, Boxes } from 'lucide-react';
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
  const [copied, setCopied] = useState(false);
  const [applied, setApplied] = useState(false);

  const runConvert = useCallback(() => {
    if (!open) return;
    setLoading(true);
    setSaved(false);
    setApplied(false);
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

  useEffect(() => {
    runConvert();
  }, [runConvert]);

  const originalLines = useMemo(() => originalSql.split('\n'), [originalSql]);
  const dbtLines = useMemo(() => dbtContent.split('\n'), [dbtContent]);
  const lineCount = Math.max(originalLines.length, dbtLines.length);

  const handleApply = async () => {
    setSaving(true);
    try {
      await saveDbtContent(projectId, filePath, dbtContent);
      onSaved(dbtContent);
      setSaved(true);
      setApplied(true);
    } catch (e) {
      console.error('Save failed:', e);
    } finally {
      setSaving(false);
    }
  };

  const handleCopyAll = async () => {
    await navigator.clipboard.writeText(dbtContent);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Dialog open={open} onOpenChange={() => { if (!saving) onClose(); }}>
      <DialogContent className="overflow-hidden w-[85vw] max-w-6xl h-[80vh] flex flex-col p-0 gap-0">
        <DialogHeader className="px-4 py-2.5 border-b shrink-0">
          <DialogTitle className="flex items-center gap-2 text-sm">
            <Boxes className="h-4 w-4 text-blue-500" />
            {t('editor.convertDbt', '转换为 dbt 模型')}
          </DialogTitle>
          <DialogDescription>{filePath}</DialogDescription>
        </DialogHeader>

        {/* Stats bar */}
        {!loading && dbtContent && (
          <div className="px-4 py-1.5 border-b bg-muted/30 text-xs text-muted-foreground shrink-0">
            {stats.model_count > 0 && <span className="mr-3">📦 {stats.model_count} {t('editor.modelRefs', '个模型引用')}</span>}
            {stats.source_count > 0 && <span className="mr-3">🔗 {stats.source_count} {t('editor.sourceRefs', '个 source 引用')}</span>}
            {stats.warnings.length > 0 && <span className="text-yellow-600">⚠ {stats.warnings.length} {t('editor.warnings', '个警告')}</span>}
          </div>
        )}

        {/* Top action bar */}
        <div className="flex items-center justify-between px-3 py-1.5 border-b bg-muted/10 shrink-0">
          <div className="flex items-center gap-1.5">
            <Button size="sm" className="h-7 gap-1 bg-blue-500 hover:bg-blue-600 text-white text-[11px] px-2.5" onClick={runConvert} disabled={loading}>
              <RotateCcw className="h-3 w-3" />{loading ? t('editor.converting', '转换中...') : t('editor.reConvert', '重新转换')}
            </Button>
            {dbtContent && (
              <Button size="sm" variant="outline" className="h-7 gap-1 text-[11px] px-2" onClick={handleCopyAll}>
                {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
                {copied ? t('editor.copied', '已复制') : t('editor.copyAll', '复制全部')}
              </Button>
            )}
          </div>
          {saved && <span className="text-xs text-green-600 flex items-center gap-1"><Check className="h-3 w-3" /> {t('editor.saved', '已保存')}</span>}
        </div>

        {/* Split view */}
        <div className="flex-1 min-h-0 flex overflow-hidden">
          {/* Left: original */}
          <div className="flex-1 min-w-0 flex flex-col border-r">
            <div className="px-2 py-1 border-b bg-muted/10 shrink-0">
              <span className="text-[10px] text-muted-foreground">{t('editor.originalSql', '原始 SQL')} ({originalLines.length} 行)</span>
            </div>
            <div className="flex-1 min-h-0 overflow-auto bg-background">
              {originalLines.map((line, idx) => (
                <div key={`l-${idx}`} className="flex items-start h-[16px]">
                  <span className="w-8 shrink-0 text-right pr-1 select-none font-mono text-[9px] leading-[16px] text-muted-foreground/40">{idx + 1}</span>
                  <span className="flex-1 whitespace-pre pr-2 overflow-hidden font-mono text-[11px] leading-[16px]">{line}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Right: dbt result */}
          <div className="flex-1 min-w-0 flex flex-col">
            <div className="flex items-center justify-between px-2 py-1 border-b bg-muted/10 shrink-0">
              <span className="text-[10px] text-muted-foreground">{t('editor.dbtModel', 'dbt 模型 SQL')} ({dbtLines.length} 行)</span>
              <Button size="sm" variant="outline" className="h-5 px-1.5 text-[10px] text-blue-500 hover:text-blue-600" onClick={handleApply} disabled={!dbtContent.trim() || saving}>
                {saving ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : applied ? <Check className="h-3 w-3 mr-1" /> : null}
                {applied ? t('editor.saved', '已保存') : t('editor.apply', '应用')}
              </Button>
            </div>
            {loading ? (
              <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
                <Loader2 className="h-5 w-5 animate-spin mr-2" /> {t('editor.converting', '转换中...')}
              </div>
            ) : (
              <div className="flex-1 min-h-0 overflow-auto bg-blue-50/20 dark:bg-blue-950/10">
                {Array.from({ length: lineCount }).map((_, idx) => {
                  const line = dbtLines[idx] ?? '';
                  return (
                    <div key={`r-${idx}`} className="flex items-start h-[16px]">
                      <span className="w-8 shrink-0 text-right pr-1 select-none font-mono text-[9px] leading-[16px] text-muted-foreground/40">{idx + 1}</span>
                      <span className="flex-1 whitespace-pre pr-2 overflow-hidden font-mono text-[11px] leading-[16px]">{line}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
