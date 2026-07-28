import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Copy, Check, RotateCcw, Scissors, X, ArrowLeft, ArrowRight } from 'lucide-react';
import { extractBqDml } from '@/lib/procedure-utils';
import { cn } from '@/lib/utils';

interface ProcedureRepairDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  originalContent: string;
  onApply: (transformedContent: string | null) => void;
}

interface MergedLine {
  content: string;
  removed: boolean;
}

function buildMergedLines(original: string, extracted: string): MergedLine[] {
  const origLines = original.split('\n');
  const extLines = extracted.split('\n');
  const result: MergedLine[] = [];

  let extIdx = 0;
  for (let i = 0; i < origLines.length; i++) {
    const origTrim = origLines[i].trim();

    if (extIdx < extLines.length) {
      const extTrim = extLines[extIdx].trim();
      if (
        origTrim === extTrim ||
        (origTrim && extTrim && (extTrim.includes(origTrim) || origTrim.includes(extTrim)))
      ) {
        result.push({ content: extLines[extIdx], removed: false });
        extIdx++;
        continue;
      }
    }

    result.push({ content: origLines[i], removed: true });
  }

  return result;
}

export function ProcedureRepairDialog({
  open,
  onOpenChange,
  originalContent,
  onApply,
}: ProcedureRepairDialogProps) {
  const { t } = useTranslation();
  const [mergedLines, setMergedLines] = useState<MergedLine[]>([]);
  const [copied, setCopied] = useState(false);
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [showRemoved, setShowRemoved] = useState(true);

  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const syncing = useRef(false);

  useEffect(() => {
    if (open && originalContent) {
      const extracted = extractBqDml(originalContent) || '';
      setMergedLines(buildMergedLines(originalContent, extracted));
    }
  }, [open, originalContent]);

  const handleScroll = useCallback((source: 'left' | 'right') => {
    if (syncing.current) return;
    syncing.current = true;
    const l = leftRef.current;
    const r = rightRef.current;
    if (!l || !r) { syncing.current = false; return; }
    if (source === 'left') r.scrollTop = l.scrollTop;
    else l.scrollTop = r.scrollTop;
    requestAnimationFrame(() => { syncing.current = false; });
  }, []);

  const handleReExtract = useCallback(() => {
    const extracted = extractBqDml(originalContent) || '';
    setMergedLines(buildMergedLines(originalContent, extracted));
  }, [originalContent]);

  // Toggle removed status — matching ETL tool exactly
  const toggleRemoved = useCallback((idx: number) => {
    setMergedLines((prev) => {
      const next = [...prev];
      if (next[idx]) {
        next[idx] = { ...next[idx], removed: !next[idx].removed };
      }
      return next;
    });
  }, []);

  const handleLineChange = useCallback((idx: number, value: string) => {
    setMergedLines((prev) => {
      const next = [...prev];
      if (next[idx]) next[idx] = { ...next[idx], content: value };
      return next;
    });
  }, []);

  const originalLines = useMemo(() => originalContent.split('\n'), [originalContent]);
  const output = useMemo(
    () => mergedLines.filter((l) => !l.removed).map((l) => l.content).join('\n'),
    [mergedLines]
  );
  const removedCount = useMemo(() => mergedLines.filter((l) => l.removed).length, [mergedLines]);
  const keptCount = mergedLines.length - removedCount;

  const handleCopyAll = useCallback(async () => {
    if (!output) return;
    await navigator.clipboard.writeText(output);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [output]);

  const handleApply = useCallback(() => {
    onApply(output.trim() || null);
    onOpenChange(false);
  }, [output, onApply, onOpenChange]);

  const fSizeMono = 'text-[10px] leading-[15px]';
  const hasResult = mergedLines.length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="full">
        <DialogHeader className="px-3 pt-3 pb-0 shrink-0">
          <div className="flex items-center gap-1.5">
            <div className="flex items-center justify-center w-6 h-6 rounded-md bg-amber-500/10">
              <Scissors className="h-3.5 w-3.5 text-amber-500" />
            </div>
            <DialogTitle>{t('procedure.title', '存储过程转换')}</DialogTitle>
            <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded-full">
              {originalLines.length} → {keptCount} 行 · 已过滤 {removedCount}
            </span>
          </div>
          <DialogDescription className="leading-tight">
            左侧原始存储过程，右侧自动过滤 DECLARE/SET/控制流 — 可删除/恢复行
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-between px-3 py-1.5 border-b shrink-0 bg-muted/20">
          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              className="h-7 gap-1 bg-amber-500 hover:bg-amber-600 text-white text-[11px] px-2.5"
              onClick={handleReExtract}
            >
              <RotateCcw className="h-3 w-3" />
              重新提取
            </Button>
            {removedCount > 0 && (
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2 text-[10px] gap-1"
                onClick={() => setShowRemoved((v) => !v)}
              >
                <X className={cn('h-2.5 w-2.5', !showRemoved && 'rotate-45')} />
                已删除 ({removedCount} 行)
              </Button>
            )}
          </div>

          <div className="flex items-center gap-1.5">
            {output && (
              <Button size="sm" variant="outline" className="h-7 gap-1 text-[11px] px-2" onClick={handleCopyAll}>
                {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
                {copied ? '已复制' : '复制全部'}
              </Button>
            )}
          </div>
        </div>

        <div className="flex-1 min-h-0 flex overflow-hidden">
          {/* Left: Original */}
          <div className="flex-1 min-w-0 flex flex-col border-r">
            <div className="flex items-center gap-1 px-2 py-1 border-b bg-muted/10 shrink-0">
              <span className="text-[10px] text-muted-foreground">
                原始存储过程 ({originalLines.length} 行)
              </span>
            </div>
            <div ref={leftRef} className="flex-1 min-h-0 overflow-auto bg-background" onScroll={() => handleScroll('left')}>
              {originalLines.map((line, idx) => (
                <div key={`l-${idx}`} className="flex items-start h-[15px]">
                  <span className="w-8 shrink-0 text-right pr-1 select-none font-mono text-[9px] leading-[15px] text-muted-foreground/40">
                    {idx + 1}
                  </span>
                  <span className={cn('flex-1 whitespace-pre pr-2 overflow-hidden font-mono', fSizeMono)}>
                    {line}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Middle: keep/delete — matching ETL exact pattern */}
          {hasResult && (
            <div className="w-12 shrink-0 flex flex-col border-r bg-muted/5">
              <div className="h-[29px] border-b shrink-0 flex items-center justify-center bg-muted/10">
                <span className="text-[8px] text-muted-foreground">操作</span>
              </div>
              <div className="flex-1 min-h-0 overflow-hidden">
                {mergedLines.map((line, idx) => {
                  if (line.removed && !showRemoved && line.content.trim()) return null;
                  return (
                    <div key={idx} className="flex items-center justify-center gap-0.5" style={{ height: '15px' }}>
                      <button
                        title="标记为删除"
                        onClick={() => { if (!line.removed) toggleRemoved(idx); }}
                        className={cn('p-0 rounded hover:bg-red-100 transition-colors', line.removed && 'bg-red-100')}
                      >
                        <ArrowLeft className={cn('h-2.5 w-2.5', line.removed ? 'text-red-500' : 'text-muted-foreground/40 hover:text-red-400')} />
                      </button>
                      <button
                        title="保留此行"
                        onClick={() => { if (line.removed) toggleRemoved(idx); }}
                        className={cn('p-0 rounded hover:bg-green-100 transition-colors', !line.removed && 'bg-green-100')}
                      >
                        <ArrowRight className={cn('h-2.5 w-2.5', !line.removed ? 'text-green-500' : 'text-muted-foreground/40 hover:text-green-400')} />
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Right: Result — matching ETL exact pattern */}
          <div className="flex-1 min-w-0 flex flex-col">
            <div className="flex items-center justify-between px-2 py-1 border-b bg-muted/10 shrink-0">
              <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                <Scissors className="h-3 w-3 text-amber-500" />
                <span>转换结果（可编辑）</span>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="h-5 px-1.5 text-[10px] text-amber-500 hover:text-amber-600"
                onClick={handleApply}
                disabled={!output.trim()}
              >
                应用
              </Button>
            </div>

            {hasResult ? (
              <div ref={rightRef} className="flex-1 min-h-0 overflow-auto bg-background" onScroll={() => handleScroll('right')}>
                {mergedLines.map((line, idx) => {
                  const isComment = line.content.trim().startsWith('--');
                  if (line.removed && !showRemoved && line.content.trim()) return null;

                  return (
                    <div
                      key={idx}
                      className={cn(
                        'flex items-start h-[15px]',
                        line.removed && 'bg-red-500/[0.06]',
                        !line.removed && isComment && 'bg-green-500/[0.04]',
                      )}
                    >
                      <span className={cn(
                        'w-8 shrink-0 text-right pr-1 select-none font-mono text-[9px] leading-[15px]',
                        line.removed ? 'text-red-400' : isComment ? 'text-green-600/50' : 'text-muted-foreground'
                      )}>
                        {idx + 1}
                      </span>

                      {line.removed ? (
                        <span className={cn(
                          'flex-1 whitespace-pre pr-2 overflow-hidden font-mono text-red-500 line-through',
                          fSizeMono
                        )}>
                          {line.content}
                        </span>
                      ) : isComment ? (
                        <span className={cn(
                          'flex-1 whitespace-pre pr-2 overflow-hidden font-mono text-green-700/60 italic',
                          fSizeMono
                        )}>
                          {line.content}
                        </span>
                      ) : editingIdx !== idx ? (
                        <span
                          className={cn('flex-1 whitespace-pre pr-2 overflow-hidden cursor-text font-mono', fSizeMono)}
                          onClick={() => setEditingIdx(idx)}
                          title="点击编辑"
                        >
                          {line.content}
                        </span>
                      ) : (
                        <input
                          type="text"
                          value={line.content}
                          onChange={(e) => handleLineChange(idx, e.target.value)}
                          onBlur={() => setEditingIdx(null)}
                          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') setEditingIdx(null); }}
                          autoFocus
                          className={cn('flex-1 min-w-0 pr-2 border-0 outline-none bg-transparent font-mono', fSizeMono, 'focus:bg-amber-500/5')}
                          spellCheck={false}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="flex-1 flex items-center justify-center text-[10px] text-muted-foreground">
                <div className="text-center space-y-1.5">
                  <RotateCcw className="h-4 w-4 mx-auto opacity-30" />
                  <p>点击"重新提取"提取 DML</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
