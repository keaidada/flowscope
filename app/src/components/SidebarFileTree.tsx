import { useState, useRef, useEffect, useMemo, useCallback, useDeferredValue } from 'react';
import {
  Upload,
  FolderUp,
  Plus,
  Search,
  FolderPlus,
  Trash2,
  CheckSquare,
} from 'lucide-react';
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
import { saveProjectFiles, upsertProjectFiles, loadFileContentsBatch } from '@/lib/file-storage';
import { ConvertFolderDialog } from './ConvertFolderDialog';
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
    selectFile,
    importFiles,
    addFilesDirectly,
    updateFiles,
    toggleFileSelection,
    setFileSelection,
    renameFile,
    renameFolder,
    deleteFolder,
    isReadOnly,
    ensureFilesContent,
    isContentLoaded,
  } = useProject();

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
  const [convertProgress, setConvertProgress] = useState<{ done: number; total: number } | null>(null);
  const [convertResult, setConvertResult] = useState<{
    success: number;
    successPaths: string[];
    empty: string[];
    errors: string[];
  } | null>(null);

  const currentProjectRef = useRef(currentProject);
  currentProjectRef.current = currentProject;

  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const folderNameInputRef = useRef<HTMLInputElement>(null);

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

  const handleCreateFolder = () => {
    const trimmed = newFolderName.trim();
    if (trimmed) {
      createFile(DEFAULT_FILE_NAMES.NEW_QUERY, '', `${trimmed}/${DEFAULT_FILE_NAMES.NEW_QUERY}`);
    }
    setIsCreatingFolder(false);
    setNewFolderName('');
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      importFiles(e.target.files);
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleFolderUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      if (!e.target.files || e.target.files.length === 0) return;

      const allFiles = Array.from(e.target.files);

      setUploadProgress({ total: allFiles.length, loaded: 0, skipped: 0, done: false, stage: 'reading' });

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
        return {
          id: genId(),
          name: file.name,
          path: relativePath || file.name,
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
        const updates: Array<{ fileId: string; content: string; isProcedure?: boolean; transformedContent?: string | null }> = [];
        for (let j = 0; j < batchPFs.length; j++) {
          batchPFs[j].content = contents[j];
          const upper = contents[j].toUpperCase();
          const isProcedure = upper.includes('CREATE PROCEDURE') || upper.includes('CREATE PROC');
          batchPFs[j].isProcedure = isProcedure;
          batchPFs[j].transformedContent = null;
          updates.push({ fileId: batchPFs[j].id, content: contents[j], isProcedure });
        }

        // Batch-update React state
        updateFiles(updates);

        loaded += batchFiles.length;
        setUploadProgress({ total: importTotal, loaded, skipped, done: false, stage: 'reading' });
      }

      // Phase 4: Persist to SQLite → OPFS/IndexedDB
      setUploadProgress({ total: importTotal, loaded: importTotal, skipped, done: false, stage: 'saving' });
      try {
        if (currentProject) {
          const allProjectFiles = [
            ...(currentProject.files.filter((f) => !projectFiles.some((pf) => pf.id === f.id))),
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

  const extractDmlFromProcedure = (content: string): string | null => {
    try {
      const upper = content.toUpperCase();
      const beginIdx = upper.indexOf('BEGIN');
      const endIdx = upper.lastIndexOf('END');
      if (beginIdx < 0 || endIdx <= beginIdx) return null;
      const body = content.slice(beginIdx + 5, endIdx);

      // Remove comments
      const uncommented = body
        .replace(/--[^\n]*/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .trim();

      const dmlKeywords = ['SELECT', 'INSERT', 'DELETE', 'MERGE', 'UPDATE', 'TRUNCATE', 'WITH', 'CREATE TABLE', 'CREATE OR REPLACE TABLE'];
      const isDml = (s: string) => dmlKeywords.some(k => s.toUpperCase().trimStart().startsWith(k));

      // Split into statements
      const rawStmts = splitProcedureStatements(uncommented);

      const results: string[] = [];
      for (const stmt of rawStmts) {
        const s = stmt.trim();
        if (!s) continue;

        // Check if the statement itself is DML
        if (isDml(s)) {
          results.push(s);
          continue;
        }

        // Extract from EXECUTE IMMEDIATE patterns
        const execSql = extractExecuteImmediateSql(s);
        if (execSql && isDml(execSql)) {
          results.push(execSql);
          continue;
        }

        // Extract from SET var = '...' / FORMAT("""...""") patterns
        const setSql = extractSetStmtSql(s);
        if (setSql && isDml(setSql)) {
          results.push(setSql);
          continue;
        }
      }

      return results.length > 0 ? results.join(';\n') : null;
    } catch {
      return null;
    }
  };

  // Split procedure body into statements, handling nested BEGIN/END and strings
  const splitProcedureStatements = (body: string): string[] => {
    const results: string[] = [];
    let depth = 0;
    let current = '';
    let i = 0;

    while (i < body.length) {
      const ch = body[i];

      // Track quoted strings to avoid splitting inside them
      if (ch === '\'' || ch === '"' || (ch === '`' && body.slice(i, i + 3) !== '```')) {
        const quote = ch;
        current += ch;
        i++;
        while (i < body.length && body[i] !== quote) {
          if (body[i] === '\\') { current += body[i]; i++; }
          current += body[i];
          i++;
        }
        if (i < body.length) { current += body[i]; i++; }
        continue;
      }

      // Triple-quoted strings (""" or ''')
      if ((ch === '"' || ch === '\'') && body.slice(i + 1, i + 3) === ch + ch) {
        const triple = body.slice(i, i + 3);
        current += triple;
        i += 3;
        while (i < body.length && body.slice(i, i + 3) !== triple) {
          current += body[i];
          i++;
        }
        if (i < body.length) { current += body.slice(i, i + 3); i += 3; }
        continue;
      }

      // Track nested BEGIN/END
      const word3 = body.slice(i, i + 3).toUpperCase();
      const word5 = body.slice(i, i + 5).toUpperCase();
      if (word5 === 'BEGIN' && /\b/.test(body[i + 5] || ' ')) {
        depth++;
      }
      if (word3 === 'END' && /\b/.test(body[i + 3] || ' ') && i > 0 && body.slice(0, i).trimEnd().length !== i) {
        depth--;
        if (depth < 0) depth = 0;
      }

      // Split at semicolons only at depth 0
      if (ch === ';' && depth === 0) {
        results.push(current);
        current = '';
        i++;
        continue;
      }

      current += ch;
      i++;
    }

    if (current.trim()) results.push(current);
    return results;
  };

  // Extract SQL from EXECUTE IMMEDIATE FORMAT("""...""") / EXECUTE IMMEDIATE """...""" / EXECUTE IMMEDIATE '...'
  const extractExecuteImmediateSql = (s: string): string | null => {
    const upper = s.toUpperCase().trimStart();
    if (!upper.startsWith('EXECUTE IMMEDIATE')) return null;

    const afterKeyword = s.slice(s.toUpperCase().indexOf('IMMEDIATE') + 9).trimStart();
    if (!afterKeyword) return null;

    // Case: FORMAT("""...""", ...) or FORMAT('...', ...)
    if (afterKeyword.toUpperCase().startsWith('FORMAT')) {
      const afterFormat = afterKeyword.slice(6).trimStart();
      const afterParen = afterFormat.startsWith('(') ? afterFormat.slice(1).trimStart() : afterFormat;
      const sql = extractFromQuotes(afterParen);
      if (!sql) return null;
      return replaceFormatPlaceholders(sql);
    }

    // Case: direct triple-quoted or single-quoted string
    return extractFromQuotes(afterKeyword);
  };

  // Extract SQL from SET var = FORMAT("""...""") / SET var = '...'
  const extractSetStmtSql = (s: string): string | null => {
    const upper = s.toUpperCase().trimStart();
    if (!upper.startsWith('SET ')) return null;

    const eqPos = s.indexOf('=');
    if (eqPos < 0) return null;
    const afterEq = s.slice(eqPos + 1).trimStart();
    if (!afterEq) return null;

    // SET var = FORMAT("""...""", ...)
    if (afterEq.toUpperCase().startsWith('FORMAT')) {
      const afterFormat = afterEq.slice(6).trimStart();
      const afterParen = afterFormat.startsWith('(') ? afterFormat.slice(1).trimStart() : afterFormat;
      const sql = extractFromQuotes(afterParen);
      if (!sql) return null;
      return replaceFormatPlaceholders(sql);
    }

    // SET var = CONCAT('part1', 'part2', ...) - skip
    if (afterEq.toUpperCase().startsWith('CONCAT')) return null;

    // SET var = '...' or SET var = "..."
    const ch = afterEq[0];
    if (ch !== '\'' && ch !== '"') return null;

    // Find matching close quote
    let end = 1;
    while (end < afterEq.length && afterEq[end] !== ch) {
      if (afterEq[end] === '\\') end++;
      end++;
    }
    if (end >= afterEq.length) return null;
    return afterEq.slice(1, end);
  };

  // Extract content from quoted string (supports triple-quoted and single-quoted)
  const extractFromQuotes = (s: string): string | null => {
    if (!s) return null;

    // Triple-quoted: """...""" or '''...'''
    if ((s[0] === '"' && s[1] === '"' && s[2] === '"') || (s[0] === '\'' && s[1] === '\'' && s[2] === '\'')) {
      const triple = s.slice(0, 3);
      let end = 3;
      while (end < s.length && s.slice(end, end + 3) !== triple) end++;
      if (end >= s.length) return null;
      return s.slice(3, end);
    }

    // Single-quoted: "..." or '...'
    if (s[0] === '"' || s[0] === '\'') {
      const q = s[0];
      let end = 1;
      while (end < s.length && s[end] !== q) {
        if (s[end] === '\\') end++;
        end++;
      }
      if (end >= s.length) return null;
      return s.slice(1, end);
    }

    return null;
  };

  // Replace FORMAT placeholders with dummy values for SQL parsing
  const replaceFormatPlaceholders = (s: string): string => {
    let out = '';
    let i = 0;
    while (i < s.length) {
      if (s[i] === '%' && i + 1 < s.length) {
        const next = s[i + 1];
        if (next === '%') { out += '%'; i += 2; continue; }
        if ('diuoxX'.includes(next)) { out += '0'; i += 2; continue; }
        if (next === 's' || next === 'S' || next === 'c') { out += 'x'; i += 2; continue; }
        if ('feEgG'.includes(next)) { out += '0.0'; i += 2; continue; }
        if (next === 't' || next === 'T') { out += '2024-01-01'; i += 2; continue; }
      }
      out += s[i];
      i++;
    }
    return out;
  };

  const handleOpenConvertFolder = useCallback((folderPath: string) => {
    setConvertTargetPath(folderPath);
    setConvertResult(null);
    setConvertDialogOpen(true);
  }, []);

  const handleConvertFolder = useCallback(async (dialect: Dialect) => {
    if (!currentProject) return;
    const prefix = convertTargetPath.endsWith('/') ? convertTargetPath : convertTargetPath + '/';
    const folderFiles = currentProject.files.filter(f => f.path.startsWith(prefix));
    const procFiles = folderFiles.filter(f => f.isProcedure);
    const total = procFiles.length;

    if (total === 0) return;

    setIsConvertingFolder(true);
    setConvertProgress({ done: 0, total });

    try {
      // Step 1: ensure all procedure files have content loaded
      const unloadedIds = procFiles.filter(f => !isContentLoaded(f.id)).map(f => f.id);
      if (unloadedIds.length > 0) {
        await ensureFilesContent(unloadedIds);
      }

      // Step 2: load content from DB directly (bypass React state timing)
      const contentMap = await loadFileContentsBatch(activeProjectId ?? '', procFiles.map(f => f.path));

      // Step 3: process and save in batches
      const BATCH = 50;
      const savedFiles: ProjectFile[] = [];
      let successCount = 0;
      const successPaths: string[] = [];
      const emptyFiles: string[] = [];
      const errorFiles: string[] = [];

      for (let i = 0; i < procFiles.length; i += BATCH) {
        const batch = procFiles.slice(i, i + BATCH);
        const batchUpdates: Array<{ fileId: string; content: string; isProcedure?: boolean; transformedContent?: string | null; dialect?: string }> = [];

        for (const f of batch) {
          try {
            const content = contentMap.get(f.path) || f.content;
            if (!content) {
              emptyFiles.push(f.path);
              continue;
            }
            const transformedContent = extractDmlFromProcedure(content);
            if (!transformedContent) {
              emptyFiles.push(f.path);
            } else {
              successCount++;
              successPaths.push(f.path);
            }
            const updatedFile: ProjectFile = { ...f, content, dialect, isProcedure: true, transformedContent };
            savedFiles.push(updatedFile);

            batchUpdates.push({
              fileId: f.id,
              content,
              isProcedure: true,
              transformedContent,
              dialect,
            });
          } catch (err) {
            errorFiles.push(`${f.path} (${err instanceof Error ? err.message : String(err)})`);
          }
        }

        if (batchUpdates.length > 0) {
          updateFiles(batchUpdates);
        }
        setConvertProgress({ done: Math.min(i + BATCH, total), total });
        await new Promise(r => setTimeout(r, 0));
      }

      setConvertProgress({ done: total, total });
      setConvertResult({ success: successCount, successPaths, empty: emptyFiles, errors: errorFiles });

      // Step 4: persist to DB
      if (savedFiles.length > 0) {
        const project = currentProjectRef.current;
        if (project) {
          const CHUNK = 200;
          for (let i = 0; i < savedFiles.length; i += CHUNK) {
            await upsertProjectFiles(project.id, savedFiles.slice(i, i + CHUNK));
          }
        }
      }
    } catch (e) {
      console.error('Failed to convert procedures:', e);
    } finally {
      setIsConvertingFolder(false);
    }
  }, [currentProject, convertTargetPath, updateFiles, ensureFilesContent, isContentLoaded, activeProjectId]);

  const folderProcedureCount = useMemo(() => {
    if (!convertDialogOpen || !currentProject) return 0;
    const prefix = convertTargetPath.endsWith('/') ? convertTargetPath : convertTargetPath + '/';
    return currentProject.files.filter(f => f.path.startsWith(prefix) && f.isProcedure).length;
  }, [convertDialogOpen, currentProject, convertTargetPath]);

  const folderTotalCount = useMemo(() => {
    if (!convertDialogOpen || !currentProject) return 0;
    const prefix = convertTargetPath.endsWith('/') ? convertTargetPath : convertTargetPath + '/';
    return currentProject.files.filter(f => f.path.startsWith(prefix)).length;
  }, [convertDialogOpen, currentProject, convertTargetPath]);

  const handleSelectFile = (fileId: string) => {
    selectFile(fileId);
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

  const isFileIncludedInAnalysis = useCallback((fileId: string) => {
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
  }, [currentProject]);

  // Defer lineage set changes so 3000+ FolderNode re-renders don't block UI
  const deferredLineageIds = useDeferredValue(lineageFileIds);

  const hasLineageFile = useCallback((filePath: string) => {
    return deferredLineageIds?.has(filePath) ?? false;
  }, [deferredLineageIds]);

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
            <span className="text-xs text-muted-foreground whitespace-nowrap">({currentProject.files.length})</span>
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
            onCreateFileInFolder={(folderPath) => {
              createFile(
                DEFAULT_FILE_NAMES.NEW_QUERY,
                '',
                `${folderPath}/${DEFAULT_FILE_NAMES.NEW_QUERY}`
              );
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
            onDeleteFolder={(folderPath) => {
              // 需要二次确认防止误删
              if (window.confirm(`确定要删除文件夹 "${folderPath}" 及其所有文件吗？此操作不可撤销。`)) {
                try {
                  deleteFolder(folderPath);
                } catch (e) {
                  console.error('[deleteFolder] sync error:', e);
                }
              }
            }}
            onConvertProcedureInFolder={!isReadOnly ? handleOpenConvertFolder : undefined}
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
          progress={uploadProgress.total > 0 ? (uploadProgress.loaded / uploadProgress.total) * 100 : 0}
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
        onOpenChange={(open) => { if (!isConvertingFolder) { setConvertDialogOpen(open); if (!open) setConvertProgress(null); } }}
        folderPath={convertTargetPath}
        procedureCount={folderProcedureCount}
        totalFileCount={folderTotalCount}
        isConverting={isConvertingFolder}
        convertProgress={convertProgress}
        convertResult={convertResult}
        onConfirm={handleConvertFolder}
      />
    </div>
  );
}
