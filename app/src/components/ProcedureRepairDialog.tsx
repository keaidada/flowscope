import { useState, useCallback, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Wand2, ArrowRight, RotateCcw } from 'lucide-react';
import { extractBqDml } from '@/lib/procedure-utils';

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
  const [transformedContent, setTransformedContent] = useState('');

  useEffect(() => {
    if (open && originalContent) {
      const extracted = extractBqDml(originalContent) || '';
      setTransformedContent(extracted);
    }
  }, [open, originalContent]);

  const handleReExtract = useCallback(() => {
    const extracted = extractBqDml(originalContent) || '';
    setTransformedContent(extracted);
  }, [originalContent]);

  const handleApply = useCallback(() => {
    const trimmed = transformedContent.trim();
    onApply(trimmed || null);
    onOpenChange(false);
  }, [transformedContent, onApply, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[95vw] w-[1400px] h-[85vh] p-0 gap-0 flex flex-col">
        <DialogHeader className="px-4 pt-4 pb-2 shrink-0">
          <DialogTitle className="text-sm flex items-center gap-2">
            <Wand2 className="h-4 w-4" />
            存储过程 DML 提取
          </DialogTitle>
          <DialogDescription className="text-xs">
            左：原始存储过程（只读） &nbsp; 右：提取的 DML（可编辑） &nbsp; 点击应用后保存为转换结果
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 flex gap-0 min-h-0 px-4 pb-2">
          {/* Left: Original */}
          <div className="flex-1 flex flex-col min-w-0">
            <div className="text-xs text-muted-foreground mb-1 shrink-0">原始脚本（只读）</div>
            <textarea
              className="flex-1 w-full resize-none rounded border bg-muted/30 p-2 font-mono text-xs"
              value={originalContent}
              readOnly
            />
          </div>

          {/* Divider */}
          <div className="flex items-center px-2 shrink-0">
            <ArrowRight className="h-4 w-4 text-muted-foreground" />
          </div>

          {/* Right: Transformed */}
          <div className="flex-1 flex flex-col min-w-0">
            <div className="text-xs text-muted-foreground mb-1 shrink-0 flex items-center gap-2">
              转换结果（可编辑）
              <Button variant="ghost" size="sm" className="h-5 text-[10px] px-1" onClick={handleReExtract}>
                <RotateCcw className="h-3 w-3 mr-1" />
                重新提取
              </Button>
            </div>
            <textarea
              className="flex-1 w-full resize-none rounded border p-2 font-mono text-xs"
              value={transformedContent}
              onChange={(e) => setTransformedContent(e.target.value)}
              placeholder="未提取到 DML 语句"
            />
          </div>
        </div>

        <DialogFooter className="px-4 pb-3 shrink-0">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button size="sm" onClick={handleApply} disabled={!transformedContent.trim()}>
            应用
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
