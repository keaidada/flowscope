/**
 * SemanticYamlDialog — dbt Semantic Layer YAML generation dialog.
 *
 * Same layout/style as DbtConvertDialog:
 * - Header with icon badge + title + stats badge
 * - Action bar: 重新生成 / 复制全部
 * - Single panel: YAML output (monospace)
 * - 应用 button to save to DB
 */

import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Check, Copy, Loader2, RotateCcw, FileJson } from 'lucide-react';
import { generateSemanticYaml, saveDbtYaml } from '@/lib/file-storage';

interface SemanticYamlDialogProps {
  open: boolean;
  onClose: () => void;
  projectId: string;
  filePath: string;
  onSaved: (yaml: string) => void;
}

export function SemanticYamlDialog({
  open, onClose, projectId, filePath, onSaved,
}: SemanticYamlDialogProps) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const [yaml, setYaml] = useState('');
  const [stats, setStats] = useState({ dimension_count: 0, measure_count: 0, source_count: 0, model_name: '' });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');

  const runGenerate = useCallback(() => {
    if (!open) return;
    setLoading(true);
    setSaved(false);
    setError('');
    generateSemanticYaml(projectId, filePath)
      .then(result => {
        setYaml(result.yaml);
        setStats({
          dimension_count: result.dimension_count,
          measure_count: result.measure_count,
          source_count: result.source_count,
          model_name: result.model_name,
        });
      })
      .catch(e => {
        const msg = e instanceof Error ? e.message : String(e);
        console.error('YAML generation failed:', msg);
        setError(msg);
        setYaml('');
      })
      .finally(() => setLoading(false));
  }, [open, projectId, filePath]);

  useEffect(() => { runGenerate(); }, [runGenerate]);

  const handleApply = useCallback(async () => {
    setSaving(true);
    try {
      await saveDbtYaml(projectId, filePath, yaml);
      onSaved(yaml);
      setSaved(true);
    } catch (e) {
      console.error('Save failed:', e);
    } finally {
      setSaving(false);
    }
  }, [projectId, filePath, yaml, onSaved]);

  const handleCopyAll = useCallback(async () => {
    await navigator.clipboard.writeText(yaml);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [yaml]);

  const lineCount = yaml ? yaml.split('\n').length : 0;

  return (
    <Dialog open={open} onOpenChange={() => { if (!saving) onClose(); }}>
      <DialogContent size="full">
        <DialogHeader className="px-3 pt-3 pb-0 shrink-0">
          <div className="flex items-center gap-1.5">
            <div className="flex items-center justify-center w-6 h-6 rounded-md bg-purple-500/10">
              <FileJson className="h-3.5 w-3.5 text-purple-500" />
            </div>
            <DialogTitle>{t('editor.generateYaml', '生成 Semantic YAML')}</DialogTitle>
            <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded-full">
              {lineCount} 行
              {stats.measure_count > 0 && ` · ${stats.measure_count} measures · ${stats.dimension_count} dims · ${stats.source_count} sources`}
            </span>
          </div>
          <DialogDescription className="leading-tight">
            {filePath}
          </DialogDescription>
        </DialogHeader>

        {/* Action bar */}
        <div className="flex items-center justify-between px-3 py-1.5 border-b shrink-0 bg-muted/20">
          <div className="flex items-center gap-1.5">
            <Button size="sm" className="h-7 gap-1 bg-purple-500 hover:bg-purple-600 text-white text-[11px] px-2.5" onClick={runGenerate} disabled={loading}>
              <RotateCcw className="h-3 w-3" />{loading ? t('editor.generating', '生成中...') : t('editor.reGenerate', '重新生成')}
            </Button>
            {yaml && (
              <Button size="sm" variant="outline" className="h-7 gap-1 text-[11px] px-2" onClick={handleCopyAll}>
                {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
                {copied ? t('editor.copied', '已复制') : t('editor.copyAll', '复制全部')}
              </Button>
            )}
          </div>
          {saved && <span className="text-xs text-green-600 flex items-center gap-1"><Check className="h-3 w-3" /> {t('editor.saved', '已保存')}</span>}
        </div>

        {/* YAML output panel */}
        <div className="flex-1 min-h-0 overflow-auto bg-purple-50/20 dark:bg-purple-950/10">
          {loading ? (
            <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm h-full">
              <Loader2 className="h-5 w-5 mr-2 animate-spin" /> {t('editor.generating', '生成中...')}
            </div>
          ) : error ? (
            <div className="p-4 text-sm text-destructive">
              <p className="font-medium mb-1">生成失败</p>
              <pre className="whitespace-pre-wrap text-xs">{error}</pre>
            </div>
          ) : (
            <div className="p-3">
              <pre className="text-xs font-mono whitespace-pre leading-[1.5]">{yaml}</pre>
            </div>
          )}
        </div>

        {/* Footer with Apply button */}
        {yaml && !error && (
          <div className="flex justify-end px-3 py-2 border-t shrink-0">
            <Button
              size="sm"
              className="h-7 gap-1 bg-purple-500 hover:bg-purple-600 text-white text-[11px] px-3"
              onClick={handleApply}
              disabled={!yaml.trim() || saving}
            >
              {saving ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : saved ? <Check className="h-3 w-3 mr-1" /> : null}
              {saved ? t('editor.saved', '已保存') : t('editor.apply', '应用')}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
