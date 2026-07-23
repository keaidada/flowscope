import { useEffect, useCallback, useRef, useMemo, useState } from 'react';
import { Loader2, AlertCircle, FileX } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { SqlView, useLineageState } from '@pondpilot/flowscope-react';
import { cn } from '@/lib/utils';
import { useProject } from '@/lib/project-store';
import { upsertProjectFiles } from '@/lib/file-storage';
import { useThemeStore, resolveTheme } from '@/lib/theme-store';
import { useDebounce, useFileNavigation, useGlobalShortcuts } from '@/hooks';
import type { GlobalShortcut } from '@/hooks';
import { EditorToolbar } from './EditorToolbar';
import type { SqlViewMode } from './EditorToolbar';
import { EtlDialog } from './EtlDialog';
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
    updateFile,
    createFile,
    setRunMode,
    isReadOnly,
    setProjectDialect,
    setTemplateMode,
    filesLoaded,
    loadFileContent,
    isContentLoaded,
  } = useProject();

  const theme = useThemeStore((state) => state.theme);
  const isDark = resolveTheme(theme) === 'dark';
  const { setActiveTab } = useNavigation();

  const activeFile = currentProject?.files.find((f) => f.id === currentProject.activeFileId);
  const editorContainerRef = useRef<HTMLDivElement>(null);

  // Lazy content loading: fetch file content when user opens it
  const [contentLoading, setContentLoading] = useState(false);
  useEffect(() => {
    if (!activeFile || isContentLoaded(activeFile.id)) {
      setContentLoading(false);
      return;
    }
    setContentLoading(true);
    loadFileContent(activeFile.id).finally(() => setContentLoading(false));
  }, [activeFile?.id, isContentLoaded, loadFileContent]);

  // Track previous values to detect changes (null means initial mount)
  const previousSchema = useRef<string | null>(null);
  const previousHideCTEs = useRef<boolean | null>(null);

  const { hideCTEs, highlightedSpan, result } = useLineageState();

  // SQL view mode toggle: 'template' shows original templated SQL, 'resolved' shows compiled SQL
  const [sqlViewMode, setSqlViewMode] = useState<SqlViewMode>('template');
  // Line wrapping toggle
  const [lineWrapping, setLineWrapping] = useState(true);

  // ETL dialog state
  const [etlOpen, setEtlOpen] = useState(false);
  const [initialEtlContent, setInitialEtlContent] = useState('');

  // Reset view mode to 'template' when active file changes
  useEffect(() => {
    setSqlViewMode('template');
  }, [currentProject?.activeFileId]);

  const { isAnalyzing, error, runAnalysis, setError } = analysis;

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
  const displayContent = useMemo(() => {
    if (sqlViewMode === 'resolved' && resolvedSql) {
      return resolvedSql;
    }
    return activeFile?.content ?? '';
  }, [sqlViewMode, resolvedSql, activeFile?.content]);

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
      onRequestOpenLineage?.();
      setActiveTab('lineage');
      void runAnalysis(activeFile.content, activeFile.path)
        .catch((err) => {
          console.error('Manual analysis failed:', err);
          setError(err instanceof Error ? err.message : 'Failed to run analysis');
        });
    }
  }, [activeFile, onRequestOpenLineage, runAnalysis, setActiveTab, setError]);

  const handleAnalyzeActiveOnly = useCallback(() => {
    if (activeFile) {
      onRequestOpenLineage?.();
      setActiveTab('lineage');
      void runAnalysis(activeFile.content, activeFile.path, { runModeOverride: 'current' })
        .catch((err) => {
          console.error('Active-file analysis failed:', err);
          setError(err instanceof Error ? err.message : 'Failed to run analysis');
        });
    }
  }, [activeFile, onRequestOpenLineage, runAnalysis, setActiveTab, setError]);

  const handleOpenLineage = useCallback(() => {
    onRequestOpenLineage?.();
    if (result) {
      setActiveTab('lineage');
      return;
    }
    handleAnalyze();
  }, [onRequestOpenLineage, result, setActiveTab, handleAnalyze]);

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
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground bg-muted/5">
        <Loader2 className="h-6 w-6 animate-spin opacity-50" />
      </div>
    );
  }

  // Read-only project (Server Files) with no files — show empty state instead of spinner
  if (!activeFile && isReadOnly) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground bg-muted/5">
        <FileX className="h-8 w-8 opacity-40 mb-2" />
        <p className="text-sm font-medium">{t('editor.noServerFiles')}</p>
        <p className="text-xs mt-1 opacity-70">{t('editor.noServerFilesDesc')}</p>
      </div>
    );
  }

  // Show loading spinner while file content is being fetched
  if (activeFile && contentLoading) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground bg-muted/5">
        <Loader2 className="h-6 w-6 animate-spin opacity-50" />
      </div>
    );
  }

  if (!activeFile) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground bg-muted/5">
        <Loader2 className="h-6 w-6 animate-spin opacity-50" />
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
        activeFileName={activeFile?.name}
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
      />

      {error && (
        <div className="flex items-start gap-2.5 px-4 py-3 text-sm border-b" style={{ backgroundColor: '#fef2f2', borderColor: '#f87171', borderLeft: '4px solid #ef4444', color: '#991b1b' }}>
          <AlertCircle className="h-5 w-5 mt-0.5 shrink-0" style={{ color: '#ef4444' }} />
          <div className="flex-1 whitespace-pre-wrap font-medium">{error}</div>
        </div>
      )}

      <div
        ref={editorContainerRef}
        className="flex-1 overflow-hidden relative"
        data-testid="sql-editor"
      >
        <ErrorBoundary fallback={<SqlViewFallback />}>
          <SqlView
            value={displayContent}
            onChange={(val) => updateFile(activeFile.id, val)}
            className="h-full text-sm"
            editable={sqlViewMode === 'template' && !isReadOnly}
            isDark={isDark}
            highlightedSpan={sqlViewMode === 'template' ? highlightedSpan : null}
            lineWrapping={lineWrapping}
            searchLabels={{
              'Find': t('editorSearch.Find'),
              'Replace': t('editorSearch.Replace'),
              'next': t('editorSearch.next'),
              'previous': t('editorSearch.previous'),
              'replace': t('editorSearch.replace'),
              'replace all': t('editorSearch.replace all'),
            }}
          />
        </ErrorBoundary>
        {isReadOnly && (
          <div className="absolute top-2 right-5 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider bg-muted/80 text-muted-foreground rounded border">
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
    </div>
  );
}
