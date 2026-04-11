import {
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Maximize,
  Minimize,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

interface LayoutModeToggleProps {
  sidebarOpen: boolean;
  editorOpen: boolean;
  onToggleSidebar: () => void;
  onToggleEditor: () => void;
  onToggleAll: () => void;
}

export function LayoutModeToggle({
  sidebarOpen,
  editorOpen,
  onToggleSidebar,
  onToggleEditor,
  onToggleAll,
}: LayoutModeToggleProps) {
  const { t } = useTranslation();
  const allOpen = sidebarOpen && editorOpen;

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex items-center rounded-lg border bg-muted/30 p-0.5 gap-0.5">
        {/* Toggle sidebar */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={onToggleSidebar}
              className={cn(
                'flex items-center justify-center h-6 w-6 rounded-md transition-all duration-150',
                sidebarOpen
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              )}
              aria-label={t('layout.toggleSidebar')}
              aria-pressed={sidebarOpen}
            >
              {sidebarOpen ? (
                <PanelLeftClose className="h-3.5 w-3.5" />
              ) : (
                <PanelLeftOpen className="h-3.5 w-3.5" />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <p>{sidebarOpen ? t('layout.hideSidebar') : t('layout.showSidebar')}</p>
          </TooltipContent>
        </Tooltip>

        {/* Toggle all: expand all or collapse to lineage only */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={onToggleAll}
              className={cn(
                'flex items-center justify-center h-6 w-6 rounded-md transition-all duration-150',
                !allOpen
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              )}
              aria-label={allOpen ? t('layout.collapseAll') : t('layout.expandAll')}
            >
              {allOpen ? (
                <Maximize className="h-3.5 w-3.5" />
              ) : (
                <Minimize className="h-3.5 w-3.5" />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <p>{allOpen ? t('layout.collapseAll') : t('layout.expandAll')}</p>
          </TooltipContent>
        </Tooltip>

        {/* Toggle editor */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={onToggleEditor}
              className={cn(
                'flex items-center justify-center h-6 w-6 rounded-md transition-all duration-150',
                editorOpen
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              )}
              aria-label={t('layout.toggleEditor')}
              aria-pressed={editorOpen}
            >
              {editorOpen ? (
                <PanelRightClose className="h-3.5 w-3.5" />
              ) : (
                <PanelRightOpen className="h-3.5 w-3.5" />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <p>{editorOpen ? t('layout.hideEditor') : t('layout.showEditor')}</p>
          </TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  );
}
