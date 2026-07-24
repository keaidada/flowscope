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
import { Loader2, FolderTree } from 'lucide-react';
import type { Dialect } from '@/lib/dialect-constants';
import { DIALECT_OPTIONS } from '@/lib/dialect-constants';

interface ConvertFolderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  folderPath: string;
  procedureCount: number;
  totalFileCount: number;
  isConverting: boolean;
  onConfirm: (dialect: Dialect) => void;
}

export function ConvertFolderDialog({
  open,
  onOpenChange,
  folderPath,
  procedureCount,
  totalFileCount,
  isConverting,
  onConfirm,
}: ConvertFolderDialogProps) {
  const [dialect, setDialect] = useState<Dialect>('bigquery');

  const handleConfirm = () => {
    onConfirm(dialect);
  };

  return (
    <Dialog open={open} onOpenChange={(open) => { if (!isConverting) onOpenChange(open); }}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>批量转换存储过程</DialogTitle>
          <DialogDescription>
            将目录下所有存储过程提取为纯 DML 语句。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <FolderTree className="h-4 w-4" />
            <span className="font-mono text-xs truncate">{folderPath}</span>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg border p-3 text-center">
              <div className="text-2xl font-bold">{totalFileCount}</div>
              <div className="text-xs text-muted-foreground">总文件数</div>
            </div>
            <div className="rounded-lg border p-3 text-center">
              <div className="text-2xl font-bold text-amber-500">{procedureCount}</div>
              <div className="text-xs text-muted-foreground">存储过程</div>
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">引擎类型</label>
            <Select
              value={dialect}
              onValueChange={(v) => setDialect(v as Dialect)}
              disabled={isConverting}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
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
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isConverting}>
            取消
          </Button>
          <Button onClick={handleConfirm} disabled={procedureCount === 0 || isConverting}>
            {isConverting ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                转换中...
              </>
            ) : (
              `转换 ${procedureCount} 个存储过程`
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
