import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { Upload, FolderUp, Plus, Search, FolderPlus, Loader2, CheckCircle2, Trash2, CheckSquare } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useProject } from '@/lib/project-store';
import type { ProjectFile } from '@/lib/project-store';
import { FileTree } from '@/components/FileTree';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { ACCEPTED_FILE_TYPES, ACCEPTED_FILE_TYPES_ARRAY, FILE_EXTENSIONS, DEFAULT_FILE_NAMES } from '@/lib/constants';
import { registerPendingFiles } from '@/lib/lazy-file-loader';

interface SidebarFileTreeProps {
  onContentWidthChange?: (widthPx: number) => void;
}

export function SidebarFileTree({ onContentWidthChange }: SidebarFileTreeProps) {
  const { t } = useTranslation();
  const {
    currentProject,
    createFile,
    deleteFile,
    deleteFiles,
    selectFile,
    importFiles,
    addFilesDirectly,
    toggleFileSelection,
    renameFile,
    renameFolder,
    isReadOnly,
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
  } | null>(null);

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

  const handleFolderUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || e.target.files.length === 0) return;

    const allFiles = Array.from(e.target.files);
    const total = allFiles.length;

    setUploadProgress({ total, loaded: 0, skipped: 0, done: false });

    // Phase 1: Filter supported files (use Set for O(1) lookup)
    const acceptedSet = new Set(ACCEPTED_FILE_TYPES_ARRAY.map(ext => ext.toLowerCase()));
    const supportedFiles: File[] = [];
    let skipped = 0;
    for (const file of allFiles) {
      const dotIdx = file.name.lastIndexOf('.');
      const ext = dotIdx >= 0 ? file.name.slice(dotIdx).toLowerCase() : '';
      if (acceptedSet.has(ext)) {
        supportedFiles.push(file);
      } else {
        skipped++;
      }
    }

    const importTotal = supportedFiles.length;
    setUploadProgress({ total: importTotal, loaded: 0, skipped, done: false });

    // Phase 2: Create file entries WITHOUT reading content (lazy load on open)
    const projectFiles: ProjectFile[] = new Array(importTotal);
    const pendingEntries: Array<{ id: string; file: File }> = new Array(importTotal);

    const getFileLanguage = (fileName: string): ProjectFile['language'] => {
      if (fileName.endsWith(FILE_EXTENSIONS.JSON)) return 'json';
      if (fileName.endsWith(FILE_EXTENSIONS.SQL) || fileName.toLowerCase().endsWith(FILE_EXTENSIONS.HQL)) return 'sql';
      return 'text';
    };

    for (let i = 0; i < supportedFiles.length; i++) {
      const file = supportedFiles[i];
      const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
      const id = crypto.randomUUID();
      projectFiles[i] = {
        id,
        name: file.name,
        path: relativePath || file.name,
        content: '', // Content loaded lazily when file is opened
        language: getFileLanguage(file.name),
      };
      pendingEntries[i] = { id, file };

      // Update progress every 200 files
      if ((i + 1) % 200 === 0 || i === supportedFiles.length - 1) {
        setUploadProgress({ total: importTotal, loaded: i + 1, skipped, done: false });
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    // Register File references for lazy content loading
    registerPendingFiles(pendingEntries);

    // Phase 3: Add files in one shot
    setUploadProgress({ total: importTotal, loaded: importTotal, skipped, done: false });
    await new Promise((r) => requestAnimationFrame(r));

    if (projectFiles.length > 0) {
      addFilesDirectly(projectFiles);
    }

    setUploadProgress({ total: importTotal, loaded: importTotal, skipped, done: true });
    setTimeout(() => setUploadProgress(null), 1500);

    if (folderInputRef.current) folderInputRef.current.value = '';
  }, [addFilesDirectly]);

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

  const isFileIncludedInAnalysis = (fileId: string) => {
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
  };

  const handleToggleFolderSelection = (fileIds: string[], select: boolean) => {
    if (!currentProject) return;
    for (const fileId of fileIds) {
      const isSelected = currentProject.selectedFileIds.includes(fileId);
      if (select && !isSelected) {
        toggleFileSelection(currentProject.id, fileId);
      } else if (!select && isSelected) {
        toggleFileSelection(currentProject.id, fileId);
      }
    }
  };

  if (!currentProject) return null;

  const selectedCount = currentProject.selectedFileIds?.length ?? 0;

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

  const allSelected = currentProject.files.length > 0
    && selectedCount === currentProject.files.length;

  const handleSelectAll = () => {
    if (!currentProject) return;
    if (allSelected) {
      // Deselect all
      for (const file of currentProject.files) {
        if (currentProject.selectedFileIds.includes(file.id)) {
          toggleFileSelection(currentProject.id, file.id);
        }
      }
    } else {
      // Select all
      for (const file of currentProject.files) {
        if (!currentProject.selectedFileIds.includes(file.id)) {
          toggleFileSelection(currentProject.id, file.id);
        }
      }
    }
  };

  const filteredFiles = useMemo(() => {
    if (!search.trim()) return currentProject.files;
    const searchLower = search.toLowerCase();
    return currentProject.files.filter(
      (f) =>
        f.name.toLowerCase().includes(searchLower) || f.path.toLowerCase().includes(searchLower)
    );
  }, [currentProject.files, search]);

  return (
    <div className="flex flex-col h-full bg-background relative">
      {/* Header with action buttons */}
      <div className="flex items-center justify-between px-3 py-2 border-b shrink-0">
        <div className="flex items-center gap-1">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            {t('common.files')}
          </span>
          {currentProject.files.length > 0 && (
            <span className="text-xs text-muted-foreground">
              ({currentProject.files.length})
            </span>
          )}
          {selectedCount > 0 && (
            <span className="text-xs text-muted-foreground">
              · {t('sidebar.selectedCount', { count: selectedCount })}
            </span>
          )}
        </div>
        {!isReadOnly && (
          <TooltipProvider delayDuration={300}>
            <div className="flex items-center gap-0.5">
              {/* Delete selected */}
              {selectedCount > 0 && (
                confirmBatchDelete ? (
                  <div className="flex items-center gap-0.5">
                    <span className="text-xs text-destructive whitespace-nowrap">{t('sidebar.confirmDelete')}</span>
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
                    <TooltipContent side="bottom"><p>{t('sidebar.deleteSelected')}</p></TooltipContent>
                  </Tooltip>
                )
              )}
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
                <TooltipContent side="bottom"><p>{t('common.new')}</p></TooltipContent>
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
                <TooltipContent side="bottom"><p>{t('sidebar.newFolder')}</p></TooltipContent>
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
                <TooltipContent side="bottom"><p>{t('common.files')}</p></TooltipContent>
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
                <TooltipContent side="bottom"><p>{t('sidebar.addFolder')}</p></TooltipContent>
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
            canDeleteFiles={true}
            renameInputRef={renameInputRef}
            isReadOnly={isReadOnly}
            onCreateFileInFolder={(folderPath) => {
              createFile(DEFAULT_FILE_NAMES.NEW_QUERY, '', `${folderPath}/${DEFAULT_FILE_NAMES.NEW_QUERY}`);
            }}
            onCreateFolderInFolder={(folderPath) => {
              if (!currentProject) return;
              // Deduplicate folder name by checking existing file paths
              const existingPaths = currentProject.files.map(f => f.path.toLowerCase());
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
              createFile(DEFAULT_FILE_NAMES.NEW_QUERY, '', `${folderPath}/${subFolderName}/${DEFAULT_FILE_NAMES.NEW_QUERY}`);
            }}
            onRenameFolder={(oldPath, newName) => renameFolder(oldPath, newName)}
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
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-xs">
          <div className="bg-background border rounded-xl shadow-lg p-5 w-[240px] space-y-3">
            <div className="flex items-center gap-2">
              {uploadProgress.done ? (
                <CheckCircle2 className="h-5 w-5 text-green-500 shrink-0" />
              ) : (
                <Loader2 className="h-5 w-5 animate-spin text-primary shrink-0" />
              )}
              <span className="text-sm font-medium">
                {uploadProgress.done
                  ? t('sidebar.uploadDone')
                  : t('sidebar.uploading')}
              </span>
            </div>

            {/* Progress bar */}
            <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden">
              <div
                className="h-full bg-primary rounded-full transition-all duration-300"
                style={{
                  width: `${uploadProgress.total > 0 ? (uploadProgress.loaded / uploadProgress.total) * 100 : 0}%`,
                }}
              />
            </div>

            <div className="text-xs text-muted-foreground space-y-0.5">
              <p>{t('sidebar.uploadProgress', {
                loaded: uploadProgress.loaded,
                total: uploadProgress.total,
              })}</p>
              {uploadProgress.done && (
                <p>{t('sidebar.uploadResult', {
                  imported: uploadProgress.total - uploadProgress.skipped,
                  skipped: uploadProgress.skipped,
                })}</p>
              )}
            </div>
          </div>
        </div>
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
    </div>
  );
}
