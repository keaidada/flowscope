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
import { Wand2, Copy, Check, RotateCcw, Scissors } from 'lucide-react';
import { extractBqDml } from '@/lib/procedure-utils';
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
  const [copied, setCopied] = useState(false);

  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const syncing = useRef(false);

  // Extract on open
  useEffect(() => {
    if (open && originalContent) {
      const extracted = extractBqDml(originalContent) || '';
      setTransformedContent(extracted);
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

  const handleReExtract = useCallback(() => {
    const extracted = extractBqDml(originalContent) || '';
    setTransformedContent(extracted);
  }, [originalContent]);

  const handleCopyAll = useCallback(async () => {
    if (!transformedContent) return;
    await navigator.clipboard.writeText(transformedContent);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [transformedContent]);

  const handleApply = useCallback(() => {
    onApply(transformedContent.trim() || null);
    onOpenChange(false);
  }, [transformedContent, onApply, onOpenChange]);

  const originalLines = useMemo(() => originalContent.split('\n'), [originalContent]);
  const transformedLines = useMemo(() => transformedContent.split('\n'), [transformedContent]);
  const fSizeMono = 'text-[10px] leading-[15px]';

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
              {originalLines.length} → {transformedLines.length} 行
            </span>
          </div>
          <DialogDescription className="leading-tight">
            自动过滤 DECLARE/SET/控制流，保留 DML/SELECT
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
          </div>

          <div className="flex items-center gap-1.5">
            {transformedContent && (
              <>
                <Button size="sm" variant="outline" className="h-7 gap-1 text-[11px] px-2" onClick={handleCopyAll}>
                  {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
                  {copied ? '已复制' : '复制全部'}
                </Button>
              </>
            )}
          </div>
        </div>

        {/* Two-column view */}
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
                <div key={idx} className="flex items-start h-[15px]">
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

          {/* Right: Transformed */}
          <div className="flex-1 min-w-0 flex flex-col">
            <div className="flex items-center justify-between px-2 py-1 border-b bg-muted/10 shrink-0">
              <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                <Wand2 className="h-3 w-3 text-amber-500" />
                <span>转换结果 ({transformedLines.length} 行)</span>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="h-5 px-1.5 text-[10px] text-amber-500 hover:text-amber-600"
                onClick={handleApply}
                disabled={!transformedContent.trim()}
              >
                <Check className="h-2.5 w-2.5 mr-0.5" />
                应用
              </Button>
            </div>

            {transformedContent ? (
              <div ref={rightRef} className="flex-1 min-h-0 overflow-auto bg-background" onScroll={() => handleScroll('right')}>
                {transformedLines.map((line, idx) => (
                  <div key={idx} className="flex items-start h-[15px]">
                    <span className="w-8 shrink-0 text-right pr-1 select-none font-mono text-[9px] leading-[15px] text-muted-foreground/40">
                      {idx + 1}
                    </span>
                    <span className={cn('flex-1 whitespace-pre pr-2 overflow-hidden font-mono', fSizeMono)}>
                      {line}
                    </span>
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
