import { useState } from 'react';
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
import {
  Loader2,
  FolderTree,
  XCircle,
  CheckCircle,
  Copy,
  Check,
  Boxes,
} from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';

interface DbtConvertFolderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  folderPath: string;
  /** SQL files to convert */
  sqlFiles: string[];
  /** Total files in the folder (for display) */
  totalFileCount: number;
  isConverting: boolean;
  convertProgress: { done: number; total: number } | null;
  convertResult: {
    success: string[];
    errors: string[];
  } | null;
  onConfirm: () => void;
}

function DbtFileListDialog({
  open,
  onOpenChange,
  title,
  files,
  icon,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  files: string[];
  icon: 'success' | 'error';
}) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [copied, setCopied] = useState(false);

  const allSelected = files.length > 0 && selected.size === files.length;
  const toggleAll = () => {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(files.map((_, i) => i)));
  };
  const toggleOne = (i: number) => {
    const next = new Set(selected);
    if (next.has(i)) next.delete(i);
    else next.add(i);
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
      <DialogContent size="md" className="w-fit min-w-[380px] max-h-[80vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {icon === 'success' ? (
              <CheckCircle className="h-4 w-4 text-green-500" />
            ) : (
              <XCircle className="h-4 w-4 text-red-500" />
            )}
            {title} ({files.length})
            {selected.size > 0 && (
              <span className="text-xs text-muted-foreground font-normal">
                — {t('editor.selectedCount', { count: selected.size })}
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        <div className="flex items-center gap-2 px-1 pb-1 border-b">
          <Checkbox checked={allSelected} onCheckedChange={toggleAll} />
          <button
            className="text-xs text-muted-foreground hover:text-foreground"
            onClick={toggleAll}
          >
            {allSelected ? t('editor.unselect') : t('editor.selectAll')}
          </button>
          {selected.size > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 ml-auto text-xs"
              onClick={copySelected}
            >
              {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
              <span className="ml-1">{copied ? t('editor.copied') : t('editor.copySelected')}</span>
            </Button>
          )}
        </div>

        <div className="max-h-[55vh] overflow-y-auto text-xs">
          {files.map((p, i) => (
            <div key={i} className="flex items-start gap-1.5 py-0.5 px-1 hover:bg-muted/50">
              <Checkbox
                checked={selected.has(i)}
                onCheckedChange={() => toggleOne(i)}
                className="mt-0.5 shrink-0"
              />
              <span
                className="font-mono text-muted-foreground break-all cursor-pointer flex-1"
                onClick={() => toggleOne(i)}
              >
                {p}
              </span>
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {t('common.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function DbtConvertFolderDialog({
  open,
  onOpenChange,
  folderPath,
  sqlFiles,
  totalFileCount,
  isConverting,
  convertProgress,
  convertResult,
  onConfirm,
}: DbtConvertFolderDialogProps) {
  const { t } = useTranslation();
  const [listType, setListType] = useState<'success' | 'errors' | null>(null);
  const completed = convertProgress && convertProgress.done >= convertProgress.total;

  const successCount = convertResult?.success.length ?? 0;
  const errorCount = convertResult?.errors.length ?? 0;

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
      <Dialog
        open={open}
        onOpenChange={(open) => {
          if (!isConverting) onOpenChange(open);
        }}
      >
        <DialogContent size="lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Boxes className="h-4 w-4 text-blue-500" />
              {t('editor.convertDbtFolder', '批量转换 dbt')}
            </DialogTitle>
            <DialogDescription>{t('editor.convertDbtFolderDesc', '将文件夹下的 SQL 脚本转换为 dbt 模型格式')}</DialogDescription>
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
                  <div className="text-xs text-muted-foreground">{t('editor.totalFilesInFolder', '文件夹内文件')}</div>
                </div>
                <div className="rounded-lg border p-3 text-center">
                  <div className="text-2xl font-bold text-blue-500">{sqlFiles.length}</div>
                  <div className="text-xs text-muted-foreground">{t('editor.sqlFilesToConvert', '待转换 SQL 文件')}</div>
                </div>
              </div>
            )}

            {/* File list preview (before confirm) */}
            {!isConverting && !completed && sqlFiles.length > 0 && (
              <div className="rounded-lg border overflow-hidden">
                <div className="px-3 py-1.5 bg-muted/30 border-b text-xs font-medium text-muted-foreground">
                  {t('editor.filesToConvert', '将转换以下文件')}
                </div>
                <div className="max-h-40 overflow-y-auto text-xs">
                  {sqlFiles.map((p) => (
                    <div key={p} className="px-3 py-1 font-mono text-muted-foreground truncate hover:bg-muted/50" title={p}>
                      {p}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {(isConverting || completed) && convertProgress && (
              <div className="space-y-2">
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>{completed ? t('convert.complete') : t('convert.converting')}</span>
                  <span>
                    {convertProgress.done} / {convertProgress.total}
                  </span>
                </div>
                <div className="h-2 rounded-full bg-muted overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-300 ${
                      completed ? 'bg-green-500' : 'bg-blue-500'
                    }`}
                    style={{
                      width: `${convertProgress.total > 0 ? (convertProgress.done / convertProgress.total) * 100 : 0}%`,
                    }}
                  />
                </div>
              </div>
            )}

            {completed && convertResult && (
              <div className="grid grid-cols-2 gap-2">
                {successCount > 0
                  ? resultCard(t('editor.convertSuccess', '个转换成功'), successCount, 'text-green-600', () =>
                      setListType('success')
                    )
                  : resultCard(t('editor.convertSuccess', '个转换成功'), successCount, 'text-green-600')}
                {errorCount > 0
                  ? resultCard(t('editor.convertErrors', '个失败'), errorCount, 'text-red-600', () =>
                      setListType('errors')
                    )
                  : resultCard(t('editor.convertErrors', '个失败'), errorCount, 'text-red-600')}
              </div>
            )}
          </div>

          <DialogFooter>
            {completed ? (
              <Button onClick={() => onOpenChange(false)}>{t('convert.done')}</Button>
            ) : (
              <>
                <Button
                  variant="outline"
                  onClick={() => onOpenChange(false)}
                  disabled={isConverting}
                >
                  {t('common.cancel')}
                </Button>
                <Button onClick={onConfirm} disabled={sqlFiles.length === 0 || isConverting}>
                  {isConverting ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      {t('convert.converting')}
                    </>
                  ) : (
                    t('editor.convertDbtN', { count: sqlFiles.length })
                  )}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {listType && convertResult && (
        <DbtFileListDialog
          open
          onOpenChange={() => setListType(null)}
          title={listType === 'success' ? t('editor.convertSuccess', '个转换成功') : t('editor.convertErrors', '个失败')}
          files={listType === 'success' ? convertResult.success : convertResult.errors}
          icon={listType === 'success' ? 'success' : 'error'}
        />
      )}
    </>
  );
}
