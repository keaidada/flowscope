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
  AlertTriangle,
  Copy,
  Check,
  Boxes,
  FileJson,
} from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';

interface DbtConvertFolderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  folderPath: string;
  /** dbt = convert to dbt model; yaml = generate semantic layer YAML */
  mode?: 'dbt' | 'yaml';
  /** SQL files to convert */
  sqlFiles: string[];
  /** Total files in the folder (for display) */
  totalFileCount: number;
  /** File metadata is still lazy-loading — list may be incomplete */
  loadingFiles?: boolean;
  isConverting: boolean;
  convertProgress: { done: number; total: number } | null;
  convertResult: {
    success: string[];
    errors: string[];
    skipped: string[] | number;
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
  icon: 'success' | 'error' | 'skipped';
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
            ) : icon === 'skipped' ? (
              <AlertTriangle className="h-4 w-4 text-amber-500" />
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
  mode = 'dbt',
  sqlFiles,
  totalFileCount,
  loadingFiles,
  isConverting,
  convertProgress,
  convertResult,
  onConfirm,
}: DbtConvertFolderDialogProps) {
  const { t } = useTranslation();
  const isYaml = mode === 'yaml';
  const [listType, setListType] = useState<'success' | 'errors' | 'skipped' | null>(null);
  const completed = convertProgress && convertProgress.done >= convertProgress.total;

  const successCount = convertResult?.success.length ?? 0;
  const errorCount = convertResult?.errors.length ?? 0;
  const skippedCount = Array.isArray(convertResult?.skipped)
    ? convertResult!.skipped.length
    : (convertResult?.skipped ?? 0);

  const resultCard = (label: string, count: number, color: string, onClick?: () => void) => (
    <div
      className={`rounded-lg border p-2 text-center transition-colors ${
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
        <DialogContent className="overflow-hidden w-[30rem] max-w-[90vw]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {isYaml ? (
                <FileJson className="h-4 w-4 text-purple-500" />
              ) : (
                <Boxes className="h-4 w-4 text-blue-500" />
              )}
              {isYaml
                ? t('editor.generateYamlFolder', '批量生成 YAML')
                : t('editor.convertDbtFolder', '批量转换 dbt')}
            </DialogTitle>
            <DialogDescription>
              {isYaml
                ? t('editor.generateYamlFolderDesc', '批量生成文件夹下 SQL 脚本的 Semantic YAML')
                : t('editor.convertDbtFolderDesc', '将文件夹下的 SQL 脚本转换为 dbt 模型格式')}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2 min-w-0 animate-in fade-in-0 slide-in-from-top-2 duration-200">
            <div className="flex items-center gap-2 text-sm text-muted-foreground min-w-0">
              <FolderTree className="h-4 w-4 shrink-0" />
              <span className="font-mono text-xs truncate">{folderPath}</span>
            </div>

            {loadingFiles && !completed && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-blue-500/30 bg-blue-500/5 text-xs text-blue-600 dark:text-blue-400">
                <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
                {t('editor.loadingFiles', '文件列表加载中，请稍候...')}
              </div>
            )}

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
              <div className="rounded-lg border overflow-hidden min-w-0 animate-in fade-in-0 duration-200">
                <div className="px-3 py-1.5 bg-muted/30 border-b text-xs font-medium text-muted-foreground">
                  {t('editor.filesToConvert', '将转换以下文件')}
                </div>
                <div className="max-h-40 overflow-y-auto text-xs min-w-0">
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
                    className={`h-full rounded-full transition-all duration-300 ease-out ${
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
              <div key="result" className="grid grid-cols-3 gap-2 animate-in fade-in-0 zoom-in-95 duration-300">
                {successCount > 0
                  ? resultCard(t('editor.convertSuccess', '转换成功'), successCount, 'text-green-600', () =>
                      setListType('success')
                    )
                  : resultCard(t('editor.convertSuccess', '转换成功'), successCount, 'text-green-600')}
                {skippedCount > 0
                  ? resultCard(
                      isYaml
                        ? t('editor.yamlSkipped', '跳过(无血缘数据)')
                        : t('editor.convertSkipped', '跳过(空文件)'),
                      skippedCount,
                      'text-amber-600',
                      () => setListType('skipped')
                    )
                  : resultCard(
                      isYaml
                        ? t('editor.yamlSkipped', '跳过(无血缘数据)')
                        : t('editor.convertSkipped', '跳过(空文件)'),
                      skippedCount,
                      'text-amber-600'
                    )}
                {errorCount > 0
                  ? resultCard(t('editor.convertErrors', '转换失败'), errorCount, 'text-red-600', () =>
                      setListType('errors')
                    )
                  : resultCard(t('editor.convertErrors', '转换失败'), errorCount, 'text-red-600')}
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
                <Button onClick={onConfirm} disabled={sqlFiles.length === 0 || isConverting || loadingFiles}>
                  {isConverting ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      {t('convert.converting')}
                    </>
                  ) : loadingFiles ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      {t('editor.loading', '加载中...')}
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
          title={
            listType === 'success'
              ? t('editor.convertSuccess', '个转换成功')
              : listType === 'skipped'
                ? t('editor.convertSkipped', '个跳过')
                : t('editor.convertErrors', '个失败')
          }
          files={
            listType === 'success'
              ? convertResult.success
              : listType === 'skipped'
                ? (Array.isArray(convertResult.skipped) ? convertResult.skipped : [])
                : convertResult.errors
          }
          icon={listType === 'success' ? 'success' : listType === 'skipped' ? 'skipped' : 'error'}
        />
      )}
    </>
  );
}
