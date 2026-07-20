import { useState, useCallback, useEffect, useRef, startTransition } from 'react';
import { useLineageStore } from '@pondpilot/flowscope-react';
import { toast } from 'sonner';
import { analyzeWithWorker, getCachedAnalysis, syncAnalysisFiles } from '@/lib/analysis-worker';
import type { BackendAdapter, AnalysisPayload } from '@/lib/backend-adapter';
import type { BatchProgress } from '@/lib/analysis-worker';
import { useProject } from '@/lib/project-store';
import type { Project } from '@/lib/project-store';
import { useAnalysisStore } from '@/lib/analysis-store';
import { useViewStateStore, getIssuesStateWithDefaults } from '@/lib/view-state-store';
import { FILE_LIMITS, ANALYSIS_SQL_PREVIEW_LIMITS } from '@/lib/constants';
import { buildScopedSchemaSQL } from '@/lib/scoped-schema';
import { AnalysisErrorCode, isAnalysisError } from '@/types';
import type { AnalysisState, AnalysisContext, FileValidationResult } from '@/types';
import { loadSchemaFiles } from '@/lib/schema-storage';
import { writeBatchFileResults, readFileResult, writeSchemaData, writeHierarchyData } from '@/lib/analysis-cache';
import i18n from '@/i18n';

// Maximum retry attempts for file sync errors to prevent infinite loops
const MAX_FILE_SYNC_RETRIES = 1;

// Debug flag for analysis-related logging - only enabled in development
const ANALYSIS_DEBUG = !!(import.meta as { env?: { DEV?: boolean } }).env?.DEV;

// Temporary feature flag: when true, skip all heavy SQLite structured writes
// and only persist per-file results to OPFS. Use for debugging sql.js allocation
// issues. Will be turned off once stability is confirmed.
const SKIP_STRUCTURED_SQL = true;
// expose runtime flag so other modules (analysis-cache) can skip heavy sqlite writes
(globalThis as any).__FLOWSCOPE_SKIP_STRUCTURED_SQL = SKIP_STRUCTURED_SQL;

// Safe time measurement function with fallback for test environments
function nowMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

/**
 * Options for the useAnalysis hook.
 */
export interface UseAnalysisOptions {
  /** Backend adapter to use for analysis (optional, falls back to direct worker calls) */
  adapter?: BackendAdapter | null;
}

interface PreparedAnalysisFile {
  id?: string;
  name: string;
  content: string;
}

/**
 * Hook for running lineage analysis.
 *
 * @param backendReady - Whether the backend (REST or WASM) is initialized and ready
 * @param options - Optional configuration including the backend adapter
 */
export function useAnalysis(backendReady: boolean, options?: UseAnalysisOptions) {
  const adapter = options?.adapter;
  const { currentProject, activeProjectId, updateFiles } = useProject();
  const hideCTEs = useLineageStore((state) => state.hideCTEs);
  const setLineageResult = useLineageStore((state) => state.setResult);
  const setLineageSql = useLineageStore((state) => state.setSql);
  const { getResult, getMetrics, setResult: storeResult, setMetrics } = useAnalysisStore();
  const getViewState = useViewStateStore((s) => s.getViewState);
  const enableLinting = activeProjectId
    ? getIssuesStateWithDefaults(getViewState(activeProjectId, 'issues')).showLintIssues
    : false;
  const [state, setState] = useState<AnalysisState>({
    isAnalyzing: false,
    error: null,
    lastAnalyzedAt: null,
    resultStatus: null,
    loadingContext: null,
    progress: 0,
  });
  const analysisRequestRef = useRef(0);
  const currentProjectRef = useRef<Project | null>(currentProject);
  const lastRestoreToastKeyRef = useRef<string | null>(null);

  useEffect(() => {
    currentProjectRef.current = currentProject;
  }, [currentProject]);

  const setAnalyzing = useCallback((isAnalyzing: boolean) => {
    setState((prev) => ({ ...prev, isAnalyzing }));
  }, []);

  const setError = useCallback((error: string | null) => {
    setState((prev) => ({ ...prev, error }));
  }, []);

  const setLoadingContext = useCallback((loadingContext: AnalysisState['loadingContext']) => {
    setState((prev) => ({ ...prev, loadingContext }));
  }, []);

  const mergeResultStatus = useCallback(
    (partial: NonNullable<AnalysisState['resultStatus']> | null) => {
      setState((prev) => ({
        ...prev,
        resultStatus: partial
          ? {
              origin: partial.origin,
              source: partial.source,
              restoredAt: partial.restoredAt,
              persistedAt: partial.persistedAt ?? prev.resultStatus?.persistedAt ?? null,
            }
          : null,
      }));
    },
    []
  );

  const validateFiles = useCallback(
    (files: Array<{ name: string; content: string }>): FileValidationResult => {
      if (files.length === 0) {
        return { valid: false, error: 'No files to analyze' };
      }

      if (files.length > FILE_LIMITS.MAX_COUNT) {
        return {
          valid: false,
          error: `Too many files selected (max ${FILE_LIMITS.MAX_COUNT}). Currently selected: ${files.length} files.`,
        };
      }

      for (const file of files) {
        if (file.content.length > FILE_LIMITS.MAX_SIZE) {
          return {
            valid: false,
            error: `File "${file.name}" is too large (max ${FILE_LIMITS.MAX_SIZE / 1024 / 1024}MB). File size: ${(file.content.length / 1024 / 1024).toFixed(2)}MB.`,
          };
        }
      }

      return { valid: true };
    },
    []
  );

  const isSqlFile = useCallback((name: string) => {
    const lower = name.toLowerCase();
    return lower.endsWith('.sql') || lower.endsWith('.hql');
  }, []);

  const resolveAnalysisContext = useCallback(
    (
      project: Project | null,
      activeFileContent?: string,
      activeFilePath?: string,
      runModeOverride?: Project['runMode']
    ): { description: string; files: PreparedAnalysisFile[] } | null => {
      if (!project) return null;

      let contextDescription = '';
      let filesToAnalyze: PreparedAnalysisFile[] = [];
      const runMode = runModeOverride ?? project.runMode;

      if (runMode === 'current') {
        const projectActiveFile =
          project.files.find((file) => file.id === project.activeFileId) ??
          (activeFilePath ? project.files.find((file) => file.path === activeFilePath) : undefined);

        const currentFilePath = activeFilePath ?? projectActiveFile?.path;
        const currentFileContent = activeFileContent ?? projectActiveFile?.content;

        if (currentFilePath && currentFileContent !== undefined) {
          filesToAnalyze = [
            {
              id: projectActiveFile?.id,
              name: currentFilePath,
              content: currentFileContent,
            },
          ];
          contextDescription = `Analyzing file: ${currentFilePath}`;
        } else {
          contextDescription = 'Analyzing current file';
        }
      } else if (runMode === 'custom') {
        const selectedIds = new Set(project.selectedFileIds || []);
        const selectedFiles = project.files.filter(
          (file) => selectedIds.has(file.id) && isSqlFile(file.name)
        );
        filesToAnalyze = selectedFiles.map((file) => ({
          id: file.id,
          name: file.path,
          content: file.content,
        }));
        contextDescription = `Analyzing selected: ${filesToAnalyze.length} files`;
      } else {
        const sqlFiles = project.files.filter((file) => isSqlFile(file.name));
        filesToAnalyze = sqlFiles.map((file) => ({
          id: file.id,
          name: file.path,
          content: file.content,
        }));
        contextDescription = `Analyzing project: ${sqlFiles.length} files`;
      }

      return {
        description: contextDescription,
        files: filesToAnalyze,
      };
    },
    [isSqlFile]
  );

  const hydrateAnalysisFiles = useCallback(
    async (files: PreparedAnalysisFile[]): Promise<Array<{ name: string; content: string }>> => {
      return files.map((file) => ({ name: file.name, content: file.content }));
    },
    [updateFiles]
  );

  const buildAnalysisContext = useCallback(
    async (
      project: Project | null,
      activeFileContent?: string,
      activeFilePath?: string,
      runModeOverride?: Project['runMode']
    ): Promise<AnalysisContext | null> => {
      const resolvedContext = resolveAnalysisContext(
        project,
        activeFileContent,
        activeFilePath,
        runModeOverride
      );
      if (!resolvedContext) return null;

      const hydratedFiles = await hydrateAnalysisFiles(resolvedContext.files);

      return {
        description: resolvedContext.description,
        fileCount: hydratedFiles.length,
        files: hydratedFiles,
      };
    },
    [resolveAnalysisContext, hydrateAnalysisFiles]
  );

  const resolveScopedSchemaSQL = useCallback(
    async (
      project: Project,
      analysisFiles: Array<{ name: string; content: string }>
    ): Promise<string> => {
      if (!activeProjectId) {
        return project.schemaSQL ?? '';
      }

      try {
        const schemaFiles = await loadSchemaFiles(activeProjectId);
        if (schemaFiles.length === 0) {
          return project.schemaSQL ?? '';
        }

        const scopedSchema = buildScopedSchemaSQL(schemaFiles, analysisFiles);
        if (ANALYSIS_DEBUG) {
          console.log(
            `[useAnalysis] Scoped schema matched ${scopedSchema.matchedBlockCount} blocks for ${scopedSchema.referencedTables.length} referenced tables`
          );
        }
        return scopedSchema.schemaSQL;
      } catch (error) {
        if (ANALYSIS_DEBUG) {
          console.warn('[useAnalysis] Failed to resolve scoped schema SQL:', error);
        }
        return project.schemaSQL ?? '';
      }
    },
    [activeProjectId]
  );

  // Restore cached analysis result from memory when project or hideCTEs changes.
  // Cache validation is built into getResult - it returns null if the cached
  // result was computed with a different hideCTEs setting.
  useEffect(() => {
    if (ANALYSIS_DEBUG)
      console.log(
        `[useAnalysis] Memory cache effect triggered (projectId: ${activeProjectId?.slice(0, 8) ?? 'null'})`
      );
    const memoryCacheStart = nowMs();

    if (!activeProjectId) {
      setLineageResult(null);
      mergeResultStatus(null);
      return;
    }

    const cachedResult = getResult(activeProjectId, hideCTEs);
    if (ANALYSIS_DEBUG)
      console.log(
        `[useAnalysis] Memory cache ${cachedResult ? 'HIT' : 'MISS'} (${(nowMs() - memoryCacheStart).toFixed(1)}ms)`
      );
    // Use startTransition to make the result update low-priority,
    // allowing UI interactions and worker callbacks to proceed without blocking
    startTransition(() => {
      setLineageResult(cachedResult);
    });
    if (cachedResult) {
      mergeResultStatus({
        origin: 'cache',
        source: 'memory',
        restoredAt: Date.now(),
        persistedAt: null,
      });
    }

    if (cachedResult || !backendReady) {
      return;
    }
  }, [activeProjectId, hideCTEs, getResult, backendReady, mergeResultStatus]);

  // Check worker's IndexedDB cache for persisted analysis results.
  // This runs after the memory cache effect and may update the result
  // if a cached result is found in the worker's persistent storage.
  const selectedFileIdsKey = currentProject?.selectedFileIds.join('|') ?? '';

  useEffect(() => {
    if (ANALYSIS_DEBUG)
      console.log(
        `[useAnalysis] IndexedDB cache effect triggered (projectId: ${activeProjectId?.slice(0, 8) ?? 'null'})`
      );

    if (!backendReady || !activeProjectId) {
      return;
    }

    const cachedResult = getResult(activeProjectId, hideCTEs);
    if (cachedResult) {
      if (ANALYSIS_DEBUG) console.log('[useAnalysis] IndexedDB cache skipped (memory cache hit)');
      return;
    }

    const project = currentProjectRef.current;
    if (!project) {
      return;
    }

    let cancelled = false;
    const cacheStart = nowMs();

    const restoreCachedAnalysis = async () => {
      const activeFile = project.files.find((file) => file.id === project.activeFileId);
      const context = await buildAnalysisContext(project, activeFile?.content, activeFile?.path);
      if (cancelled || !context || context.files.length === 0) {
        return;
      }

      const schemaSQL = await resolveScopedSchemaSQL(project, context.files);
      if (cancelled) {
        return;
      }

      if (ANALYSIS_DEBUG)
        console.log(`[useAnalysis] Checking IndexedDB cache for ${context.files.length} files`);

      const cachePayload: AnalysisPayload = {
        files: context.files,
        dialect: project.dialect,
        schemaSQL,
        hideCTEs,
        enableColumnLineage: true,
        enableLinting,
        templateMode: project.templateMode,
      };

      const cached = adapter
        ? await adapter.getCached(cachePayload)
        : await syncAnalysisFiles(context.files).then(() => {
            if (ANALYSIS_DEBUG)
              console.log(`[useAnalysis] Files synced, checking IndexedDB cache...`);
            return getCachedAnalysis({
              fileNames: context.files.map((file) => file.name),
              dialect: project.dialect,
              schemaSQL,
              hideCTEs,
              enableColumnLineage: true,
              enableLinting,
              templateMode: project.templateMode,
            });
          });

      const durationMs = nowMs() - cacheStart;
      if (cancelled) {
        if (ANALYSIS_DEBUG)
          console.log(`[useAnalysis] IndexedDB cache cancelled after ${durationMs.toFixed(1)}ms`);
        return;
      }
      if (!cached?.result) {
        if (ANALYSIS_DEBUG)
          console.log(`[useAnalysis] IndexedDB cache MISS after ${durationMs.toFixed(1)}ms`);
        return;
      }
      if (ANALYSIS_DEBUG)
        console.log(
          `[useAnalysis] IndexedDB cache HIT after ${durationMs.toFixed(1)}ms - calling setResult`
        );
      // Use startTransition to make the result update low-priority,
      // allowing UI interactions and worker callbacks to proceed without blocking
      startTransition(() => {
        setLineageResult(cached.result);
      });
      storeResult(activeProjectId, cached.result, hideCTEs);
      mergeResultStatus({
        origin: 'cache',
        source: 'indexeddb',
        restoredAt: Date.now(),
        persistedAt: null,
      });
      const restoreToastKey = `indexeddb:${activeProjectId}:${project.activeFileId ?? 'unknown'}`;
      if (lastRestoreToastKeyRef.current !== restoreToastKey) {
        toast.success(i18n.t('analysis.restoredPersistentResult'), {
          description: activeFile?.path ?? context.files[0]?.name ?? undefined,
          duration: 2200,
        });
        lastRestoreToastKeyRef.current = restoreToastKey;
      }
      setMetrics(activeProjectId, {
        lastDurationMs: durationMs,
        lastCacheHit: true,
        lastCacheKey: cached.cacheKey,
        lastAnalyzedAt: Date.now(),
        workerTimings: cached.timings ?? null,
      });
    };

    restoreCachedAnalysis().catch((error: unknown) => {
      if (!cancelled) {
        console.warn('Failed to restore cached analysis:', error);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [
    activeProjectId,
    currentProject?.activeFileId,
    currentProject?.runMode,
    selectedFileIdsKey,
    hideCTEs,
    enableLinting,
    getResult,
    storeResult,
    setMetrics,
    backendReady,
    buildAnalysisContext,
    resolveScopedSchemaSQL,
    adapter,
    mergeResultStatus,
  ]);

  // 从 SQLite project_file_results 恢复已分析文件的结果。
  // 当文件切换时，尝试从持久化的单文件结果恢复。
  useEffect(() => {
    if (!activeProjectId || !currentProject?.activeFileId) return;

    const activeFile = currentProject.files.find((f) => f.id === currentProject.activeFileId);
    if (!activeFile) return;
    const isCurrentFileMode = currentProject.runMode === 'current';

    let cancelled = false;

    readFileResult(activeProjectId, activeFile.path).then((result) => {
      if (cancelled) return;
      if (!result) {
        if (isCurrentFileMode) {
          startTransition(() => {
            setLineageResult(null);
          });
          mergeResultStatus(null);
        }
        return;
      }

      console.log(`[useAnalysis] SQLite file cache HIT: ${activeFile.path}`);
      startTransition(() => {
        setLineageResult(result);
      });
      storeResult(activeProjectId, result, hideCTEs);
      mergeResultStatus({
        origin: 'cache',
        source: 'sqlite',
        restoredAt: Date.now(),
        persistedAt: null,
      });

      // 同步 SQL 预览
      if (activeFile.content) {
        setLineageSql(activeFile.content);
      }

      const restoreToastKey = `sqlite:${activeProjectId}:${activeFile.path}`;
      if (lastRestoreToastKeyRef.current !== restoreToastKey) {
        toast.success(i18n.t('analysis.restoredPersistentResult'), {
          description: activeFile.path,
          duration: 2200,
        });
        lastRestoreToastKeyRef.current = restoreToastKey;
      }
    });

    return () => {
      cancelled = true;
    };
  }, [
    activeProjectId,
    currentProject?.activeFileId,
    currentProject?.files,
    currentProject?.runMode,
    hideCTEs,
    storeResult,
    mergeResultStatus,
  ]);

  const runAnalysis = useCallback(
    async (
      activeFileContent?: string,
      activeFilePath?: string,
      options?: { runModeOverride?: Project['runMode'] }
    ) => {
      const project = currentProjectRef.current;
      if (!backendReady || !project) return;

      const requestId = analysisRequestRef.current + 1;
      analysisRequestRef.current = requestId;
      const runMode = options?.runModeOverride ?? project.runMode;
      const requestedFileName =
        activeFilePath ??
        project.files.find((file) => file.id === project.activeFileId)?.path ??
        null;

      setAnalyzing(true);
      setError(null);
      setLoadingContext({
        fileName: requestedFileName,
        runMode,
        fileCount: 0,
        stage: 'preparing',
      });

      const analysisStart = performance.now();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

      try {
        const context = await buildAnalysisContext(
          project,
          activeFileContent,
          activeFilePath,
          runMode
        );

        if (!context) {
          setError('No project context available');
          return;
        }

        if (context.files.length === 0) {
          if ((options?.runModeOverride ?? project.runMode) === 'custom') {
            setError('No files selected for analysis.');
            return;
          }
          if (project.files.length > 0) {
            setError('No .sql files found in project.');
            return;
          }
          return;
        }

        setLoadingContext({
          fileName: context.files[0]?.name ?? requestedFileName,
          runMode,
          fileCount: context.fileCount,
          stage: 'loadingSchema',
        });

        const validation = validateFiles(context.files);
        if (!validation.valid) {
          setError(validation.error || 'Validation failed');
          return;
        }

        console.log(context.description);

        let shouldBuildPreview = context.files.length <= ANALYSIS_SQL_PREVIEW_LIMITS.MAX_FILES;
        let totalChars = 0;

        if (shouldBuildPreview) {
          totalChars = context.files.reduce((sum, file) => sum + file.content.length, 0);
          shouldBuildPreview = totalChars <= ANALYSIS_SQL_PREVIEW_LIMITS.MAX_CHARS;
        }

        if (shouldBuildPreview) {
          const representativeSql = context.files
            .map((f) => `-- File: ${f.name}\n${f.content}`)
            .join('\n\n');
          setLineageSql(representativeSql);
        } else if (activeFileContent !== undefined) {
          setLineageSql(activeFileContent);
        }

        const schemaSQL = await resolveScopedSchemaSQL(project, context.files);

        setLoadingContext({
          fileName: context.files[0]?.name ?? requestedFileName,
          runMode,
          fileCount: context.fileCount,
          stage: 'buildingLineage',
        });

        const adapterPayload: AnalysisPayload = {
          files: context.files,
          dialect: project.dialect,
          schemaSQL,
          hideCTEs,
          enableColumnLineage: true,
          enableLinting,
          templateMode: project.templateMode,
        };

        const cachedResult = activeProjectId ? getResult(activeProjectId, hideCTEs) : null;
        const knownCacheKey =
          cachedResult && activeProjectId
            ? (getMetrics(activeProjectId)?.lastCacheKey ?? null)
            : null;

        let analysisResponse: Awaited<ReturnType<typeof analyzeWithWorker>>;
        let fileSyncRetries = 0;

        // Use adapter if available, otherwise fall back to direct worker calls
        if (adapter) {
          while (true) {
            try {
              analysisResponse = await adapter.analyze(adapterPayload);
              break;
            } catch (error) {
              if (
                isAnalysisError(error, AnalysisErrorCode.MISSING_FILE_CONTENT) &&
                fileSyncRetries < MAX_FILE_SYNC_RETRIES
              ) {
                fileSyncRetries++;
                await adapter.syncFiles(context.files);
                continue;
              }
              throw error;
            }
          }
        } else {
          // Fallback to direct worker calls for backwards compatibility
          const workerPayload = {
            fileNames: context.files.map((file) => file.name),
            dialect: project.dialect,
            schemaSQL,
            hideCTEs,
            enableColumnLineage: true,
            enableLinting,
            templateMode: project.templateMode,
          };

          while (true) {
            try {
              analysisResponse = await analyzeWithWorker(workerPayload, {
                knownCacheKey,
                onProgress: (prog: BatchProgress) => {
                  // Compute percent: prefer completedFiles/totalFiles, else fallback to batchIndex/batchTotal
                  let pct: number | undefined;
                  if (prog.totalFiles && prog.totalFiles > 0) {
                    pct = Math.round(((prog.completedFiles ?? 0) / prog.totalFiles) * 100);
                  } else if (
                    typeof prog.batchIndex === 'number' &&
                    typeof prog.batchTotal === 'number' &&
                    prog.batchTotal > 0
                  ) {
                    // Use batchIndex (0-based) to estimate progress across batches
                    pct = Math.round(((prog.batchIndex + 1) / prog.batchTotal) * 100);
                  }

                  setState((prev) => ({
                    ...prev,
                    progress: pct ?? prev.progress,
                    loadingContext: prev.loadingContext
                      ? {
                          ...prev.loadingContext,
                          batchProgress: prog.batchProgress ?? prev.loadingContext.batchProgress,
                          processedFiles: prog.completedFiles ?? prev.loadingContext.processedFiles,
                          fileName: prog.batchFile ?? prev.loadingContext.fileName,
                        }
                      : prev.loadingContext,
                  }));
                },
              });
              break;
            } catch (error) {
              // Handle missing file content by syncing files and retrying.
              // Uses structured error codes instead of string matching for reliability.
              // Limited retries prevent infinite loops if sync consistently fails.
              if (
                isAnalysisError(error, AnalysisErrorCode.MISSING_FILE_CONTENT) &&
                fileSyncRetries < MAX_FILE_SYNC_RETRIES
              ) {
                fileSyncRetries++;
                await syncAnalysisFiles(context.files);
                continue;
              }
              throw error;
            }
          }
        }

        if (analysisRequestRef.current !== requestId) {
          return;
        }

        const durationMs = performance.now() - analysisStart;

        if (!analysisResponse.skipped && analysisResponse.result) {
          const result = analysisResponse.result; // narrowed to non-null
          setLoadingContext({
            fileName: context.files[0]?.name ?? requestedFileName,
            runMode,
            fileCount: context.fileCount,
            stage: 'persisting',
          });
          // Use startTransition to make the result update low-priority,
          // allowing UI interactions and worker callbacks to proceed without blocking
          startTransition(() => {
            setLineageResult(result);
          });
          if (activeProjectId) {
            storeResult(activeProjectId, result, hideCTEs);
            // Defer frequent DB persists while performing many writes to reduce sql.js memory pressure.
            (globalThis as any).__FLOWSCOPE_DEFER_PERSIST = true;
            // Fallback content hash so files with different content get distinct cache keys.
            // Otherwise all results collapse to 'no_hash' and only one is kept/exported.
            const cacheKey = analysisResponse.cacheKey || (() => {
              let h = 5381;
              for (const f of context.files) {
                const c = (f as { content?: string }).content ?? '';
                const id = (f as { path?: string; name?: string }).path ?? f.name ?? '';
                h = (((h * 33) ^ id.length) ^ c.length) | 0;
              }
              return 'h' + (h >>> 0).toString(36);
            })();

            // Collect all file paths, then write the merged result to OPFS once
            // and batch-insert DB pointer rows.  This avoids writing the same
            // 10MB+ JSON O(N) times when N files share one result.
            const allFilePaths = context.files.map((f: { name: string; path?: string }) => f.path ?? f.name);
            try {
              await writeBatchFileResults(activeProjectId, allFilePaths, cacheKey, result);
            } catch (err) {
              console.error('[useAnalysis] writeBatchFileResults failed', err);
            }

            // Update progress bar to show completion
            setState((prev) => ({
              ...prev,
              progress: 100,
              loadingContext: prev.loadingContext
                ? { ...prev.loadingContext, processedFiles: context.files.length }
                : prev.loadingContext,
            }));

            // Persist lineage data (nodes/columns/edges) per file — do this FIRST
            // before other writes that may fail in serve mode (writeSchemaData etc. use DuckDB/OPFS)
            const { writeLineageData, writeTableMetadata } = await import('@/lib/analysis-cache');
            try {
              await writeLineageData(activeProjectId, result);
            } catch (err) {
              console.error('[useAnalysis] writeLineageData failed', err);
            }
            // 预计算表级血缘(穿透 CTE)物化到 table_level_edges,供导出快速读取
            try {
              const { writeTableLevelEdges } = await import('@/lib/analysis-cache');
              await writeTableLevelEdges(activeProjectId, result);
            } catch (err) {
              console.error('[useAnalysis] writeTableLevelEdges failed', err);
            }

            // Persist table/column metadata from resolvedSchema
            try {
              await writeTableMetadata(activeProjectId, result, project.dialect);
            } catch (err) {
              console.error('[useAnalysis] writeTableMetadata failed', err);
            }

            // Write global artifacts (best-effort)
            try { await writeSchemaData(activeProjectId, result); } catch {}
            try { await writeHierarchyData(activeProjectId, result); } catch {}
          }

          toast.success(i18n.t('analysis.persistedCurrentResult'), {
            description:
              context.fileCount > 1
                ? i18n.t('analysis.persistedCurrentResultDesc', {
                    primary:
                      context.files[0]?.name ??
                      requestedFileName ??
                      i18n.t('analysis.loadingCurrentFilePending'),
                    rest: Math.max(0, context.fileCount - 1),
                  })
                : context.files[0]?.name ?? requestedFileName ?? undefined,
            duration: 2200,
          });
          mergeResultStatus({
            origin: 'fresh',
            source: 'fresh',
            restoredAt: null,
            persistedAt: Date.now(),
          });
        }

        setLoadingContext({
          fileName: context.files[0]?.name ?? requestedFileName,
          runMode,
          fileCount: context.fileCount,
          stage: 'rendering',
        });

        if (activeProjectId) {
          setMetrics(activeProjectId, {
            lastDurationMs: durationMs,
            lastCacheHit: analysisResponse.cacheHit,
            lastCacheKey: analysisResponse.cacheKey,
            lastAnalyzedAt: Date.now(),
            workerTimings: analysisResponse.timings ?? null,
          });
        }
        setState((prev) => ({ ...prev, lastAnalyzedAt: Date.now() }));
      } catch (error) {
        if (analysisRequestRef.current !== requestId) {
          return;
        }
        setError(error instanceof Error ? error.message : 'Analysis failed');
        console.error(error);
      } finally {
        if (analysisRequestRef.current === requestId) {
          setAnalyzing(false);
          setLoadingContext(null);
        }
      }
    },
    [
      backendReady,
      activeProjectId,
      storeResult,
      setMetrics,
      getMetrics,
      getResult,
      buildAnalysisContext,
      validateFiles,
      setAnalyzing,
      setError,
      hideCTEs,
      enableLinting,
      adapter,
      setLoadingContext,
      mergeResultStatus,
      resolveScopedSchemaSQL,
    ]
  );

  return {
    ...state,
    runAnalysis,
    setError,
  };
}
