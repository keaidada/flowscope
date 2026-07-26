import { useState, useCallback, useRef, useMemo, useEffect, createContext, useContext } from 'react';
import { useTranslation } from 'react-i18next';
import { SqlView } from '@pondpilot/flowscope-react';
import {
  Upload,
  Trash2,
  FolderUp,
  FolderPlus,
  CheckSquare,
  ChevronRight,
  ChevronDown,
  Folder,
  FolderOpen as FolderOpenIcon,
  FileCode,
  X,
  WrapText,
  Plus,
  Pencil,
} from 'lucide-react';
import ProgressOverlay from './ProgressOverlay';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useProject } from '@/lib/project-store';
import { useThemeStore, resolveTheme } from '@/lib/theme-store';
import { schemaMetadataToSQL } from '@/lib/schema-parser';
import { cn, genId } from '@/lib/utils';
import { BINARY_EXTENSIONS } from '@/lib/constants';
import { saveSchemaFiles, loadSchemaFiles } from '@/lib/schema-storage';
import { onSchemaFileSelect } from '@/lib/schema-events';

// --- Schema context for split-panel layout ---
interface SchemaCtx {
  schemaFiles: SchemaFile[];
  activeFileId: string | null;
  activeFile: SchemaFile | undefined;
  expandedFolders: Set<string>;
  selectedFileIds: Set<string>;
  activeFolderPath: string;
  activeParentFolder: string;
  search: string;
  isReadOnly: boolean;
  isBackendMode: boolean;
  tree: TreeNode;
  sortedRootChildren: TreeNode[];
  filteredFiles: SchemaFile[];
  allSelected: boolean;
  isCreatingFile: boolean;
  isCreatingFolder: boolean;
  newFileName: string;
  newFolderName: string;
  confirmBatchDelete: boolean;
  schemaHighlightSpan: { start: number; end: number } | null;
  lineWrapping: boolean;
  treePanelWidth: number;
  isResizing: boolean;
  isDark: boolean;
  uploadProgress: { total: number; loaded: number; skipped: number; done: boolean } | null;
  // Refs
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  folderInputRef: React.RefObject<HTMLInputElement | null>;
  fileNameInputRef: React.RefObject<HTMLInputElement | null>;
  folderNameInputRef: React.RefObject<HTMLInputElement | null>;
  treeContentRef: React.RefObject<HTMLDivElement | null>;
  // Setters / actions
  setSearch: (v: string) => void;
  setNewFileName: (v: string) => void;
  setNewFolderName: (v: string) => void;
  setIsCreatingFile: (v: boolean) => void;
  setIsCreatingFolder: (v: boolean) => void;
  setConfirmBatchDelete: (v: boolean) => void;
  setLineWrapping: React.Dispatch<React.SetStateAction<boolean>>;
  setTreePanelWidth: React.Dispatch<React.SetStateAction<number>>;
  setIsResizing: (v: boolean) => void;
  setActiveFolderPath: (v: string) => void;
  handleSelectFile: (id: string | null | ((prev: string | null) => string | null)) => void;
  handleToggleFolder: (path: string) => void;
  handleEditorChange: (value: string) => void;
  handleFileUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  handleFolderUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  handleDeleteFile: (fileId: string) => void;
  handleRenameFile: (fileId: string, newName: string) => void;
  handleRenameFolder: (oldPath: string, newName: string) => void;
  handleCreateFile: () => void;
  handleCreateFolder: () => void;
  handleDoubleClickCreateFile: (folderPath: string) => void;
  handleCreateFolderInFolder: (parentPath: string) => void;
  handleSelectAll: () => void;
  handleBatchDeleteClick: () => void;
  handleConfirmBatchDelete: () => void;
  handleToggleSelection: (ids: string[], select: boolean) => void;
  handleResizeStart: (e: React.MouseEvent) => void;
  setActiveFileId: (updater: string | null | ((prev: string | null) => string | null)) => void;
}

const SchemaContext = createContext<SchemaCtx | null>(null);
function useSchemaCtx() {
  const ctx = useContext(SchemaContext);
  if (!ctx) throw new Error('useSchemaCtx must be used within SchemaProvider');
  return ctx;
}

// --- Schema file model ---
interface SchemaFile {
  id: string;
  name: string;
  path: string;
  content: string;
}

// --- Tree node for display ---
interface TreeNode {
  name: string;
  path: string;
  file?: SchemaFile;
  children: Map<string, TreeNode>;
}

function buildTree(files: SchemaFile[]): TreeNode {
  const root: TreeNode = { name: '', path: '', children: new Map() };
  for (const file of files) {
    const parts = file.path.split('/').filter(Boolean);
    let current = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isFile = i === parts.length - 1;
      const pathSoFar = parts.slice(0, i + 1).join('/');
      if (!current.children.has(part)) {
        current.children.set(part, {
          name: part,
          path: pathSoFar,
          file: isFile ? file : undefined,
          children: new Map(),
        });
      } else if (isFile) {
        current.children.get(part)!.file = file;
      }
      current = current.children.get(part)!;
    }
  }
  return root;
}

function sortNodes(nodes: TreeNode[]): TreeNode[] {
  return nodes.sort((a, b) => {
    const aIsFolder = a.children.size > 0;
    const bIsFolder = b.children.size > 0;
    if (aIsFolder && !bIsFolder) return -1;
    if (!aIsFolder && bIsFolder) return 1;
    return a.name.localeCompare(b.name);
  });
}

// Collect all file IDs under a tree node
function collectFileIds(node: TreeNode): string[] {
  const ids: string[] = [];
  for (const child of node.children.values()) {
    if (child.file) ids.push(child.file.id);
    if (child.children.size > 0) ids.push(...collectFileIds(child));
  }
  return ids;
}

// --- Folder node component ---
function SchemaFolderNode({
  node,
  depth,
  activeFileId,
  activeFolderPath,
  onSelect,
  onDelete,
  expandedFolders,
  onToggleFolder,
  onSelectFolder,
  onDoubleClickFolder,
  onCreateFolderInFolder,
  onRenameFolder,
  onRenameFile,
  selectedFileIds,
  onToggleSelection,
}: {
  node: TreeNode;
  depth: number;
  activeFileId: string | null;
  activeFolderPath: string;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  expandedFolders: Set<string>;
  onToggleFolder: (path: string) => void;
  onSelectFolder: (path: string) => void;
  onDoubleClickFolder: (folderPath: string) => void;
  onCreateFolderInFolder: (folderPath: string) => void;
  onRenameFolder: (oldPath: string, newName: string) => void;
  onRenameFile: (fileId: string, newName: string) => void;
  selectedFileIds: Set<string>;
  onToggleSelection: (ids: string[], select: boolean) => void;
}) {
  const isExpanded = expandedFolders.has(node.path);
  const isActiveFolder = activeFolderPath === node.path;
  const sorted = useMemo(() => sortNodes(Array.from(node.children.values())), [node]);
  const folderFileIds = useMemo(() => collectFileIds(node), [node]);
  const allSelected =
    folderFileIds.length > 0 && folderFileIds.every((id) => selectedFileIds.has(id));
  const someSelected = !allSelected && folderFileIds.some((id) => selectedFileIds.has(id));

  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(node.name);
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isRenaming && renameInputRef.current) {
      setTimeout(() => renameInputRef.current?.focus(), 0);
    }
  }, [isRenaming]);

  const handleConfirmRename = () => {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== node.name) {
      onRenameFolder(node.path, trimmed);
    }
    setIsRenaming(false);
  };

  if (isRenaming) {
    return (
      <div>
        <div
          className="flex items-center gap-1 py-1 px-2"
          style={{ paddingLeft: `${depth * 12 + 8}px` }}
          onClick={(e) => e.stopPropagation()}
        >
          <Folder className="size-4 shrink-0 text-amber-500" />
          <input
            ref={renameInputRef}
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            className="h-6 flex-1 text-sm bg-background border rounded px-1"
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') {
                e.preventDefault();
                handleConfirmRename();
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                setIsRenaming(false);
                setRenameValue(node.name);
              }
            }}
            onBlur={handleConfirmRename}
          />
        </div>
        {isExpanded &&
          sorted.map((child) =>
            child.file ? (
              <SchemaFileNode
                key={child.file.id}
                node={child}
                depth={depth + 1}
                activeFileId={activeFileId}
                onSelect={onSelect}
                onDelete={onDelete}
                onRenameFile={onRenameFile}
                onSelectFolder={onSelectFolder}
                selectedFileIds={selectedFileIds}
                onToggleSelection={onToggleSelection}
              />
            ) : (
              <SchemaFolderNode
                key={child.path}
                node={child}
                depth={depth + 1}
                activeFileId={activeFileId}
                activeFolderPath={activeFolderPath}
                onSelect={onSelect}
                onDelete={onDelete}
                expandedFolders={expandedFolders}
                onToggleFolder={onToggleFolder}
                onSelectFolder={onSelectFolder}
                onDoubleClickFolder={onDoubleClickFolder}
                onCreateFolderInFolder={onCreateFolderInFolder}
                onRenameFolder={onRenameFolder}
                onRenameFile={onRenameFile}
                selectedFileIds={selectedFileIds}
                onToggleSelection={onToggleSelection}
              />
            )
          )}
      </div>
    );
  }

  return (
    <div>
      <div
        className={cn(
          'flex items-center gap-1 py-1 px-2 cursor-pointer hover:bg-muted/50 group text-sm',
          isActiveFolder ? 'bg-muted/40 text-foreground' : 'text-muted-foreground'
        )}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        onClick={() => {
          onToggleFolder(node.path);
          onSelectFolder(node.path);
        }}
      >
        <Checkbox
          checked={allSelected ? true : someSelected ? 'indeterminate' : false}
          onClick={(e) => {
            e.stopPropagation();
            onToggleSelection(folderFileIds, !allSelected);
          }}
          className="shrink-0 border-muted-foreground"
        />
        {isExpanded ? (
          <ChevronDown className="size-4 shrink-0" />
        ) : (
          <ChevronRight className="size-4 shrink-0" />
        )}
        {isExpanded ? (
          <FolderOpenIcon className="size-4 shrink-0 text-amber-500" />
        ) : (
          <Folder className="size-4 shrink-0 text-amber-500" />
        )}
        <span className="whitespace-nowrap">{node.name}</span>
        <span className="text-[10px] text-muted-foreground shrink-0 mr-1">
          ({folderFileIds.length})
        </span>
        <div className="opacity-0 group-hover:opacity-100 flex items-center gap-0.5 shrink-0 transition-opacity">
          <button
            className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
            onClick={(e) => {
              e.stopPropagation();
              onSelectFolder(node.path);
              onDoubleClickFolder(node.path);
            }}
            title="New file"
          >
            <Plus className="size-3" />
          </button>
          <button
            className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
            onClick={(e) => {
              e.stopPropagation();
              onSelectFolder(node.path);
              onCreateFolderInFolder(node.path);
            }}
            title="New folder"
          >
            <FolderPlus className="size-3" />
          </button>
          <button
            className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
            onClick={(e) => {
              e.stopPropagation();
              setRenameValue(node.name);
              setIsRenaming(true);
            }}
            title="Rename"
          >
            <Pencil className="size-3" />
          </button>
        </div>
      </div>
      {isExpanded &&
        sorted.map((child) =>
          child.file ? (
            <SchemaFileNode
              key={child.file.id}
              node={child}
              depth={depth + 1}
              activeFileId={activeFileId}
              onSelect={onSelect}
              onDelete={onDelete}
              onRenameFile={onRenameFile}
              onSelectFolder={onSelectFolder}
              selectedFileIds={selectedFileIds}
              onToggleSelection={onToggleSelection}
            />
          ) : (
            <SchemaFolderNode
              key={child.path}
              node={child}
              depth={depth + 1}
              activeFileId={activeFileId}
              activeFolderPath={activeFolderPath}
              onSelect={onSelect}
              onDelete={onDelete}
              expandedFolders={expandedFolders}
              onToggleFolder={onToggleFolder}
              onSelectFolder={onSelectFolder}
              onDoubleClickFolder={onDoubleClickFolder}
              onCreateFolderInFolder={onCreateFolderInFolder}
              onRenameFolder={onRenameFolder}
              onRenameFile={onRenameFile}
              selectedFileIds={selectedFileIds}
              onToggleSelection={onToggleSelection}
            />
          )
        )}
    </div>
  );
}

// --- File node with rename support ---
function SchemaFileNode({
  node,
  depth,
  activeFileId,
  onSelect,
  onDelete,
  onRenameFile,
  onSelectFolder,
  selectedFileIds,
  onToggleSelection,
}: {
  node: TreeNode;
  depth: number;
  activeFileId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onRenameFile: (fileId: string, newName: string) => void;
  onSelectFolder: (path: string) => void;
  selectedFileIds: Set<string>;
  onToggleSelection: (ids: string[], select: boolean) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isRenaming && renameInputRef.current) {
      setTimeout(() => renameInputRef.current?.focus(), 0);
    }
  }, [isRenaming]);

  if (!node.file) return null;
  const isActive = activeFileId === node.file.id;
  const isSelected = selectedFileIds.has(node.file.id);
  const parentFolder = node.path.includes('/') ? node.path.split('/').slice(0, -1).join('/') : '';

  const handleConfirmRename = () => {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== node.name && node.file) {
      onRenameFile(node.file.id, trimmed);
    }
    setIsRenaming(false);
  };

  if (isRenaming) {
    return (
      <div
        className="flex items-center gap-1 py-1 px-2"
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        onClick={(e) => e.stopPropagation()}
      >
        <FileCode className="size-4 shrink-0 text-blue-500" />
        <input
          ref={renameInputRef}
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          className="h-6 flex-1 text-sm bg-background border rounded px-1"
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') {
              e.preventDefault();
              handleConfirmRename();
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              setIsRenaming(false);
            }
          }}
          onBlur={handleConfirmRename}
        />
      </div>
    );
  }

  return (
    <div
      className={cn(
        'flex items-center gap-1 py-1 px-2 cursor-pointer hover:bg-muted/50 group text-sm',
        isActive ? 'bg-muted text-foreground' : 'text-muted-foreground'
      )}
      style={{ paddingLeft: `${depth * 12 + 8}px` }}
      onClick={() => {
        setConfirming(false);
        onSelect(node.file!.id);
        onSelectFolder(parentFolder);
      }}
    >
      <Checkbox
        checked={isSelected}
        onClick={(e) => {
          e.stopPropagation();
          onToggleSelection([node.file!.id], !isSelected);
        }}
        className="shrink-0 border-muted-foreground"
      />
      <FileCode className="size-4 shrink-0 text-blue-500" />
      <span className="whitespace-nowrap">{node.name}</span>
      {confirming ? (
        <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
          <span className="text-xs text-destructive whitespace-nowrap">Delete?</span>
          <button
            className="p-0.5 rounded hover:bg-destructive/10 text-destructive"
            onClick={() => onDelete(node.file!.id)}
          >
            <Trash2 className="size-3" />
          </button>
          <button
            className="p-0.5 rounded hover:bg-muted text-muted-foreground"
            onClick={() => setConfirming(false)}
          >
            <X className="size-3" />
          </button>
        </div>
      ) : (
        <div className="opacity-0 group-hover:opacity-100 flex items-center gap-0.5 shrink-0 transition-opacity">
          <button
            className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
            onClick={(e) => {
              e.stopPropagation();
              setRenameValue(node.name);
              setIsRenaming(true);
            }}
          >
            <Pencil className="size-3" />
          </button>
          <button
            className="p-0.5 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive"
            onClick={(e) => {
              e.stopPropagation();
              setConfirming(true);
            }}
          >
            <Trash2 className="size-3" />
          </button>
        </div>
      )}
    </div>
  );
}

// Module-level cache for fast restore across sidebar switches (avoids async DB read on every mount).
// Also serves as write-through cache — synced to IndexedDB via debounced save.
const schemaFilesCache = new Map<string, SchemaFile[]>();
const expandedFoldersCache = new Map<string, Set<string>>();
const activeFileIdCache = new Map<string, string | null>();

// Debounced save to IndexedDB (mirrors file-storage pattern)
const schemaSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
function debouncedSaveSchemaFiles(projectId: string, files: SchemaFile[]) {
  const existing = schemaSaveTimers.get(projectId);
  if (existing) clearTimeout(existing);
  schemaSaveTimers.set(
    projectId,
    setTimeout(() => {
      saveSchemaFiles(projectId, files);
      schemaSaveTimers.delete(projectId);
    }, 500)
  );
}

interface SidebarSchemaProps {
  onContentWidthChange?: (widthPx: number) => void;
}

// --- Schema provider (holds all state, renders children via context) ---
export function SchemaProvider({ children, onContentWidthChange }: { children: React.ReactNode; onContentWidthChange?: (widthPx: number) => void }) {
  const { t } = useTranslation();
  const {
    currentProject,
    updateSchemaSQL,
    activeProjectId,
    isBackendMode,
    isReadOnly,
    backendSchema,
  } = useProject();
  const theme = useThemeStore((state) => state.theme);
  const isDark = resolveTheme(theme) === 'dark';

  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  const cacheKey = activeProjectId || '__default__';

  // Existing schemaSQL (from project store)
  const existingSchemaSQL = isBackendMode
    ? schemaMetadataToSQL(backendSchema)
    : (currentProject?.schemaSQL ?? '');

  // Schema files list — restored from memory cache (fast), then async-loaded from IndexedDB
  const [schemaFiles, setSchemaFilesState] = useState<SchemaFile[]>(() => {
    const cached = schemaFilesCache.get(cacheKey);
    if (cached && cached.length > 0) return cached;
    // Don't create fallback here — let useEffect handle IndexedDB loading first
    return [];
  });
  const [activeFileId, setActiveFileIdState] = useState<string | null>(
    () => activeFileIdCache.get(cacheKey) ?? null
  );
  const [expandedFolders, setExpandedFoldersState] = useState<Set<string>>(
    () => expandedFoldersCache.get(cacheKey) ?? new Set()
  );

  // On mount or project switch: restore from memory cache, then async from IndexedDB
  const [, setDbLoaded] = useState(false);

  // Sync merged schema SQL to project store whenever files are loaded/restored
  const syncSchemaToProject = useCallback(
    (files: SchemaFile[]) => {
      if (!isBackendMode && activeProjectId && files.length > 0) {
        const merged = files.map((f) => `-- File: ${f.path}\n${f.content}`).join('\n\n');
        updateSchemaSQL(activeProjectId, merged);
      }
    },
    [isBackendMode, activeProjectId, updateSchemaSQL]
  );

  useEffect(() => {
    // Restore from memory cache first (fast, handles sidebar switches)
    const cachedFiles = schemaFilesCache.get(cacheKey);
    if (cachedFiles && cachedFiles.length > 0) {
      setSchemaFilesState(cachedFiles);
      setActiveFileIdState(activeFileIdCache.get(cacheKey) ?? null);
      setExpandedFoldersState(expandedFoldersCache.get(cacheKey) ?? new Set());
      syncSchemaToProject(cachedFiles);
      setDbLoaded(true);
      return;
    }

    // No memory cache — clear state immediately to avoid showing stale data from previous project
    setSchemaFilesState([]);
    setActiveFileIdState(null);
    setExpandedFoldersState(new Set());
    setDbLoaded(false);

    // Then try IndexedDB
    let cancelled = false;
    loadSchemaFiles(cacheKey).then((files) => {
      if (cancelled) return;
      if (files.length > 0) {
        schemaFilesCache.set(cacheKey, files);
        setSchemaFilesState(files);
        syncSchemaToProject(files);
      } else if (existingSchemaSQL.trim()) {
        // Last resort fallback: create from schemaSQL stored in project
        const initial = [
          {
            id: genId(),
            name: 'schema.sql',
            path: 'schema.sql',
            content: existingSchemaSQL,
          },
        ];
        schemaFilesCache.set(cacheKey, initial);
        setSchemaFilesState(initial);
        // No need to sync — existingSchemaSQL is already in project store
      }
      setDbLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [cacheKey, existingSchemaSQL, syncSchemaToProject]);

  // Flush pending schema saves on page unload
  useEffect(() => {
    const handleBeforeUnload = () => {
      const timer = schemaSaveTimers.get(cacheKey);
      if (timer) {
        clearTimeout(timer);
        schemaSaveTimers.delete(cacheKey);
        const cached = schemaFilesCache.get(cacheKey);
        if (cached) {
          saveSchemaFiles(cacheKey, cached);
        }
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [cacheKey]);

  // Wrappers that update memory cache + trigger debounced DB save + auto-save merged SQL
  const prevMergedRef = useRef<string>('');
  const setSchemaFiles = useCallback(
    (updater: SchemaFile[] | ((prev: SchemaFile[]) => SchemaFile[])) => {
      setSchemaFilesState((prev) => {
        const next = typeof updater === 'function' ? updater(prev) : updater;
        schemaFilesCache.set(cacheKey, next);
        debouncedSaveSchemaFiles(cacheKey, next);
        // Auto-save merged SQL to project store (skip files with empty content — lazy-loaded)
        // Only update if merged content actually changed to avoid triggering unnecessary re-analysis
        if (!isBackendMode && activeProjectId) {
          const filesWithContent = next.filter((f) => f.content);
          if (filesWithContent.length > 0) {
            const merged = filesWithContent
              .map((f) => `-- File: ${f.path}\n${f.content}`)
              .join('\n\n');
            if (merged !== prevMergedRef.current) {
              prevMergedRef.current = merged;
              updateSchemaSQL(activeProjectId, merged);
            }
          }
        }
        return next;
      });
    },
    [cacheKey, isBackendMode, activeProjectId, updateSchemaSQL]
  );

  const setActiveFileId = useCallback(
    (updater: string | null | ((prev: string | null) => string | null)) => {
      setActiveFileIdState((prev) => {
        const next = typeof updater === 'function' ? updater(prev) : updater;
        activeFileIdCache.set(cacheKey, next);
        return next;
      });
    },
    [cacheKey]
  );

  const setExpandedFolders = useCallback(
    (updater: Set<string> | ((prev: Set<string>) => Set<string>)) => {
      setExpandedFoldersState((prev) => {
        const next = typeof updater === 'function' ? updater(prev) : updater;
        expandedFoldersCache.set(cacheKey, next);
        return next;
      });
    },
    [cacheKey]
  );

  // Highlight span from search results
  const [schemaHighlightSpan, setSchemaHighlightSpan] = useState<{
    start: number;
    end: number;
  } | null>(null);

  // Wrapper to clear search highlight when manually selecting a file
  const handleSelectFile = useCallback(
    (id: string | null | ((prev: string | null) => string | null)) => {
      setSchemaHighlightSpan(null);
      setActiveFileId(id);
    },
    [setActiveFileId]
  );

  // Listen for schema file selection events from SidebarSearch
  useEffect(() => {
    return onSchemaFileSelect((payload) => {
      // Find the file and expand its parent folders
      const file = schemaFiles.find((f) => f.id === payload.fileId);
      if (file) {
        const parts = file.path.split('/').filter(Boolean);
        if (parts.length > 1) {
          const pathsToExpand: string[] = [];
          for (let i = 1; i < parts.length; i++) {
            pathsToExpand.push(parts.slice(0, i).join('/'));
          }
          setExpandedFolders((prev) => new Set([...prev, ...pathsToExpand]));
        }
        setActiveFileId(payload.fileId);
        setSchemaHighlightSpan(payload.span ?? null);
      }
    });
  }, [schemaFiles, setExpandedFolders, setActiveFileId]);

  const [uploadProgress, setUploadProgress] = useState<{
    total: number;
    loaded: number;
    skipped: number;
    done: boolean;
  } | null>(null);
  const [lineWrapping, setLineWrapping] = useState(true);
  const [treePanelWidth, setTreePanelWidth] = useState(280);
  const [isResizing, setIsResizing] = useState(false);
  const [isCreatingFile, setIsCreatingFile] = useState(false);
  const [newFileName, setNewFileName] = useState('');
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [selectedFileIds, setSelectedFileIds] = useState<Set<string>>(new Set());
  const [confirmBatchDelete, setConfirmBatchDelete] = useState(false);
  const [search, setSearch] = useState('');
  // Track the currently focused folder path (set by clicking a folder or selecting a file inside one)
  const [activeFolderPath, setActiveFolderPath] = useState<string>('');
  const folderNameInputRef = useRef<HTMLInputElement>(null);
  const fileNameInputRef = useRef<HTMLInputElement>(null);
  const treeContentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isCreatingFolder && folderNameInputRef.current) {
      setTimeout(() => folderNameInputRef.current?.focus(), 0);
    }
  }, [isCreatingFolder]);

  useEffect(() => {
    if (isCreatingFile && fileNameInputRef.current) {
      setTimeout(() => fileNameInputRef.current?.focus(), 0);
    }
  }, [isCreatingFile]);

  // Active file content for editor
  const activeFile = useMemo(
    () => schemaFiles.find((f) => f.id === activeFileId),
    [schemaFiles, activeFileId]
  );

  // Build tree (filtered by search)
  const filteredFiles = useMemo(() => {
    if (!search.trim()) return schemaFiles;
    const q = search.toLowerCase();
    return schemaFiles.filter(
      (f) => f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q)
    );
  }, [schemaFiles, search]);
  const tree = useMemo(() => buildTree(filteredFiles), [filteredFiles]);
  const sortedRootChildren = useMemo(() => sortNodes(Array.from(tree.children.values())), [tree]);

  const handleToggleFolder = useCallback((path: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  // Auto-expand folders when searching, collapse when not searching
  useEffect(() => {
    if (search.trim()) {
      // Expand all parent folders of matched files
      const allPaths = new Set<string>();
      for (const f of filteredFiles) {
        const parts = f.path.split('/');
        for (let i = 1; i < parts.length; i++) {
          allPaths.add(parts.slice(0, i).join('/'));
        }
      }
      setExpandedFolders(allPaths);
    } else {
      // No search — collapse all
      setExpandedFolders(new Set());
    }
  }, [filteredFiles, search, setExpandedFolders]);

  useEffect(() => {
    if (!onContentWidthChange || !treeContentRef.current || filteredFiles.length === 0) return;
    const raf = requestAnimationFrame(() => {
      onContentWidthChange(treeContentRef.current?.scrollWidth ?? 0);
    });
    return () => cancelAnimationFrame(raf);
  }, [expandedFolders, filteredFiles, onContentWidthChange, search]);

  // Resize handler for tree/detail split
  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsResizing(true);
      const startX = e.clientX;
      const startWidth = treePanelWidth;

      const handleMouseMove = (e: MouseEvent) => {
        const deltaX = e.clientX - startX;
        setTreePanelWidth(Math.max(220, Math.min(520, startWidth + deltaX)));
      };

      const handleMouseUp = () => {
        setIsResizing(false);
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };

      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    },
    [treePanelWidth]
  );

  // Select all / deselect all
  const allSelected = schemaFiles.length > 0 && selectedFileIds.size === schemaFiles.length;
  const handleSelectAll = useCallback(() => {
    if (allSelected) {
      setSelectedFileIds(new Set());
    } else {
      setSelectedFileIds(new Set(schemaFiles.map((f) => f.id)));
    }
  }, [allSelected, schemaFiles]);

  // Determine current parent folder: prefer explicitly selected folder, else derive from active file
  const activeParentFolder = useMemo(() => {
    if (activeFolderPath) return activeFolderPath;
    if (!activeFileId) return '';
    const file = schemaFiles.find((f) => f.id === activeFileId);
    if (!file) return '';
    const parts = file.path.split('/');
    if (parts.length <= 1) return ''; // file is at root
    return parts.slice(0, -1).join('/');
  }, [activeFolderPath, activeFileId, schemaFiles]);

  // Create a new folder with an empty placeholder file inside (supports nesting)
  const handleCreateFolder = useCallback(() => {
    const trimmed = newFolderName.trim();
    if (!trimmed) return;
    const folderPath = activeParentFolder ? `${activeParentFolder}/${trimmed}` : trimmed;
    const filePath = `${folderPath}/new_schema.sql`;
    // Check for duplicate path
    const existingPaths = new Set(schemaFiles.map((f) => f.path));
    if (existingPaths.has(filePath)) {
      toast.info(t('schemaEditor.duplicateFile'));
      return;
    }
    const newFile: SchemaFile = {
      id: genId(),
      name: 'new_schema.sql',
      path: filePath,
      content: '',
    };
    setSchemaFiles((prev) => [...prev, newFile]);
    // Expand all ancestor folders + the new folder itself
    const parts = folderPath.split('/');
    const pathsToExpand: string[] = [];
    for (let i = 1; i <= parts.length; i++) {
      pathsToExpand.push(parts.slice(0, i).join('/'));
    }
    setExpandedFolders((prev) => new Set([...prev, ...pathsToExpand]));
    setActiveFolderPath(folderPath);
    setActiveFileId(newFile.id);
    setIsCreatingFolder(false);
    setNewFolderName('');
  }, [
    newFolderName,
    activeParentFolder,
    schemaFiles,
    t,
    setSchemaFiles,
    setExpandedFolders,
    setActiveFileId,
  ]);

  // Toggle selection for file IDs
  const handleToggleSelection = useCallback((ids: string[], select: boolean) => {
    setSelectedFileIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (select) next.add(id);
        else next.delete(id);
      }
      return next;
    });
    setConfirmBatchDelete(false);
  }, []);

  // Batch delete selected files
  const handleBatchDeleteClick = useCallback(() => {
    if (selectedFileIds.size === 0) return;
    setConfirmBatchDelete(true);
  }, [selectedFileIds]);

  const handleConfirmBatchDelete = useCallback(() => {
    if (selectedFileIds.size === 0) return;
    setSchemaFiles((prev) => prev.filter((f) => !selectedFileIds.has(f.id)));
    if (activeFileId && selectedFileIds.has(activeFileId)) {
      const remaining = schemaFiles.filter((f) => !selectedFileIds.has(f.id));
      setActiveFileId(remaining[0]?.id ?? null);
    }
    setSelectedFileIds(new Set());
    setConfirmBatchDelete(false);
  }, [selectedFileIds, activeFileId, schemaFiles, setSchemaFiles, setActiveFileId]);

  // Create a new empty schema file (in current folder context)
  const handleCreateFile = useCallback(() => {
    const inputName = newFileName.trim() || 'new_schema.sql';
    // Ensure .sql extension if none provided
    const name = /\.\w+$/.test(inputName) ? inputName : `${inputName}.sql`;
    const existingPaths = new Set(schemaFiles.map((f) => f.path));
    const buildPath = (n: string) => (activeParentFolder ? `${activeParentFolder}/${n}` : n);
    let finalName = name;
    let i = 1;
    while (existingPaths.has(buildPath(finalName))) {
      const base = name.replace(/(\.\w+)$/, '');
      const ext = name.match(/(\.\w+)$/)?.[1] || '.sql';
      finalName = `${base}_${i}${ext}`;
      i++;
    }
    const filePath = buildPath(finalName);
    const newFile: SchemaFile = {
      id: genId(),
      name: finalName,
      path: filePath,
      content: '',
    };
    setSchemaFiles((prev) => [...prev, newFile]);
    // Expand parent folders if needed
    if (activeParentFolder) {
      const parts = activeParentFolder.split('/');
      const pathsToExpand: string[] = [];
      for (let j = 1; j <= parts.length; j++) {
        pathsToExpand.push(parts.slice(0, j).join('/'));
      }
      setExpandedFolders((prev) => new Set([...prev, ...pathsToExpand]));
    }
    setActiveFileId(newFile.id);
    setIsCreatingFile(false);
    setNewFileName('');
  }, [
    newFileName,
    schemaFiles,
    activeParentFolder,
    setSchemaFiles,
    setExpandedFolders,
    setActiveFileId,
  ]);

  // Quick-create a file via double-click (in specified folder or root)
  const handleDoubleClickCreateFile = useCallback(
    (folderPath: string) => {
      if (isReadOnly) return;
      const existingPaths = new Set(schemaFiles.map((f) => f.path));
      const buildPath = (n: string) => (folderPath ? `${folderPath}/${n}` : n);
      let name = 'new_schema.sql';
      let i = 1;
      while (existingPaths.has(buildPath(name))) {
        name = `new_schema_${i}.sql`;
        i++;
      }
      const filePath = buildPath(name);
      const newFile: SchemaFile = { id: genId(), name, path: filePath, content: '' };
      setSchemaFiles((prev) => [...prev, newFile]);
      if (folderPath) {
        const parts = folderPath.split('/');
        const pathsToExpand: string[] = [];
        for (let j = 1; j <= parts.length; j++) {
          pathsToExpand.push(parts.slice(0, j).join('/'));
        }
        setExpandedFolders((prev) => new Set([...prev, ...pathsToExpand]));
      }
      setActiveFolderPath(folderPath);
      setActiveFileId(newFile.id);
    },
    [isReadOnly, schemaFiles, setSchemaFiles, setExpandedFolders, setActiveFileId]
  );

  // Create a sub-folder inside the specified folder (with a placeholder file)
  const handleCreateFolderInFolder = useCallback(
    (parentPath: string) => {
      if (isReadOnly) return;
      const existingPaths = new Set(schemaFiles.map((f) => f.path));
      let folderName = 'new_folder';
      let i = 1;
      const buildFolderFile = (fn: string) => `${parentPath}/${fn}/new_schema.sql`;
      while (existingPaths.has(buildFolderFile(folderName))) {
        folderName = `new_folder_${i}`;
        i++;
      }
      const filePath = buildFolderFile(folderName);
      const newFile: SchemaFile = {
        id: genId(),
        name: 'new_schema.sql',
        path: filePath,
        content: '',
      };
      setSchemaFiles((prev) => [...prev, newFile]);
      // Expand all ancestors + parent + new folder
      const newFolderPath = `${parentPath}/${folderName}`;
      const parts = newFolderPath.split('/');
      const pathsToExpand: string[] = [];
      for (let j = 1; j <= parts.length; j++) {
        pathsToExpand.push(parts.slice(0, j).join('/'));
      }
      setExpandedFolders((prev) => new Set([...prev, ...pathsToExpand]));
      setActiveFolderPath(newFolderPath);
      setActiveFileId(newFile.id);
    },
    [isReadOnly, schemaFiles, setSchemaFiles, setExpandedFolders, setActiveFileId]
  );

  // Edit active file content
  const handleEditorChange = useCallback(
    (value: string) => {
      if (!activeFileId) return;
      setSchemaFiles((prev) =>
        prev.map((f) => (f.id === activeFileId ? { ...f, content: value } : f))
      );
    },
    [activeFileId, setSchemaFiles]
  );

  // Upload single file(s)
  const handleFileUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (!files || files.length === 0) return;
      const newFiles: SchemaFile[] = [];
      for (const file of Array.from(files)) {
        const content = await file.text();
        newFiles.push({ id: genId(), name: file.name, path: file.name, content });
      }
      // Deduplicate: update existing files by path, add new ones
      setSchemaFiles((prev) => {
        const existingPaths = new Map(prev.map((f) => [f.path, f]));
        let added = 0;
        let updated = 0;
        for (const nf of newFiles) {
          if (existingPaths.has(nf.path)) {
            const existing = existingPaths.get(nf.path)!;
            existing.content = nf.content;
            updated++;
          } else {
            existingPaths.set(nf.path, nf);
            added++;
          }
        }
        if (updated > 0) {
          toast.info(t('schemaEditor.deduped', { added, updated }));
        }
        return Array.from(existingPaths.values());
      });
      if (newFiles.length > 0 && !activeFileId) {
        setActiveFileId(newFiles[0].id);
      }
      toast.success(t('schemaEditor.imported', { name: `${newFiles.length} file(s)` }));
      if (fileInputRef.current) fileInputRef.current.value = '';
    },
    [activeFileId, t, setSchemaFiles, setActiveFileId]
  );

  // Upload folder with progress
  const handleFolderUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (!files || files.length === 0) return;

      const allFiles = Array.from(files);
      const totalScanned = allFiles.length;

      setUploadProgress({ total: totalScanned, loaded: 0, skipped: 0, done: false });

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
      setUploadProgress({ total: importTotal, loaded: 0, skipped, done: false });

      if (importTotal === 0) {
        setUploadProgress({ total: 0, loaded: 0, skipped, done: true });
        setTimeout(() => setUploadProgress(null), 1500);
        toast.info(t('schemaEditor.noSupportedFiles'));
        if (folderInputRef.current) folderInputRef.current.value = '';
        return;
      }

      // Phase 2: Create entries with empty content — instant UI display
      const newFiles: SchemaFile[] = supportedFiles.map((file) => {
        const relativePath =
          (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
        return { id: genId(), name: file.name, path: relativePath, content: '' };
      });

      // Compute expand paths
      const expandPaths = new Set<string>();
      for (const nf of newFiles) {
        const parts = nf.path.split('/').filter(Boolean);
        for (let j = 1; j < parts.length; j++) {
          expandPaths.add(parts.slice(0, j).join('/'));
        }
      }

      // Show files in tree immediately (empty content)
      setSchemaFiles((prev) => {
        const existingPaths = new Map(prev.map((f) => [f.path, f]));
        for (const nf of newFiles) {
          existingPaths.set(nf.path, nf);
        }
        return Array.from(existingPaths.values());
      });
      setExpandedFolders((prev) => new Set([...prev, ...expandPaths]));
      if (!activeFileId && newFiles.length > 0) {
        setActiveFileId(newFiles[0].id);
      }

      // Phase 3: Read content in background batches
      const BATCH = 100;
      for (let i = 0; i < supportedFiles.length; i += BATCH) {
        const batchFiles = supportedFiles.slice(i, i + BATCH);
        const batchEntries = newFiles.slice(i, i + BATCH);

        const contents = await Promise.all(batchFiles.map((f) => f.text()));

        // Update content in-place and refresh state
        for (let j = 0; j < batchEntries.length; j++) {
          batchEntries[j].content = contents[j];
        }
        // Trigger React re-render with updated content
        setSchemaFiles((prev) => [...prev]);

        setUploadProgress({
          total: importTotal,
          loaded: Math.min(i + BATCH, importTotal),
          skipped,
          done: false,
        });
      }

      setUploadProgress({ total: importTotal, loaded: importTotal, skipped, done: true });
      setTimeout(() => setUploadProgress(null), 1500);
      if (folderInputRef.current) folderInputRef.current.value = '';
    },
    [activeFileId, t, setSchemaFiles, setExpandedFolders, setActiveFileId]
  );

  // Delete a file
  const handleDeleteFile = useCallback(
    (fileId: string) => {
      setSchemaFiles((prev) => prev.filter((f) => f.id !== fileId));
      if (activeFileId === fileId) {
        setActiveFileId(() => {
          const remaining = schemaFiles.filter((f) => f.id !== fileId);
          return remaining[0]?.id ?? null;
        });
      }
    },
    [activeFileId, schemaFiles, setSchemaFiles, setActiveFileId]
  );

  // Rename a schema file
  const handleRenameFile = useCallback(
    (fileId: string, newName: string) => {
      setSchemaFiles((prev) =>
        prev.map((f) => {
          if (f.id !== fileId) return f;
          const lastSlash = f.path.lastIndexOf('/');
          const newPath =
            lastSlash === -1 ? newName : `${f.path.slice(0, lastSlash + 1)}${newName}`;
          return { ...f, name: newName, path: newPath };
        })
      );
    },
    [setSchemaFiles]
  );

  // Rename a schema folder (update all files under it)
  const handleRenameFolder = useCallback(
    (oldFolderPath: string, newFolderName: string) => {
      const lastSlash = oldFolderPath.lastIndexOf('/');
      const newFolderPath =
        lastSlash === -1
          ? newFolderName
          : `${oldFolderPath.slice(0, lastSlash + 1)}${newFolderName}`;
      const prefix = `${oldFolderPath}/`;
      setSchemaFiles((prev) =>
        prev.map((f) => {
          if (f.path === oldFolderPath || f.path.startsWith(prefix)) {
            const newPath = newFolderPath + f.path.slice(oldFolderPath.length);
            const newFileName = newPath.split('/').pop() || f.name;
            return { ...f, path: newPath, name: newFileName };
          }
          return f;
        })
      );
      // Update expanded folders
      setExpandedFolders((prev) => {
        const next = new Set<string>();
        for (const p of prev) {
          if (p === oldFolderPath) {
            next.add(newFolderPath);
          } else if (p.startsWith(prefix)) {
            next.add(newFolderPath + p.slice(oldFolderPath.length));
          } else {
            next.add(p);
          }
        }
        return next;
      });
    },
    [setSchemaFiles, setExpandedFolders]
  );

  const ctxValue: SchemaCtx = {
    schemaFiles,
    activeFileId,
    activeFile,
    expandedFolders,
    selectedFileIds,
    activeFolderPath,
    activeParentFolder,
    search,
    isReadOnly,
    isBackendMode,
    tree,
    sortedRootChildren,
    filteredFiles,
    allSelected,
    isCreatingFile,
    isCreatingFolder,
    newFileName,
    newFolderName,
    confirmBatchDelete,
    schemaHighlightSpan,
    lineWrapping,
    treePanelWidth,
    isResizing,
    isDark,
    uploadProgress,
    fileInputRef,
    folderInputRef,
    fileNameInputRef,
    folderNameInputRef,
    treeContentRef,
    setSearch,
    setNewFileName,
    setNewFolderName,
    setIsCreatingFile,
    setIsCreatingFolder,
    setConfirmBatchDelete,
    setLineWrapping,
    setTreePanelWidth,
    setIsResizing,
    setActiveFolderPath,
    handleSelectFile,
    handleToggleFolder,
    handleEditorChange,
    handleFileUpload,
    handleFolderUpload,
    handleDeleteFile,
    handleRenameFile,
    handleRenameFolder,
    handleCreateFile,
    handleCreateFolder,
    handleDoubleClickCreateFile,
    handleCreateFolderInFolder,
    handleSelectAll,
    handleBatchDeleteClick,
    handleConfirmBatchDelete,
    handleToggleSelection,
    handleResizeStart,
    setActiveFileId,
  };

  return (
    <SchemaContext.Provider value={ctxValue}>
      {/* Hidden file inputs — rendered once at provider level */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".sql,.hql,.ddl,.txt"
        multiple
        className="hidden"
        onChange={handleFileUpload}
      />
      <input
        ref={folderInputRef}
        type="file"
        className="hidden"
        onChange={handleFolderUpload}
        {...({ webkitdirectory: '', directory: '' } as React.InputHTMLAttributes<HTMLInputElement>)}
      />
      {children}
    </SchemaContext.Provider>
  );
}

// --- Tree panel (left sidebar) ---
export function SidebarSchemaTreePanel() {
  const { t } = useTranslation();
  const ctx = useSchemaCtx();
  const {
    schemaFiles, selectedFileIds, confirmBatchDelete, isReadOnly,
    allSelected, isCreatingFile, isCreatingFolder, newFileName, newFolderName,
    activeParentFolder, search, activeFolderPath, activeFileId,
    sortedRootChildren, expandedFolders,
    fileNameInputRef, folderNameInputRef, treeContentRef,
  } = ctx;
  const {
    setSearch, setNewFileName, setNewFolderName, setIsCreatingFile, setIsCreatingFolder,
    setConfirmBatchDelete, handleSelectFile, handleDeleteFile, handleRenameFile,
    setActiveFolderPath, handleToggleFolder, handleDoubleClickCreateFile,
    handleCreateFolderInFolder, handleRenameFolder, handleToggleSelection,
    handleSelectAll, handleBatchDeleteClick, handleConfirmBatchDelete,
    handleCreateFile, handleCreateFolder,
  } = ctx;
  const { fileInputRef, folderInputRef, uploadProgress } = ctx;

  return (
    <div className="flex flex-col h-full bg-background relative">

      {/* Header toolbar */}
      <div className="flex items-center justify-between px-3 py-2 border-b shrink-0">
        <div className="flex items-center gap-1">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Schema
          </span>
          {schemaFiles.length > 0 && (
            <span className="text-xs text-muted-foreground">({schemaFiles.length})</span>
          )}
          {selectedFileIds.size > 0 && (
            <span className="text-xs text-muted-foreground">
              · {t('sidebar.selectedCount', { count: selectedFileIds.size })}
            </span>
          )}
        </div>
        <TooltipProvider delayDuration={300}>
          <div className="flex items-center gap-0.5">
            {!isReadOnly && (
              <>
                {/* Delete selected */}
                {selectedFileIds.size > 0 &&
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
                {schemaFiles.length > 0 && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        onClick={handleSelectAll}
                      >
                        <CheckSquare
                          className={`h-3.5 w-3.5 ${allSelected ? 'text-primary' : ''}`}
                        />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      <p>{allSelected ? t('sidebar.deselectAll') : t('sidebar.selectAll')}</p>
                    </TooltipContent>
                  </Tooltip>
                )}
                {/* New file */}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      onClick={() => {
                        setIsCreatingFile(true);
                        setIsCreatingFolder(false);
                      }}
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    <p>{t('common.new')}</p>
                  </TooltipContent>
                </Tooltip>
                {/* New folder */}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      onClick={() => {
                        setIsCreatingFolder(true);
                        setIsCreatingFile(false);
                      }}
                    >
                      <FolderPlus className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    <p>{t('sidebar.newFolder')}</p>
                  </TooltipContent>
                </Tooltip>
                {/* Upload files */}
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
                    <p>{t('schemaEditor.import')}</p>
                  </TooltipContent>
                </Tooltip>
                {/* Upload folder */}
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
                    <p>{t('schemaEditor.importFolder')}</p>
                  </TooltipContent>
                </Tooltip>
              </>
            )}
          </div>
        </TooltipProvider>
      </div>

      {/* Search */}
      {schemaFiles.length > 0 && (
        <div className="px-2 py-1.5 border-b shrink-0">
          <div className="relative">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('fileSelector.searchFiles')}
              className="h-7 text-xs pl-7"
            />
            <span className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none">
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.3-4.3" />
              </svg>
            </span>
            {search && (
              <button
                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground p-0.5"
                onClick={() => setSearch('')}
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        </div>
      )}

      {/* New folder input */}
      {isCreatingFolder && (
        <div className="px-2 py-1.5 border-b shrink-0">
          {activeParentFolder && (
            <div className="text-[10px] text-muted-foreground/70 mb-1 truncate pl-6">
              {activeParentFolder}/
            </div>
          )}
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

      {/* New file input */}
      {isCreatingFile && (
        <div className="px-2 py-1.5 border-b shrink-0">
          {activeParentFolder && (
            <div className="text-[10px] text-muted-foreground/70 mb-1 truncate pl-6">
              {activeParentFolder}/
            </div>
          )}
          <div className="flex items-center gap-1.5">
            <FileCode className="h-4 w-4 text-blue-500 shrink-0" />
            <Input
              ref={fileNameInputRef}
              value={newFileName}
              onChange={(e) => setNewFileName(e.target.value)}
              placeholder="new_schema.sql"
              className="h-7 text-xs flex-1"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleCreateFile();
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setIsCreatingFile(false);
                  setNewFileName('');
                }
              }}
              onBlur={() => {
                if (!newFileName.trim()) {
                  setIsCreatingFile(false);
                  setNewFileName('');
                }
              }}
            />
          </div>
        </div>
      )}

      {/* Tree — fills the sidebar panel */}
      <div className="flex-1 min-h-0 overflow-auto bg-background">
        {schemaFiles.length === 0 ? (
          <div className="px-3 py-4 text-xs text-muted-foreground text-center">
            {ctx.isBackendMode ? t('schemaEditor.viewDesc') : t('schemaEditor.emptyHint')}
          </div>
        ) : (
          <div ref={treeContentRef} className="py-1 min-w-max">
            {sortedRootChildren.map((child) =>
              child.file ? (
                <SchemaFileNode
                  key={child.file.id}
                  node={child}
                  depth={0}
                  activeFileId={activeFileId}
                  onSelect={handleSelectFile}
                  onDelete={handleDeleteFile}
                  onRenameFile={handleRenameFile}
                  onSelectFolder={setActiveFolderPath}
                  selectedFileIds={selectedFileIds}
                  onToggleSelection={handleToggleSelection}
                />
              ) : (
                <SchemaFolderNode
                  key={child.path}
                  node={child}
                  depth={0}
                  activeFileId={activeFileId}
                  activeFolderPath={activeFolderPath}
                  onSelect={handleSelectFile}
                  onDelete={handleDeleteFile}
                  expandedFolders={expandedFolders}
                  onToggleFolder={handleToggleFolder}
                  onSelectFolder={setActiveFolderPath}
                  onDoubleClickFolder={handleDoubleClickCreateFile}
                  onCreateFolderInFolder={handleCreateFolderInFolder}
                  onRenameFolder={handleRenameFolder}
                  onRenameFile={handleRenameFile}
                  selectedFileIds={selectedFileIds}
                  onToggleSelection={handleToggleSelection}
                />
              )
            )}
          </div>
        )}
      </div>

      {/* Upload progress overlay */}
      {uploadProgress && (
        <ProgressOverlay
          visible={Boolean(uploadProgress)}
          title={uploadProgress.done ? t('sidebar.uploadDone') : t('sidebar.uploading')}
          progress={
            uploadProgress.total > 0 ? (uploadProgress.loaded / uploadProgress.total) * 100 : 0
          }
          loaded={uploadProgress.loaded}
          total={uploadProgress.total}
          done={uploadProgress.done}
        />
      )}
    </div>
  );
}

// --- Editor panel (right side) ---
export function SidebarSchemaEditorPanel() {
  const { t } = useTranslation();
  const ctx = useSchemaCtx();
  const {
    activeFile, isReadOnly, isDark, lineWrapping, schemaHighlightSpan,
    handleEditorChange, setLineWrapping, setActiveFileId,
  } = ctx;

  if (!activeFile) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted-foreground bg-background">
        <div className="text-center">
          <FileCode className="h-10 w-10 mx-auto mb-2 opacity-30" />
          <p>{t('schemaEditor.selectFile')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-background">
      <div className="flex items-center justify-between px-3 py-2 border-b h-[44px] shrink-0 bg-muted/30 overflow-hidden gap-2">
        <div className="flex items-center gap-1.5 min-w-0 flex-1 text-sm text-muted-foreground">
          <FileCode className="h-4 w-4 shrink-0" />
          <span className="truncate font-medium text-foreground">{activeFile.path}</span>
        </div>
        <TooltipProvider delayDuration={300}>
          <div className="flex items-center gap-2 shrink-0">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className={`h-7 w-7 ${lineWrapping ? 'bg-muted' : ''}`}
                  onClick={() => setLineWrapping((prev) => !prev)}
                >
                  <WrapText className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <p>{lineWrapping ? t('schemaEditor.nowrap') : t('schemaEditor.wrap')}</p>
              </TooltipContent>
            </Tooltip>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => setActiveFileId(null)}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        </TooltipProvider>
      </div>
      <div className="flex-1 min-h-0 overflow-hidden">
        <SqlView
          value={activeFile.content}
          onChange={isReadOnly ? undefined : handleEditorChange}
          className="h-full text-sm"
          editable={!isReadOnly}
          isDark={isDark}
          lineWrapping={lineWrapping}
          highlightedSpan={schemaHighlightSpan}
        />
      </div>
    </div>
  );
}

// --- Legacy wrapper: full self-contained layout (tree + editor side by side) ---
export function SidebarSchema({ onContentWidthChange }: SidebarSchemaProps) {
  return (
    <SchemaProvider onContentWidthChange={onContentWidthChange}>
      <div className="flex h-full">
        <div className="flex-1 min-w-0">
          <SidebarSchemaTreePanel />
        </div>
        <div className="flex-1 min-w-0 border-l">
          <SidebarSchemaEditorPanel />
        </div>
      </div>
    </SchemaProvider>
  );
}
