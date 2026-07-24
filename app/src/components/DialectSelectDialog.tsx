import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { Dialect } from '@/lib/dialect-constants';
import { DIALECT_OPTIONS } from '@/lib/dialect-constants';

interface DialectSelectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentDialect: Dialect;
  onConfirm: (dialect: Dialect) => void;
}

export function DialectSelectDialog({
  open,
  onOpenChange,
  currentDialect,
  onConfirm,
}: DialectSelectDialogProps) {
  const [dialect, setDialect] = useState<Dialect>(currentDialect);

  const handleConfirm = () => {
    onConfirm(dialect);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[380px]">
        <DialogHeader>
          <DialogTitle>选择 SQL 引擎</DialogTitle>
          <DialogDescription>
            选择引擎类型后继续上传文件。
          </DialogDescription>
        </DialogHeader>

        <div className="py-4">
          <Select
            value={dialect}
            onValueChange={(v) => setDialect(v as Dialect)}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="选择引擎" />
            </SelectTrigger>
            <SelectContent>
              {DIALECT_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={handleConfirm}>
            下一步
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
