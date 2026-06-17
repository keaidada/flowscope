import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import {
  Wand2,
  Copy,
  Check,
  ArrowLeftRight,
  FileCode,
  RefreshCw,
  X,
  ArrowRight,
  ArrowLeft,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { processEtl, getEtlSummary, mergeLines, inlineDiff } from '@/lib/etl-utils';
import type { MergedLine } from '@/lib/etl-utils';
import { cn } from '@/lib/utils';

interface EtlDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialContent?: string;
  onApplyResult?: (content: string) => void;
}

export function EtlDialog({ open, onOpenChange, initialContent = '', onApplyResult }: EtlDialogProps) {
  const [input, setInput] = useState(initialContent);
  const [mergedLines, setMergedLines] = useState<MergedLine[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [lineEnd, setLineEnd] = useState<number>(0);
  const [summary, setSummary] = useState('');
  const [showRemoved, setShowRemoved] = useState(true);
  const [editingLineIdx, setEditingLineIdx] = useState<number | null>(null);

  const leftScrollRef = useRef<HTMLTextAreaElement>(null);
  const leftGutterRef = useRef<HTMLDivElement>(null);
  const middleScrollRef = useRef<HTMLDivElement>(null);
  const rightScrollRef = useRef<HTMLDivElement>(null);
  const syncing = useRef(false);

  /** Sync scroll between left textarea and its line-number gutter. */
  const handleLeftScroll = useCallback(() => {
    const textarea = leftScrollRef.current;
    const gutter = leftGutterRef.current;
    if (textarea && gutter) {
      gutter.scrollTop = textarea.scrollTop;
    }
  }, []);

  /** Synchronized scrolling between left textarea and right panel (proportional). */
  const handleScroll = useCallback((source: 'left' | 'right') => {
    if (syncing.current) return;
    syncing.current = true;

    const leftEl = leftScrollRef.current;
    const middleEl = middleScrollRef.current;
    const rightEl = rightScrollRef.current;
    if (!leftEl || !rightEl) {
      syncing.current = false;
      return;
    }

    if (source === 'left') {
      const ratio = leftEl.scrollTop / Math.max(leftEl.scrollHeight - leftEl.clientHeight, 1);
      rightEl.scrollTop = ratio * Math.max(rightEl.scrollHeight - rightEl.clientHeight, 1);
      if (middleEl) middleEl.scrollTop = ratio * Math.max(middleEl.scrollHeight - middleEl.clientHeight, 1);
      // Sync left gutter (direct scrollTop, not proportional)
      const gutter = leftGutterRef.current;
      if (gutter) gutter.scrollTop = leftEl.scrollTop;
    } else {
      const ratio = rightEl.scrollTop / Math.max(rightEl.scrollHeight - rightEl.clientHeight, 1);
      leftEl.scrollTop = ratio * Math.max(leftEl.scrollHeight - leftEl.clientHeight, 1);
      if (middleEl) middleEl.scrollTop = ratio * Math.max(middleEl.scrollHeight - middleEl.clientHeight, 1);
      if (leftGutterRef.current) leftGutterRef.current.scrollTop = leftEl.scrollTop;
    }

    requestAnimationFrame(() => {
      syncing.current = false;
    });
  }, []);

  // The raw output (non-removed lines only) for copy/apply
  const output = useMemo(
    () => mergedLines.filter((l) => !l.removed).map((l) => l.content).join('\n'),
    [mergedLines]
  );

  // Reset state when dialog opens
  useEffect(() => {
    if (open) {
      setInput(initialContent);
      setMergedLines([]);
      setSummary('');
      setShowRemoved(true);
      setCopied(false);
    }
  }, [open, initialContent]);

  // Update lineEnd when output changes
  useEffect(() => {
    const lines = output.split('\n');
    setLineEnd(lines.length);
  }, [output]);

  // Count removed lines
  const removedCount = useMemo(
    () => mergedLines.filter((l) => l.removed).length,
    [mergedLines]
  );

  const handleProcess = useCallback(() => {
    if (!input.trim()) return;

    setIsProcessing(true);
    setTimeout(() => {
      try {
        const result = processEtl(input);
        const lines = mergeLines(input, result);
        setMergedLines(lines);
        setSummary(getEtlSummary(input, result));
      } catch {
        setMergedLines([]);
        setSummary('处理出错');
      }
      setIsProcessing(false);
    }, 100);
  }, [input]);

  const handleCopyAll = useCallback(async () => {
    if (!output) return;
    await navigator.clipboard.writeText(output);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [output]);

  const handleCopyRange = useCallback(async () => {
    if (lineEnd > 0) {
      const outLines = output.split('\n');
      await navigator.clipboard.writeText(outLines.slice(0, lineEnd).join('\n'));
    }
  }, [lineEnd, output]);

  /** Update a single merged line's content. Keeps originalContent for diffing user edits. */
  const handleLineChange = useCallback((idx: number, value: string) => {
    setMergedLines((prev) => {
      const next = [...prev];
      if (next[idx]) {
        const line = next[idx];
        // Only update content; keep originalContent so we can diff user edits
        next[idx] = { ...line, content: value };
      }
      return next;
    });
  }, []);

  /** Toggle whether a merged line is marked as removed. */
  const toggleRemoved = useCallback((idx: number) => {
    setMergedLines((prev) => {
      const next = [...prev];
      if (next[idx]) {
        next[idx] = { ...next[idx], removed: !next[idx].removed };
      }
      return next;
    });
  }, []);

  const fSizeMono = 'text-[10px] leading-[15px]';
  const hasResult = mergedLines.length > 0;

  /** Render a kept line with ETL-diff (yellow) and user-edit (cyan) highlights. */
  const renderLineWithHighlights = useCallback((line: MergedLine) => {
    const userEdited = line.content !== line.originalContent;

    if (userEdited) {
      // User edited: diff originalContent → content, show user changes in cyan
      const diff = inlineDiff(line.originalContent, line.content);
      return diff.map((seg, si) => (
        <span
          key={si}
          className={cn(seg.highlight && 'bg-cyan-300/60 rounded-sm')}
        >
          {seg.text}
        </span>
      ));
    }

    // ETL-processed only: show ETL changes in yellow
    if (line.changed || line.added) {
      return line.segments.map((seg, si) => (
        <span
          key={si}
          className={cn(seg.highlight && 'bg-yellow-300/60 rounded-sm')}
        >
          {seg.text}
        </span>
      ));
    }

    // Unchanged: plain text
    return <>{line.content}</>;
  }, []);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[98vw] w-[1500px] h-[90vh] p-0 gap-0 flex flex-col">
        {/* Header */}
        <DialogHeader className="px-3 pt-3 pb-0 shrink-0">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <div className="flex items-center justify-center w-6 h-6 rounded-md bg-orange-500/10">
                <Wand2 className="h-3.5 w-3.5 text-orange-500" />
              </div>
              <DialogTitle className="text-sm">ETL 工具</DialogTitle>
              {summary && (
                <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded-full">
                  {summary}
                </span>
              )}
            </div>
          </div>
          <DialogDescription className="text-[10px] leading-tight">
            自动替换模板变量 <code className="bg-muted px-0.5 rounded text-[9px]">{'{var}'}</code> →{' '}
            <code className="bg-muted px-0.5 rounded text-[9px]">{"'{var}'"}</code>，支持 PySpark 提取 SQL
          </DialogDescription>
        </DialogHeader>

        {/* Toolbar */}
        <div className="flex items-center justify-between px-3 py-1.5 border-b shrink-0 bg-muted/20">
          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              onClick={handleProcess}
              disabled={!input.trim() || isProcessing}
              className="h-7 gap-1 bg-orange-500 hover:bg-orange-600 text-white text-[11px] px-2.5"
            >
              {isProcessing ? (
                <RefreshCw className="h-3 w-3 animate-spin" />
              ) : (
                <ArrowLeftRight className="h-3 w-3" />
              )}
              处理
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
                      if (!isNaN(v) && v >= 1 && v <= max) {
                        setLineEnd(v);
                      }
                    }}
                    className="w-12 h-5 text-center font-mono text-[10px] border rounded bg-background"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-5 px-1.5 text-[10px]"
                    onClick={handleCopyRange}
                  >
                    <Copy className="h-2.5 w-2.5 mr-0.5" />
                    复制
                  </Button>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 gap-1 text-[11px] px-2"
                  onClick={handleCopyAll}
                >
                  {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
                  {copied ? '已复制' : '复制全部'}
                </Button>
              </>
            )}
          </div>
        </div>

        {/* Two-column editor area */}
        <div className="flex-1 min-h-0 flex overflow-hidden">
          {/* Left: Original input with line numbers */}
          <div className="flex-1 min-w-0 flex flex-col border-r">
            <div className="flex items-center justify-between px-2 py-1 border-b bg-muted/10 shrink-0">
              <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                <FileCode className="h-3 w-3" />
                <span>原始输入</span>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="h-5 px-1.5 text-[10px]"
                onClick={() => { setInput(''); setMergedLines([]); }}
                disabled={!input}
              >
                <X className="h-2.5 w-2.5 mr-0.5" />清空
              </Button>
            </div>
            <div className="flex-1 min-h-0 flex overflow-hidden">
              {/* Line number gutter — on the left side of textarea */}
              <div
                ref={leftGutterRef}
                className="w-7 shrink-0 overflow-hidden bg-muted/5 border-r border-border/40 select-none"
              >
                <div className="font-mono text-[9px] leading-[15px] text-muted-foreground text-right pr-1 py-2">
                  {input.split('\n').map((_, i) => (
                    <div key={i} className="h-[15px]">{i + 1}</div>
                  ))}
                </div>
              </div>
              <textarea
                ref={leftScrollRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onScroll={() => { handleLeftScroll(); handleScroll('left'); }}
                className={cn(
                  'flex-1 min-w-0 resize-none bg-background p-2 font-mono outline-none border-0 focus:ring-0',
                  fSizeMono
                )}
                placeholder="粘贴原始 SQL 或 PySpark 脚本..."
                spellCheck={false}
              />
            </div>
          </div>

          {/* Middle: action arrows (keep / delete) */}
          {hasResult && (
            <div className="w-12 shrink-0 flex flex-col border-r bg-muted/5">
              <div className="h-[29px] border-b shrink-0 flex items-center justify-center bg-muted/10">
                <span className="text-[8px] text-muted-foreground">操作</span>
              </div>
              <div
                ref={middleScrollRef}
                className="flex-1 min-h-0 overflow-hidden"
              >
                {mergedLines.map((line, idx) => {
                  if (line.removed && !showRemoved && line.content.trim()) return null;
                  return (
                    <div
                      key={idx}
                      className="flex items-center justify-center gap-0.5"
                      style={{ height: '15px' }}
                    >
                      <button
                        title="标记为删除"
                        onClick={() => { if (!line.removed) toggleRemoved(idx); }}
                        className={cn(
                          'p-0 rounded hover:bg-red-100 transition-colors',
                          line.removed && 'bg-red-100'
                        )}
                      >
                        <ArrowLeft
                          className={cn(
                            'h-2.5 w-2.5',
                            line.removed ? 'text-red-500' : 'text-muted-foreground/40 hover:text-red-400'
                          )}
                        />
                      </button>
                      <button
                        title="保留此行"
                        onClick={() => { if (line.removed) toggleRemoved(idx); }}
                        className={cn(
                          'p-0 rounded hover:bg-green-100 transition-colors',
                          !line.removed && 'bg-green-100'
                        )}
                      >
                        <ArrowRight
                          className={cn(
                            'h-2.5 w-2.5',
                            !line.removed ? 'text-green-500' : 'text-muted-foreground/40 hover:text-green-400'
                          )}
                        />
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Right: Processed result (editable) */}
          <div className="flex-1 min-w-0 flex flex-col">
            <div className="flex items-center justify-between px-2 py-1 border-b bg-muted/10 shrink-0">
              <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                <Wand2 className="h-3 w-3 text-orange-500" />
                <span>处理后结果（可编辑）</span>
                {hasResult && (
                  <span className="text-muted-foreground/60">({mergedLines.length} 行)</span>
                )}
              </div>
              {onApplyResult && output && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 px-1.5 text-[10px] text-orange-500 hover:text-orange-600"
                  onClick={() => onApplyResult(output)}
                >
                  应用到编辑器
                </Button>
              )}
            </div>

            {hasResult ? (
              <div
                ref={rightScrollRef}
                className="flex-1 min-h-0 overflow-auto bg-background"
                onScroll={() => handleScroll('right')}
              >
                {mergedLines.map((line, idx) => {
                  if (line.removed && !showRemoved && line.content.trim()) return null;

                  return (
                    <div
                      key={idx}
                      className={cn(
                        'flex items-start',
                        'h-[15px]',
                        line.removed && 'bg-red-500/[0.06]',
                        !line.removed && line.added && 'bg-green-500/10 border-l-[3px] border-l-green-500',
                        !line.removed && !line.added && line.changed && 'bg-orange-500/10 border-l-[3px] border-l-orange-500'
                      )}
                    >
                      <span
                        className={cn(
                          'w-7 shrink-0 text-right pr-1 select-none',
                          'text-[9px] leading-[15px]',
                          line.removed && 'text-red-400',
                          !line.removed && 'text-muted-foreground'
                        )}
                      >
                        {line.lineNum}
                      </span>

                      {line.removed ? (
                        <span
                          className={cn(
                            'flex-1 whitespace-pre pr-2 select-all overflow-hidden',
                            fSizeMono,
                            'text-red-500 line-through'
                          )}
                        >
                          {line.content}
                        </span>
                      ) : editingLineIdx !== idx ? (
                        <span
                          className={cn(
                            'flex-1 whitespace-pre pr-2 overflow-hidden cursor-text',
                            fSizeMono,
                            'font-mono'
                          )}
                          onClick={() => setEditingLineIdx(idx)}
                          title="点击编辑"
                        >
                          {renderLineWithHighlights(line)}
                        </span>
                      ) : (
                        <input
                          type="text"
                          value={line.content}
                          onChange={(e) => handleLineChange(idx, e.target.value)}
                          onBlur={() => setEditingLineIdx(null)}
                          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') setEditingLineIdx(null); }}
                          autoFocus={editingLineIdx === idx}
                          className={cn(
                            'flex-1 min-w-0 pr-2 border-0 outline-none bg-transparent overflow-hidden',
                            fSizeMono,
                            'font-mono',
                            'focus:bg-orange-500/5 focus:ring-1 focus:ring-inset focus:ring-orange-500/30'
                          )}
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
                  <ArrowLeftRight className="h-4 w-4 mx-auto opacity-30" />
                  <p>点击"处理"按钮开始转换</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
