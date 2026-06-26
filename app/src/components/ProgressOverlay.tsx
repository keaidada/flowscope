import { Loader2, CheckCircle2 } from 'lucide-react';

interface Props {
  visible: boolean;
  title?: string;
  progress?: number; // 0-100
  loaded?: number;
  total?: number;
  currentFile?: string;
  batch?: string;        // e.g. "批次 5/36"
  stage?: string;         // current stage label for secondary info
  done?: boolean;
}

export default function ProgressOverlay({
  visible,
  title,
  progress = 0,
  loaded,
  total,
  currentFile,
  batch,
  stage,
  done,
}: Props) {
  if (!visible) return null;
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
      <div className="bg-card border rounded-xl shadow-lg p-5 w-[420px] space-y-3">
        <div className="flex items-center gap-3">
          {done ? (
            <CheckCircle2 className="h-6 w-6 text-green-500" />
          ) : (
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          )}
          <div>
            <div className="text-sm font-semibold">{title ?? (done ? '完成' : '操作中')}</div>
            {typeof loaded === 'number' && typeof total === 'number' && total > 0 && (
              <div className="text-xs text-muted-foreground">{`${loaded.toLocaleString()} / ${total.toLocaleString()} 个文件`}</div>
            )}
            {batch && (
              <div className="text-xs text-muted-foreground">{batch}</div>
            )}
            {stage && (
              <div className="text-xs text-muted-foreground">{stage}</div>
            )}
          </div>
        </div>

        <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
          <div
            className="h-full rounded-full bg-primary transition-all duration-300"
            style={{ width: `${Math.max(0, Math.min(100, progress))}%` }}
          />
        </div>

        {currentFile && !batch && (
          <div className="text-xs text-muted-foreground truncate">{currentFile}</div>
        )}
      </div>
    </div>
  );
}
