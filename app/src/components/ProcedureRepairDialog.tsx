import { useState, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation();
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
      <DialogContent size="full">
        <DialogHeader className="px-4 pt-4 pb-2 shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <Wand2 className="h-4 w-4" />
            {t('procedure.title')}
          </DialogTitle>
          <DialogDescription>
            {t('procedure.desc')}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 flex gap-0 min-h-0 px-4 pb-2">
          {/* Left: Original */}
          <div className="flex-1 flex flex-col min-w-0">
            <div className="text-xs text-muted-foreground mb-1 shrink-0">{t('procedure.original')}</div>
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
              {t('procedure.transformed')}
              <Button
                variant="ghost"
                size="sm"
                className="h-5 text-[10px] px-1"
                onClick={handleReExtract}
              >
                <RotateCcw className="h-3 w-3 mr-1" />
                {t('procedure.reExtract')}
              </Button>
            </div>
            <textarea
              className="flex-1 w-full resize-none rounded border bg-background p-2 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              value={transformedContent}
              onChange={(e) => setTransformedContent(e.target.value)}
              placeholder={t('procedure.noDml')}
            />
          </div>
        </div>

        <DialogFooter className="px-4 pb-3 shrink-0">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" onClick={handleApply} disabled={!transformedContent.trim()}>
            {t('procedure.apply')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
