import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  startTransition,
} from 'react';
import type { FileSource, SchemaMetadata } from '@pondpilot/flowscope-core';
import {
  STORAGE_KEYS,
  FILE_EXTENSIONS,
  SHARE_LIMITS,
  DEFAULT_FILE_LANGUAGE,
  ACCEPTED_FILE_TYPES_ARRAY,
} from './constants';
import type { SharePayload } from './share';
import { parseTemplateMode } from '@/types';
import type { TemplateMode } from '@/types';
import { DEFAULT_PROJECT, DEFAULT_DBT_PROJECT } from './default-projects';
import { useBackend } from './backend-context';
import { useBackendFiles } from '@/hooks/useBackendFiles';
import { saveProjectFiles, loadProjectFiles, deleteProjectFiles } from './file-storage';
import * as serverDb from '@/lib/server-db';
import { genId } from '@/lib/utils';

const uuidv4 = () => genId();

const MAX_PROJECT_NAME_LENGTH = 50;
const VALID_RUN_MODES: readonly RunMode[] = ['current', 'all', 'custom'];

/**
 * Validates and sanitizes a project name.
 * Returns the sanitized name or null if invalid.
 */
function validateProjectName(name: string, existingNames: string[]): string | null {
  const trimmed = name.trim().slice(0, MAX_PROJECT_NAME_LENGTH);

  if (!trimmed) {
    return null;
  }

  // Check for duplicate names (case-insensitive)
  const lowerName = trimmed.toLowerCase();
  if (existingNames.some((existing) => existing.toLowerCase() === lowerName)) {
    return null;
  }

  return trimmed;
}

export type Dialect =
  | 'generic'
  | 'ansi'
  | 'bigquery'
  | 'clickhouse'
  | 'databricks'
  | 'duckdb'
  | 'hive'
  | 'mssql'
  | 'mysql'
  | 'oracle'
  | 'postgres'
  | 'redshift'
  | 'snowflake'
  | 'sqlite';

/** Human-readable labels for each dialect. */
const DIALECT_LABELS: Record<Dialect, string> = {
  generic: 'Generic SQL',
  ansi: 'ANSI SQL',
  bigquery: 'BigQuery',
  clickhouse: 'ClickHouse',
  databricks: 'Databricks',
  duckdb: 'DuckDB',
  hive: 'Hive',
  mssql: 'MS SQL Server',
  mysql: 'MySQL',
  oracle: 'Oracle',
  postgres: 'PostgreSQL',
  redshift: 'Redshift',
  snowflake: 'Snowflake',
  sqlite: 'SQLite',
};

/** All valid dialect values for runtime validation. */
export const VALID_DIALECTS: readonly Dialect[] = [
  'generic',
  'ansi',
  'bigquery',
  'clickhouse',
  'databricks',
  'duckdb',
  'hive',
  'mssql',
  'mysql',
  'oracle',
  'postgres',
  'redshift',
  'snowflake',
  'sqlite',
] as const;

/**
 * Dialect options for UI dropdowns, derived from VALID_DIALECTS.
 * This ensures the UI options are always in sync with valid dialect values.
 * Note: 'ansi' is excluded from UI since 'generic' serves the same purpose for users.
 */
export const DIALECT_OPTIONS: readonly { value: Dialect; label: string }[] = VALID_DIALECTS.filter(
  (d) => d !== 'ansi' // 'ansi' is valid but not shown in UI (use 'generic' instead)
).map((value) => ({
  value,
  label: DIALECT_LABELS[value],
}));

/**
 * Type guard to check if a value is a valid Dialect.
 */
export function isValidDialect(value: unknown): value is Dialect {
  return typeof value === 'string' && VALID_DIALECTS.includes(value as Dialect);
}

export type RunMode = 'current' | 'all' | 'custom';
// Re-export TemplateMode from shared types for backward compatibility
export type { TemplateMode } from '@/types';

export interface ProjectFile {
  id: string;
  name: string;
  path: string; // Relative path including filename, e.g., "queries/users/get-all.sql"
  content: string;
  language: 'sql' | 'json' | 'text';
  size?: number;
}

export interface Project {
  id: string;
  name: string;
  files: ProjectFile[];
  activeFileId: string | null;
  dialect: Dialect;
  runMode: RunMode;
  selectedFileIds: string[];
  schemaSQL: string; // User-provided CREATE TABLE statements for schema augmentation
  templateMode: TemplateMode; // Template preprocessing mode (raw, jinja, dbt)
}

interface ProjectContextType {
  projects: Project[];
  activeProjectId: string | null;
  currentProject: Project | null;
  createProject: (name: string) => void;
  deleteProject: (id: string) => void;
  renameProject: (id: string, newName: string) => void;
  selectProject: (id: string) => void;
  setProjectDialect: (projectId: string, dialect: Dialect) => void;
  setRunMode: (projectId: string, mode: RunMode) => void;
  setTemplateMode: (projectId: string, mode: TemplateMode) => void;
  toggleFileSelection: (projectId: string, fileId: string) => void;
  setFileSelection: (projectId: string, fileIds: string[], select: boolean) => void;

  // File actions for active project
  createFile: (name: string, content?: string, path?: string) => void;
  updateFile: (fileId: string, content: string) => void;
  updateFiles: (updates: Array<{ fileId: string; content: string }>) => void;
  deleteFile: (fileId: string) => void;
  deleteFiles: (fileIds: string[]) => void;
  renameFile: (fileId: string, newName: string) => void;
  renameFolder: (oldFolderPath: string, newFolderName: string) => void;
  deleteFolder: (folderPath: string) => void;
  selectFile: (fileId: string) => void;

  // Schema SQL management
  updateSchemaSQL: (projectId: string, schemaSQL: string) => void;

  // Import/Export
  importFiles: (files: FileList | File[]) => Promise<void>;
  replaceWithFiles: (files: FileList | File[]) => Promise<void>;
  /** Directly add pre-built ProjectFile objects (no file reading needed) */
  addFilesDirectly: (files: ProjectFile[]) => void;

  // Import from shared URL
  importProject: (payload: SharePayload) => string;

  // Backend mode state
  /** True when connected to REST backend (serve mode) */
  isBackendMode: boolean;
  /** True when files are read-only (in backend mode) */
  isReadOnly: boolean;
  /** Schema metadata from backend (database introspection), null if not available */
  backendSchema: SchemaMetadata | null;
  /** Directories being watched by the backend */
  backendWatchDirs: string[];
  /** Refresh files from backend */
  refreshBackendFiles: () => Promise<void>;
}

const ProjectContext = createContext<ProjectContextType | null>(null);

/**
 * Sync initialiser — returns default projects.
 * Real projects are loaded from DuckDB asynchronously after mount.
 */
const loadProjectsFromStorage = (): Project[] => {
  try {
    const saved = localStorage.getItem(STORAGE_KEYS.PROJECTS);
    if (saved) {
      const parsed = JSON.parse(saved);
      return parsed.map((p: Partial<Project>) => ({
        id: p.id || genId(),
        name: p.name || 'Untitled',
        dialect: p.dialect || 'generic',
        runMode:
          typeof p.runMode === 'string' && VALID_RUN_MODES.includes(p.runMode as RunMode)
            ? (p.runMode as RunMode)
            : ('current' as RunMode),
        selectedFileIds: Array.isArray(p.selectedFileIds)
          ? p.selectedFileIds.filter((id): id is string => typeof id === 'string')
          : [],
        schemaSQL: p.schemaSQL || '',
        templateMode: parseTemplateMode(p.templateMode),
        files: [], // Files are loaded from DuckDB asynchronously
        activeFileId: typeof p.activeFileId === 'string' ? p.activeFileId : null,
      }));
    }
  } catch (error) {
    console.error('Failed to load projects from storage:', error);
  }
  return [DEFAULT_PROJECT, DEFAULT_DBT_PROJECT];
};

/** Convert backend ProjectMeta row → frontend Project (files loaded separately). */
const metaToProject = (m: serverDb.ProjectMeta): Project => ({
  id: m.id,
  name: m.name,
  dialect: isValidDialect(m.dialect) ? (m.dialect as Dialect) : 'generic',
  runMode: VALID_RUN_MODES.includes(m.run_mode as RunMode) ? (m.run_mode as RunMode) : 'current',
  selectedFileIds: (() => {
    try {
      const parsed = JSON.parse(m.selected_file_ids);
      return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
    } catch {
      return [];
    }
  })(),
  schemaSQL: m.schema_sql,
  templateMode: parseTemplateMode(m.template_mode),
  files: [],
  activeFileId: m.active_file_id,
});

/**
 * Persist project settings to localStorage (lightweight, sync).
 * File contents are saved to DuckDB separately (async).
 */
const saveProjectSettingsToStorage = (projects: Project[]) => {
  try {
    const settings = projects.map((p) => ({
      id: p.id,
      name: p.name,
      dialect: p.dialect,
      templateMode: p.templateMode,
      schemaSQL: p.schemaSQL,
      runMode: p.runMode,
      selectedFileIds: p.selectedFileIds,
      activeFileId: p.activeFileId,
    }));
    localStorage.setItem(STORAGE_KEYS.PROJECTS, JSON.stringify(settings));
    // 同步到后端(db 为 source of truth),debounced
    scheduleBackendProjectSync(projects);
  } catch (error) {
    console.error('Failed to save project settings to storage:', error);
  }
};

let backendProjectSyncTimer: ReturnType<typeof setTimeout> | undefined;
const scheduleBackendProjectSync = (projects: Project[]) => {
  if (backendProjectSyncTimer) clearTimeout(backendProjectSyncTimer);
  backendProjectSyncTimer = setTimeout(() => {
    for (const p of projects) {
      serverDb
        .saveProject({
          id: p.id,
          name: p.name,
          dialect: p.dialect,
          run_mode: p.runMode,
          template_mode: p.templateMode,
          schema_sql: p.schemaSQL,
          selected_file_ids: JSON.stringify(p.selectedFileIds),
          active_file_id: p.activeFileId,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .catch((e) => console.error('Failed to sync project to backend:', e));
    }
  }, 500);
};

/** Debounced IndexedDB file save — 500ms delay to avoid frequent writes */
const fileSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();

const debouncedSaveFiles = (projectId: string, files: ProjectFile[]) => {
  const existing = fileSaveTimers.get(projectId);
  if (existing) clearTimeout(existing);
  fileSaveTimers.set(
    projectId,
    setTimeout(() => {
      fileSaveTimers.delete(projectId);
      saveProjectFiles(projectId, files);
    }, 500)
  );
};

const loadActiveProjectIdFromStorage = (projects: Project[]): string | null => {
  try {
    const saved = localStorage.getItem(STORAGE_KEYS.ACTIVE_PROJECT_ID);
    if (saved && projects.some((p) => p.id === saved)) {
      return saved;
    }
  } catch (error) {
    console.error('Failed to load active project id from storage:', error);
  }
  return projects[0]?.id || null;
};

const saveActiveProjectIdToStorage = (projectId: string | null) => {
  try {
    if (projectId) {
      localStorage.setItem(STORAGE_KEYS.ACTIVE_PROJECT_ID, projectId);
    } else {
      localStorage.removeItem(STORAGE_KEYS.ACTIVE_PROJECT_ID);
    }
  } catch (error) {
    console.error('Failed to save active project id to storage:', error);
  }
};

/** Convert backend FileSource to ProjectFile format */
function fileSourceToProjectFile(file: FileSource): ProjectFile {
  return {
    id: file.name, // Use name as ID for backend files (stable identifier)
    name: file.name.split('/').pop() || file.name,
    path: file.name,
    content: file.content,
    language: file.name.endsWith('.sql') ? 'sql' : file.name.endsWith('.json') ? 'json' : 'text',
  };
}

/** Backend project ID constant */
const BACKEND_PROJECT_ID = '__backend__';

export function ProjectProvider({ children }: { children: React.ReactNode }) {
  const [projects, setProjects] = useState<Project[]>(loadProjectsFromStorage);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(() =>
    loadActiveProjectIdFromStorage(projects)
  );
  // Track active file separately to avoid triggering full project serialization on file switch
  const [activeFileIdOverride, setActiveFileIdOverride] = useState<string | null>(null);

  // Get backend state
  const { backendType } = useBackend();
  const isBackendMode = backendType === 'rest';
  const {
    files: backendFiles,
    schema: backendSchema,
    dialect: backendDialect,
    watchDirs: backendWatchDirs,
    templateMode: backendTemplateMode,
    refresh: refreshBackendFiles,
  } = useBackendFiles(isBackendMode);

  // Track backend-specific state separately since it's derived, not persisted.
  const [backendActiveFileId, setBackendActiveFileId] = useState<string | null>(null);
  const [backendRunMode, setBackendRunMode] = useState<RunMode>('current');
  const [backendSelectedFileIds, setBackendSelectedFileIds] = useState<string[]>([]);

  useEffect(() => {
    if (!backendFiles || backendFiles.length === 0) {
      setBackendActiveFileId(null);
      return;
    }

    if (!backendActiveFileId || !backendFiles.some((file) => file.name === backendActiveFileId)) {
      setBackendActiveFileId(backendFiles[0].name);
    }
  }, [backendFiles, backendActiveFileId]);

  // Sync selected file IDs when backend files change (files may be removed)
  useEffect(() => {
    if (!backendFiles) {
      setBackendSelectedFileIds([]);
      setBackendRunMode('current');
      return;
    }

    setBackendSelectedFileIds((prev) => {
      const validIds = prev.filter((id) => backendFiles.some((file) => file.name === id));
      // Only update if something changed
      return validIds.length === prev.length ? prev : validIds;
    });
  }, [backendFiles]);

  // Reset run mode to 'current' when all selected files are removed
  useEffect(() => {
    if (backendSelectedFileIds.length === 0 && backendRunMode === 'custom') {
      setBackendRunMode('current');
    }
  }, [backendSelectedFileIds, backendRunMode]);

  useEffect(() => {
    if (!isBackendMode) {
      setBackendActiveFileId(null);
      setBackendSelectedFileIds([]);
      setBackendRunMode('current');
    }
  }, [isBackendMode]);

  // Create a virtual project from backend files
  const backendProject: Project | null = useMemo(() => {
    if (!isBackendMode || !backendFiles) return null;

    return {
      id: BACKEND_PROJECT_ID,
      name: 'Server Files',
      files: backendFiles.map(fileSourceToProjectFile),
      activeFileId: backendActiveFileId,
      dialect: backendDialect,
      runMode: backendRunMode,
      selectedFileIds: backendSelectedFileIds,
      schemaSQL: '', // Schema comes from backend
      templateMode: backendTemplateMode,
    };
  }, [
    isBackendMode,
    backendFiles,
    backendDialect,
    backendTemplateMode,
    backendActiveFileId,
    backendRunMode,
    backendSelectedFileIds,
  ]);

  // Track whether IndexedDB files have been loaded (prevent overwriting on mount)
  const filesLoadedRef = useRef(false);
  // Track previous file signatures per project to detect changes (id+path+content length)
  const prevFileSignaturesRef = useRef<Map<string, string>>(new Map());

  // Compute a lightweight signature for a project's files
  const computeFileSignature = (files: ProjectFile[]): string => {
    return files.map((f) => `${f.id}:${f.path}:${f.content.length}`).join('|');
  };

  // 回填:localStorage 无项目时,从后端 loadProjects 恢复(换设备/清缓存)
  useEffect(() => {
    if (localStorage.getItem(STORAGE_KEYS.PROJECTS)) return;
    serverDb
      .loadProjects()
      .then((rows) => {
        if (rows.length > 0) {
          setProjects(rows.map(metaToProject));
        }
      })
      .catch(() => {
        /* backend unavailable, keep defaults */
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Save project settings to localStorage (sync, lightweight)
  useEffect(() => {
    saveProjectSettingsToStorage(projects);
  }, [projects]);

  // Save project files to IndexedDB — detect changes by signature, not just count
  useEffect(() => {
    if (!filesLoadedRef.current) return;
    for (const project of projects) {
      const prevSig = prevFileSignaturesRef.current.get(project.id);
      const currentSig = computeFileSignature(project.files);
      // Save if signature changed (covers add/delete/rename/content-length changes)
      if (prevSig !== currentSig && project.files.length > 0) {
        debouncedSaveFiles(project.id, project.files);
      }
    }
    // Update tracking
    const newSigs = new Map<string, string>();
    for (const p of projects) {
      newSigs.set(p.id, computeFileSignature(p.files));
    }
    prevFileSignaturesRef.current = newSigs;
  }, [projects]);

  // Flush pending saves on page unload
  useEffect(() => {
    const handleBeforeUnload = () => {
      // Fire off immediate saves for any pending debounced writes
      for (const project of projects) {
        const timer = fileSaveTimers.get(project.id);
        if (timer) {
          clearTimeout(timer);
          fileSaveTimers.delete(project.id);
          saveProjectFiles(project.id, project.files);
        }
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [projects]);

  // Load files from DuckDB on mount (non-blocking)
  useEffect(() => {
    let cancelled = false;
    const loadFiles = async () => {
      // Load files per-project in small batches to avoid blocking the main thread
      const updatedProjects: Array<{ id: string; files: ProjectFile[] } | null> = [];
      for (const p of projects) {
        if (p.files.length > 0) {
          updatedProjects.push(null);
          continue;
        }
        // Load files from DB
        const files = await loadProjectFiles(p.id);
        updatedProjects.push(files.length > 0 ? { id: p.id, files } : null);
        // Yield to main thread to allow rendering progress
        await new Promise((res) => requestAnimationFrame(res));
      }

      if (cancelled) return;

      const projectsWithFiles = updatedProjects.filter(Boolean) as {
        id: string;
        files: ProjectFile[];
      }[];

      // Mark loaded BEFORE setState so the save effect doesn't re-save stale data
      filesLoadedRef.current = true;

      // Initialize signature tracking so save effect doesn't immediately trigger
      const newSigs = new Map<string, string>();
      for (const p of projects) {
        const loaded = projectsWithFiles.find((u) => u.id === p.id);
        const files = loaded ? loaded.files : p.files;
        newSigs.set(p.id, computeFileSignature(files));
      }
      prevFileSignaturesRef.current = newSigs;

      if (projectsWithFiles.length > 0) {
        // Use startTransition and incremental updates to avoid UI freeze when injecting many files
        startTransition(() => {
          setProjects((prev) =>
            prev.map((p) => {
              const loaded = projectsWithFiles.find((u) => u.id === p.id);
              if (!loaded) return p;
              const validActiveFileId =
                p.activeFileId && loaded.files.some((file) => file.id === p.activeFileId)
                  ? p.activeFileId
                  : loaded.files[0]?.id || null;
              const validSelectedFileIds = (p.selectedFileIds || []).filter((fileId) =>
                loaded.files.some((file) => file.id === fileId)
              );
              return {
                ...p,
                files: loaded.files,
                activeFileId: validActiveFileId,
                selectedFileIds: validSelectedFileIds,
                runMode:
                  p.runMode === 'custom' && validSelectedFileIds.length === 0 ? 'current' : p.runMode,
              };
            })
          );
        });
      }
    };

    loadFiles();
    return () => {
      cancelled = true;
    };
  }, []); // Run once on mount

  useEffect(() => {
    saveActiveProjectIdToStorage(activeProjectId);
  }, [activeProjectId]);

  // In backend mode, use the backend project; otherwise use regular projects
  const effectiveProjects =
    isBackendMode && backendProject ? [backendProject, ...projects] : projects;

  // In backend mode, default to backend project unless user selected a valid local project
  const effectiveActiveProjectId = isBackendMode
    ? (activeProjectId && projects.some((p) => p.id === activeProjectId) ? activeProjectId : BACKEND_PROJECT_ID)
    : activeProjectId;

  const currentProjectRaw =
    effectiveProjects.find((p) => p.id === effectiveActiveProjectId) || null;
  const currentProject = useMemo(() => {
    if (!currentProjectRaw) return null;
    // Use the override activeFileId if set (avoids triggering full project serialization)
    const effectiveActiveFileId =
      activeFileIdOverride && currentProjectRaw.files.some((f) => f.id === activeFileIdOverride)
        ? activeFileIdOverride
        : currentProjectRaw.activeFileId;
    return effectiveActiveFileId !== currentProjectRaw.activeFileId
      ? { ...currentProjectRaw, activeFileId: effectiveActiveFileId }
      : currentProjectRaw;
  }, [currentProjectRaw, activeFileIdOverride]);
  const isReadOnly = isBackendMode && currentProject?.id === BACKEND_PROJECT_ID;

  const createProject = useCallback(
    (name: string) => {
      const existingNames = projects.map((p) => p.name);
      const validatedName = validateProjectName(name, existingNames);

      if (!validatedName) {
        return;
      }

      const newProject: Project = {
        id: uuidv4(),
        name: validatedName,
        files: [],
        activeFileId: null,
        dialect: 'generic',
        runMode: 'current',
        selectedFileIds: [],
        schemaSQL: '',
        templateMode: 'raw',
      };
      setProjects((prev) => [...prev, newProject]);
      setActiveProjectId(newProject.id);
    },
    [projects]
  );

  const deleteProject = useCallback(
    (id: string) => {
      setProjects((prev) => prev.filter((p) => p.id !== id));
      deleteProjectFiles(id); // Clean up IndexedDB
      serverDb.deleteProject(id).catch((e) => console.error('Failed to delete project from backend:', e));
      if (activeProjectId === id) {
        setActiveProjectId(null);
      }
    },
    [activeProjectId]
  );

  const renameProject = useCallback(
    (id: string, newName: string) => {
      // Exclude the project being renamed from the duplicate check
      const existingNames = projects.filter((p) => p.id !== id).map((p) => p.name);
      const validatedName = validateProjectName(newName, existingNames);

      if (!validatedName) {
        return;
      }

      setProjects((prev) =>
        prev.map((p) => {
          if (p.id !== id) return p;
          return { ...p, name: validatedName };
        })
      );
    },
    [projects]
  );

  const selectProject = useCallback((id: string) => {
    setActiveProjectId(id);
    setActiveFileIdOverride(null);
  }, []);

  const setProjectDialect = useCallback((projectId: string, dialect: Dialect) => {
    setProjects((prev) =>
      prev.map((p) => {
        if (p.id !== projectId) return p;
        return { ...p, dialect };
      })
    );
  }, []);

  const setRunMode = useCallback((projectId: string, mode: RunMode) => {
    if (projectId === BACKEND_PROJECT_ID) {
      setBackendRunMode(mode);
      return;
    }

    setProjects((prev) =>
      prev.map((p) => {
        if (p.id !== projectId) return p;
        return { ...p, runMode: mode };
      })
    );
  }, []);

  const setTemplateMode = useCallback((projectId: string, mode: TemplateMode) => {
    setProjects((prev) =>
      prev.map((p) => {
        if (p.id !== projectId) return p;
        return { ...p, templateMode: mode };
      })
    );
  }, []);

  const toggleFileSelection = useCallback((projectId: string, fileId: string) => {
    if (projectId === BACKEND_PROJECT_ID) {
      setBackendSelectedFileIds((prev) => {
        const exists = prev.includes(fileId);
        const updated = exists ? prev.filter((id) => id !== fileId) : [...prev, fileId];
        setBackendRunMode(updated.length > 0 ? 'custom' : 'current');
        return updated;
      });
      return;
    }

    setProjects((prev) =>
      prev.map((p) => {
        if (p.id !== projectId) return p;
        const currentSelected = p.selectedFileIds || [];
        const newSelected = currentSelected.includes(fileId)
          ? currentSelected.filter((id) => id !== fileId)
          : [...currentSelected, fileId];

        // Automatically switch runMode based on selection:
        // - Selecting files implies the user wants 'custom' mode
        // - Deselecting all files reverts to 'current' mode as a sensible default
        return {
          ...p,
          selectedFileIds: newSelected,
          runMode: newSelected.length > 0 ? 'custom' : 'current',
        };
      })
    );
  }, []);

  const setFileSelection = useCallback((projectId: string, fileIds: string[], select: boolean) => {
    if (fileIds.length === 0) {
      return;
    }

    const fileIdSet = new Set(fileIds);

    if (projectId === BACKEND_PROJECT_ID) {
      setBackendSelectedFileIds((prev) => {
        const next = new Set(prev);
        let changed = false;

        for (const fileId of fileIdSet) {
          if (select) {
            if (!next.has(fileId)) {
              next.add(fileId);
              changed = true;
            }
          } else if (next.delete(fileId)) {
            changed = true;
          }
        }

        if (!changed) {
          return prev;
        }

        const updated = Array.from(next);
        setBackendRunMode(updated.length > 0 ? 'custom' : 'current');
        return updated;
      });
      return;
    }

    setProjects((prev) =>
      prev.map((p) => {
        if (p.id !== projectId) return p;

        const next = new Set(p.selectedFileIds || []);
        let changed = false;

        for (const fileId of fileIdSet) {
          if (select) {
            if (!next.has(fileId)) {
              next.add(fileId);
              changed = true;
            }
          } else if (next.delete(fileId)) {
            changed = true;
          }
        }

        if (!changed) {
          return p;
        }

        const selectedFileIds = Array.from(next);
        return {
          ...p,
          selectedFileIds,
          runMode: selectedFileIds.length > 0 ? 'custom' : 'current',
        };
      })
    );
  }, []);

  const getFileLanguage = (fileName: string): ProjectFile['language'] => {
    if (fileName.endsWith(FILE_EXTENSIONS.JSON)) return 'json';
    if (
      fileName.endsWith(FILE_EXTENSIONS.SQL) ||
      fileName.toLowerCase().endsWith(FILE_EXTENSIONS.HQL)
    )
      return 'sql';
    return 'text';
  };

  const createFile = useCallback(
    (name: string, content: string = '', path?: string) => {
      if (!activeProjectId) return;

      const newFileId = uuidv4();
      setProjects((prev) =>
        prev.map((p) => {
          if (p.id !== activeProjectId) return p;

          // When path is provided, deduplicate by full path (allows same name in different folders)
          // When no path, deduplicate by file name (flat file list)
          const existingPaths = new Set(p.files.map((f) => f.path.toLowerCase()));
          let uniqueName = name;
          let uniquePath = path || name;

          if (existingPaths.has(uniquePath.toLowerCase())) {
            const dotIndex = name.lastIndexOf('.');
            const baseName = dotIndex > 0 ? name.slice(0, dotIndex) : name;
            const ext = dotIndex > 0 ? name.slice(dotIndex) : '';
            let counter = 2;
            // Derive the folder prefix from the original path
            const folderPrefix =
              path && path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
            while (existingPaths.has(`${folderPrefix}${baseName}_${counter}${ext}`.toLowerCase())) {
              counter++;
            }
            uniqueName = `${baseName}_${counter}${ext}`;
            uniquePath = `${folderPrefix}${uniqueName}`;
          }

          const newFile: ProjectFile = {
            id: newFileId,
            name: uniqueName,
            path: uniquePath,
            content,
            language: getFileLanguage(uniqueName),
          };

          return {
            ...p,
            files: [...p.files, newFile],
          };
        })
      );
      setActiveFileIdOverride(newFileId);
    },
    [activeProjectId]
  );

  const updateFile = useCallback(
    (fileId: string, content: string) => {
      if (!activeProjectId) return;

      setProjects((prev) =>
        prev.map((p) => {
          if (p.id !== activeProjectId) return p;
          return {
            ...p,
            files: p.files.map((f) => (f.id === fileId ? { ...f, content } : f)),
          };
        })
      );
    },
    [activeProjectId]
  );

  const updateFiles = useCallback(
    (updates: Array<{ fileId: string; content: string }>) => {
      if (!activeProjectId || updates.length === 0) return;

      const updatesMap = new Map(updates.map((update) => [update.fileId, update.content]));

      setProjects((prev) =>
        prev.map((p) => {
          if (p.id !== activeProjectId) return p;
          return {
            ...p,
            files: p.files.map((f) =>
              updatesMap.has(f.id) ? { ...f, content: updatesMap.get(f.id) ?? f.content } : f
            ),
          };
        })
      );
    },
    [activeProjectId]
  );

  const deleteFile = useCallback(
    (fileId: string) => {
      if (!activeProjectId) return;

      setProjects((prev) => {
        const project = prev.find((p) => p.id === activeProjectId);
        if (!project) return prev;

        const remainingFiles = project.files.filter((f) => f.id !== fileId);
        // If deleting the active file, switch to first remaining
        const currentActive = activeFileIdOverride || project.activeFileId;
        if (currentActive === fileId) {
          setActiveFileIdOverride(remainingFiles[0]?.id || null);
        }

        // Immediately persist to storage (skip debounce to avoid data loss on HMR/reload)
        saveProjectFiles(activeProjectId, remainingFiles);

        return prev.map((p) => {
          if (p.id !== activeProjectId) return p;
          return {
            ...p,
            files: remainingFiles,
            selectedFileIds: (p.selectedFileIds || []).filter((id) => id !== fileId),
          };
        });
      });
    },
    [activeProjectId, activeFileIdOverride]
  );

  const deleteFiles = useCallback(
    (fileIds: string[]) => {
      if (!activeProjectId || fileIds.length === 0) return;
      const idsSet = new Set(fileIds);

      setProjects((prev) => {
        const project = prev.find((p) => p.id === activeProjectId);
        if (!project) return prev;

        const remainingFiles = project.files.filter((f) => !idsSet.has(f.id));

        const currentActive = activeFileIdOverride || project.activeFileId;
        if (currentActive && idsSet.has(currentActive)) {
          setActiveFileIdOverride(remainingFiles[0]?.id || null);
        }

        // Immediately persist to storage (skip debounce to avoid data loss on HMR/reload)
        saveProjectFiles(activeProjectId, remainingFiles);

        return prev.map((p) => {
          if (p.id !== activeProjectId) return p;
          return {
            ...p,
            files: remainingFiles,
            selectedFileIds: (p.selectedFileIds || []).filter((id) => !idsSet.has(id)),
          };
        });
      });
    },
    [activeProjectId, activeFileIdOverride]
  );

  const renameFile = useCallback(
    (fileId: string, newName: string) => {
      if (!activeProjectId) return;

      setProjects((prev) =>
        prev.map((p) => {
          if (p.id !== activeProjectId) return p;
          return {
            ...p,
            files: p.files.map((f) => {
              if (f.id !== fileId) return f;
              const lastSlashIndex = f.path.lastIndexOf('/');
              const newPath =
                lastSlashIndex === -1
                  ? newName
                  : `${f.path.slice(0, lastSlashIndex + 1)}${newName}`;
              return {
                ...f,
                name: newName,
                path: newPath,
              };
            }),
          };
        })
      );
    },
    [activeProjectId]
  );

  const renameFolder = useCallback(
    (oldFolderPath: string, newFolderName: string) => {
      if (!activeProjectId) return;

      setProjects((prev) =>
        prev.map((p) => {
          if (p.id !== activeProjectId) return p;
          // Compute new folder path: replace last segment of oldFolderPath
          const lastSlash = oldFolderPath.lastIndexOf('/');
          const newFolderPath =
            lastSlash === -1
              ? newFolderName
              : `${oldFolderPath.slice(0, lastSlash + 1)}${newFolderName}`;
          const prefix = `${oldFolderPath}/`;
          return {
            ...p,
            files: p.files.map((f) => {
              if (f.path === oldFolderPath || f.path.startsWith(prefix)) {
                const newPath = newFolderPath + f.path.slice(oldFolderPath.length);
                // Update name only if the file sits directly in this folder
                const newName = newPath.split('/').pop() || f.name;
                return { ...f, path: newPath, name: newName };
              }
              return f;
            }),
          };
        })
      );
    },
    [activeProjectId]
  );

  const deleteFolder = useCallback(
    (folderPath: string) => {
      if (!activeProjectId) return;
      const prefix = `${folderPath}/`;
      setProjects((prev) =>
        prev.map((p) => {
          if (p.id !== activeProjectId) return p;
          const remaining = p.files.filter(
            (f) => f.path !== folderPath && !f.path.startsWith(prefix)
          );
          const newActiveFileId =
            remaining.some((f) => f.id === p.activeFileId) ? p.activeFileId : remaining[0]?.id ?? null;
          return {
            ...p,
            files: remaining,
            activeFileId: newActiveFileId,
            selectedFileIds: (p.selectedFileIds || []).filter((id) =>
              remaining.some((f) => f.id === id)
            ),
          };
        })
      );
    },
    [activeProjectId]
  );

  const selectFile = useCallback(
    (fileId: string) => {
      // 只有当前是后端项目(Server Files)才更新 backendActiveFileId;
      // 本地项目(serve 模式 + 本地)走常规路径更新 project.activeFileId
      if (isBackendMode && effectiveActiveProjectId === BACKEND_PROJECT_ID) {
        setBackendActiveFileId(fileId);
        return;
      }
      setActiveFileIdOverride(fileId);
      if (!activeProjectId) return;
      setProjects((prev) =>
        prev.map((p) => {
          if (p.id !== activeProjectId || p.activeFileId === fileId) return p;
          return { ...p, activeFileId: fileId };
        })
      );
    },
    [activeProjectId, isBackendMode, effectiveActiveProjectId]
  );

  const updateSchemaSQL = useCallback((projectId: string, schemaSQL: string) => {
    setProjects((prev) =>
      prev.map((p) => {
        if (p.id !== projectId) return p;
        return { ...p, schemaSQL };
      })
    );
  }, []);

  const importFiles = useCallback(
    async (fileList: FileList | File[]) => {
      if (!activeProjectId) return;

      const newFiles: ProjectFile[] = [];
      const files = Array.from(fileList);

      for (const file of files) {
        // Filter by accepted file types
        const ext = '.' + file.name.split('.').pop()?.toLowerCase();
        if (
          !ACCEPTED_FILE_TYPES_ARRAY.includes(ext as (typeof ACCEPTED_FILE_TYPES_ARRAY)[number])
        ) {
          continue;
        }
        const content = await file.text();
        // Use webkitRelativePath if available (folder upload), otherwise just filename
        const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
        const path = relativePath || file.name;
        newFiles.push({
          id: uuidv4(),
          name: file.name,
          path,
          content,
          language: getFileLanguage(file.name),
        });
      }

      if (newFiles.length === 0) return;

      setProjects((prev) =>
        prev.map((p) => {
          if (p.id !== activeProjectId) return p;
          return {
            ...p,
            files: [...p.files, ...newFiles],
          };
        })
      );
      setActiveFileIdOverride(newFiles[0].id);
    },
    [activeProjectId]
  );

  const replaceWithFiles = useCallback(
    async (fileList: FileList | File[]) => {
      if (!activeProjectId) return;

      const newFiles: ProjectFile[] = [];
      const files = Array.from(fileList);

      for (const file of files) {
        const ext = '.' + file.name.split('.').pop()?.toLowerCase();
        if (
          !ACCEPTED_FILE_TYPES_ARRAY.includes(ext as (typeof ACCEPTED_FILE_TYPES_ARRAY)[number])
        ) {
          continue;
        }
        const content = await file.text();
        const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
        const path = relativePath || file.name;
        newFiles.push({
          id: uuidv4(),
          name: file.name,
          path,
          content,
          language: getFileLanguage(file.name),
        });
      }

      if (newFiles.length === 0) return;

      setProjects((prev) =>
        prev.map((p) => {
          if (p.id !== activeProjectId) return p;
          return {
            ...p,
            files: newFiles,
            selectedFileIds: [],
          };
        })
      );
      setActiveFileIdOverride(newFiles[0].id);
    },
    [activeProjectId]
  );

  const addFilesDirectly = useCallback(
    (newFiles: ProjectFile[]) => {
      if (!activeProjectId || newFiles.length === 0) return;

      setProjects((prev) =>
        prev.map((p) => {
          if (p.id !== activeProjectId) return p;
          return {
            ...p,
            files: [...p.files, ...newFiles],
          };
        })
      );
      setActiveFileIdOverride(newFiles[0].id);
    },
    [activeProjectId]
  );

  const importProject = useCallback(
    (payload: SharePayload): string => {
      // Generate unique name if collision (with safety limit)
      const existingNames = projects.map((p) => p.name.toLowerCase());
      let name = payload.n;
      let counter = 1;
      while (
        existingNames.includes(name.toLowerCase()) &&
        counter <= SHARE_LIMITS.MAX_NAME_COLLISION_ATTEMPTS
      ) {
        name = `${payload.n} (${counter++})`;
      }
      // Fallback if we hit the limit
      if (existingNames.includes(name.toLowerCase())) {
        name = `${payload.n} (${Date.now()})`;
      }

      // Create files with new IDs
      const newFiles: ProjectFile[] = payload.f.map((f) => ({
        id: uuidv4(),
        name: f.n,
        path: f.p || f.n, // Use path if available, otherwise default to filename
        content: f.c,
        language: f.l || DEFAULT_FILE_LANGUAGE,
      }));

      // Map selected file indices to new IDs
      const selectedFileIds = (payload.sel || [])
        .filter((i) => i >= 0 && i < newFiles.length)
        .map((i) => newFiles[i].id);

      const newProject: Project = {
        id: uuidv4(),
        name,
        files: newFiles,
        activeFileId: newFiles[0]?.id || null,
        dialect: payload.d,
        runMode: payload.r,
        selectedFileIds,
        schemaSQL: payload.s,
        templateMode: parseTemplateMode(payload.t),
      };

      setProjects((prev) => [...prev, newProject]);
      setActiveProjectId(newProject.id);

      return name;
    },
    [projects]
  );

  const value = {
    projects: effectiveProjects,
    activeProjectId: effectiveActiveProjectId,
    currentProject,
    createProject,
    deleteProject,
    renameProject,
    selectProject,
    setProjectDialect,
    setRunMode,
    setTemplateMode,
    toggleFileSelection,
    setFileSelection,
    createFile,
    updateFile,
    updateFiles,
    deleteFile,
    deleteFiles,
    renameFile,
    renameFolder,
    deleteFolder,
    selectFile,
    updateSchemaSQL,
    importFiles,
    replaceWithFiles,
    addFilesDirectly,
    importProject,
    // Backend mode state
    isBackendMode,
    isReadOnly,
    backendSchema,
    backendWatchDirs,
    refreshBackendFiles,
  };

  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
}

export function useProject() {
  const context = useContext(ProjectContext);
  if (!context) {
    throw new Error('useProject must be used within a ProjectProvider');
  }
  return context;
}
