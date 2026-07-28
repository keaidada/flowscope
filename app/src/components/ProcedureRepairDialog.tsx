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
import {
  Wand2,
  Copy,
  Check,
  ArrowRight,
  ArrowLeft,
  RotateCcw,
  RefreshCw,
  Scissors,
} from 'lucide-react';
import { extractBqDml } from '@/lib/procedure-utils';
import { cn } from '@/lib/utils';

interface ProcedureRepairDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  originalContent: string;
  onApply: (transformedContent: string | null) => void;
}

interface ResultLine {
  content: string;
  removed: boolean;
  lineNum: number;
}

export function ProcedureRepairDialog({
  open,
  onOpenChange,
  originalContent,
  onApply,
}: ProcedureRepairDialogProps) {
  const { t } = useTranslation();
  const [resultLines, setResultLines] = useState<ResultLine[]>([]);
  const [copied, setCopied] = useState(false);
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [lineEnd, setLineEnd] = useState(0);

  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const syncing = useRef(false);

  // Extract DML on open
  useEffect(() => {
    if (open && originalContent) {
      const extracted = extractBqDml(originalContent) || '';
      const lines = extracted.split('\n');
      setResultLines(
        lines.map((content, i) => ({
          content,
          removed: false,
          lineNum: i + 1,
        }))
      );
      setLineEnd(lines.length);
    }
  }, [open, originalContent]);

  // Sync scroll between left/right
  const handleScroll = useCallback((source: 'left' | 'right') => {
    if (syncing.current) return;
    syncing.current = true;
    const l = leftRef.current;
    const r = rightRef.current;
    if (!l || !r) {
      syncing.current = false;
      return;
    }
    if (source === 'left') r.scrollTop = l.scrollTop;
    else l.scrollTop = r.scrollTop;
    requestAnimationFrame(() => { syncing.current = false; });
  }, []);

  // Output = non-removed lines
  const output = useMemo(
    () => resultLines.filter((l) => !l.removed).map((l) => l.content).join('\n'),
    [resultLines]
  );

  const removedCount = useMemo(
    () => resultLines.filter((l) => l.removed).length,
    [resultLines]
  );

  // Actions
  const handleReExtract = useCallback(() => {
    const extracted = extractBqDml(originalContent) || '';
    const lines = extracted.split('\n');
    setResultLines(lines.map((content, i) => ({ content, removed: false, lineNum: i + 1 })));
    setLineEnd(lines.length);
  }, [originalContent]);

  const handleLineChange = useCallback((idx: number, value: string) => {
    setResultLines((prev) => {
      const next = [...prev];
      if (next[idx]) next[idx] = { ...next[idx], content: value };
      return next;
    });
  }, []);

  const toggleRemoved = useCallback((idx: number) => {
    setResultLines((prev) => {
      const next = [...prev];
      if (next[idx]) next[idx] = { ...next[idx], removed: !next[idx].removed };
      return next;
    });
  }, []);

  const handleCopyAll = useCallback(async () => {
    if (!output) return;
    await navigator.clipboard.writeText(output);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [output]);

  const handleCopyRange = useCallback(async () => {
    if (lineEnd > 0) {
      const lines = output.split('\n');
      await navigator.clipboard.writeText(lines.slice(0, lineEnd).join('\n'));
    }
  }, [lineEnd, output]);

  const handleApply = useCallback(() => {
    onApply(output.trim() || null);
    onOpenChange(false);
  }, [output, onApply, onOpenChange]);

  const fSizeMono = 'text-[10px] leading-[15px]';
  const hasResult = resultLines.length > 0;

  // Left panel: original procedure source
  const originalLines = originalContent.split('\n');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="full">
        {/* Header */}
        <DialogHeader className="px-3 pt-3 pb-0 shrink-0">
          <div className="flex items-center gap-1.5">
            <div className="flex items-center justify-center w-6 h-6 rounded-md bg-amber-500/10">
              <Scissors className="h-3.5 w-3.5 text-amber-500" />
            </div>
            <DialogTitle>{t('procedure.title', '存储过程转换')}</DialogTitle>
            <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded-full">
              自动提取 DML · 可编辑 · 可删除行
            </span>
          </div>
          <DialogDescription className="leading-tight">
            从 CREATE PROCEDURE 体中提取 DML/SELECT，支持 EXECUTE IMMEDIATE 和 SET 变量
          </DialogDescription>
        </DialogHeader>

        {/* Toolbar */}
        <div className="flex items-center justify-between px-3 py-1.5 border-b shrink-0 bg-muted/20">
          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              className="h-7 gap-1 bg-amber-500 hover:bg-amber-600 text-white text-[11px] px-2.5"
              onClick={handleReExtract}
            >
              <RefreshCw className="h-3 w-3" />
              重新提取
            </Button>
            {removedCount > 0 && (
              <span className="text-[10px] text-muted-foreground">
                已删除 {removedCount} 行
              </span>
            )}
          </div>

          <div className="flex items-center gap-1.5">
            {output && (
              <>
                <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                  <span>复制行</span>
                  <span className="font-mono bg-muted px-1 rounded">1</span>
                  <span>至</span>
                  <input
                    type="number"
                    value={lineEnd || ''}
                    min={1}
                    max={output.split('\n').length}
                    onChange={(e) => {
                      const v = parseInt(e.target.value, 10);
                      const max = output.split('\n').length;
                      if (!isNaN(v) && v >= 1 && v <= max) setLineEnd(v);
                    }}
                    className="w-12 h-5 text-center font-mono text-[10px] border rounded bg-background"
                  />
                  <Button size="sm" variant="outline" className="h-5 px-1.5 text-[10px]" onClick={handleCopyRange}>
                    <Copy className="h-2.5 w-2.5 mr-0.5" />
                    复制
                  </Button>
                </div>
                <Button size="sm" variant="outline" className="h-7 gap-1 text-[11px] px-2" onClick={handleCopyAll}>
                  {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
                  {copied ? '已复制' : '复制全部'}
                </Button>
              </>
            )}
          </div>
        </div>

        {/* Two-column editor */}
        <div className="flex-1 min-h-0 flex overflow-hidden">
          {/* Left: Original procedure source */}
          <div className="flex-1 min-w-0 flex flex-col border-r">
            <div className="flex items-center gap-1 px-2 py-1 border-b bg-muted/10 shrink-0">
              <span className="text-[10px] text-muted-foreground">原始存储过程 ({originalLines.length} 行)</span>
            </div>
            <div className="flex-1 min-h-0 flex overflow-hidden">
              <div ref={leftRef} className="flex-1 min-w-0 overflow-auto bg-background" onScroll={() => handleScroll('left')}>
                {originalLines.map((line, idx) => (
                  <div key={idx} className="flex items-start h-[15px]">
                    <span className="w-8 shrink-0 text-right pr-1 select-none font-mono text-[9px] leading-[15px] text-muted-foreground/50">
                      {idx + 1}
                    </span>
                    <span className={cn('flex-1 whitespace-pre pr-2 overflow-hidden font-mono', fSizeMono)}>
                      {line}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Middle: keep/delete actions */}
          {hasResult && (
            <div className="w-10 shrink-0 flex flex-col border-r bg-muted/5">
              <div className="h-[25px] border-b shrink-0" />
              <div className="flex-1 min-h-0 overflow-hidden" ref={(el) => {
                if (el && leftRef.current) el.scrollTop = leftRef.current.scrollTop;
              }}>
                {resultLines.map((line, idx) => (
                  <div key={idx} className="flex items-center justify-center gap-0.5" style={{ height: '15px' }}>
                    <button
                      title="标记为删除"
                      onClick={() => { if (!line.removed) toggleRemoved(idx); }}
                      className={cn('p-0 rounded hover:bg-red-100', line.removed && 'bg-red-100')}
                    >
                      <ArrowLeft className={cn('h-2.5 w-2.5', line.removed ? 'text-red-500' : 'text-muted-foreground/40 hover:text-red-400')} />
                    </button>
                    <button
                      title="保留此行"
                      onClick={() => { if (line.removed) toggleRemoved(idx); }}
                      className={cn('p-0 rounded hover:bg-green-100', !line.removed && 'bg-green-100')}
                    >
                      <ArrowRight className={cn('h-2.5 w-2.5', !line.removed ? 'text-green-500' : 'text-muted-foreground/40 hover:text-green-400')} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Right: Extracted DML (editable) */}
          <div className="flex-1 min-w-0 flex flex-col">
            <div className="flex items-center justify-between px-2 py-1 border-b bg-muted/10 shrink-0">
              <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                <Wand2 className="h-3 w-3 text-amber-500" />
                <span>提取的 DML（可编辑）</span>
                {hasResult && <span className="text-muted-foreground/60">({resultLines.length} 行)</span>}
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="h-5 px-1.5 text-[10px] text-amber-500 hover:text-amber-600"
                onClick={handleApply}
                disabled={!output.trim()}
              >
                <Check className="h-2.5 w-2.5 mr-0.5" />
                应用
              </Button>
            </div>

            {hasResult ? (
              <div ref={rightRef} className="flex-1 min-h-0 overflow-auto bg-background" onScroll={() => handleScroll('right')}>
                {resultLines.map((line, idx) => (
                  <div
                    key={idx}
                    className={cn(
                      'flex items-start h-[15px]',
                      line.removed && 'bg-red-500/[0.06]',
                    )}
                  >
                    <span className={cn('w-8 shrink-0 text-right pr-1 select-none font-mono text-[9px] leading-[15px]', line.removed ? 'text-red-400' : 'text-muted-foreground')}>
                      {line.lineNum}
                    </span>
                    {editingIdx !== idx ? (
                      <span
                        className={cn(
                          'flex-1 whitespace-pre pr-2 overflow-hidden cursor-text font-mono',
                          fSizeMono,
                          line.removed && 'text-red-500 line-through'
                        )}
                        onClick={() => !line.removed && setEditingIdx(idx)}
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
                        className={cn(
                          'flex-1 min-w-0 pr-2 border-0 outline-none bg-transparent font-mono',
                          fSizeMono,
                          'focus:bg-amber-500/5'
                        )}
                        spellCheck={false}
                      />
                    )}
                  </div>
                ))}
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
