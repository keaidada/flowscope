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
import { Loader2, FolderTree, AlertTriangle, XCircle, CheckCircle, Copy, Check } from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
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
  convertResult: { success: number; successPaths: string[]; empty: string[]; errors: string[] } | null;
  onConfirm: (dialect: Dialect) => void;
}

function FileListDialog({ open, onOpenChange, title, files, icon }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  files: string[];
  icon: 'success' | 'warn' | 'error';
}) {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [copied, setCopied] = useState(false);

  const allSelected = files.length > 0 && selected.size === files.length;
  const toggleAll = () => {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(files.map((_, i) => i)));
    }
  };
  const toggleOne = (i: number) => {
    const next = new Set(selected);
    if (next.has(i)) next.delete(i); else next.add(i);
    setSelected(next);
  };
  const copySelected = async () => {
    const paths = files.filter((_, i) => selected.has(i)).join('\n');
    await navigator.clipboard.writeText(paths);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[90vw] w-fit min-w-[380px] max-h-[80vh]">
        <DialogHeader>
          <DialogTitle className="text-sm flex items-center gap-2">
            {icon === 'success' ? (
              <CheckCircle className="h-4 w-4 text-green-500" />
            ) : icon === 'warn' ? (
              <AlertTriangle className="h-4 w-4 text-amber-500" />
            ) : (
              <XCircle className="h-4 w-4 text-red-500" />
            )}
            {title} ({files.length})
            {selected.size > 0 && (
              <span className="text-xs text-muted-foreground font-normal">
                — 已选 {selected.size}
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        <div className="flex items-center gap-2 px-1 pb-1 border-b">
          <Checkbox checked={allSelected} onCheckedChange={toggleAll} />
          <button className="text-xs text-muted-foreground hover:text-foreground" onClick={toggleAll}>
            {allSelected ? '取消全选' : '全选'}
          </button>
          {selected.size > 0 && (
            <Button variant="ghost" size="sm" className="h-6 ml-auto text-xs" onClick={copySelected}>
              {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
              <span className="ml-1">{copied ? '已复制' : '复制选中'}</span>
            </Button>
          )}
        </div>

        <div className="max-h-[55vh] overflow-y-auto text-xs">
          {files.map((p, i) => (
            <div
              key={i}
              className="flex items-start gap-1.5 py-0.5 px-1 hover:bg-muted/50"
            >
              <Checkbox
                checked={selected.has(i)}
                onCheckedChange={() => toggleOne(i)}
                className="mt-0.5 shrink-0"
              />
              <span className="font-mono text-muted-foreground break-all cursor-pointer flex-1" onClick={() => toggleOne(i)}>
                {p}
              </span>
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
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
  const [listType, setListType] = useState<'success' | 'empty' | 'errors' | null>(null);
  const completed = convertProgress && convertProgress.done >= convertProgress.total;

  const emptyCount = convertResult?.empty.length ?? 0;
  const errorCount = convertResult?.errors.length ?? 0;

  const handleConfirm = () => {
    onConfirm(dialect);
  };

  const resultCard = (label: string, count: number, color: string, onClick?: () => void) => (
    <div
      className={`rounded-lg border p-2 text-center ${
        onClick ? 'cursor-pointer hover:bg-muted/50' : ''
      }`}
      onClick={onClick}
    >
      <div className={`text-lg font-bold ${color}`}>{count}</div>
      <div className="text-[10px] text-muted-foreground">{label}</div>
    </div>
  );

  return (
    <>
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
                {dialect !== 'bigquery' && (
                  <p className="text-xs text-muted-foreground">
                    该引擎的存储过程转换尚未实现，仅支持 BigQuery。
                  </p>
                )}
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
              <div className="grid grid-cols-3 gap-2">
                {convertResult.success > 0
                  ? resultCard('成功', convertResult.success, 'text-green-600', () => setListType('success'))
                  : resultCard('成功', convertResult.success, 'text-green-600')
                }
                {emptyCount > 0
                  ? resultCard('无 DML', emptyCount, 'text-amber-600', () => setListType('empty'))
                  : resultCard('无 DML', emptyCount, 'text-amber-600')
                }
                {errorCount > 0
                  ? resultCard('异常', errorCount, 'text-red-600', () => setListType('errors'))
                  : resultCard('异常', errorCount, 'text-red-600')
                }
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

      {listType && convertResult && (
        <FileListDialog
          open
          onOpenChange={() => setListType(null)}
          title={
            listType === 'success' ? '成功转换' :
            listType === 'empty' ? '未提取到 DML' : '异常'
          }
          files={
            listType === 'success' ? convertResult.successPaths :
            listType === 'empty' ? convertResult.empty : convertResult.errors
          }
          icon={
            listType === 'success' ? 'success' :
            listType === 'empty' ? 'warn' : 'error'
          }
        />
      )}
    </>
  );
}
