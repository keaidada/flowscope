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
import { Loader2, FolderTree, AlertTriangle, XCircle } from 'lucide-react';
import type { Dialect } from '@/lib/dialect-constants';
import { DIALECT_OPTIONS } from '@/lib/dialect-constants';

interface ConvertFolderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  folderPath: string;
  procedureCount: number;
  totalFileCount: number;
  isConverting: boolean;
  convertProgress: { done: number; total: number } | null;
  convertResult: { success: number; empty: string[]; errors: string[] } | null;
  onConfirm: (dialect: Dialect) => void;
}

export function ConvertFolderDialog({
  open,
  onOpenChange,
  folderPath,
  procedureCount,
  totalFileCount,
  isConverting,
  convertProgress,
  convertResult,
  onConfirm,
}: ConvertFolderDialogProps) {
  const [dialect, setDialect] = useState<Dialect>('bigquery');
  const [showDetails, setShowDetails] = useState(false);
  const completed = convertProgress && convertProgress.done >= convertProgress.total;

  const handleConfirm = () => {
    onConfirm(dialect);
  };

  return (
    <Dialog open={open} onOpenChange={(open) => { if (!isConverting) onOpenChange(open); }}>
      <DialogContent className="sm:max-w-[480px]">
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

          {!completed && (
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
          )}

          {!isConverting && !completed && (
            <div className="space-y-2">
              <label className="text-sm font-medium">引擎类型</label>
              <Select value={dialect} onValueChange={(v) => setDialect(v as Dialect)}>
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
          )}

          {(isConverting || completed) && convertProgress && (
            <div className="space-y-2">
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>{completed ? '完成' : '转换中...'}</span>
                <span>{convertProgress.done} / {convertProgress.total}</span>
              </div>
              <div className="h-2 rounded-full bg-muted overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-300 ${
                    completed ? 'bg-green-500' : 'bg-amber-500'
                  }`}
                  style={{ width: `${convertProgress.total > 0 ? (convertProgress.done / convertProgress.total) * 100 : 0}%` }}
                />
              </div>
            </div>
          )}

          {completed && convertResult && (
            <div className="space-y-3">
              <div className="grid grid-cols-3 gap-2">
                <div className="rounded-lg border border-green-200 bg-green-50 dark:bg-green-950/20 p-2 text-center">
                  <div className="text-lg font-bold text-green-600">{convertResult.success}</div>
                  <div className="text-[10px] text-muted-foreground">成功</div>
                </div>
                <div className="rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-950/20 p-2 text-center">
                  <div className="text-lg font-bold text-amber-600">{convertResult.empty.length}</div>
                  <div className="text-[10px] text-muted-foreground">无 DML</div>
                </div>
                <div className="rounded-lg border border-red-200 bg-red-50 dark:bg-red-950/20 p-2 text-center">
                  <div className="text-lg font-bold text-red-600">{convertResult.errors.length}</div>
                  <div className="text-[10px] text-muted-foreground">异常</div>
                </div>
              </div>

              {(convertResult.empty.length > 0 || convertResult.errors.length > 0) && (
                <div className="space-y-1">
                  <button
                    className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
                    onClick={() => setShowDetails(!showDetails)}
                  >
                    {showDetails ? '收起' : '展开'}详情
                  </button>

                  {showDetails && (
                    <div className="max-h-48 overflow-y-auto space-y-1 text-xs border rounded p-2">
                      {convertResult.empty.length > 0 && (
                        <div>
                          <div className="flex items-center gap-1 text-amber-600 font-medium mb-1">
                            <AlertTriangle className="h-3 w-3" />
                            未提取到 DML ({convertResult.empty.length}):
                          </div>
                          {convertResult.empty.slice(0, 50).map((p, i) => (
                            <div key={i} className="truncate pl-4 text-muted-foreground">{p}</div>
                          ))}
                          {convertResult.empty.length > 50 && (
                            <div className="pl-4 text-muted-foreground">
                              ...还有 {convertResult.empty.length - 50} 个
                            </div>
                          )}
                        </div>
                      )}
                      {convertResult.errors.length > 0 && (
                        <div className="mt-2">
                          <div className="flex items-center gap-1 text-red-600 font-medium mb-1">
                            <XCircle className="h-3 w-3" />
                            异常 ({convertResult.errors.length}):
                          </div>
                          {convertResult.errors.slice(0, 50).map((p, i) => (
                            <div key={i} className="truncate pl-4 text-red-500">{p}</div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          {completed ? (
            <Button onClick={() => onOpenChange(false)}>完成</Button>
          ) : (
            <>
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
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
