import { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import { Share2, Github } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { useLineageActions, useLineageState } from '@pondpilot/flowscope-react';
import { Button } from './ui/button';
import { FlowScopeLogo } from './FlowScopeLogo';
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from './ui/resizable';
import type { ImperativePanelHandle } from 'react-resizable-panels';

import { EditorArea } from './EditorArea';
import { AnalysisView } from './AnalysisView';
import { SidebarFileTree } from './SidebarFileTree';
import { SidebarSearch } from './SidebarSearch';
import { ActivityBar } from './ActivityBar';
import type { SidebarView } from './ActivityBar';
import { LayoutModeToggle } from './LayoutModeToggle';
import { ProjectSelector } from './ProjectSelector';
import { ShareDialog } from './ShareDialog';
import { ExportDialog } from './ExportDialog';
import { ThemeToggle } from './ThemeToggle';
import { LanguageToggle } from './LanguageToggle';
import { KeyboardShortcutsDialog } from './KeyboardShortcutsDialog';
import { CommandPalette } from './CommandPalette';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';
import { useProject } from '@/lib/project-store';
import { NavigationProvider } from '@/lib/navigation-context';
import { FocusRegistryProvider } from '@/lib/focus-registry';
import { useGlobalShortcuts, useAnalysis } from '@/hooks';
import type { GlobalShortcut } from '@/hooks';
import { useThemeStore, type Theme } from '@/lib/theme-store';
import { useViewStateStore } from '@/lib/view-state-store';
import { getShortcutDisplay } from '@/lib/shortcuts';
import { useBackend } from '@/lib/backend-context';

interface WorkspaceProps {
  backendReady: boolean;
  error: string | null;
  onRetry?: () => void;
  isRetrying?: boolean;
}

/**
 * Main workspace component containing the two-panel layout:
 * - Left: SQL editor with file selector
 * - Right: Lineage visualization
 */

export function Workspace({ backendReady, error, onRetry, isRetrying }: WorkspaceProps) {
  const { t } = useTranslation();
  const { currentProject, selectFile, activeProjectId, isBackendMode } = useProject();
  const { adapter } = useBackend();
  const analysis = useAnalysis(backendReady, { adapter });
  const lineageActions = useLineageActions();
  const {
    highlightSpan,
    setViewMode,
    toggleColumnEdges,
    setAllNodesCollapsed,
    toggleShowScriptTables,
    setLayoutAlgorithm,
  } = lineageActions;
  const lineageState = useLineageState();
  const { result, viewMode, layoutAlgorithm } = lineageState;
  const [projectSelectorOpen, setProjectSelectorOpen] = useState(false);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [shortcutsDialogOpen, setShortcutsDialogOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [sidebarView, setSidebarView] = useState<SidebarView>('files');
  const [editorOpen, setEditorOpen] = useState(true);

  // Theme cycling for keyboard shortcut
  const { theme, setTheme } = useThemeStore();
  const cycleTheme = useCallback(() => {
    const themes: Theme[] = ['light', 'dark', 'system'];
    const currentIndex = themes.indexOf(theme);
    const nextTheme = themes[(currentIndex + 1) % themes.length];
    setTheme(nextTheme);
    toast.success(t('theme.changed', { theme: nextTheme.charAt(0).toUpperCase() + nextTheme.slice(1) }));
  }, [theme, setTheme]);

  const editorPanelRef = useRef<ImperativePanelHandle>(null);
  const graphContainerRef = useRef<HTMLDivElement>(null);

  // Use ref for currentProject to avoid recreating callback on every project change
  const currentProjectRef = useRef(currentProject);
  useEffect(() => {
    currentProjectRef.current = currentProject;
  }, [currentProject]);

  // Handler for navigating to a file in the editor
  // Uses ref to avoid dependency on currentProject object which changes frequently
  const handleNavigateToEditor = useCallback(
    (sourceName: string, span?: { start: number; end: number }) => {
      if (!sourceName?.trim()) {
        return;
      }

      const project = currentProjectRef.current;
      if (!project?.files) {
        toast.error(t('errors.cannotOpenFile'), {
          description: t('errors.noProjectLoaded'),
        });
        return;
      }

      // Normalize the source name for comparison (handle different path separators)
      const normalizeForComparison = (path: string) => path.replace(/\\/g, '/').toLowerCase();
      const normalizedSource = normalizeForComparison(sourceName);

      // Find the file by name - try exact match first, then by path
      let file = project.files.find((f) => f.name === sourceName);
      if (!file) {
        // Try matching by path (sourceName might be a path)
        file = project.files.find((f) => f.path === sourceName);
      }
      if (!file) {
        // Try normalized path match (handle different path separators and case)
        file = project.files.find(
          (f) =>
            normalizeForComparison(f.name) === normalizedSource ||
            normalizeForComparison(f.path) === normalizedSource
        );
      }
      if (!file) {
        // Try partial match (sourceName might be just filename without path)
        file = project.files.find(
          (f) =>
            normalizeForComparison(f.name).endsWith(normalizedSource) ||
            normalizeForComparison(f.path).endsWith(normalizedSource)
        );
      }

      if (!file) {
        if (import.meta.env.DEV) {
          console.warn(
            `[Workspace] Cannot navigate to editor: file "${sourceName}" not found. Available files:`,
            project.files.map((f) => ({ name: f.name, path: f.path }))
          );
        }
        toast.error(t('errors.fileNotFound'), {
          description: t('errors.fileNotLocated', { name: sourceName }),
        });
        return;
      }

      selectFile(file.id);
      // Expand the editor panel if collapsed
      if (editorPanelRef.current?.isCollapsed()) {
        editorPanelRef.current.expand();
      }
      // Highlight the span when opening the editor from navigation actions
      if (span) {
        highlightSpan(span);
      }
    },
    [selectFile, highlightSpan]
  );

  const toggleEditorPanel = useCallback(() => {
    const panel = editorPanelRef.current;
    if (!panel) return;

    if (panel.isCollapsed()) {
      panel.expand();
    } else {
      panel.collapse();
    }
  }, []);

  // Global keyboard shortcuts
  const shortcuts = useMemo<GlobalShortcut[]>(
    () => [
      {
        key: 'o',
        cmdOrCtrl: true,
        handler: () => setSidebarView((prev: SidebarView) => prev === 'files' ? null : 'files'),
      },
      {
        key: 'p',
        cmdOrCtrl: true,
        handler: () => setProjectSelectorOpen((prev) => !prev),
      },
      {
        key: 'b',
        cmdOrCtrl: true,
        handler: toggleEditorPanel,
      },
      // Help dialog
      {
        key: '?',
        handler: () => setShortcutsDialogOpen(true),
      },
      // Share dialog (disabled in serve mode)
      {
        key: 's',
        cmdOrCtrl: true,
        shift: true,
        handler: () => {
          if (currentProject && !isBackendMode) {
            setShareDialogOpen(true);
          }
        },
      },
      // Theme toggle (Cmd+\ to avoid browser conflict with Cmd+Shift+T)
      {
        key: '\\',
        cmdOrCtrl: true,
        handler: cycleTheme,
      },
      // Command palette
      {
        key: 'k',
        cmdOrCtrl: true,
        handler: () => setCommandPaletteOpen(true),
      },
    ],
    [toggleEditorPanel, currentProject, cycleTheme, isBackendMode]
  );

  useGlobalShortcuts(shortcuts);

  // View state store for tab switching via command palette
  const setActiveTab = useViewStateStore((s) => s.setActiveTab);
  const getActiveTab = useViewStateStore((s) => s.getActiveTab);
  const currentActiveTab = activeProjectId ? getActiveTab(activeProjectId) : 'lineage';

  // Command palette handler
  const handleExecuteCommand = useCallback(
    (commandId: string) => {
      switch (commandId) {
        // Navigation
        case 'help':
          setShortcutsDialogOpen(true);
          break;
        case 'command-palette':
          setCommandPaletteOpen(true);
          break;
        case 'open-files':
          setSidebarView((prev) => prev === 'files' ? null : 'files');
          break;
        case 'open-projects':
          setProjectSelectorOpen(true);
          break;
        case 'toggle-editor':
          toggleEditorPanel();
          break;

        // Tab switching
        case 'tab-lineage':
          if (activeProjectId) setActiveTab(activeProjectId, 'lineage');
          break;
        case 'tab-hierarchy':
          if (activeProjectId) setActiveTab(activeProjectId, 'hierarchy');
          break;
        case 'tab-matrix':
          if (activeProjectId) setActiveTab(activeProjectId, 'matrix');
          break;
        case 'tab-schema':
          if (activeProjectId) setActiveTab(activeProjectId, 'schema');
          break;
        case 'tab-issues':
          if (activeProjectId) setActiveTab(activeProjectId, 'issues');
          break;

        // Actions
        case 'share':
          if (currentProject && !isBackendMode) setShareDialogOpen(true);
          break;

        // Settings
        case 'toggle-theme':
          cycleTheme();
          break;

        // Lineage view commands - execute via lineage actions
        case 'toggle-view-mode':
          setViewMode(viewMode === 'table' ? 'script' : 'table');
          break;
        case 'toggle-column-edges':
          toggleColumnEdges();
          break;
        case 'expand-all':
          setAllNodesCollapsed(false);
          break;
        case 'collapse-all':
          setAllNodesCollapsed(true);
          break;
        case 'toggle-script-tables':
          toggleShowScriptTables();
          break;
        case 'cycle-layout':
          setLayoutAlgorithm(layoutAlgorithm === 'dagre' ? 'elk' : 'dagre');
          break;
        case 'focus-search':
          // Focus search is context-dependent, use keyboard shortcut
          toast.info(t('errors.focusSearch'));
          break;

        default:
          console.warn(`Unknown command: ${commandId}`);
      }
    },
    [
      toggleEditorPanel,
      activeProjectId,
      setActiveTab,
      currentProject,
      cycleTheme,
      setViewMode,
      viewMode,
      toggleColumnEdges,
      setAllNodesCollapsed,
      toggleShowScriptTables,
      setLayoutAlgorithm,
      layoutAlgorithm,
      isBackendMode,
    ]
  );

  return (
    <div className="flex flex-col h-svh">
      {/* App Header */}
      <header
        className="flex items-center justify-between px-4 h-12 border-b border-border bg-background shrink-0"
        data-testid="app-header"
      >
        <div className="flex items-center gap-2">
          {/* Logo */}
          <div className="flex items-center gap-3">
            <FlowScopeLogo className="w-8 h-8 text-foreground/30 dark:text-white/30" />
            <span className="text-lg font-semibold text-foreground">{t('app.brandName')}</span>
          </div>

          {/* Project Selector */}
          <ProjectSelector open={projectSelectorOpen} onOpenChange={setProjectSelectorOpen} />
        </div>

        {/* Header Actions */}
        <div className="flex items-center gap-1">
          {currentProject && (
            <>
              <ExportDialog
                result={result}
                projectName={currentProject.name}
                graphRef={graphContainerRef}
              />
              {/* Hide Share button in serve mode - files come from CLI */}
              {!isBackendMode && (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => setShareDialogOpen(true)}
                      >
                        <Share2 className="h-4 w-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p className="flex items-center gap-2">
                        {t('app.shareProject')}
                        <kbd className="px-1.5 py-0.5 text-xs bg-muted rounded border font-mono">
                          {getShortcutDisplay('share')}
                        </kbd>
                      </p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}
            </>
          )}
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8" asChild>
                  <a
                    href="https://github.com/pondpilot/flowscope"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <Github className="h-4 w-4" />
                  </a>
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>{t('app.viewOnGithub')}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <LayoutModeToggle
            sidebarOpen={sidebarView !== null}
            editorOpen={editorOpen}
            onToggleSidebar={() => setSidebarView(sidebarView ? null : 'files')}
            onToggleEditor={() => setEditorOpen(!editorOpen)}
            onToggleAll={() => {
              const allOpen = sidebarView !== null && editorOpen;
              if (allOpen) {
                setSidebarView(null);
                setEditorOpen(false);
              } else {
                setSidebarView('files');
                setEditorOpen(true);
              }
            }}
          />
          <LanguageToggle />
          <ThemeToggle />
        </div>
      </header>

      {/* Share Dialog */}
      {currentProject && (
        <ShareDialog
          open={shareDialogOpen}
          onOpenChange={setShareDialogOpen}
          project={currentProject}
        />
      )}

      {/* Keyboard Shortcuts Help Dialog */}
      <KeyboardShortcutsDialog
        open={shortcutsDialogOpen}
        onOpenChange={setShortcutsDialogOpen}
        activeTab={currentActiveTab}
      />

      {/* Command Palette */}
      <CommandPalette
        open={commandPaletteOpen}
        onOpenChange={setCommandPaletteOpen}
        onExecuteCommand={handleExecuteCommand}
      />

      {/* Global Error Banner */}
      {error && (
        <div
          className="px-4 py-2 bg-destructive/10 text-destructive text-xs font-medium border-b border-destructive/20 flex items-center justify-center gap-3"
          data-testid="error-banner"
        >
          <span>{t('app.systemError', { error })}</span>
          {onRetry && (
            <Button
              variant="outline"
              size="sm"
              onClick={onRetry}
              disabled={isRetrying}
              className="h-6 text-xs"
              data-testid="retry-btn"
            >
              {isRetrying ? t('common.retrying') : t('common.retry')}
            </Button>
          )}
        </div>
      )}

      {/* Main Content - VS Code style layout */}
      <NavigationProvider projectId={activeProjectId} onNavigateToEditor={handleNavigateToEditor}>
        <FocusRegistryProvider>
          <div className="flex-1 overflow-hidden flex">
            {/* Activity Bar (narrow icon strip) */}
            <ActivityBar activeView={sidebarView} onViewChange={setSidebarView} />

            {/* Sidebar (collapsible) */}
            {sidebarView && (
              <div className="w-[220px] shrink-0 border-r overflow-hidden">
                {sidebarView === 'files' && <SidebarFileTree />}
                {sidebarView === 'search' && <SidebarSearch />}
              </div>
            )}

            {/* Main panels area */}
            <div className="flex-1 overflow-hidden">
              <ResizablePanelGroup direction="horizontal">
                {/* Analysis Panel (Lineage) - always visible */}
                <ResizablePanel
                  defaultSize={editorOpen ? 55 : 100}
                  minSize={30}
                  data-testid="analysis-panel"
                >
                  <AnalysisView
                    graphContainerRef={graphContainerRef}
                    isAnalyzing={analysis.isAnalyzing}
                  />
                </ResizablePanel>

                {/* Editor Panel - toggleable */}
                {editorOpen && (
                  <>
                    <ResizableHandle withHandle />
                    <ResizablePanel
                      ref={editorPanelRef}
                      defaultSize={45}
                      minSize={25}
                      data-testid="editor-panel"
                    >
                      <EditorArea
                        backendReady={backendReady}
                        analysis={analysis}
                      />
                    </ResizablePanel>
                  </>
                )}
              </ResizablePanelGroup>
            </div>
          </div>
        </FocusRegistryProvider>
      </NavigationProvider>
    </div>
  );
}
