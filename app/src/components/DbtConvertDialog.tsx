/**
 * DbtConvertDialog — SQL → dbt conversion dialog.
 *
 * Same layout/style as ProcedureRepairDialog:
 * - DialogContent size="full"
 * - Header with icon badge + title + stats badge
 * - Action bar: 重新转换 / 复制全部 / page nav
 * - Three columns: 原始 SQL | 操作 | dbt 模型 SQL (synced scroll)
 * - 应用 button in right column header
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Check, Copy, Loader2, RotateCcw, Boxes, ArrowLeft, ArrowRight } from 'lucide-react';
import { convertToDbt, saveDbtContent } from '@/lib/file-storage';
import { cn } from '@/lib/utils';

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
  const [page, setPage] = useState(0);

  // Synced scroll refs (same pattern as ProcedureRepairDialog)
  const leftRef = useRef<HTMLDivElement>(null);
  const middleRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const syncing = useRef(false);

  const runConvert = useCallback(() => {
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

  useEffect(() => { runConvert(); }, [runConvert]);

  const originalLines = useMemo(() => originalSql.split('\n'), [originalSql]);
  const dbtLines = useMemo(() => dbtContent.split('\n'), [dbtContent]);

  // Chunk large files into pages (same as ProcedureRepairDialog)
  const CHUNK_SIZE = 100_000;
  const chunks = useMemo(() => {
    if (originalSql.length <= CHUNK_SIZE) return null;
    const pages: { start: number; end: number }[] = [];
    let start = 0;
    let byteCount = 0;
    for (let i = 0; i < originalLines.length; i++) {
      byteCount += originalLines[i].length + 1;
      if (byteCount >= CHUNK_SIZE && i > start) {
        pages.push({ start, end: i });
        start = i;
        byteCount = originalLines[i].length + 1;
      }
    }
    if (start < originalLines.length) pages.push({ start, end: originalLines.length });
    return pages;
  }, [originalLines, originalSql.length]);

  useEffect(() => { setPage(0); }, [chunks]);

  const activeChunk = chunks ? chunks[page] : null;
  const pageStart = activeChunk ? activeChunk.start : 0;
  const pageEnd = activeChunk ? activeChunk.end : originalLines.length;
  const pageOriginalLines = originalLines.slice(pageStart, pageEnd);
  const pageDbtLines = dbtLines.slice(pageStart, pageEnd);

  const lineCount = Math.max(pageOriginalLines.length, pageDbtLines.length);

  // Synced scroll handler
  const handleScroll = useCallback((source: 'left' | 'right') => {
    if (syncing.current) return;
    syncing.current = true;
    const l = leftRef.current;
    const r = rightRef.current;
    const m = middleRef.current;
    if (!l || !r) { syncing.current = false; return; }
    const st = source === 'left' ? l.scrollTop : r.scrollTop;
    if (source === 'left') r.scrollTop = st;
    else l.scrollTop = st;
    if (m) m.scrollTop = st;
    requestAnimationFrame(() => { syncing.current = false; });
  }, []);

  const handleApply = useCallback(async () => {
    setSaving(true);
    try {
      await saveDbtContent(projectId, filePath, dbtContent);
      onSaved(dbtContent);
      setSaved(true);
    } catch (e) {
      console.error('Save failed:', e);
    } finally {
      setSaving(false);
    }
  }, [projectId, filePath, dbtContent, onSaved]);

  const handleCopyAll = useCallback(async () => {
    await navigator.clipboard.writeText(dbtContent);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [dbtContent]);

  const fSizeMono = 'text-[10px] leading-[15px]';

  return (
    <Dialog open={open} onOpenChange={() => { if (!saving) onClose(); }}>
      <DialogContent size="full">
        {/* Header — same layout as ProcedureRepairDialog */}
        <DialogHeader className="px-3 pt-3 pb-0 shrink-0">
          <div className="flex items-center gap-1.5">
            <div className="flex items-center justify-center w-6 h-6 rounded-md bg-blue-500/10">
              <Boxes className="h-3.5 w-3.5 text-blue-500" />
            </div>
            <DialogTitle>{t('editor.convertDbt', '转换为 dbt 模型')}</DialogTitle>
            <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded-full">
              {originalLines.length} → {dbtLines.length} 行
              {stats.model_count > 0 && ` · ${stats.model_count} ref() · ${stats.source_count} source()`}
              {chunks && ` · 第${page + 1}/${chunks.length}页`}
            </span>
          </div>
          <DialogDescription className="leading-tight">
            {filePath}
          </DialogDescription>
        </DialogHeader>

        {/* Action bar — same layout as ProcedureRepairDialog */}
        <div className="flex items-center justify-between px-3 py-1.5 border-b shrink-0 bg-muted/20">
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
            {/* Page navigation */}
            {chunks && chunks.length > 1 && (
              <div className="flex items-center gap-0.5 ml-2">
                <Button size="sm" variant="ghost" className="h-6 px-1" disabled={page === 0} onClick={() => setPage(p => p - 1)}>
                  <ArrowLeft className="h-3 w-3" />
                </Button>
                <span className="text-[10px] text-muted-foreground mx-1">{page + 1}/{chunks.length}</span>
                <Button size="sm" variant="ghost" className="h-6 px-1" disabled={page >= chunks.length - 1} onClick={() => setPage(p => p + 1)}>
                  <ArrowRight className="h-3 w-3" />
                </Button>
              </div>
            )}
          </div>
          {saved && <span className="text-xs text-green-600 flex items-center gap-1"><Check className="h-3 w-3" /> {t('editor.saved', '已保存')}</span>}
        </div>

        {/* Three-column split — same as ProcedureRepairDialog */}
        <div className="flex-1 min-h-0 flex overflow-hidden">
          {/* Left: Original SQL */}
          <div className="flex-1 min-w-0 flex flex-col border-r">
            <div className="flex items-center gap-1 px-2 py-1 border-b bg-muted/10 shrink-0">
              <span className="text-[10px] text-muted-foreground">{t('editor.originalSql', '原始 SQL')} (行 {pageStart + 1}-{pageEnd} / {originalLines.length})</span>
            </div>
            <div ref={leftRef} className="flex-1 min-h-0 overflow-auto bg-background" onScroll={() => handleScroll('left')}>
              {pageOriginalLines.map((line, idx) => (
                <div key={`l-${pageStart + idx}`} className="flex items-start h-[15px]">
                  <span className="w-8 shrink-0 text-right pr-1 select-none font-mono text-[9px] leading-[15px] text-muted-foreground/40">{pageStart + idx + 1}</span>
                  <span className={cn('flex-1 whitespace-pre pr-2 overflow-hidden font-mono', fSizeMono)}>{line}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Middle: diff indicator column */}
          <div className="w-8 shrink-0 flex flex-col border-r bg-muted/5">
            <div className="h-[29px] border-b shrink-0 flex items-center justify-center bg-muted/10">
              <span className="text-[8px] text-muted-foreground">⟷</span>
            </div>
            <div ref={middleRef} className="flex-1 min-h-0 overflow-hidden">
              {Array.from({ length: lineCount }).map((_, idx) => {
                const origLine = pageOriginalLines[idx] ?? '';
                const dbtLine = pageDbtLines[idx] ?? '';
                const isSame = origLine.trim() === dbtLine.trim();
                const isRemoved = origLine && !dbtLine;
                const isAdded = !origLine && dbtLine;
                const isModified = origLine && dbtLine && !isSame;
                return (
                  <div key={`m-${idx}`} className="flex items-center justify-center" style={{ height: '15px' }}>
                    {isModified && <span className="w-1 h-1 rounded-full bg-amber-400" />}
                    {isRemoved && <span className="w-1 h-1 rounded-full bg-red-400" />}
                    {isAdded && <span className="w-1 h-1 rounded-full bg-green-400" />}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Right: dbt model SQL */}
          <div className="flex-1 min-w-0 flex flex-col">
            <div className="flex items-center justify-between px-2 py-1 border-b bg-muted/10 shrink-0">
              <span className="text-[10px] text-muted-foreground">{t('editor.dbtModel', 'dbt 模型 SQL')} ({dbtLines.length} 行)</span>
              <Button variant="ghost" size="sm" className="h-5 px-1.5 text-[10px] text-blue-500 hover:text-blue-600" onClick={handleApply} disabled={!dbtContent.trim() || saving}>
                {saving ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : saved ? <Check className="h-3 w-3 mr-1" /> : null}
                {saved ? t('editor.saved', '已保存') : t('editor.apply', '应用')}
              </Button>
            </div>
            {loading ? (
              <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
                <Loader2 className="h-5 w-5 animate-spin mr-2" /> {t('editor.converting', '转换中...')}
              </div>
            ) : (
              <div ref={rightRef} className="flex-1 min-h-0 overflow-auto bg-blue-50/20 dark:bg-blue-950/10" onScroll={() => handleScroll('right')}>
                {Array.from({ length: lineCount }).map((_, idx) => {
                  const origLine = pageOriginalLines[idx] ?? '';
                  const dbtLine = pageDbtLines[idx] ?? '';
                  const isSame = origLine.trim() === dbtLine.trim();
                  const isRemoved = origLine && !dbtLine;
                  const isAdded = !origLine && dbtLine;
                  const isModified = origLine && dbtLine && !isSame;
                  return (
                    <div key={`r-${idx}`} className={cn(
                      'flex items-start h-[15px]',
                      isModified && 'bg-amber-500/[0.06]',
                      isAdded && 'bg-green-500/[0.06]',
                      isRemoved && 'bg-red-500/[0.06]',
                    )}>
                      <span className={cn(
                        'w-8 shrink-0 text-right pr-1 select-none font-mono text-[9px] leading-[15px]',
                        isModified ? 'text-amber-400' : isAdded ? 'text-green-400' : isRemoved ? 'text-red-400' : 'text-muted-foreground/40',
                      )}>{pageStart + idx + 1}</span>
                      <span className={cn('flex-1 whitespace-pre pr-2 overflow-hidden font-mono', fSizeMono)}>
                        {dbtLine || '\u00A0'}
                      </span>
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
