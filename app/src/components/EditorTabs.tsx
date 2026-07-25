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

  useEffect(() => {
    if (!scrollRef.current || !activeFileId) return;
    const el = scrollRef.current.querySelector(`[data-tab-id="${activeFileId}"]`);
    if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [activeFileId]);

  if (openFiles.length === 0) return null;

  return (
    <div className="flex items-stretch h-[36px] shrink-0 bg-background border-b">
      <div
        ref={scrollRef}
        className="flex items-stretch overflow-x-auto overflow-y-hidden scrollbar-none flex-1"
      >
        {openFiles.map((file) => {
          const isActive = file.id === activeFileId;
          return (
            <div
              key={file.id}
              data-tab-id={file.id}
              className={cn(
                'group relative flex items-center gap-1 px-3 py-0 cursor-pointer select-none shrink-0 border-r',
                'text-[13px] leading-none transition-colors duration-100',
                isActive
                  ? 'bg-background text-foreground font-medium'
                  : 'text-muted-foreground hover:text-foreground bg-muted/30 hover:bg-muted/50',
                // Active tab: top accent border, no bottom border (connected to content)
                isActive && 'border-t-2 border-t-primary border-b-background -mb-px'
              )}
              style={isActive ? { borderBottomColor: 'transparent' } : undefined}
              onClick={() => onSelectTab(file.id)}
              onMouseDown={(e) => {
                // Middle-click to close
                if (e.button === 1) {
                  e.preventDefault();
                  onCloseTab(file.id);
                }
              }}
            >
              {/* Status dot for procedure files */}
              {file.isProcedure && (
                <span className={cn(
                  'w-1.5 h-1.5 rounded-full shrink-0',
                  file.transformedContent ? 'bg-green-500' : 'bg-amber-500'
                )} />
              )}
              <span className="truncate max-w-[160px]">{file.name}</span>
              <div
                className={cn(
                  'flex items-center justify-center w-5 h-5 rounded-sm shrink-0',
                  'hover:bg-muted-foreground/15',
                  // Always visible for active, on hover for inactive
                  isActive ? 'opacity-70' : 'opacity-0 group-hover:opacity-70',
                )}
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseTab(file.id);
                }}
              >
                <X className="h-3.5 w-3.5" />
              </div>
            </div>
          );
        })}
      </div>

      {/* Batch actions dropdown */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="px-2 hover:bg-muted/50 shrink-0 border-l flex items-center">
            <ChevronDown className="h-3 w-3 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-36">
          <DropdownMenuItem onClick={() => onCloseAll()}>
            全部关闭
          </DropdownMenuItem>
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
    </div>
  );
}
