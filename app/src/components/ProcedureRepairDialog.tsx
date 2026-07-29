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
import { extractDmlWithLineMap } from '@/lib/procedure-utils';
import { cn } from '@/lib/utils';

interface ProcedureRepairDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  originalContent: string;
  onApply: (transformedContent: string | null) => void;
}

export function ProcedureRepairDialog({
  open,
  onOpenChange,
  originalContent,
  onApply,
}: ProcedureRepairDialogProps) {
  const { t } = useTranslation();
  const [transformedContent, setTransformedContent] = useState('');
  const [lineMap, setLineMap] = useState<number[]>([]);
  const [userRemoved, setUserRemoved] = useState<Set<number>>(new Set());
  const [userKept, setUserKept] = useState<Set<number>>(new Set());
  const [showRemoved, setShowRemoved] = useState(true);
  const [copied, setCopied] = useState(false);

  const leftRef = useRef<HTMLDivElement>(null);
  const middleRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const syncing = useRef(false);

  useEffect(() => {
    if (open && originalContent) {
      extractDmlWithLineMap(originalContent).then((result) => {
        if (result) {
          setTransformedContent(result.dml);
          setLineMap(result.lineMap);
          console.log('[ProcedureRepair] lineMap first 10:', result.lineMap.slice(0, 10), 'dml first 80 chars:', result.dml.substring(0, 80));
        } else {
          setTransformedContent('');
          setLineMap([]);
        }
        setUserRemoved(new Set());
        setUserKept(new Set());
      });
    }
  }, [open, originalContent]);

  const originalLines = useMemo(() => originalContent.split('\n'), [originalContent]);

  // Build padded right panel using server-computed line map
  const rightLines = useMemo(() => {
    const dmlLines = transformedContent.split('\n');
    const result: string[] = new Array(originalLines.length).fill('');
    for (let i = 0; i < Math.min(lineMap.length, originalLines.length); i++) {
      const dmlIdx = lineMap[i];
      if (dmlIdx >= 0 && dmlIdx < dmlLines.length) {
        result[i] = dmlLines[dmlIdx];
      }
    }
    return result;
  }, [originalLines, transformedContent, lineMap]);

  // Output = DML lines (minus removed) + user-kept original lines
  const output = useMemo(() => {
    const kept: string[] = [];
    for (let i = 0; i < rightLines.length; i++) {
      if (userKept.has(i)) {
        kept.push(originalLines[i].trimEnd());
      } else if (rightLines[i] && !userRemoved.has(i)) {
        kept.push(rightLines[i]);
      }
    }
    return kept.join('\n');
  }, [rightLines, userRemoved, userKept, originalLines]);

  const removedCount = rightLines.filter((l) => !l).length + userRemoved.size;

  const handleScroll = useCallback((source: 'left' | 'right') => {
    if (syncing.current) return;
    syncing.current = true;
    const l = leftRef.current;
    const m = middleRef.current;
    const r = rightRef.current;
    if (!l || !r) { syncing.current = false; return; }
    const st = source === 'left' ? l.scrollTop : r.scrollTop;
    if (source === 'left') r.scrollTop = st;
    else l.scrollTop = st;
    if (m) m.scrollTop = st;
    requestAnimationFrame(() => { syncing.current = false; });
  }, []);

  const handleReExtract = useCallback(() => {
    extractDmlWithLineMap(originalContent).then((result) => {
      if (result) {
        setTransformedContent(result.dml);
        setLineMap(result.lineMap);
      }
      setUserRemoved(new Set());
    });
  }, [originalContent]);

  const toggleRemoved = useCallback((idx: number) => {
    setUserRemoved((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }, []);

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
  const dmlCount = rightLines.reduce((c, l, i) => c + (l && !userRemoved.has(i) ? 1 : 0), 0);

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
              {originalLines.length} → {output.split('\n').length} 行 DML · 已过滤 {removedCount}
            </span>
          </div>
          <DialogDescription className="leading-tight">
            左侧原始存储过程，右侧 AST 引擎提取的 DML（空行对齐），中间操作列可删除/恢复
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-between px-3 py-1.5 border-b shrink-0 bg-muted/20">
          <div className="flex items-center gap-1.5">
            <Button size="sm" className="h-7 gap-1 bg-amber-500 hover:bg-amber-600 text-white text-[11px] px-2.5" onClick={handleReExtract}>
              <RotateCcw className="h-3 w-3" />重新提取
            </Button>
            {removedCount > 0 && (
              <Button size="sm" variant="outline" className="h-7 px-2 text-[10px] gap-1" onClick={() => setShowRemoved((v) => !v)}>
                <X className={cn('h-2.5 w-2.5', !showRemoved && 'rotate-45')} />
                已删除 ({removedCount} 行)
              </Button>
            )}
          </div>
          {output && (
            <Button size="sm" variant="outline" className="h-7 gap-1 text-[11px] px-2" onClick={handleCopyAll}>
              {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
              {copied ? '已复制' : '复制全部'}
            </Button>
          )}
        </div>

        <div className="flex-1 min-h-0 flex overflow-hidden">
          {/* Left: Original */}
          <div className="flex-1 min-w-0 flex flex-col border-r">
            <div className="flex items-center gap-1 px-2 py-1 border-b bg-muted/10 shrink-0">
              <span className="text-[10px] text-muted-foreground">原始存储过程 ({originalLines.length} 行)</span>
            </div>
            <div ref={leftRef} className="flex-1 min-h-0 overflow-auto bg-background" onScroll={() => handleScroll('left')}>
              {originalLines.map((line, idx) => (
                <div key={`l-${idx}`} className="flex items-start h-[15px]">
                  <span className="w-8 shrink-0 text-right pr-1 select-none font-mono text-[9px] leading-[15px] text-muted-foreground/40">{idx + 1}</span>
                  <span className={cn('flex-1 whitespace-pre pr-2 overflow-hidden font-mono', fSizeMono)}>{line}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Middle: keep/delete */}
          <div className="w-12 shrink-0 flex flex-col border-r bg-muted/5">
            <div className="h-[29px] border-b shrink-0 flex items-center justify-center bg-muted/10">
              <span className="text-[8px] text-muted-foreground">操作</span>
            </div>
            <div ref={middleRef} className="flex-1 min-h-0 overflow-hidden">
              {rightLines.map((line, idx) => {
                const isAutoRemoved = !line;
                const isUserRemoved = userRemoved.has(idx);
                const isUserKept = userKept.has(idx);
                if (isAutoRemoved && !isUserKept && !showRemoved) return null;
                const isRemoved = (isAutoRemoved && !isUserKept) || isUserRemoved;
                return (
                  <div key={idx} className="flex items-center justify-center gap-0.5" style={{ height: '15px' }}>
                    <button
                      title={isUserKept ? '取消保留' : '删除'}
                      onClick={() => {
                        if (isUserKept) {
                          setUserKept(prev => { const n = new Set(prev); n.delete(idx); return n; });
                        } else if (line && !isRemoved) {
                          toggleRemoved(idx);
                        }
                      }}
                      className={cn('p-0 rounded hover:bg-red-100 transition-colors', (isRemoved || isUserKept) && 'bg-red-100')}
                    >
                      <ArrowLeft className={cn('h-2.5 w-2.5', isUserKept ? 'text-red-500' : isRemoved ? 'text-red-500' : 'text-muted-foreground/40 hover:text-red-400')} />
                    </button>
                    <button
                      title={isUserRemoved ? '恢复' : isAutoRemoved ? '保留原始' : ''}
                      onClick={() => {
                        if (isUserRemoved) { toggleRemoved(idx); }
                        else if (isAutoRemoved) { setUserKept(prev => { const n = new Set(prev); n.add(idx); return n; }); }
                      }}
                      className={cn('p-0 rounded hover:bg-green-100 transition-colors', (!isRemoved || isUserKept) && 'bg-green-100', isUserKept && 'ring-1 ring-blue-300')}
                    >
                      <ArrowRight className={cn('h-2.5 w-2.5', (!isRemoved || isUserKept) ? 'text-green-500' : 'text-muted-foreground/40 hover:text-green-400')} />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Right: Padded result */}
          <div className="flex-1 min-w-0 flex flex-col">
            <div className="flex items-center justify-between px-2 py-1 border-b bg-muted/10 shrink-0">
              <span className="text-[10px] text-muted-foreground">转换结果 ({dmlCount} 行 DML)</span>
              <Button variant="ghost" size="sm" className="h-5 px-1.5 text-[10px] text-amber-500 hover:text-amber-600" onClick={handleApply} disabled={!output.trim()}>应用</Button>
            </div>
            <div ref={rightRef} className="flex-1 min-h-0 overflow-auto bg-background" onScroll={() => handleScroll('right')}>
              {rightLines.map((line, idx) => {
                const isAutoRemoved = !line;
                const isUserRemoved = userRemoved.has(idx);
                const isUserKept = userKept.has(idx);
                const isRemoved = (isAutoRemoved && !isUserKept) || isUserRemoved;
                if (isRemoved && !showRemoved) return null;
                // For auto-removed lines, show original content in red strikethrough
                // instead of blank — user can see exactly what was deleted
                const displayText = isUserRemoved || isAutoRemoved
                  ? (originalLines[idx] || '\u00A0')
                  : line;
                return (
                  <div key={`r-${idx}`} className={cn('flex items-start h-[15px]', isRemoved && 'bg-red-500/[0.06]', isUserKept && 'bg-blue-500/[0.06]')}>
                    <span className={cn('w-8 shrink-0 text-right pr-1 select-none font-mono text-[9px] leading-[15px]', isRemoved && !isUserKept ? 'text-red-400' : isUserKept ? 'text-blue-400' : 'text-muted-foreground')}>{idx + 1}</span>
                    <span className={cn('flex-1 whitespace-pre pr-2 overflow-hidden font-mono', fSizeMono, (isUserRemoved || (isAutoRemoved && !isUserKept)) && 'text-red-500 line-through', isUserKept && 'text-blue-500')}>{displayText}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
