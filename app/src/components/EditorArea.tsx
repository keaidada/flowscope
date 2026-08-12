import { useEffect, useCallback, useRef, useMemo, useState } from 'react';
import { Loader2, AlertCircle, FileX, FileCode, X } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { SqlView, useLineageState } from '@pondpilot/capybara-react';
import { cn } from '@/lib/utils';
import { useProject } from '@/lib/project-store';
import { upsertProjectFiles } from '@/lib/file-storage';
import { useThemeStore, resolveTheme } from '@/lib/theme-store';
import { useDebounce, useFileNavigation, useGlobalShortcuts } from '@/hooks';
import type { GlobalShortcut } from '@/hooks';
import { EditorToolbar } from './EditorToolbar';
import type { SqlViewMode } from './EditorToolbar';
import { EtlDialog } from './EtlDialog';
import { ProcedureRepairDialog } from './ProcedureRepairDialog';
import { DbtConvertDialog } from './DbtConvertDialog';
import { SemanticYamlDialog } from './SemanticYamlDialog';
import { MetricExtractDialog } from './MetricExtractDialog';
import { ErrorBoundary } from './ErrorBoundary';
import { DEFAULT_FILE_NAMES } from '@/lib/constants';
import type { RunMode } from '@/lib/project-store';
import { useNavigation } from '@/lib/navigation-context';

interface EditorAnalysisState {
  isAnalyzing: boolean;
  error: string | null;
  runAnalysis: (
    activeFileContent?: string,
    activeFilePath?: string,
    options?: { runModeOverride?: RunMode }
  ) => Promise<void>;
  setError: (error: string | null) => void;
  loadLineageForFile: (filePath: string) => Promise<'db' | 'none'>;
}

// Fallback component shown when SqlView encounters an error
function SqlViewFallback() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center justify-center h-full text-muted-foreground bg-muted/5 p-4">
      <AlertCircle className="h-8 w-8 text-destructive mb-2" />
      <p className="text-sm font-medium">{t('editor.failedToRender')}</p>
      <p className="text-xs mt-1">{t('editor.tryReloading')}</p>
    </div>
  );
}

interface EditorAreaProps {
  backendReady: boolean;
  className?: string;
  analysis: EditorAnalysisState;
  onRequestOpenLineage?: () => void;
}

export function EditorArea({
  backendReady,
  className,
  analysis,
  onRequestOpenLineage,
}: EditorAreaProps) {
  const { t } = useTranslation();
  const {
    currentProject,
    activeProjectId,
    updateFile,
    updateFiles,
    createFile,
    setRunMode,
    isReadOnly,
    setProjectDialect,
    setTemplateMode,
    filesLoaded,
    loadFileContent,
    isContentLoaded,
    openFile,
    closeTab,
    closeAllTabs,
    closeOtherTabs,
    closeTabsToLeft,
    closeTabsToRight,
    revealActiveFile,
  } = useProject();

  const theme = useThemeStore((state) => state.theme);
  const isDark = resolveTheme(theme) === 'dark';
  const { setActiveTab } = useNavigation();

  const activeFile = currentProject?.files.find((f) => f.id === currentProject.activeFileId);
  const editorContainerRef = useRef<HTMLDivElement>(null);

  // Lazy content loading: fetch file content when user opens it
  const [contentLoading, setContentLoading] = useState(false);
  useEffect(() => {
    if (!activeFile || isContentLoaded(activeFile.id) || activeFile.content) {
      setContentLoading(false);
      return;
    }
    setContentLoading(true);
    loadFileContent(activeFile.id).finally(() => setContentLoading(false));
  }, [activeFile?.id, isContentLoaded, loadFileContent, activeFile?.content]);

  // Track previous values to detect changes (null means initial mount)
  const previousSchema = useRef<string | null>(null);
  const previousHideCTEs = useRef<boolean | null>(null);

  const { hideCTEs, highlightedSpan, result } = useLineageState();

  // SQL view mode toggle: 'template' shows original templated SQL, 'resolved' shows compiled SQL
  const [sqlViewMode, setSqlViewMode] = useState<SqlViewMode>('template');
  // Line wrapping toggle
  const [lineWrapping, setLineWrapping] = useState(true);
  const sqlViewRef = useRef<any>(null);

  // ETL dialog state
  const [etlOpen, setEtlOpen] = useState(false);
  const [initialEtlContent, setInitialEtlContent] = useState('');

  // Reset view mode to 'template' when active file changes
  useEffect(() => {
    setSqlViewMode('template');
  }, [currentProject?.activeFileId]);

  const { isAnalyzing, error, runAnalysis, setError, loadLineageForFile } = analysis;

  // Show error toast when error occurs, keep visible until next analysis
  useEffect(() => {
    if (error) {
      toast.error(t('editor.analysisError'), {
        description: error,
        duration: 8000,
      });
      // 不清除 error，让它在页面上持久显示直到下一次分析
    }
  }, [error]);

  // Debounce schema SQL to prevent rapid re-analysis during editing
  const debouncedSchemaSQL = useDebounce(currentProject?.schemaSQL ?? '', 300);

  useFileNavigation();

  useEffect(() => {
    if (isReadOnly) {
      return;
    }

    if (currentProject && filesLoaded && currentProject.files.length === 0) {
      createFile(DEFAULT_FILE_NAMES.SCRATCHPAD);
    }
  }, [currentProject, createFile, isReadOnly, filesLoaded]);

  // Focus the editor when active file changes (e.g., new file created)
  useEffect(() => {
    if (activeFile && editorContainerRef.current) {
      requestAnimationFrame(() => {
        const cmContent = editorContainerRef.current?.querySelector('.cm-content') as HTMLElement;
        cmContent?.focus();
      });
    }
  }, [activeFile?.id]);

  // Auto-trigger re-analysis when schema or hideCTEs changes.
  // Consolidated into a single effect to prevent duplicate analyses when both change.
  // activeFile.content is intentionally omitted to prevent re-analysis on keystrokes.
  useEffect(() => {
    if (!backendReady || !currentProject || !activeFile) {
      return;
    }

    const name = (activeFile.path || activeFile.name).toLowerCase();
    if (!name.endsWith('.sql') && !name.endsWith('.hql')) return;

    const schemaChanged =
      previousSchema.current !== null && previousSchema.current !== debouncedSchemaSQL;
    const hideCTEsChanged =
      previousHideCTEs.current !== null && previousHideCTEs.current !== hideCTEs;

    previousSchema.current = debouncedSchemaSQL;
    previousHideCTEs.current = hideCTEs;

    if (schemaChanged || hideCTEsChanged) {
      runAnalysis(activeFile.content, activeFile.path).catch((err) => {
        const reason = schemaChanged ? 'schema change' : 'CTE toggle';
        console.error(`Auto-analysis after ${reason} failed:`, err);
        setError(err instanceof Error ? err.message : `Failed to re-run analysis after ${reason}`);
      });
    }
    // Note: currentProject is used in the guard but excluded from deps because activeFile
    // (derived from currentProject) already captures project changes via activeFile.id
  }, [
    backendReady,
    debouncedSchemaSQL,
    hideCTEs,
    activeFile?.id,
    activeFile?.name,
    runAnalysis,
    setError,
  ]);

  // Compute resolved SQL from analysis result for the current file
  // Concatenates resolvedSql from all statements that came from the active file
  // Size limit prevents browser crashes with very large results
  const MAX_RESOLVED_SQL_SIZE = 10 * 1024 * 1024; // 10MB

  // Use path for matching since analysis uses paths as sourceName to avoid basename collisions.
  // For files without a path (e.g., scratchpad), fall back to name.
  const resolvedSql = useMemo(() => {
    const filePath = activeFile?.path || activeFile?.name;
    if (!result?.statements || !filePath) return null;

    const resolvedParts = result.statements
      .filter((stmt) => stmt.sourceName === filePath && stmt.resolvedSql)
      .map((stmt) => stmt.resolvedSql!);

    if (resolvedParts.length === 0) return null;

    const joined = resolvedParts.join('\n\n');
    if (joined.length > MAX_RESOLVED_SQL_SIZE) {
      return (
        joined.slice(0, MAX_RESOLVED_SQL_SIZE) + '\n\n-- [Truncated: resolved SQL exceeds 10MB]'
      );
    }
    return joined;
  }, [result, activeFile?.path, activeFile?.name]);

  // Determine if we should show the toggle (only in dbt/jinja mode)
  const showSqlViewToggle = currentProject?.templateMode !== 'raw';

  // Content to display in the editor based on view mode
  const [showTransformed, setShowTransformed] = useState(false);
  const [folded, setFolded] = useState(false);
  const [showDbt, setShowDbt] = useState(false);
  const [dbtDialogOpen, setDbtDialogOpen] = useState(false);
  const [showYaml, setShowYaml] = useState(false);
  const [yamlDialogOpen, setYamlDialogOpen] = useState(false);
  const [metricDialogOpen, setMetricDialogOpen] = useState(false);
  const showTransformedRef = useRef(showTransformed);
  showTransformedRef.current = showTransformed;
  const showDbtRef = useRef(showDbt);
  showDbtRef.current = showDbt;
  const showYamlRef = useRef(showYaml);
  showYamlRef.current = showYaml;

  // When toggling into dbt view, re-fetch the file from the DB so the view
  // always reflects the latest persisted dbt_content.
  const firstShowDbt = useRef(true);
  useEffect(() => {
    if (firstShowDbt.current) {
      firstShowDbt.current = false;
      return;
    }
    if (showDbt && activeFile) {
      loadFileContent(activeFile.id, { force: true });
    }
  }, [showDbt]);

  const hasTransformedContent = !!activeFile?.transformedContent;
  const hasDbtContent = !!activeFile?.dbtContent;

  const displayContent = useMemo(() => {
    if (showYaml && activeFile?.dbtYaml) {
      return activeFile.dbtYaml;
    }
    if (showDbt && hasDbtContent) {
      return activeFile?.dbtContent ?? '';
    }
    if (sqlViewMode === 'resolved' && resolvedSql) {
      return resolvedSql;
    }
    if (showTransformed && hasTransformedContent) {
      return activeFile?.transformedContent ?? '';
    }
    return activeFile?.content ?? '';
  }, [
    sqlViewMode,
    resolvedSql,
    activeFile?.content,
    activeFile?.transformedContent,
    activeFile?.dbtContent,
    activeFile?.dbtYaml,
    showTransformed,
    showDbt,
    showYaml,
    hasTransformedContent,
    hasDbtContent,
  ]);

  const handleContentChange = useCallback(
    (val: string) => {
      // Do not write back to the file when viewing a derived view (transformed
      // or dbt). Monaco fires onChange when its value is set programmatically
      // (e.g. via the toggle), which would otherwise overwrite the original
      // content with the dbt/transformed version.
      if (!activeFile || showTransformedRef.current || showDbtRef.current || showYamlRef.current) return;
      updateFile(activeFile.id, val);
    },
    [activeFile, updateFile]
  );

  const handleSave = useCallback(() => {
    if (currentProject && currentProject.files.length > 0) {
      // Only save files that have content loaded (avoid overwriting DB with empty content)
      const saveableFiles = currentProject.files.filter(
        (f) => isContentLoaded(f.id) || f.content.length > 0
      );
      if (saveableFiles.length > 0) {
        upsertProjectFiles(currentProject.id, saveableFiles)
          .then(() => toast.success(t('editor.saved')))
          .catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            console.error('[EditorArea] Save failed:', msg);
            toast.error(`${t('editor.saveFailed')}: ${msg}`);
          });
      }
    }
  }, [currentProject, t, isContentLoaded]);

  const handleAnalyze = useCallback(() => {
    if (activeFile) {
      const name = (activeFile.path || activeFile.name).toLowerCase();
      if (!name.endsWith('.sql') && !name.endsWith('.hql')) return;
      onRequestOpenLineage?.();
      setActiveTab('lineage');
      void runAnalysis(activeFile.content, activeFile.path).catch((err) => {
        console.error('Manual analysis failed:', err);
        setError(err instanceof Error ? err.message : 'Failed to run analysis');
      });
    }
  }, [activeFile, onRequestOpenLineage, runAnalysis, setActiveTab, setError]);

  const handleAnalyzeActiveOnly = useCallback(() => {
    if (activeFile) {
      const name = (activeFile.path || activeFile.name).toLowerCase();
      if (!name.endsWith('.sql') && !name.endsWith('.hql')) return;
      onRequestOpenLineage?.();
      setActiveTab('lineage');
      void runAnalysis(activeFile.content, activeFile.path, { runModeOverride: 'current' }).catch(
        (err) => {
          console.error('Active-file analysis failed:', err);
          setError(err instanceof Error ? err.message : 'Failed to run analysis');
        }
      );
    }
  }, [activeFile, onRequestOpenLineage, runAnalysis, setActiveTab, setError]);

  const handleOpenLineage = useCallback(async () => {
    onRequestOpenLineage?.();
    // DB-first: load the current file's persisted lineage directly instead of
    // trusting the in-memory store (which may hold another script's result).
    const filePath = activeFile?.path || activeFile?.name;
    if (activeProjectId && filePath) {
      const source = await loadLineageForFile(filePath);
      if (source === 'db') {
        setActiveTab('lineage');
        return;
      }
    }
    // No persisted lineage — parse the current file, then load.
    handleAnalyzeActiveOnly();
  }, [
    activeProjectId,
    activeFile?.path,
    activeFile?.name,
    handleAnalyzeActiveOnly,
    loadLineageForFile,
    onRequestOpenLineage,
    setActiveTab,
  ]);

  const handleOpenEtl = useCallback(() => {
    setInitialEtlContent(activeFile?.content || '');
    setEtlOpen(true);
  }, [activeFile?.content]);

  const handleApplyEtlResult = useCallback(
    (content: string) => {
      if (!activeFile) return;
      updateFile(activeFile.id, content);
      setEtlOpen(false);
    },
    [activeFile, updateFile]
  );

  const [procedureDialogOpen, setProcedureDialogOpen] = useState(false);

  const handleConvertProcedure = useCallback(() => {
    if (!activeFile) return;
    setProcedureDialogOpen(true);
  }, [activeFile]);

  const handleApplyTransformed = useCallback(
    (transformedContent: string | null) => {
      if (!activeFile || !activeProjectId) return;
      const content = activeFile.content;
      updateFiles([{ fileId: activeFile.id, content, isProcedure: true, transformedContent }]);
      upsertProjectFiles(activeProjectId, [
        { ...activeFile, isProcedure: true, transformedContent },
      ]).catch((e) => console.error('Failed to save transformed content:', e));
      setShowTransformed(true);
    },
    [activeFile, activeProjectId, updateFiles]
  );

  // Detect stored procedure from content (not just the stored flag)
  const isProcedure = useMemo(() => {
    if (activeFile?.isProcedure) return true;
    const content = activeFile?.content ?? '';
    const upper = content.toUpperCase();
    return upper.includes('CREATE PROCEDURE')
      || upper.includes('CREATE PROC ')
      || upper.includes('CREATE OR REPLACE PROCEDURE');
  }, [activeFile?.isProcedure, activeFile?.content]);

  // Keyboard shortcuts for running analysis
  const analysisShortcuts = useMemo<GlobalShortcut[]>(
    () => [
      {
        key: 'Enter',
        cmdOrCtrl: true,
        handler: handleAnalyze,
      },
      {
        key: 'Enter',
        cmdOrCtrl: true,
        shift: true,
        handler: handleAnalyzeActiveOnly,
      },
      {
        key: 's',
        cmdOrCtrl: true,
        handler: handleSave,
      },
    ],
    [handleAnalyze, handleAnalyzeActiveOnly, handleSave]
  );

  useGlobalShortcuts(analysisShortcuts);

  if (!currentProject) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="flex flex-col items-center justify-center h-full text-muted-foreground bg-muted/5 gap-2"
      >
        <Loader2 className="h-8 w-8 animate-spin opacity-40" />
      </div>
    );
  }

  // Read-only project (Server Files) with no files — show empty state instead of spinner
  if (!activeFile && isReadOnly) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground bg-muted/5 gap-2">
        <FileX className="h-8 w-8 opacity-40" />
        <p className="text-sm font-medium">{t('editor.noServerFiles')}</p>
        <p className="text-xs opacity-70">{t('editor.noServerFilesDesc')}</p>
      </div>
    );
  }

  // Show loading spinner while file content is being fetched
  if (activeFile && contentLoading) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="flex flex-col items-center justify-center h-full text-muted-foreground bg-muted/5 gap-2"
      >
        <Loader2 className="h-8 w-8 animate-spin opacity-40" />
      </div>
    );
  }

  if (!activeFile) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground bg-muted/5 gap-2">
        <FileCode className="h-10 w-10 opacity-20" />
        <p className="text-sm font-medium">{t('editor.noFileOpen')}</p>
        <p className="text-xs opacity-70">{t('editor.noFileOpenDesc')}</p>
      </div>
    );
  }

  const allFileCount = currentProject.files.filter((f) => {
    const lower = f.name.toLowerCase();
    return lower.endsWith('.sql') || lower.endsWith('.hql');
  }).length;
  const fileIdSet = new Set(currentProject.files.map((f) => f.id));
  const selectedCount = (currentProject.selectedFileIds || []).filter((id) =>
    fileIdSet.has(id)
  ).length;

  return (
    <div className={cn('flex flex-col h-full bg-background', className)}>
      <EditorToolbar
        runMode={currentProject.runMode}
        onRunModeChange={(mode: RunMode) => setRunMode(currentProject.id, mode)}
        isAnalyzing={isAnalyzing}
        backendReady={backendReady}
        onAnalyze={handleAnalyze}
        allFileCount={allFileCount}
        selectedCount={selectedCount}
        sqlViewMode={sqlViewMode}
        onSqlViewModeChange={setSqlViewMode}
        showSqlViewToggle={showSqlViewToggle}
        hasResolvedSql={!!resolvedSql}
        dialect={currentProject.dialect}
        onDialectChange={(d) => setProjectDialect(currentProject.id, d)}
        templateMode={currentProject.templateMode}
        onTemplateModeChange={(m) => setTemplateMode(currentProject.id, m)}
        lineWrapping={lineWrapping}
        onLineWrappingChange={setLineWrapping}
        onOpenLineage={handleOpenLineage}
        hasLineageResult={!!result}
        onOpenEtl={handleOpenEtl}
        onSave={handleSave}
        isProcedure={isProcedure}
        onConvertProcedure={isProcedure ? handleConvertProcedure : undefined}
        showTransformed={showTransformed}
        onToggleTransformed={isProcedure ? () => setShowTransformed((v) => !v) : undefined}
        hasTransformedContent={hasTransformedContent}
        onFoldAll={() => {
          if (folded) sqlViewRef.current?.unfoldAll();
          else sqlViewRef.current?.foldAll();
          setFolded((v) => !v);
        }}
        folded={folded}
        onConvertDbt={() => setDbtDialogOpen(true)}
        showDbt={showDbt}
        onToggleDbt={() => setShowDbt(!showDbtRef.current)}
        onGenerateYaml={() => setYamlDialogOpen(true)}
        showYaml={showYaml}
        onToggleYaml={() => setShowYaml(!showYamlRef.current)}
        onExtractMetrics={() => setMetricDialogOpen(true)}
        openFiles={
          (currentProject?.openFileIds || [])
            .map((id) => currentProject?.files.find((f) => f.id === id))
            .filter(Boolean) as any[]
        }
        activeFileId={currentProject?.activeFileId ?? null}
        onOpenFile={openFile}
        onCloseTab={closeTab}
        onCloseAllTabs={closeAllTabs}
        onCloseOtherTabs={closeOtherTabs}
        onCloseTabsToLeft={closeTabsToLeft}
        onCloseTabsToRight={closeTabsToRight}
        onLocateFile={revealActiveFile}
      />

      {error && (
        <div
          role="alert"
          aria-live="assertive"
          className="flex items-start gap-2.5 px-4 py-3 text-sm border-b bg-destructive/10 border-destructive/30 border-l-4 border-l-destructive text-destructive max-h-[40vh] overflow-y-auto"
        >
          <AlertCircle className="h-5 w-5 mt-0.5 shrink-0" />
          <div className="flex-1 whitespace-pre-wrap font-medium">{error}</div>
          <button
            className="shrink-0 p-1 rounded hover:bg-destructive/20 transition-colors"
            onClick={() => analysis.setError(null)}
            aria-label={t('common.dismiss')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      <div
        ref={editorContainerRef}
        className="flex-1 overflow-hidden relative"
        data-testid="sql-editor"
      >
        <ErrorBoundary fallback={<SqlViewFallback />}>
          <SqlView
            ref={sqlViewRef}
            value={displayContent}
            onChange={handleContentChange}
            className="h-full text-sm"
            editable={!showTransformed && !showDbt && !showYaml && sqlViewMode === 'template' && !isReadOnly}
            isDark={isDark}
            highlightedSpan={sqlViewMode === 'template' ? highlightedSpan : null}
            lineWrapping={lineWrapping}
          />
        </ErrorBoundary>
        {isReadOnly && (
          <div className="absolute top-2 left-2 z-10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider bg-muted/80 text-muted-foreground rounded border">
            {t('common.readOnly')}
          </div>
        )}
      </div>

      <EtlDialog
        open={etlOpen}
        onOpenChange={setEtlOpen}
        initialContent={initialEtlContent}
        onApplyResult={handleApplyEtlResult}
      />

      <ProcedureRepairDialog
        open={procedureDialogOpen}
        onOpenChange={setProcedureDialogOpen}
        originalContent={activeFile?.content || ''}
        onApply={handleApplyTransformed}
      />

      {currentProject && activeFile && (
        <DbtConvertDialog
          open={dbtDialogOpen}
          onClose={() => setDbtDialogOpen(false)}
          projectId={currentProject.id}
          filePath={activeFile.path}
          originalSql={activeFile.content}
          onSaved={(dbtContent) => {
            updateFiles([{ fileId: activeFile.id, dbtContent }]);
          }}
        />
      )}

      {currentProject && activeFile && (
        <SemanticYamlDialog
          open={yamlDialogOpen}
          onClose={() => setYamlDialogOpen(false)}
          projectId={currentProject.id}
          filePath={activeFile.path}
          onSaved={(yaml) => {
            updateFiles([{ fileId: activeFile.id, dbtYaml: yaml }]);
          }}
        />
      )}

      {currentProject && activeFile && (
        <MetricExtractDialog
          open={metricDialogOpen}
          onClose={() => setMetricDialogOpen(false)}
          projectId={currentProject.id}
          filePath={activeFile.path}
          sqlContent={activeFile.content}
        />
      )}
    </div>
  );
}
