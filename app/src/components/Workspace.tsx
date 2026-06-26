import { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import { Share2, Github, Settings, Network, Trash2, Download } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { useLineageActions, useLineageState } from '@pondpilot/flowscope-react';
import type { AnalyzeResult } from '@pondpilot/flowscope-core';
import { Button } from './ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { FlowScopeLogo } from './FlowScopeLogo';
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from './ui/resizable';
import type { ImperativePanelHandle } from 'react-resizable-panels';

import { EditorArea } from './EditorArea';
import { AnalysisView } from './AnalysisView';
import { SidebarFileTree } from './SidebarFileTree';
import { SidebarSearch } from './SidebarSearch';
import { SidebarSchema } from './SidebarSchema';
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
import { GlobalLineageView, type GlobalLineageMode } from './GlobalLineageView';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from './ui/sheet';
import { useProject } from '@/lib/project-store';
import { NavigationProvider } from '@/lib/navigation-context';
import { FocusRegistryProvider } from '@/lib/focus-registry';
import { useGlobalShortcuts, useAnalysis } from '@/hooks';
import { readFileResultPaths } from '@/lib/analysis-cache';
import type { GlobalShortcut } from '@/hooks';
import { useThemeStore, type Theme } from '@/lib/theme-store';
import { useViewStateStore } from '@/lib/view-state-store';
import { useBackend } from '@/lib/backend-context';
import { readAllFileResults, clearProjectLineage, exportSqliteDb } from '@/lib/analysis-cache';
import { mergeAnalyzeResults, buildTableLevelLineage, extractTableComments } from '@/lib/merge-results';

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
    setResult: setLineageResult,
  } = lineageActions;
  const lineageState = useLineageState();
  const { result, viewMode, layoutAlgorithm } = lineageState;
  const [projectSelectorOpen, setProjectSelectorOpen] = useState(false);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [shortcutsDialogOpen, setShortcutsDialogOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [sidebarView, setSidebarView] = useState<SidebarView>('files');
  const [editorOpen, setEditorOpen] = useState(true);
  const [lineageWorkspaceOpen, setLineageWorkspaceOpen] = useState(false);
  const [globalLineageOpen, setGlobalLineageOpen] = useState(false);
  const [globalLineageView, setGlobalLineageView] = useState<GlobalLineageMode>('list');
  const [globalFocusNodeId, setGlobalFocusNodeId] = useState<string | undefined>(undefined);
  const previousResultRef = useRef(result);
  const previousLayoutRef = useRef(layoutAlgorithm);
  // 缓存全局血缘加载的各文件分析结果，跳转时直接使用
  const globalFileResultsRef = useRef<Map<string, AnalyzeResult>>(new Map());

  // 血缘文件图标
  const [lineageFileIds, setLineageFileIds] = useState<Set<string>>(new Set());

  // 页面刷新后从 SQLite 恢复已有的血缘图标
  useEffect(() => {
    if (activeProjectId) {
      readFileResultPaths(activeProjectId).then((paths) => {
        setLineageFileIds(new Set(paths));
      });
    }
  }, [activeProjectId]);

  // 分析完成后更新血缘图标
  useEffect(() => {
    if (activeProjectId && analysis.lastAnalyzedAt) {
      readFileResultPaths(activeProjectId).then((paths) => {
        setLineageFileIds(new Set(paths));
      });
    }
  }, [activeProjectId, analysis.lastAnalyzedAt]);

  // 打开全局血缘：从 SQLite 加载所有文件结果并合并
  const handleGlobalLineageToggle = useCallback(async () => {
    if (globalLineageOpen) {
      // 关闭：恢复之前的单文件 result 和布局
      setGlobalLineageOpen(false);
      setGlobalFocusNodeId(undefined);
      setLineageResult(previousResultRef.current);
      setLayoutAlgorithm(previousLayoutRef.current);
      return;
    }

    if (!activeProjectId) return;

    // 保存当前 result 和布局以便恢复
    previousResultRef.current = result;
    previousLayoutRef.current = layoutAlgorithm;
    setGlobalLineageOpen(true);
    // 全局血缘默认使用 ELK（最小化交叉）布局
    setLayoutAlgorithm('elk');

    try {
      const startTime = performance.now();
      const fileResults = await readAllFileResults(activeProjectId);
      if (fileResults.length === 0) {
        toast.info(t('analysis.emptyState.runAnalysis'));
        return;
      }
      console.log(`[GlobalLineage] Loaded ${fileResults.length} files in ${(performance.now() - startTime).toFixed(0)}ms`);

      // 缓存各文件结果，供跳转时直接使用
      const resultMap = new Map<string, AnalyzeResult>();
      for (const fr of fileResults) {
        resultMap.set(fr.filePath, fr.result);
      }
      globalFileResultsRef.current = resultMap;

      // 去重：如果所有文件指向同一个 result 对象（runMode=all），只需处理一次
      const uniqueResults = [...new Set(fileResults.map((r) => r.result))];
      console.log(`[GlobalLineage] ${uniqueResults.length} unique results from ${fileResults.length} files`);

      const mergeStart = performance.now();
      const merged = uniqueResults.length === 1
        ? uniqueResults[0]
        : mergeAnalyzeResults(fileResults.map((r) => r.result));
      if (!merged) {
        toast.info(t('analysis.emptyState.runAnalysis'));
        return;
      }
      // 从文件内容提取中文注释
      const fileContents = new Map<string, string>();
      if (currentProject?.files) {
        for (const f of currentProject.files) {
          if (f.content) fileContents.set(f.path || f.name, f.content);
        }
      }
      const tableComments = extractTableComments(fileContents);

      // 提取表级血缘（只保留源表→目标表），与 schema 视图一致
      const tableLevelResult = buildTableLevelLineage(merged, tableComments);
      console.log(`[GlobalLineage] Merge + build in ${(performance.now() - mergeStart).toFixed(0)}ms, tables=${tableLevelResult.statements.reduce((s, st) => s + st.nodes.length, 0)}`);
      setLineageResult(tableLevelResult);
    } catch (error) {
      console.error('[Workspace] Failed to load global lineage:', error);
      toast.error('Failed to load global lineage');
    }
  }, [globalLineageOpen, activeProjectId, result, setLineageResult, t]);

  // 清理当前项目的全局血缘数据
  const handleClearGlobalLineage = useCallback(async () => {
    if (!activeProjectId) return;
    if (!window.confirm('确定要清理当前项目的所有血缘缓存数据吗？清理后需要重新运行分析。')) return;
    await clearProjectLineage(activeProjectId);
    if (globalLineageOpen) {
      setLineageResult(null);
    }
    toast.success(t('app.globalLineage') + ' - 已清理');
  }, [activeProjectId, globalLineageOpen, setLineageResult, t]);

  // 全局血缘中点击节点时，监听 navigationRequest 关闭全局血缘并跳转文件
  const lastNavRequestRef = useRef(lineageState.navigationRequest);
  useEffect(() => {
    // 记录打开全局血缘时的 navigationRequest，忽略旧值
    if (!globalLineageOpen) {
      lastNavRequestRef.current = lineageState.navigationRequest;
      return;
    }

    const request = lineageState.navigationRequest;
    // 只响应新的请求（和上次不同的引用）
    if (!request?.sourceName || request === lastNavRequestRef.current) return;
    lastNavRequestRef.current = request;

    const project = currentProject;
    if (!project?.files) return;

    const normalizeForComparison = (path: string) => path.replace(/\\/g, '/').toLowerCase();
    const normalizedSource = normalizeForComparison(request.sourceName);

    const file = project.files.find(
      (f) =>
        f.name === request.sourceName ||
        f.path === request.sourceName ||
        normalizeForComparison(f.name) === normalizedSource ||
        normalizeForComparison(f.path) === normalizedSource ||
        normalizeForComparison(f.name).endsWith(normalizedSource) ||
        normalizeForComparison(f.path).endsWith(normalizedSource)
    );

    if (file) {
      setGlobalLineageOpen(false);
      setGlobalFocusNodeId(undefined);
      setLayoutAlgorithm(previousLayoutRef.current);
      // 从缓存中取 result，过滤出只属于该文件的 statements
      const cachedResult = globalFileResultsRef.current.get(file.path)
        || globalFileResultsRef.current.get(file.name);
      if (cachedResult) {
        const fileStatements = cachedResult.statements.filter(
          (s) => s.sourceName === file.name || s.sourceName === file.path || !s.sourceName
        );
        if (fileStatements.length > 0 && fileStatements.length < cachedResult.statements.length) {
          // 有多个文件的 statements 混在一起，只取当前文件的
          setLineageResult({ ...cachedResult, statements: fileStatements });
        } else {
          setLineageResult(cachedResult);
        }
      } else {
        setLineageResult(null);
      }
      selectFile(file.id);
    }
  }, [lineageState.navigationRequest, globalLineageOpen, currentProject, selectFile, setLineageResult, setLayoutAlgorithm]);

  // 全局血缘打开期间，切换视图时强制保持 ELK 布局
  useEffect(() => {
    if (globalLineageOpen) {
      setLayoutAlgorithm('elk');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [globalLineageOpen, viewMode]);

  // 导出 SQLite 数据库文件
  const handleExportLineage = useCallback(async () => {
    try {
      const data = await exportSqliteDb();
      const blob = new Blob([new Uint8Array(data)], { type: 'application/x-sqlite3' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `flowscope-${currentProject?.name ?? 'export'}.db`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success('SQLite 数据库已导出');
    } catch (error) {
      console.error('[Workspace] Failed to export SQLite:', error);
      toast.error('导出失败');
    }
  }, [currentProject?.name]);

  // Theme cycling for keyboard shortcut
  const { theme, setTheme } = useThemeStore();
  const cycleTheme = useCallback(() => {
    const themes: Theme[] = ['light', 'dark', 'system'];
    const currentIndex = themes.indexOf(theme);
    const nextTheme = themes[(currentIndex + 1) % themes.length];
    setTheme(nextTheme);
    toast.success(
      t('theme.changed', { theme: nextTheme.charAt(0).toUpperCase() + nextTheme.slice(1) })
    );
  }, [theme, setTheme]);

  const editorPanelRef = useRef<ImperativePanelHandle>(null);
  const sidebarPanelRef = useRef<ImperativePanelHandle>(null);
  const sidebarLayoutRef = useRef<HTMLDivElement>(null);
  const graphContainerRef = useRef<HTMLDivElement>(null);

  // Initial sidebar width: start with a sensible default based on project file names.
  // After render, the file tree reports its actual visible content width and we auto-grow from there.
  const sidebarDefaultSize = useMemo(() => {
    if (!currentProject || currentProject.files.length === 0) return 15;
    let maxLen = 0;
    for (const f of currentProject.files) {
      const depth = f.path.split('/').length - 1;
      const displayLen = f.name.length + depth * 2;
      if (displayLen > maxLen) maxLen = displayLen;
    }
    const pct = Math.round(((maxLen * 2) / 3) * 0.5);
    return Math.max(15, Math.min(35, pct));
  }, [currentProject?.files]);

  const handleSidebarContentWidthChange = useCallback((contentWidthPx: number) => {
    const layoutWidth = sidebarLayoutRef.current?.clientWidth;
    const sidebarPanel = sidebarPanelRef.current;
    if (!layoutWidth || !sidebarPanel || !contentWidthPx) return;

    // Keep the files sidebar conservative: size it to about 2/3 of the longest visible row.
    const targetPx = contentWidthPx * (2 / 3);
    const targetPct = Math.max(15, Math.min(35, (targetPx / layoutWidth) * 100));
    const currentPct = sidebarPanel.getSize();

    if (Math.abs(targetPct - currentPct) > 0.5) {
      sidebarPanel.resize(targetPct);
    }
  }, []);

  // Reset to the initial size when switching project or reopening the files sidebar.
  useEffect(() => {
    if (sidebarView !== 'files' || !sidebarPanelRef.current) return;
    const raf = requestAnimationFrame(() => {
      sidebarPanelRef.current?.resize(sidebarDefaultSize);
    });
    return () => cancelAnimationFrame(raf);
  }, [activeProjectId, sidebarView, sidebarDefaultSize]);

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
      // 如果在全局血缘视图中，关闭它回到操作界面
      if (globalLineageOpen) {
        setGlobalLineageOpen(false);
        setGlobalFocusNodeId(undefined);
        setLayoutAlgorithm(previousLayoutRef.current);
        const cachedResult = globalFileResultsRef.current.get(file.path)
          || globalFileResultsRef.current.get(file.name);
        if (cachedResult) {
          const fileStatements = cachedResult.statements.filter(
            (s) => s.sourceName === file.name || s.sourceName === file.path || !s.sourceName
          );
          if (fileStatements.length > 0 && fileStatements.length < cachedResult.statements.length) {
            setLineageResult({ ...cachedResult, statements: fileStatements });
          } else {
            setLineageResult(cachedResult);
          }
        } else {
          setLineageResult(null);
        }
      }
      // Expand the editor panel if collapsed
      if (editorPanelRef.current?.isCollapsed()) {
        editorPanelRef.current.expand();
      }
      // Highlight the span when opening the editor from navigation actions
      if (span) {
        highlightSpan(span);
      }
    },
    [selectFile, highlightSpan, globalLineageOpen, setLineageResult]
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
        handler: () => setSidebarView((prev: SidebarView) => (prev === 'files' ? null : 'files')),
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
          setSidebarView((prev) => (prev === 'files' ? null : 'files'));
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

          {/* Global Lineage Toggle */}
          <Button
            variant={globalLineageOpen ? 'secondary' : 'ghost'}
            size="sm"
            className="h-7 gap-1.5 text-xs"
            onClick={handleGlobalLineageToggle}
          >
            <Network className="h-3.5 w-3.5" />
            {t('app.globalLineage')}
          </Button>
          {globalLineageOpen && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 text-xs"
              onClick={handleExportLineage}
              title="导出血缘数据"
            >
              <Download className="h-3.5 w-3.5" />
            </Button>
          )}
          {globalLineageOpen && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 text-xs text-destructive hover:text-destructive"
              onClick={handleClearGlobalLineage}
              title="清理全局血缘缓存"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>

        {/* Header Actions */}
        <div className="flex items-center gap-1">
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
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8">
                <Settings className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {currentProject && (
                <>
                  <ExportDialog
                    result={result}
                    projectName={currentProject.name}
                    graphRef={graphContainerRef}
                  />
                  {!isBackendMode && (
                    <DropdownMenuItem onClick={() => setShareDialogOpen(true)}>
                      <Share2 className="h-4 w-4 mr-2" />
                      {t('app.shareProject')}
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuSeparator />
                </>
              )}
              <DropdownMenuItem asChild>
                <a
                  href="https://github.com/pondpilot/flowscope"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Github className="h-4 w-4 mr-2" />
                  {t('app.viewOnGithub')}
                </a>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <div className="flex flex-col gap-1 px-2 py-1.5">
                <LanguageToggle />
                <ThemeToggle />
              </div>
            </DropdownMenuContent>
          </DropdownMenu>
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
            {globalLineageOpen ? (
              /* Global Lineage — full-screen graph/list/matrix view */
              <div className="flex min-w-0 flex-1 flex-col">
                {result ? (
                  <GlobalLineageView
                    result={result}
                    mode={globalLineageView}
                    onModeChange={setGlobalLineageView}
                    focusNodeId={globalFocusNodeId}
                    onFocusApplied={() => setGlobalFocusNodeId(undefined)}
                  />
                ) : (
                  <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-3">
                    <Network className="h-10 w-10 opacity-30" />
                    <p className="text-sm">{t('app.globalLineage')}</p>
                    <p className="text-xs opacity-60">
                      {t('analysis.emptyState.runAnalysis')}
                    </p>
                  </div>
                )}
              </div>
            ) : (
             /* Normal layout — sidebar + editor, lineage opens in a sheet */
              <>
                {/* Activity Bar (narrow icon strip) */}
                <ActivityBar
                  activeView={sidebarView}
                  onViewChange={setSidebarView}
                  hideSchema={isBackendMode}
                />

                {/* Main area with optional resizable sidebar */}
                <div ref={sidebarLayoutRef} className="flex-1 min-w-0">
                  <ResizablePanelGroup direction="horizontal" className="h-full">
                    {/* Sidebar (collapsible & resizable) */}
                    {sidebarView && sidebarView !== 'schema' && (
                      <>
                        <ResizablePanel
                          ref={sidebarPanelRef}
                          defaultSize={sidebarDefaultSize}
                          minSize={10}
                          maxSize={50}
                          className="overflow-hidden flex flex-col"
                        >
                          {sidebarView === 'files' && (
                            <SidebarFileTree
                              onContentWidthChange={handleSidebarContentWidthChange}
                              lineageFileIds={lineageFileIds}
                            />
                          )}
                          {sidebarView === 'search' && (
                            <SidebarSearch
                              onOpenSchemaFile={() => {
                                setSidebarView('schema');
                              }}
                              onHighlightSpan={highlightSpan}
                            />
                          )}
                        </ResizablePanel>
                        <ResizableHandle />
                      </>
                    )}

                    {/* Main panels area */}
                    <ResizablePanel
                      defaultSize={sidebarView && sidebarView !== 'schema' ? 100 - sidebarDefaultSize : 100}
                      minSize={40}
                    >
                      {sidebarView === 'schema' ? (
                        <SidebarSchema />
                      ) : (
                        editorOpen && (
                        <EditorArea
                          backendReady={backendReady}
                          analysis={analysis}
                          onRequestOpenLineage={() => setLineageWorkspaceOpen(true)}
                        />
                        )
                      )}
                    </ResizablePanel>
                  </ResizablePanelGroup>
                </div>

                <Sheet open={lineageWorkspaceOpen} onOpenChange={setLineageWorkspaceOpen}>
                  <SheetContent
                    side="right"
                    className="w-[78vw] min-w-[960px] max-w-none p-0 sm:max-w-none"
                  >
                    <div className="flex h-full min-h-0 flex-col">
                      <SheetHeader className="border-b px-5 py-4">
                        <SheetTitle>{t('app.globalLineage')}</SheetTitle>
                        <SheetDescription>{t('analysis.emptyState.runAnalysis')}</SheetDescription>
                      </SheetHeader>
                      <div className="min-h-0 flex-1">
                        <AnalysisView
                          graphContainerRef={graphContainerRef}
                          isAnalyzing={analysis.isAnalyzing}
                          progress={analysis.progress}
                          lastAnalyzedAt={analysis.lastAnalyzedAt}
                          resultStatus={analysis.resultStatus}
                          loadingContext={analysis.loadingContext}
                        />
                      </div>
                    </div>
                  </SheetContent>
                </Sheet>
              </>
            )}
          </div>
        </FocusRegistryProvider>
      </NavigationProvider>
    </div>
  );
}
