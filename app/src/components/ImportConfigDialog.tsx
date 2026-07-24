import { useState, useMemo, useCallback } from 'react';
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
import { Badge } from '@/components/ui/badge';
import { FileCode, AlertCircle, Wand2 } from 'lucide-react';
import type { Dialect, ProjectFile } from '@/lib/project-store';
import { DIALECT_OPTIONS } from '@/lib/dialect-constants';

interface PendingFile {
  file: File;
  name: string;
  path: string;
  content: string;
  language: ProjectFile['language'];
  isProcedure: boolean;
}

interface ImportConfigDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pendingFiles: PendingFile[];
  currentDialect: Dialect;
  onConfirm: (dialect: Dialect, files: ProjectFile[]) => void;
}

function detectStoredProcedure(content: string): boolean {
  const upper = content.toUpperCase();
  return upper.includes('CREATE PROCEDURE') || upper.includes('CREATE PROC');
}

export function ImportConfigDialog({
  open,
  onOpenChange,
  pendingFiles,
  currentDialect,
  onConfirm,
}: ImportConfigDialogProps) {
  const [dialect, setDialect] = useState<Dialect>(currentDialect);

  const procedureFiles = useMemo(() => {
    return pendingFiles.filter((f) => detectStoredProcedure(f.content));
  }, [pendingFiles]);

  const nonProcedureFiles = useMemo(() => {
    return pendingFiles.filter((f) => !detectStoredProcedure(f.content));
  }, [pendingFiles]);

  const handleConfirm = useCallback(() => {
    const projectFiles: ProjectFile[] = pendingFiles.map((f) => {
      const isProc = detectStoredProcedure(f.content);
      return {
        id: crypto.randomUUID(),
        name: f.name,
        path: f.path,
        content: f.content,
        language: f.language,
        dialect,
        isProcedure: isProc,
        transformedContent: null,
      };
    });
    onConfirm(dialect, projectFiles);
    onOpenChange(false);
  }, [pendingFiles, dialect, onConfirm, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>导入文件配置</DialogTitle>
          <DialogDescription>
            选择 SQL 引擎类型，系统将自动检测存储过程。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <label className="text-sm font-medium">引擎类型</label>
            <Select
              value={dialect}
              onValueChange={(v) => setDialect(v as Dialect)}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="选择方言" />
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

          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm">
              <FileCode className="h-4 w-4 text-muted-foreground" />
              <span className="font-medium">
                共 {pendingFiles.length} 个文件
              </span>
            </div>

            {procedureFiles.length > 0 && (
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <Wand2 className="h-4 w-4 text-amber-500" />
                  <span className="text-sm font-medium text-amber-600 dark:text-amber-400">
                    检测到 {procedureFiles.length} 个存储过程
                  </span>
                </div>
                <div className="max-h-32 overflow-y-auto space-y-1 pl-6">
                  {procedureFiles.map((f, i) => (
                    <div
                      key={i}
                      className="flex items-center gap-2 text-xs text-muted-foreground"
                    >
                      <span className="truncate">{f.path}</span>
                      <Badge variant="outline" className="text-[10px] h-4 px-1 py-0">
                        存过
                      </Badge>
                    </div>
                  ))}
                </div>
                {dialect !== 'bigquery' && procedureFiles.length > 0 && (
                  <div className="flex items-start gap-2 pl-6 pt-1">
                    <AlertCircle className="h-3.5 w-3.5 text-muted-foreground mt-0.5 shrink-0" />
                    <p className="text-xs text-muted-foreground">
                      非 BigQuery 存储过程的自动转换尚不支持，导入后可使用魔棒工具手动处理。
                    </p>
                  </div>
                )}
              </div>
            )}

            {nonProcedureFiles.length > 0 && (
              <p className="text-xs text-muted-foreground pl-6">
                {nonProcedureFiles.length} 个普通 SQL 文件
              </p>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={handleConfirm}>
            确认导入
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export type { PendingFile };
