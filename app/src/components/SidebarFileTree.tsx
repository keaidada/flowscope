import { useState, useRef, useEffect, useMemo, useCallback, useDeferredValue } from 'react';
import { Upload, FolderUp, Plus, Search, FolderPlus, Trash2, CheckSquare } from 'lucide-react';
import ProgressOverlay from './ProgressOverlay';
import { useTranslation } from 'react-i18next';
import { useProject } from '@/lib/project-store';
import type { ProjectFile } from '@/lib/project-store';
import { FileTree } from '@/components/FileTree';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
  ACCEPTED_FILE_TYPES,
  BINARY_EXTENSIONS,
  FILE_EXTENSIONS,
  DEFAULT_FILE_NAMES,
} from '@/lib/constants';
import { genId } from '@/lib/utils';
import { saveProjectFiles } from '@/lib/file-storage';
import { convertToDbtBatch, generateSemanticYamlBatch } from '@/lib/file-storage';
import { convertProceduresOnServer } from '@/lib/server-db';
import { ConvertFolderDialog } from './ConvertFolderDialog';
import { DbtConvertDialog } from './DbtConvertDialog';
import { DbtConvertFolderDialog } from './DbtConvertFolderDialog';
import type { Dialect } from '@/lib/dialect-constants';

interface SidebarFileTreeProps {
  onContentWidthChange?: (widthPx: number) => void;
  /** Set of file paths that already have lineage analysis results */
  lineageFileIds?: Set<string>;
}

export function SidebarFileTree({ onContentWidthChange, lineageFileIds }: SidebarFileTreeProps) {
  const { t } = useTranslation();
  const {
    currentProject,
    activeProjectId,
    createFile,
    deleteFile,
    deleteFiles,
    openFile,
    importFiles,
    addFilesDirectly,
    updateFiles,
    toggleFileSelection,
    setFileSelection,
    renameFile,
    renameFolder,
    isReadOnly,
    filesLoaded,
    selectFile,
    revealCnt,
  } = useProject();

  const [quickOpen, setQuickOpen] = useState(false);
  const [quickQuery, setQuickQuery] = useState('');
  const quickInputRef = useRef<HTMLInputElement>(null);

  const [search, setSearch] = useState('');
  const [renamingFileId, setRenamingFileId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deletingFileId, setDeletingFileId] = useState<string | null>(null);
  const [confirmBatchDelete, setConfirmBatchDelete] = useState(false);
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [uploadProgress, setUploadProgress] = useState<{
    total: number;
    loaded: number;
    skipped: number;
    done: boolean;
    stage?: 'reading' | 'saving';
  } | null>(null);
  const [convertDialogOpen, setConvertDialogOpen] = useState(false);
  const [convertTargetPath, setConvertTargetPath] = useState('');
  const [isConvertingFolder, setIsConvertingFolder] = useState(false);
  const [convertProgress, setConvertProgress] = useState<{ done: number; total: number } | null>(
    null
  );
  const [convertResult, setConvertResult] = useState<{
    success: number;
    successPaths: string[];
    empty: string[];
    errors: string[];
  } | null>(null);
  // dbt conversion state
  const [dbtConvertPath, setDbtConvertPath] = useState<string | null>(null);
  const [dbtConvertOpen, setDbtConvertOpen] = useState(false);
  const [dbtFolderPath, setDbtFolderPath] = useState<string | null>(null);
  const [dbtFolderOpen, setDbtFolderOpen] = useState(false);
  const [dbtFolderFiles, setDbtFolderFiles] = useState<string[]>([]);
  const [dbtFolderLoadingFiles, setDbtFolderLoadingFiles] = useState(false);
  const [isConvertingDbtFolder, setIsConvertingDbtFolder] = useState(false);
  const [dbtFolderProgress, setDbtFolderProgress] = useState<{
    done: number;
    total: number;
    success: string[];
    errors: string[];
    skipped: number;
  } | null>(null);
  // YAML folder batch
  const [yamlFolderPath, setYamlFolderPath] = useState<string | null>(null);
  const [yamlFolderOpen, setYamlFolderOpen] = useState(false);
  const [yamlFolderFiles, setYamlFolderFiles] = useState<string[]>([]);
  const [yamlFolderLoadingFiles, setYamlFolderLoadingFiles] = useState(false);
  const [isGeneratingYaml, setIsGeneratingYaml] = useState(false);
  const [yamlFolderProgress, setYamlFolderProgress] = useState<{
    done: number;
    total: number;
    success: string[];
    errors: string[];
    skipped: number;
  } | null>(null);

  const currentProjectRef = useRef(currentProject);
  currentProjectRef.current = currentProject;

  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const folderNameInputRef = useRef<HTMLInputElement>(null);
  const uploadTargetDirRef = useRef<string | null>(null);

  useEffect(() => {
    if (renamingFileId && renameInputRef.current) {
      setTimeout(() => renameInputRef.current?.focus(), 0);
    }
  }, [renamingFileId]);

  useEffect(() => {
    if (isCreatingFolder && folderNameInputRef.current) {
      setTimeout(() => folderNameInputRef.current?.focus(), 0);
    }
  }, [isCreatingFolder]);

  // When project file metadata finishes loading, refresh the dbt folder file
  // list (it may have been empty because lazy loading hadn't completed).
  useEffect(() => {
    if (!filesLoaded || !dbtFolderLoadingFiles || !currentProject || !dbtFolderPath) return;
    const prefix = dbtFolderPath.endsWith('/') ? dbtFolderPath : dbtFolderPath + '/';
    const sqlFiles = currentProject.files.filter(
      (f) =>
        f.path.startsWith(prefix) &&
        (f.language === 'sql' || /\.(sql|hql|hive|ddl|bigquery|spark)$/i.test(f.path))
    );
    setDbtFolderFiles(sqlFiles.map((f) => f.path));
    setDbtFolderLoadingFiles(false);
  }, [filesLoaded, dbtFolderLoadingFiles, currentProject, dbtFolderPath]);

  // Same for the YAML folder dialog.
  useEffect(() => {
    if (!filesLoaded || !yamlFolderLoadingFiles || !currentProject || !yamlFolderPath) return;
    const prefix = yamlFolderPath.endsWith('/') ? yamlFolderPath : yamlFolderPath + '/';
    const sqlFiles = currentProject.files.filter(
      (f) =>
        f.path.startsWith(prefix) &&
        (f.language === 'sql' || /\.(sql|hql|hive|ddl|bigquery|spark)$/i.test(f.path))
    );
    setYamlFolderFiles(sqlFiles.map((f) => f.path));
    setYamlFolderLoadingFiles(false);
  }, [filesLoaded, yamlFolderLoadingFiles, currentProject, yamlFolderPath]);

  const quickMatches = useMemo(() => {
    if (!quickQuery.trim() || !currentProject) return [] as ProjectFile[];
    const q = quickQuery.toLowerCase();
    return currentProject.files
      .filter((f) => f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q))
      .slice(0, 20);
  }, [quickQuery, currentProject]);

  useEffect(() => {
    if (quickOpen && quickInputRef.current) {
      setTimeout(() => quickInputRef.current?.focus(), 0);
    }
  }, [quickOpen]);

  const handleQuickSelect = (fileId: string) => {
    selectFile(fileId);
    setQuickOpen(false);
    setQuickQuery('');
  };

  const handleCreateFolder = () => {
    const trimmed = newFolderName.trim();
    if (trimmed) {
      createFile(DEFAULT_FILE_NAMES.NEW_QUERY, '', `${trimmed}/${DEFAULT_FILE_NAMES.NEW_QUERY}`);
    }
    setIsCreatingFolder(false);
    setNewFolderName('');
  };

  // Determine upload directory from active file or explicit target
  const getUploadDir = (): string | undefined => {
    // Priority 1: explicitly set target (from folder hover upload button)
    if (uploadTargetDirRef.current) return uploadTargetDirRef.current;
    // Priority 2: parent directory of the active file
    const activeFileId = currentProject?.activeFileId;
    if (activeFileId) {
      const activeFile = currentProject?.files.find((f) => f.id === activeFileId);
      if (activeFile) {
        const lastSlash = activeFile.path.lastIndexOf('/');
        if (lastSlash > 0) return activeFile.path.substring(0, lastSlash);
      }
    }
    // Priority 3: root
    return undefined;
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const targetDir = getUploadDir();
      importFiles(e.target.files, targetDir);
    }
    uploadTargetDirRef.current = null;
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleFolderUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      if (!e.target.files || e.target.files.length === 0) return;

      const allFiles = Array.from(e.target.files);
      const targetDir = getUploadDir();

      setUploadProgress({
        total: allFiles.length,
        loaded: 0,
        skipped: 0,
        done: false,
        stage: 'reading',
      });

      // Phase 1: Accept all text files — skip known binary extensions only
      const supportedFiles: File[] = [];
      let skipped = 0;
      for (const file of allFiles) {
        const dotIdx = file.name.lastIndexOf('.');
        const ext = dotIdx >= 0 ? file.name.slice(dotIdx).toLowerCase() : '';
        if (BINARY_EXTENSIONS.has(ext)) {
          skipped++;
        } else {
          supportedFiles.push(file);
        }
      }

      const importTotal = supportedFiles.length;
      setUploadProgress({ total: importTotal, loaded: 0, skipped, done: false, stage: 'reading' });

      const getFileLanguage = (fileName: string): ProjectFile['language'] => {
        if (fileName.endsWith(FILE_EXTENSIONS.JSON)) return 'json';
        if (
          fileName.endsWith(FILE_EXTENSIONS.SQL) ||
          fileName.toLowerCase().endsWith(FILE_EXTENSIONS.HQL)
        )
          return 'sql';
        return 'text';
      };

      // Phase 2: Create file entries with empty content — instant UI display
      const projectFiles: ProjectFile[] = supportedFiles.map((file) => {
        const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
        const rawPath = relativePath || file.name;
        // Prepend target directory if set
        const path = targetDir ? `${targetDir}/${rawPath}` : rawPath;
        return {
          id: genId(),
          name: file.name,
          path,
          content: '',
          language: getFileLanguage(file.name),
        };
      });

      // Show files in tree immediately (empty content)
      if (projectFiles.length > 0) {
        addFilesDirectly(projectFiles);
      }

      // Phase 3: Read content in background, update React state + SQLite progressively
      let loaded = 0;
      const BATCH = 100;
      for (let i = 0; i < supportedFiles.length; i += BATCH) {
        const batchFiles = supportedFiles.slice(i, i + BATCH);
        const batchPFs = projectFiles.slice(i, i + BATCH);

        // Read content for this batch in parallel
        const contents = await Promise.all(batchFiles.map((f) => f.text()));

        // Update in-memory ProjectFile objects
        const updates: Array<{
          fileId: string;
          content: string;
          isProcedure?: boolean;
          transformedContent?: string | null;
        }> = [];
        for (let j = 0; j < batchPFs.length; j++) {
          batchPFs[j].content = contents[j];
          const upper = contents[j].toUpperCase();
          const isProcedure = upper.includes('CREATE PROCEDURE') || upper.includes('CREATE PROC');
          batchPFs[j].isProcedure = isProcedure;
          batchPFs[j].transformedContent = null;
          updates.push({
            fileId: batchPFs[j].id,
            content: contents[j],
            isProcedure,
            transformedContent: null,
          });
        }

        // Batch-update React state
        updateFiles(updates);

        loaded += batchFiles.length;
        setUploadProgress({ total: importTotal, loaded, skipped, done: false, stage: 'reading' });
      }

      // Phase 4: Persist to SQLite → OPFS/IndexedDB
      setUploadProgress({
        total: importTotal,
        loaded: importTotal,
        skipped,
        done: false,
        stage: 'saving',
      });
      try {
        if (currentProject) {
          const allProjectFiles = [
            ...currentProject.files.filter((f) => !projectFiles.some((pf) => pf.id === f.id)),
            ...projectFiles,
          ];
          await saveProjectFiles(currentProject.id, allProjectFiles);
        }
      } catch (e) {
        console.error('Failed to persist imported files:', e);
      }

      setUploadProgress({ total: importTotal, loaded: importTotal, skipped, done: true });
      setTimeout(() => setUploadProgress(null), 1500);

      if (folderInputRef.current) folderInputRef.current.value = '';
    },
    [addFilesDirectly, updateFiles, currentProject]
  );

  // Dialects that support automatic procedure-to-DML conversion
  const CONVERT_SUPPORTED_DIALECTS: Set<string> = new Set(['bigquery']);

  const handleOpenConvertFolder = useCallback((folderPath: string) => {
    setConvertTargetPath(folderPath);
    setConvertResult(null);
    setConvertDialogOpen(true);
  }, []);

  const handleConvertDbtFile = useCallback((filePath: string) => {
    setDbtConvertPath(filePath);
    setDbtConvertOpen(true);
  }, []);

  // Open the folder convert dialog with a file list (no conversion yet)
  const handleConvertDbtFolder = useCallback(
    (folderPath: string) => {
      if (!currentProject) return;
      const prefix = folderPath.endsWith('/') ? folderPath : folderPath + '/';
      // List ALL SQL files under the folder — content may be lazy-loaded,
      // so don't filter on content here (backend skips empty files).
      const sqlFiles = currentProject.files.filter(
        (f) =>
          f.path.startsWith(prefix) &&
          (f.language === 'sql' || /\.(sql|hql|hive|ddl|bigquery|spark)$/i.test(f.path))
      );
      setDbtFolderPath(folderPath);
      setDbtFolderFiles(sqlFiles.map((f) => f.path));
      setDbtFolderProgress(null);
      // If the project's file metadata hasn't finished loading yet, the file
      // list may be empty and conversion would show "0 / 0". Keep the dialog
      // open in a "loading" state instead of letting the user confirm an empty
      // batch. The dialog re-renders once filesLoaded flips to true.
      if (!filesLoaded) {
        setDbtFolderLoadingFiles(true);
      }
      setDbtFolderOpen(true);
    },
    [currentProject, filesLoaded]
  );

  // Execute conversion after user confirms in the dialog
  const handleConfirmDbtFolder = useCallback(async () => {
    if (!currentProject || !dbtFolderPath) return;
    // Guard: file metadata may still be lazy-loading. Refuse to run an empty
    // batch — show a message instead of the misleading "0 / 0 completed".
    if (!filesLoaded) {
      setDbtFolderLoadingFiles(true);
      return;
    }
    setDbtFolderOpen(false);
    setIsConvertingDbtFolder(true);
    setDbtFolderProgress({ done: 0, total: 0, success: [], errors: [], skipped: 0 });

    const prefix = dbtFolderPath.endsWith('/') ? dbtFolderPath : dbtFolderPath + '/';
    // Convert ALL SQL files under the folder; backend skips empty-content files.
    const sqlFiles = currentProject.files.filter(
      (f) =>
        f.path.startsWith(prefix) &&
        (f.language === 'sql' || /\.(sql|hql|hive|ddl|bigquery|spark)$/i.test(f.path))
    );
    const total = sqlFiles.length;
    const success: string[] = [];
    const errors: string[] = [];
    let skipped = 0;

    if (total === 0) {
      setDbtFolderProgress({ done: 0, total: 0, success, errors, skipped });
      setIsConvertingDbtFolder(false);
      return;
    }

    // Process in chunks so the progress bar animates and the UI stays responsive
    const CHUNK = 100;
    let done = 0;
    for (let i = 0; i < sqlFiles.length; i += CHUNK) {
      const chunk = sqlFiles.slice(i, i + CHUNK);
      console.log(`[convert-dbt-folder] chunk ${i / CHUNK + 1}/${Math.ceil(sqlFiles.length / CHUNK)} (${chunk.length} files)`);
      try {
        const result = await convertToDbtBatch(
          currentProject.id,
          dbtFolderPath,
          chunk.map((f) => ({ path: f.path, content: f.content || '' }))
        );
        console.log(`[convert-dbt-folder] chunk ${i / CHUNK + 1} done: success=${result.success} errors=${result.errors} skipped=${result.skipped}`);
        success.push(...result.successPaths);
        errors.push(...result.errorPaths);
        skipped += result.skipped;
      } catch (e) {
        console.error('[convert-dbt-batch] chunk failed:', e);
        errors.push(...chunk.map((f) => f.path));
      }
      done += chunk.length;
      setDbtFolderProgress({ done, total, success, errors, skipped });
    }

    setDbtFolderProgress({ done: total, total, success, errors, skipped });
    setIsConvertingDbtFolder(false);
    console.log(`[convert-dbt-folder] FINISHED: ${success.length} success, ${errors.length} errors, ${skipped} skipped`);
  }, [currentProject, dbtFolderPath, filesLoaded]);

  // Open the YAML folder dialog with a file list (no generation yet)
  const handleGenerateYamlFolder = useCallback(
    (folderPath: string) => {
      if (!currentProject) return;
      const prefix = folderPath.endsWith('/') ? folderPath : folderPath + '/';
      const sqlFiles = currentProject.files.filter(
        (f) =>
          f.path.startsWith(prefix) &&
          (f.language === 'sql' || /\.(sql|hql|hive|ddl|bigquery|spark)$/i.test(f.path))
      );
      setYamlFolderPath(folderPath);
      setYamlFolderFiles(sqlFiles.map((f) => f.path));
      setYamlFolderProgress(null);
      if (!filesLoaded) {
        setYamlFolderLoadingFiles(true);
      }
      setYamlFolderOpen(true);
    },
    [currentProject, filesLoaded]
  );

  // Execute YAML generation after user confirms in the dialog
  const handleConfirmYamlFolder = useCallback(async () => {
    if (!currentProject || !yamlFolderPath) return;
    if (!filesLoaded) {
      setYamlFolderLoadingFiles(true);
      return;
    }
    setYamlFolderOpen(false);
    setIsGeneratingYaml(true);
    setYamlFolderProgress({ done: 0, total: 0, success: [], errors: [], skipped: 0 });

    const prefix = yamlFolderPath.endsWith('/') ? yamlFolderPath : yamlFolderPath + '/';
    const sqlFiles = currentProject.files.filter(
      (f) =>
        f.path.startsWith(prefix) &&
        (f.language === 'sql' || /\.(sql|hql|hive|ddl|bigquery|spark)$/i.test(f.path))
    );
    const total = sqlFiles.length;
    const success: string[] = [];
    const errors: string[] = [];
    let skipped = 0;

    if (total === 0) {
      setYamlFolderProgress({ done: 0, total: 0, success, errors, skipped });
      setIsGeneratingYaml(false);
      return;
    }

    const CHUNK = 100;
    let done = 0;
    for (let i = 0; i < sqlFiles.length; i += CHUNK) {
      const chunk = sqlFiles.slice(i, i + CHUNK);
      console.log(`[generate-yaml-folder] chunk ${i / CHUNK + 1}/${Math.ceil(sqlFiles.length / CHUNK)} (${chunk.length} files)`);
      try {
        const result = await generateSemanticYamlBatch(
          currentProject.id,
          yamlFolderPath,
          chunk.map((f) => ({ path: f.path, content: f.content || '' }))
        );
        console.log(`[generate-yaml-folder] chunk ${i / CHUNK + 1} done: success=${result.success} errors=${result.errors} skipped=${result.skipped}`);
        success.push(...result.successPaths);
        errors.push(...result.errorPaths);
        skipped += result.skipped;
      } catch (e) {
        console.error('[generate-yaml-batch] chunk failed:', e);
        errors.push(...chunk.map((f) => f.path));
      }
      done += chunk.length;
      setYamlFolderProgress({ done, total, success, errors, skipped });
    }

    setYamlFolderProgress({ done: total, total, success, errors, skipped });
    setIsGeneratingYaml(false);
    console.log(`[generate-yaml-folder] FINISHED: ${success.length} success, ${errors.length} errors, ${skipped} skipped`);
  }, [currentProject, yamlFolderPath, filesLoaded]);

  const handleConvertFolder = useCallback(
    async (dialect: Dialect) => {
      if (!currentProject) {
        console.warn('[convert] currentProject is null');
        return;
      }

      const prefix = convertTargetPath.endsWith('/') ? convertTargetPath : convertTargetPath + '/';
      const folderFiles = currentProject.files.filter((f) => f.path.startsWith(prefix));
      // Detect procedures by content, not just stored flag
      const procFiles = folderFiles.filter((f) => {
        if (f.isProcedure) return true;
        const upper = (f.content || '').toUpperCase();
        return upper.includes('CREATE PROCEDURE') || upper.includes('CREATE PROC ');
      });
      const total = procFiles.length;

      console.log(`[convert] folder=${prefix}, total=${folderFiles.length}, procedures=${total}`);

      if (total === 0) return;

      // For unsupported dialects, mark all as empty (no conversion logic available yet)
      if (!CONVERT_SUPPORTED_DIALECTS.has(dialect)) {
        setConvertResult({
          success: 0,
          successPaths: [],
          empty: procFiles.map((f) => f.path),
          errors: [],
        });
        setConvertProgress({ done: total, total });
        return;
      }

      setIsConvertingFolder(true);
      setConvertProgress({ done: 0, total });

      try {
        // Delegate to backend — same sanitizer, native performance, no Wasm limits
        const result = await convertProceduresOnServer(
          activeProjectId ?? '',
          convertTargetPath
        );

        setConvertProgress({ done: total, total });
        setConvertResult({
          success: result.success,
          successPaths: result.successPaths,
          empty: result.emptyPaths,
          errors: result.errorPaths,
        });

        // DB already updated by backend. Store will pick up changes on
        // next refresh — no need to mutate 4304 file objects in-memory.
        // The dialog result display is sufficient immediate feedback.
      } catch (e) {
        console.error('Failed to convert procedures:', e);
        setConvertResult({
          success: 0,
          successPaths: [],
          empty: [],
          errors: [String(e)],
        });
      } finally {
        setIsConvertingFolder(false);
      }
    },
    [
      currentProject,
      convertTargetPath,
      activeProjectId,
    ]
  );

  const folderProcedureCount = useMemo(() => {
    if (!convertDialogOpen || !currentProject) return 0;
    const prefix = convertTargetPath.endsWith('/') ? convertTargetPath : convertTargetPath + '/';
    return currentProject.files.filter((f) => {
      if (!f.path.startsWith(prefix)) return false;
      if (f.isProcedure) return true;
      const upper = (f.content || '').toUpperCase();
      return upper.includes('CREATE PROCEDURE') || upper.includes('CREATE PROC ');
    }).length;
  }, [convertDialogOpen, currentProject, convertTargetPath]);

  const folderTotalCount = useMemo(() => {
    if (!convertDialogOpen || !currentProject) return 0;
    const prefix = convertTargetPath.endsWith('/') ? convertTargetPath : convertTargetPath + '/';
    return currentProject.files.filter((f) => f.path.startsWith(prefix)).length;
  }, [convertDialogOpen, currentProject, convertTargetPath]);

  // Total files under the dbt convert folder (for dialog display)
  const dbtFolderTotalCount = useMemo(() => {
    if (!dbtFolderOpen || !currentProject || !dbtFolderPath) return 0;
    const prefix = dbtFolderPath.endsWith('/') ? dbtFolderPath : dbtFolderPath + '/';
    return currentProject.files.filter((f) => f.path.startsWith(prefix)).length;
  }, [dbtFolderOpen, currentProject, dbtFolderPath]);

  const handleSelectFile = (fileId: string) => {
    openFile(fileId);
  };

  const handleDeleteClick = (e: React.MouseEvent, fileId: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (isReadOnly) return;
    if (deletingFileId === fileId) {
      deleteFile(fileId);
      setDeletingFileId(null);
    } else {
      setDeletingFileId(fileId);
    }
  };

  const handleStartRename = (fileId: string, currentName: string) => {
    if (isReadOnly) return;
    setRenamingFileId(fileId);
    setRenameValue(currentName);
  };

  const handleConfirmRename = () => {
    if (renamingFileId && renameValue.trim()) {
      renameFile(renamingFileId, renameValue.trim());
    }
    setRenamingFileId(null);
    setRenameValue('');
  };

  const handleCancelRename = () => {
    setRenamingFileId(null);
    setRenameValue('');
  };

  const handleToggleSelection = (e: React.MouseEvent, fileId: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (currentProject) {
      toggleFileSelection(currentProject.id, fileId);
    }
  };

  const isFileIncludedInAnalysis = useCallback(
    (fileId: string) => {
      if (!currentProject) return false;
      switch (currentProject.runMode) {
        case 'all':
          return true;
        case 'current':
          return currentProject.activeFileId === fileId;
        case 'custom':
          return currentProject.selectedFileIds?.includes(fileId) ?? false;
        default:
          return false;
      }
    },
    [currentProject]
  );

  // Defer lineage set changes so 3000+ FolderNode re-renders don't block UI
  const deferredLineageIds = useDeferredValue(lineageFileIds);

  const hasLineageFile = useCallback(
    (filePath: string) => {
      return deferredLineageIds?.has(filePath) ?? false;
    },
    [deferredLineageIds]
  );

  const handleToggleFolderSelection = useCallback(
    (fileIds: string[], select: boolean) => {
      if (!currentProject) return;
      setFileSelection(currentProject.id, fileIds, select);
    },
    [currentProject, setFileSelection]
  );

  const currentFiles = currentProject?.files ?? [];

  // Display the count only for files that are actually loaded into the project files list
  const visibleSelectedCount = (() => {
    if (!currentProject) return 0;
    const stored = currentProject.selectedFileIds || [];
    if (currentFiles.length === 0) return 0;
    const fileIdSet = new Set(currentFiles.map((f) => f.id));
    let cnt = 0;
    for (const id of stored) if (fileIdSet.has(id)) cnt++;
    return cnt;
  })();
  const selectedCount = visibleSelectedCount;

  const handleBatchDeleteClick = () => {
    if (!currentProject || selectedCount === 0) return;
    setConfirmBatchDelete(true);
  };

  const handleConfirmBatchDelete = () => {
    if (!currentProject) return;
    const ids = [...(currentProject.selectedFileIds || [])];
    if (ids.length > 0) {
      deleteFiles(ids);
    }
    setConfirmBatchDelete(false);
  };

  const allSelected = currentFiles.length > 0 && selectedCount === currentFiles.length;

  const handleSelectAll = useCallback(() => {
    if (!currentProject) return;
    setFileSelection(
      currentProject.id,
      currentFiles.map((file) => file.id),
      !allSelected
    );
  }, [allSelected, currentFiles, currentProject, setFileSelection]);

  const filteredFiles = useMemo(() => {
    if (!search.trim()) return currentFiles;
    const searchLower = search.toLowerCase();
    return currentFiles.filter(
      (f) =>
        f.name.toLowerCase().includes(searchLower) || f.path.toLowerCase().includes(searchLower)
    );
  }, [currentFiles, search]);

  if (!currentProject) return null;

  return (
    <div className="flex flex-col h-full bg-background relative">
      {/* Header with action buttons */}
      <div className="flex items-center justify-between px-3 py-2 border-b shrink-0">
        <div className="flex items-center gap-1 min-w-0">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            {t('common.files')}
          </span>
          {currentProject.files.length > 0 && (
            <span className="text-xs text-muted-foreground whitespace-nowrap">
              ({currentProject.files.length})
            </span>
          )}
          {selectedCount > 0 && (
            <span className="text-xs text-muted-foreground whitespace-nowrap">
              · {t('sidebar.selectedCount', { count: selectedCount })}
            </span>
          )}
        </div>
        {!isReadOnly && (
          <TooltipProvider delayDuration={300}>
            <div className="flex items-center gap-0.5 shrink-0">
              {/* Delete selected */}
              {selectedCount > 0 &&
                (confirmBatchDelete ? (
                  <div className="flex items-center gap-0.5">
                    <span className="text-xs text-destructive whitespace-nowrap">
                      {t('sidebar.confirmDelete')}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 text-destructive hover:bg-destructive/10"
                      onClick={handleConfirmBatchDelete}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      onClick={() => setConfirmBatchDelete(false)}
                    >
                      <span className="text-xs">✕</span>
                    </Button>
                  </div>
                ) : (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 text-destructive hover:bg-destructive/10"
                        onClick={handleBatchDeleteClick}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      <p>{t('sidebar.deleteSelected')}</p>
                    </TooltipContent>
                  </Tooltip>
                ))}
              {/* Select all / Deselect all */}
              {currentProject.files.length > 0 && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      onClick={handleSelectAll}
                    >
                      <CheckSquare className={`h-3.5 w-3.5 ${allSelected ? 'text-primary' : ''}`} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    <p>{allSelected ? t('sidebar.deselectAll') : t('sidebar.selectAll')}</p>
                  </TooltipContent>
                </Tooltip>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    onClick={() => createFile(DEFAULT_FILE_NAMES.NEW_QUERY)}
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  <p>{t('common.new')}</p>
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    onClick={() => setIsCreatingFolder(true)}
                  >
                    <FolderPlus className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  <p>{t('sidebar.newFolder')}</p>
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <Upload className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  <p>{t('common.files')}</p>
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    onClick={() => folderInputRef.current?.click()}
                  >
                    <FolderUp className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  <p>{t('sidebar.addFolder')}</p>
                </TooltipContent>
              </Tooltip>
            </div>
          </TooltipProvider>
        )}
      </div>

      {/* Quick open popup */}
      {quickOpen && (
        <div className="px-2 py-1.5 border-b shrink-0 bg-muted/20">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-primary pointer-events-none" />
            <Input
              ref={quickInputRef}
              value={quickQuery}
              onChange={(e) => setQuickQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') { setQuickOpen(false); setQuickQuery(''); }
                if (e.key === 'Enter' && quickMatches.length > 0) {
                  handleQuickSelect(quickMatches[0].id);
                }
              }}
              placeholder="输入文件名快速打开..."
              className="h-7 pl-7 text-xs bg-background border-primary/30"
            />
          </div>
          {quickMatches.length > 0 && (
            <div className="mt-1 max-h-40 overflow-auto rounded border bg-background">
              {quickMatches.map((f) => (
                <div
                  key={f.id}
                  className="flex items-center gap-2 px-2 py-1 cursor-pointer hover:bg-primary/10 text-xs border-b last:border-0"
                  onClick={() => handleQuickSelect(f.id)}
                >
                  <span className="truncate flex-1">{f.name}</span>
                  <span className="text-[10px] text-muted-foreground truncate max-w-[50%]">{f.path}</span>
                </div>
              ))}
            </div>
          )}
          {quickQuery && quickMatches.length === 0 && (
            <div className="mt-1 px-2 py-1 text-[10px] text-muted-foreground">无匹配文件</div>
          )}
        </div>
      )}

      {/* Search */}
      <div className="px-2 py-1.5 border-b shrink-0">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
          <Input
            ref={searchInputRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('fileSelector.searchFiles')}
            className="h-7 pl-7 text-xs bg-muted/30 border-transparent focus:border-border"
          />
        </div>
      </div>

      {/* New folder input */}
      {isCreatingFolder && (
        <div className="px-2 py-1.5 border-b shrink-0">
          <div className="flex items-center gap-1.5">
            <FolderPlus className="h-4 w-4 text-amber-500 shrink-0" />
            <Input
              ref={folderNameInputRef}
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              placeholder={t('sidebar.folderName')}
              className="h-7 text-xs flex-1"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleCreateFolder();
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setIsCreatingFolder(false);
                  setNewFolderName('');
                }
              }}
              onBlur={() => {
                if (!newFolderName.trim()) {
                  setIsCreatingFolder(false);
                  setNewFolderName('');
                }
              }}
            />
          </div>
        </div>
      )}

      {/* File tree with full functionality */}
      <div className="flex-1 overflow-y-auto overflow-x-auto">
        {filteredFiles.length > 0 ? (
          <FileTree
            files={filteredFiles}
            activeFileId={currentProject.activeFileId}
            selectedFileIds={currentProject.selectedFileIds || []}
            showCheckboxes={true}
            deletingFileId={deletingFileId}
            renamingFileId={renamingFileId}
            renameValue={renameValue}
            searchQuery={search}
            onContentWidthChange={onContentWidthChange}
            onSelectFile={handleSelectFile}
            onToggleSelection={handleToggleSelection}
            onToggleFolderSelection={handleToggleFolderSelection}
            onStartRename={handleStartRename}
            onConfirmRename={handleConfirmRename}
            onCancelRename={handleCancelRename}
            onRenameValueChange={setRenameValue}
            onDeleteClick={handleDeleteClick}
            onCancelDelete={() => setDeletingFileId(null)}
            isFileIncludedInAnalysis={isFileIncludedInAnalysis}
            hasLineageFile={hasLineageFile}
            canDeleteFiles={true}
            renameInputRef={renameInputRef}
            isReadOnly={isReadOnly}
            revealCnt={revealCnt}
            onCreateFileInFolder={(folderPath) => {
              createFile(
                DEFAULT_FILE_NAMES.NEW_QUERY,
                '',
                `${folderPath}/${DEFAULT_FILE_NAMES.NEW_QUERY}`
              );
            }}
            onUploadToFolder={(folderPath) => {
              uploadTargetDirRef.current = folderPath;
              fileInputRef.current?.click();
            }}
            onCreateFolderInFolder={(folderPath) => {
              if (!currentProject) return;
              // Deduplicate folder name by checking existing file paths
              const existingPaths = currentProject.files.map((f) => f.path.toLowerCase());
              const prefix = `${folderPath}/`.toLowerCase();
              // Collect existing direct child folder names
              const existingFolders = new Set<string>();
              for (const p of existingPaths) {
                if (p.startsWith(prefix)) {
                  const rest = p.slice(prefix.length);
                  const slashIdx = rest.indexOf('/');
                  if (slashIdx > 0) existingFolders.add(rest.slice(0, slashIdx));
                }
              }
              let subFolderName = 'new_folder';
              let counter = 2;
              while (existingFolders.has(subFolderName.toLowerCase())) {
                subFolderName = `new_folder_${counter}`;
                counter++;
              }
              createFile(
                DEFAULT_FILE_NAMES.NEW_QUERY,
                '',
                `${folderPath}/${subFolderName}/${DEFAULT_FILE_NAMES.NEW_QUERY}`
              );
            }}
            onRenameFolder={(oldPath, newName) => renameFolder(oldPath, newName)}
            onConvertProcedureInFolder={!isReadOnly ? handleOpenConvertFolder : undefined}
            onConvertDbtFile={!isReadOnly ? handleConvertDbtFile : undefined}
            onConvertDbtInFolder={!isReadOnly ? handleConvertDbtFolder : undefined}
            onGenerateYamlInFolder={!isReadOnly ? handleGenerateYamlFolder : undefined}
          />
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4 text-center">
            {search ? (
              <p className="text-xs">{t('fileSelector.noFilesFound')}</p>
            ) : (
              <>
                <FolderUp className="h-8 w-8 mb-2 opacity-30" />
                <p className="text-xs">{t('fileSelector.noFilesInProject')}</p>
                {!isReadOnly && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-3 text-xs"
                    onClick={() => folderInputRef.current?.click()}
                  >
                    <FolderUp className="h-3.5 w-3.5 mr-1.5" />
                    {t('common.folder')}
                  </Button>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* Upload progress overlay */}
      {uploadProgress && (
        <ProgressOverlay
          visible={Boolean(uploadProgress)}
          title={
            uploadProgress.done
              ? t('sidebar.uploadDone')
              : uploadProgress.stage === 'saving'
                ? t('sidebar.uploadSaving')
                : t('sidebar.uploadReading')
          }
          progress={
            uploadProgress.total > 0 ? (uploadProgress.loaded / uploadProgress.total) * 100 : 0
          }
          loaded={uploadProgress.loaded}
          total={uploadProgress.total}
          done={uploadProgress.done}
        />
      )}

      {/* Hidden file inputs */}
      <input
        type="file"
        multiple
        ref={fileInputRef}
        className="hidden"
        accept={ACCEPTED_FILE_TYPES}
        onChange={handleFileUpload}
      />
      <input
        type="file"
        ref={folderInputRef}
        className="hidden"
        onChange={handleFolderUpload}
        {...({ webkitdirectory: '', directory: '' } as React.InputHTMLAttributes<HTMLInputElement>)}
      />

      <ConvertFolderDialog
        open={convertDialogOpen}
        onOpenChange={(open) => {
          if (!isConvertingFolder) {
            setConvertDialogOpen(open);
            if (!open) setConvertProgress(null);
          }
        }}
        folderPath={convertTargetPath}
        procedureCount={folderProcedureCount}
        totalFileCount={folderTotalCount}
        isConverting={isConvertingFolder}
        convertProgress={convertProgress}
        convertResult={convertResult}
        onConfirm={handleConvertFolder}
      />

      {currentProject && dbtConvertPath && (
        <DbtConvertDialog
          open={dbtConvertOpen}
          onClose={() => setDbtConvertOpen(false)}
          projectId={currentProject.id}
          filePath={dbtConvertPath}
          originalSql={currentProject.files.find((f) => f.path === dbtConvertPath)?.content || ''}
          onSaved={(dbtContent) => {
            const file = currentProject.files.find((f) => f.path === dbtConvertPath);
            if (file) {
              updateFiles([{ fileId: file.id, dbtContent }]);
            }
          }}
        />
      )}

      {/* Folder dbt conversion dialog */}
      <DbtConvertFolderDialog
        open={dbtFolderOpen || Boolean(dbtFolderProgress)}
        onOpenChange={(open) => {
          if (!isConvertingDbtFolder) {
            setDbtFolderOpen(open);
            if (!open) {
              setDbtFolderPath(null);
              setDbtFolderFiles([]);
              setDbtFolderProgress(null);
              setDbtFolderLoadingFiles(false);
            }
          }
        }}
        folderPath={dbtFolderPath ?? ''}
        sqlFiles={dbtFolderFiles}
        totalFileCount={dbtFolderTotalCount}
        loadingFiles={dbtFolderLoadingFiles}
        isConverting={isConvertingDbtFolder}
        convertProgress={dbtFolderProgress ? { done: dbtFolderProgress.done, total: dbtFolderProgress.total } : null}
        convertResult={dbtFolderProgress ? { success: dbtFolderProgress.success, errors: dbtFolderProgress.errors, skipped: dbtFolderProgress.skipped } : null}
        onConfirm={handleConfirmDbtFolder}
      />

      {/* Folder YAML generation dialog */}
      <DbtConvertFolderDialog
        open={yamlFolderOpen || Boolean(yamlFolderProgress)}
        onOpenChange={(open) => {
          if (!isGeneratingYaml) {
            setYamlFolderOpen(open);
            if (!open) {
              setYamlFolderPath(null);
              setYamlFolderFiles([]);
              setYamlFolderProgress(null);
              setYamlFolderLoadingFiles(false);
            }
          }
        }}
        folderPath={yamlFolderPath ?? ''}
        sqlFiles={yamlFolderFiles}
        totalFileCount={yamlFolderFiles.length}
        loadingFiles={yamlFolderLoadingFiles}
        isConverting={isGeneratingYaml}
        convertProgress={yamlFolderProgress ? { done: yamlFolderProgress.done, total: yamlFolderProgress.total } : null}
        convertResult={yamlFolderProgress ? { success: yamlFolderProgress.success, errors: yamlFolderProgress.errors, skipped: yamlFolderProgress.skipped } : null}
        onConfirm={handleConfirmYamlFolder}
      />
    </div>
  );
}
