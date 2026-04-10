import { useState } from 'react';
import { ChevronDown, Plus, FolderOpen, Trash, Server } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { clearAnalysisWorkerCache } from '@/lib/analysis-worker';
import { useProject } from '@/lib/project-store';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { ProjectMenuItem } from './ProjectMenuItem';

interface ProjectSelectorProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/**
 * Keyboard handler for interactive dropdown sections.
 * Stops propagation for all keys except Escape, allowing the dropdown to close.
 */
function handleDropdownSectionKeyDown(e: React.KeyboardEvent): void {
  if (e.key === 'Escape') return;
  e.stopPropagation();
}

/**
 * Click handler for interactive dropdown sections.
 * Stops propagation to prevent the dropdown from closing.
 */
function handleDropdownSectionClick(e: React.MouseEvent): void {
  e.stopPropagation();
}

export function ProjectSelector({ open: controlledOpen, onOpenChange }: ProjectSelectorProps) {
  const { t } = useTranslation();
  const {
    projects,
    activeProjectId,
    currentProject,
    selectProject,
    createProject,
    deleteProject,
    renameProject,
    isBackendMode,
    backendWatchDirs,
  } = useProject();

  const [isCreating, setIsCreating] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [internalOpen, setInternalOpen] = useState(false);

  const open = controlledOpen ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;

  const handleCreate = () => {
    const trimmedName = newProjectName.trim();
    if (trimmedName) {
      try {
        createProject(trimmedName);
        setNewProjectName('');
        setIsCreating(false);
        setOpen(false);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        toast.error(t('project.createFailed', { message }));
      }
    }
  };

  const handleOpenChange = (newOpen: boolean) => {
    setOpen(newOpen);
    if (!newOpen) {
      setIsCreating(false);
      setNewProjectName('');
    }
  };

  const handleSelectProject = (projectId: string) => {
    selectProject(projectId);
    setOpen(false);
  };

  // In serve mode, show a simple indicator with the watched folder path
  if (isBackendMode) {
    const displayName =
      backendWatchDirs.length === 1
        ? backendWatchDirs[0]
        : backendWatchDirs.length > 1
          ? t('project.folders', { count: backendWatchDirs.length })
          : t('project.staticFiles');

    const tooltipContent =
      backendWatchDirs.length > 1
        ? backendWatchDirs.join('\n')
        : backendWatchDirs.length === 1
          ? backendWatchDirs[0]
          : t('project.servingStatic');

    return (
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <div
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm"
              data-testid="serve-mode-indicator"
            >
              <div className="flex size-6 items-center justify-center rounded-md border bg-background">
                <Server className="size-3.5" />
              </div>
              <span className="font-medium truncate max-w-[300px]">{displayName}</span>
            </div>
          </TooltipTrigger>
          <TooltipContent side="bottom" align="start" className="max-w-md">
            <p className="text-xs whitespace-pre-wrap break-all">{tooltipContent}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return (
    <DropdownMenu open={open} onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm focus:outline-hidden"
          data-testid="project-selector-trigger"
        >
          <div className="flex size-6 items-center justify-center rounded-md border bg-background">
            <FolderOpen className="size-3.5" />
          </div>
          <span className="font-medium">{currentProject?.name || t('project.selectProject')}</span>
          <ChevronDown className="size-4 opacity-50" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="min-w-64 rounded-lg" align="start" sideOffset={8}>
        <TooltipProvider delayDuration={300}>
          <DropdownMenuLabel className="text-xs text-muted-foreground flex items-center justify-between">
            <span>{t('project.projects')}</span>
            <kbd className="hidden sm:inline-flex h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium">
              <span className="text-xs">⌘</span>P
            </kbd>
          </DropdownMenuLabel>

          {projects.map((project) => (
            <ProjectMenuItem
              key={project.id}
              project={project}
              isActive={activeProjectId === project.id}
              canDelete={projects.length > 1}
              onSelect={() => handleSelectProject(project.id)}
              onRename={(newName) => renameProject(project.id, newName)}
              onDelete={() => deleteProject(project.id)}
            />
          ))}

          <DropdownMenuSeparator />

          {isCreating ? (
            <div
              className="p-2"
              onClick={handleDropdownSectionClick}
              onKeyDown={handleDropdownSectionKeyDown}
            >
              <div className="flex gap-2">
                <Input
                  value={newProjectName}
                  onChange={(e) => setNewProjectName(e.target.value)}
                  placeholder={t('project.projectName')}
                  className="h-8 text-sm"
                  maxLength={50}
                  autoFocus
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleCreate();
                    }
                    if (e.key === 'Escape') {
                      e.preventDefault();
                      setIsCreating(false);
                      setNewProjectName('');
                    }
                  }}
                  data-testid="new-project-input"
                />
                <Button
                  size="sm"
                  className="h-8 px-3"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    handleCreate();
                  }}
                  disabled={!newProjectName.trim()}
                  data-testid="create-project-btn"
                >
                  {t('common.add')}
                </Button>
              </div>
            </div>
          ) : (
            <DropdownMenuItem
              onSelect={(e) => {
                e.preventDefault();
                setIsCreating(true);
              }}
              className="gap-2 p-2"
              data-testid="new-project-btn"
            >
              <div className="flex size-6 items-center justify-center rounded-md border bg-transparent">
                <Plus className="size-4" />
              </div>
              <span className="font-medium">{t('project.addProject')}</span>
            </DropdownMenuItem>
          )}

          <DropdownMenuSeparator />

          <DropdownMenuItem
            onSelect={async (event) => {
              event.preventDefault();
              const confirmed = window.confirm(
                'Clear analysis cache? This will force re-analysis of all files.'
              );
              if (!confirmed) {
                return;
              }
              try {
                await clearAnalysisWorkerCache();
                toast.success('Analysis cache cleared');
              } catch (error) {
                console.error('Failed to clear analysis cache', error);
                toast.error('Failed to clear analysis cache');
              } finally {
                setOpen(false);
              }
            }}
            className="gap-2 p-2 text-muted-foreground"
            data-testid="clear-cache-btn"
          >
            <div className="flex size-6 items-center justify-center rounded-md border bg-transparent">
              <Trash className="size-3.5" />
            </div>
            <span>{t('project.clearCache')}</span>
          </DropdownMenuItem>
        </TooltipProvider>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
