import { useRef, useEffect } from 'react';
import { X, ChevronDown } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import type { ProjectFile } from '@/lib/project-store';

interface EditorTabsProps {
  openFiles: ProjectFile[];
  activeFileId: string | null;
  onSelectTab: (fileId: string) => void;
  onCloseTab: (fileId: string) => void;
  onCloseAll: () => void;
  onCloseOthers: (fileId: string) => void;
  onCloseToLeft: (fileId: string) => void;
  onCloseToRight: (fileId: string) => void;
}

export function EditorTabs({
  openFiles,
  activeFileId,
  onSelectTab,
  onCloseTab,
  onCloseAll,
  onCloseOthers,
  onCloseToLeft,
  onCloseToRight,
}: EditorTabsProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll active tab into view
  useEffect(() => {
    if (!scrollRef.current || !activeFileId) return;
    const el = scrollRef.current.querySelector(`[data-tab-id="${activeFileId}"]`);
    if (el) {
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [activeFileId]);

  if (openFiles.length === 0) return null;

  return (
    <div className="flex items-center gap-0 min-w-0 flex-1 h-full">
      <div
        ref={scrollRef}
        className="flex items-center gap-0 overflow-x-auto overflow-y-hidden scrollbar-none h-full flex-1"
      >
        {openFiles.map((file) => {
          const isActive = file.id === activeFileId;
          return (
            <div
              key={file.id}
              data-tab-id={file.id}
              className={cn(
                'group flex items-center gap-0.5 h-full px-2 py-0 border-r cursor-pointer shrink-0 select-none',
                isActive
                  ? 'bg-background text-foreground border-t-2 border-t-primary'
                  : 'text-muted-foreground hover:bg-muted/50 border-t-2 border-t-transparent'
              )}
              onClick={() => onSelectTab(file.id)}
            >
              <span className="text-xs truncate max-w-[160px]">{file.name}</span>
              <button
                className="h-4 w-4 rounded-sm flex items-center justify-center opacity-0 group-hover:opacity-100 hover:bg-muted-foreground/20 shrink-0"
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseTab(file.id);
                }}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          );
        })}
      </div>

      {openFiles.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="h-full px-1.5 hover:bg-muted/50 shrink-0 border-r">
              <ChevronDown className="h-3 w-3 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-36">
            <DropdownMenuItem onClick={() => onCloseAll()}>全部关闭</DropdownMenuItem>
            {activeFileId && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => onCloseOthers(activeFileId)}>
                  关闭其他
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onCloseToLeft(activeFileId)}>
                  关闭左侧
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onCloseToRight(activeFileId)}>
                  关闭右侧
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
