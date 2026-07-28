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
  Scissors,
} from 'lucide-react';
import { extractBqDml } from '@/lib/procedure-utils';
import { inlineDiff } from '@/lib/etl-utils';
import { cn } from '@/lib/utils';

interface ProcedureRepairDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  originalContent: string;
  onApply: (transformedContent: string | null) => void;
}

/**
 * A merged line: either kept (extracted DML) or removed (filtered out).
 * Mirrors EtlDialog's MergedLine but simpler.
 */
interface MergedLine {
  /** Content of this line */
  content: string;
  /** True = filtered out by extraction (red strikethrough) */
  removed: boolean;
  /** True = line was modified during extraction (yellow highlight) */
  changed: boolean;
  /** Inline diff segments for changed lines */
  segments: Array<{ text: string; highlight: boolean }>;
  /** 1-based line number in the original source */
  origLineNum: number;
  /** 1-based line number in the output (kept lines only) */
  outLineNum: number;
}

/**
 * Merge original procedure source with extracted DML.
 * Each original line maps to either a kept line (DML) or removed line (filtered).
 * Lines that changed during extraction get diff segments.
 */
function mergeProcedureLines(original: string, extracted: string): MergedLine[] {
  const origLines = original.split('\n');
  const extLines = extracted.split('\n');

  // Build a set of extracted lines for matching (trimmed comparison)
  const extSet = new Map<string, number>(); // trimmed line → output line number
  extLines.forEach((line, i) => {
    const key = line.trim();
    if (key) extSet.set(key, i + 1);
  });

  const result: MergedLine[] = [];
  let outNum = 0;

  // Track which extracted lines have been matched
  const matchedExt = new Set<number>();

  for (let i = 0; i < origLines.length; i++) {
    const origLine = origLines[i];
    const trimmed = origLine.trim();

    // Try to find this original line in the extracted output
    let matchedIdx = -1;
    for (let j = 0; j < extLines.length; j++) {
      if (matchedExt.has(j)) continue;
      const extTrimmed = extLines[j].trim();
      // Exact match or one is substring of other (extraction may modify slightly)
      if (trimmed && extTrimmed && (trimmed === extTrimmed || extTrimmed.includes(trimmed) || trimmed.includes(extTrimmed))) {
        matchedIdx = j;
        break;
      }
    }

    if (matchedIdx >= 0) {
      matchedExt.add(matchedIdx);
      outNum++;
      const extLine = extLines[matchedIdx];
      const isChanged = origLine.trim() !== extLine.trim();
      result.push({
        content: extLine,
        removed: false,
        changed: isChanged,
        segments: isChanged ? inlineDiff(origLine, extLine) : [{ text: extLine, highlight: false }],
        origLineNum: i + 1,
        outLineNum: outNum,
      });
    } else {
      // This original line was filtered out
      result.push({
        content: origLine,
        removed: true,
        changed: false,
        segments: [],
        origLineNum: i + 1,
        outLineNum: 0,
      });
    }
  }

  // Add any remaining extracted lines that weren't matched (new/added lines)
  for (let j = 0; j < extLines.length; j++) {
    if (!matchedExt.has(j) && extLines[j].trim()) {
      outNum++;
      result.push({
        content: extLines[j],
        removed: false,
        changed: true,
        segments: [{ text: extLines[j], highlight: true }],
        origLineNum: 0,
        outLineNum: outNum,
      });
    }
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
  const [lineEnd, setLineEnd] = useState(0);
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [userRemoved, setUserRemoved] = useState<Set<number>>(new Set());

  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const syncing = useRef(false);

  // Extract + merge on open
  useEffect(() => {
    if (open && originalContent) {
      const extracted = extractBqDml(originalContent) || '';
      const merged = mergeProcedureLines(originalContent, extracted);
      setMergedLines(merged);
      const keptCount = merged.filter((l) => !l.removed).length;
      setLineEnd(keptCount);
      setUserRemoved(new Set());
      setEditingIdx(null);
    }
  }, [open, originalContent]);

  // Sync scroll
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

  // Output = non-removed, non-user-deleted lines
  const output = useMemo(() => {
    return mergedLines
      .filter((l, i) => !l.removed && !userRemoved.has(i))
      .map((l) => l.content)
      .join('\n');
  }, [mergedLines, userRemoved]);

  const removedCount = useMemo(
    () => mergedLines.filter((l) => l.removed).length + userRemoved.size,
    [mergedLines, userRemoved]
  );

  // Actions
  const handleReExtract = useCallback(() => {
    const extracted = extractBqDml(originalContent) || '';
    const merged = mergeProcedureLines(originalContent, extracted);
    setMergedLines(merged);
    setUserRemoved(new Set());
    setLineEnd(merged.filter((l) => !l.removed).length);
  }, [originalContent]);

  const handleLineChange = useCallback((idx: number, value: string) => {
    setMergedLines((prev) => {
      const next = [...prev];
      if (next[idx]) {
        next[idx] = { ...next[idx], content: value, segments: [{ text: value, highlight: false }] };
      }
      return next;
    });
  }, []);

  const toggleUserRemoved = useCallback((idx: number) => {
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
  const hasResult = mergedLines.length > 0;

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
            从 CREATE PROCEDURE 体中提取 DML/SELECT，过滤行以红色删除线标识
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
              <RotateCcw className="h-3 w-3" />
              重新提取
            </Button>
            {removedCount > 0 && (
              <span className="text-[10px] text-red-500">
                已过滤 {removedCount} 行
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

        {/* Two-column editor — left and right have same line count, scroll synced */}
        <div className="flex-1 min-h-0 flex overflow-hidden">
          {/* Left: Original procedure source (all lines, matching right 1:1) */}
          <div className="flex-1 min-w-0 flex flex-col border-r">
            <div className="flex items-center gap-1 px-2 py-1 border-b bg-muted/10 shrink-0">
              <span className="text-[10px] text-muted-foreground">
                原始存储过程 ({mergedLines.length} 行)
              </span>
            </div>
            <div ref={leftRef} className="flex-1 min-h-0 overflow-auto bg-background" onScroll={() => handleScroll('left')}>
              {mergedLines.map((line, idx) => (
                <div
                  key={idx}
                  className={cn(
                    'flex items-start h-[15px]',
                    line.removed && 'bg-red-500/[0.06]',
                  )}
                >
                  <span className="w-8 shrink-0 text-right pr-1 select-none font-mono text-[9px] leading-[15px] text-muted-foreground/40">
                    {line.origLineNum || ''}
                  </span>
                  <span
                    className={cn(
                      'flex-1 whitespace-pre pr-2 overflow-hidden font-mono',
                      fSizeMono,
                      line.removed && 'text-red-500 line-through opacity-60',
                    )}
                  >
                    {line.content}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Middle: keep/delete toggle */}
          {hasResult && (
            <div className="w-10 shrink-0 flex flex-col border-r bg-muted/5">
              <div className="h-[25px] border-b shrink-0" />
              <div className="flex-1 min-h-0 overflow-hidden">
                {mergedLines.map((line, idx) => {
                  const isUserRemoved = userRemoved.has(idx);
                  const isFiltered = line.removed;
                  return (
                    <div key={idx} className="flex items-center justify-center gap-0.5" style={{ height: '15px' }}>
                      {!isFiltered && (
                        <>
                          <button
                            title="标记为删除"
                            onClick={() => { if (!isUserRemoved) toggleUserRemoved(idx); }}
                            className={cn('p-0 rounded hover:bg-red-100', isUserRemoved && 'bg-red-100')}
                          >
                            <ArrowLeft className={cn('h-2.5 w-2.5', isUserRemoved ? 'text-red-500' : 'text-muted-foreground/40 hover:text-red-400')} />
                          </button>
                          <button
                            title="保留此行"
                            onClick={() => { if (isUserRemoved) toggleUserRemoved(idx); }}
                            className={cn('p-0 rounded hover:bg-green-100', !isUserRemoved && 'bg-green-100')}
                          >
                            <ArrowRight className={cn('h-2.5 w-2.5', !isUserRemoved ? 'text-green-500' : 'text-muted-foreground/40 hover:text-green-400')} />
                          </button>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Right: Extracted result (kept = editable, removed = red strikethrough) */}
          <div className="flex-1 min-w-0 flex flex-col">
            <div className="flex items-center justify-between px-2 py-1 border-b bg-muted/10 shrink-0">
              <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                <Wand2 className="h-3 w-3 text-amber-500" />
                <span>提取结果（可编辑）</span>
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
                {mergedLines.map((line, idx) => {
                  const isUserRemoved = userRemoved.has(idx);
                  return (
                    <div
                      key={idx}
                      className={cn(
                        'flex items-start h-[15px]',
                        line.removed && 'bg-red-500/[0.06]',
                        isUserRemoved && 'bg-red-500/[0.06]',
                        !line.removed && !isUserRemoved && line.changed && 'bg-amber-500/10 border-l-[3px] border-l-amber-500',
                      )}
                    >
                      <span className={cn(
                        'w-8 shrink-0 text-right pr-1 select-none font-mono text-[9px] leading-[15px]',
                        line.removed ? 'text-red-400' : 'text-muted-foreground'
                      )}>
                        {line.removed ? '-' : line.outLineNum}
                      </span>
                      {editingIdx === idx && !line.removed && !isUserRemoved ? (
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
                      ) : (
                        <span
                          className={cn(
                            'flex-1 whitespace-pre pr-2 overflow-hidden font-mono',
                            fSizeMono,
                            (line.removed || isUserRemoved) && 'text-red-500 line-through opacity-60 cursor-default',
                            !line.removed && !isUserRemoved && 'cursor-text',
                          )}
                          onClick={() => !line.removed && !isUserRemoved && setEditingIdx(idx)}
                          title={!line.removed && !isUserRemoved ? '点击编辑' : ''}
                        >
                          {/* Show diff highlights for changed lines */}
                          {!line.removed && !isUserRemoved && line.changed && line.segments.length > 1
                            ? line.segments.map((seg, si) => (
                                <span key={si} className={cn(seg.highlight && 'bg-amber-300/60 rounded-sm')}>
                                  {seg.text}
                                </span>
                              ))
                            : line.content}
                        </span>
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
