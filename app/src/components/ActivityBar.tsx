import { FolderOpen, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

export type SidebarView = 'files' | 'search' | null;

interface ActivityBarProps {
  activeView: SidebarView;
  onViewChange: (view: SidebarView) => void;
}

const ACTIVITY_ITEMS: Array<{
  id: SidebarView;
  icon: React.ElementType;
  labelKey: string;
  shortcut?: string;
}> = [
  { id: 'files', icon: FolderOpen, labelKey: 'activityBar.files', shortcut: '⌘⇧E' },
  { id: 'search', icon: Search, labelKey: 'activityBar.search', shortcut: '⌘⇧F' },
];

export function ActivityBar({ activeView, onViewChange }: ActivityBarProps) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col items-center w-12 bg-muted/30 border-r shrink-0 py-2 gap-1">
      <TooltipProvider delayDuration={300}>
        {ACTIVITY_ITEMS.map((item) => {
          const Icon = item.icon;
          const isActive = activeView === item.id;

          return (
            <Tooltip key={item.id}>
              <TooltipTrigger asChild>
                <button
                  onClick={() => onViewChange(isActive ? null : item.id)}
                  className={cn(
                    'flex items-center justify-center w-10 h-10 rounded-lg transition-all duration-150',
                    isActive
                      ? 'bg-background text-foreground shadow-sm border'
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
                  )}
                  aria-label={t(item.labelKey)}
                  aria-pressed={isActive}
                >
                  <Icon className="h-5 w-5" strokeWidth={isActive ? 2 : 1.5} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right" sideOffset={8}>
                <p className="flex items-center gap-2">
                  {t(item.labelKey)}
                  {item.shortcut && (
                    <kbd className="px-1.5 py-0.5 text-[10px] bg-muted rounded border font-mono">
                      {item.shortcut}
                    </kbd>
                  )}
                </p>
              </TooltipContent>
            </Tooltip>
          );
        })}
      </TooltipProvider>
    </div>
  );
}
