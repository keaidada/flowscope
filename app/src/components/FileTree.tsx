import { useState, useMemo, useEffect, useRef, memo, useDeferredValue } from 'react';
import {
  ChevronRight,
  ChevronDown,
  Folder,
  FolderOpen,
  FolderPlus,
  FileCode,
  Pencil,
  Trash2,
  Plus,
  Scissors,
  Upload,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { SpBadge } from './SpBadge';
import type { ProjectFile } from '@/lib/project-store';

/** Max children to render at once in a folder before showing "load more" */
const FOLDER_RENDER_LIMIT = 50;

/** Format byte size to human-readable string (like `ls -h`) */
function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'K', 'M', 'G'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  // Show 1 decimal for values < 10, otherwise integer
  return value < 10 && i > 0 ? `${value.toFixed(1)}${units[i]}` : `${Math.round(value)}${units[i]}`;
}

interface FileTreeProps {
  files: ProjectFile[];
  activeFileId: string | null;
  selectedFileIds: string[];
  showCheckboxes: boolean;
  deletingFileId: string | null;
  renamingFileId: string | null;
  renameValue: string;
  focusedFileId?: string | null;
  /** Increments each time "locate" button is clicked in the editor */
  revealCnt?: number;
  onSelectFile: (fileId: string) => void;
  onToggleSelection: (e: React.MouseEvent, fileId: string) => void;
  /** Toggle selection via keyboard (Space key) */
  onToggleSelectionKeyboard?: (fileId: string) => void;
  /** Toggle all files under a folder path */
  onToggleFolderSelection?: (fileIds: string[], select: boolean) => void;
  onStartRename: (fileId: string, currentName: string) => void;
  onConfirmRename: () => void;
  onCancelRename: () => void;
  onRenameValueChange: (value: string) => void;
  onDeleteClick: (e: React.MouseEvent, fileId: string) => void;
  onCancelDelete: () => void;
  isFileIncludedInAnalysis: (fileId: string) => boolean;
  /** Returns true if the file already has lineage analysis results */
  hasLineageFile: (filePath: string) => boolean;
  canDeleteFiles: boolean;
  renameInputRef: React.RefObject<HTMLInputElement | null>;
  /** When true, hides rename/delete buttons (backend mode) */
  isReadOnly?: boolean;
  /** Called when user clicks the "+" button on a folder row — receives the folder path */
  onCreateFileInFolder?: (folderPath: string) => void;
  /** Called when user clicks the upload button on a folder row — receives the folder path */
  onUploadToFolder?: (folderPath: string) => void;
  /** Called when user clicks the folder+ button on a folder row — receives the folder path */
  onCreateFolderInFolder?: (folderPath: string) => void;
  /** Called when user confirms renaming a folder */
  onRenameFolder?: (oldFolderPath: string, newFolderName: string) => void;
  /** Called when user clicks the delete button on a folder */
  onDeleteFolder?: (folderPath: string) => void;
  /** Called when user clicks the convert procedure button on a folder */
  onConvertProcedureInFolder?: (folderPath: string) => void;
  /** Current search query — when non-empty, auto-expand folders containing matched files */
  searchQuery?: string;
  /** Reports the rendered tree content width so the sidebar can auto-resize */
  onContentWidthChange?: (widthPx: number) => void;
}

interface TreeNode {
  name: string;
  path: string;
  file?: ProjectFile;
  children: Map<string, TreeNode>;
}

function buildFileTree(files: ProjectFile[]): TreeNode {
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
        // Update the existing node with file info
        const node = current.children.get(part)!;
        node.file = file;
      }

      current = current.children.get(part)!;
    }
  }

  return root;
}

function sortTreeNodes(nodes: TreeNode[]): TreeNode[] {
  return nodes.sort((a, b) => {
    // Folders first, then files
    const aIsFolder = a.children.size > 0 && !a.file;
    const bIsFolder = b.children.size > 0 && !b.file;
    if (aIsFolder && !bIsFolder) return -1;
    if (!aIsFolder && bIsFolder) return 1;
    // Alphabetical within same type
    return a.name.localeCompare(b.name);
  });
}

// Returns files in the order they appear visually in the tree (depth-first traversal)
export function getFilesInTreeOrder(files: ProjectFile[]): ProjectFile[] {
  const tree = buildFileTree(files);
  const result: ProjectFile[] = [];

  function traverse(node: TreeNode) {
    const sortedChildren = sortTreeNodes(Array.from(node.children.values()));
    for (const child of sortedChildren) {
      if (child.file) {
        result.push(child.file);
      }
      if (child.children.size > 0) {
        traverse(child);
      }
    }
  }

  traverse(tree);
  return result;
}

interface FolderNodeProps {
  node: TreeNode;
  depth: number;
  props: FileTreeProps;
  expandedFolders: Set<string>;
  onToggleFolder: (path: string) => void;
  /** Precomputed folder file IDs — avoids per-folder recursive traversal */
  folderFileIdsMap: Map<string, string[]>;
}

/** Recursively collect all file IDs under a tree node */
function collectFileIds(node: TreeNode): string[] {
  const ids: string[] = [];
  for (const child of node.children.values()) {
    if (child.file) {
      ids.push(child.file.id);
    }
    if (child.children.size > 0) {
      ids.push(...collectFileIds(child));
    }
  }
  return ids;
}

/** Count direct files under a tree node (non-recursive) */
function countDirectFiles(node: TreeNode): number {
  let count = 0;
  for (const child of node.children.values()) {
    if (child.file) count++;
  }
  return count;
}

/** Count direct child sub-folders under a tree node */
function countDirectSubFolders(node: TreeNode): number {
  let count = 0;
  for (const child of node.children.values()) {
    if (child.children.size > 0) count++;
  }
  return count;
}

const FolderNode = memo(function FolderNode({
  node,
  depth,
  props,
  expandedFolders,
  onToggleFolder,
  folderFileIdsMap,
}: FolderNodeProps) {
  const isExpanded = expandedFolders.has(node.path);
  const sortedChildren = useMemo(() => sortTreeNodes(Array.from(node.children.values())), [node]);

  const fileCount = useMemo(() => countDirectFiles(node), [node]);

  const lineageCount = useMemo(() => {
    let cnt = 0;
    for (const child of node.children.values()) {
      if (child.file && props.hasLineageFile(child.file.path)) cnt++;
    }
    return cnt;
  }, [node, props.hasLineageFile]);

  const subFolderCount = useMemo(() => countDirectSubFolders(node), [node]);

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
    if (trimmed && trimmed !== node.name && props.onRenameFolder) {
      props.onRenameFolder(node.path, trimmed);
    }
    setIsRenaming(false);
  };

  // Folder selection state — precomputed at tree level, O(1) lookup
  const folderFileIds = useMemo(
    () => (props.showCheckboxes ? (folderFileIdsMap.get(node.path) ?? []) : []),
    [node.path, props.showCheckboxes, folderFileIdsMap]
  );
  const selectedSet = useMemo(() => new Set(props.selectedFileIds), [props.selectedFileIds]);
  const { allSelected, someSelected } = useMemo(() => {
    if (folderFileIds.length === 0) return { allSelected: false, someSelected: false };
    let selectedCount = 0;
    for (const id of folderFileIds) {
      if (selectedSet.has(id)) selectedCount++;
    }
    return {
      allSelected: selectedCount === folderFileIds.length,
      someSelected: selectedCount > 0 && selectedCount < folderFileIds.length,
    };
  }, [folderFileIds, selectedSet]);

  const handleFolderCheckbox = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (props.onToggleFolderSelection) {
      props.onToggleFolderSelection(folderFileIds, !allSelected);
    }
  };

  if (isRenaming) {
    return (
      <div role="treeitem">
        <div
          className="flex items-center gap-1 py-1 px-2"
          style={{ paddingLeft: `${depth * 12 + 8}px` }}
          onClick={(e) => e.stopPropagation()}
        >
          <Folder className="size-4 shrink-0 text-amber-500" />
          <Input
            ref={renameInputRef}
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            className="h-7 flex-1 text-sm"
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
        {isExpanded && (
          <FolderChildren
            sortedChildren={sortedChildren}
            depth={depth}
            props={props}
            expandedFolders={expandedFolders}
            onToggleFolder={onToggleFolder}
            folderFileIdsMap={folderFileIdsMap}
          />
        )}
      </div>
    );
  }

  return (
    <div role="treeitem" aria-expanded={isExpanded}>
      <div
        className={cn(
          'flex items-center gap-1 py-1 px-2 rounded-md cursor-pointer hover:bg-muted/50 group',
          'text-sm text-muted-foreground'
        )}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        onClick={() => onToggleFolder(node.path)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggleFolder(node.path);
          }
        }}
        tabIndex={-1}
        role="button"
        aria-label={`${isExpanded ? 'Collapse' : 'Expand'} folder ${node.name}`}
      >
        {props.showCheckboxes && (
          <Checkbox
            checked={allSelected ? true : someSelected ? 'indeterminate' : false}
            onClick={handleFolderCheckbox}
            className="shrink-0 border-muted-foreground"
          />
        )}
        {isExpanded ? (
          <ChevronDown className="size-4 shrink-0" />
        ) : (
          <ChevronRight className="size-4 shrink-0" />
        )}
        {isExpanded ? (
          <FolderOpen className="size-4 shrink-0 text-amber-500" />
        ) : (
          <Folder className="size-4 shrink-0 text-amber-500" />
        )}
        <span className="whitespace-nowrap">{node.name}</span>
        {fileCount > 0 && (
          <span className="text-[10px] text-muted-foreground shrink-0 mr-1">
            {lineageCount > 0 ? (
              <>
                <span className="text-emerald-500 font-medium">{lineageCount}</span>
                <span className="text-muted-foreground/60">/</span>
                <span>{fileCount}f</span>
              </>
            ) : (
              `(${fileCount}f)`
            )}
          </span>
        )}
        {fileCount === 0 && subFolderCount > 0 && (
          <span className="text-[10px] text-muted-foreground/60 shrink-0 mr-1">
            ({subFolderCount}d)
          </span>
        )}
        {!props.isReadOnly && (
          <div className="opacity-0 group-hover:opacity-100 flex items-center gap-0.5 shrink-0 transition-opacity">
            {props.onCreateFileInFolder && (
              <button
                className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                onClick={(e) => {
                  e.stopPropagation();
                  props.onCreateFileInFolder!(node.path);
                }}
                title="New file"
              >
                <Plus className="size-3" />
              </button>
            )}
            {props.onUploadToFolder && (
              <button
                className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                onClick={(e) => {
                  e.stopPropagation();
                  props.onUploadToFolder!(node.path);
                }}
                title="Upload to this folder"
              >
                <Upload className="size-3" />
              </button>
            )}
            {props.onCreateFolderInFolder && (
              <button
                className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                onClick={(e) => {
                  e.stopPropagation();
                  props.onCreateFolderInFolder!(node.path);
                }}
                title="New folder"
              >
                <FolderPlus className="size-3" />
              </button>
            )}
            {props.onRenameFolder && (
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
            )}
            {props.onDeleteFolder && (
              <button
                className="p-0.5 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive"
                onClick={(e) => {
                  e.stopPropagation();
                  props.onDeleteFolder!(node.path);
                }}
                title="Delete folder"
              >
                <Trash2 className="size-3" />
              </button>
            )}
            {props.onConvertProcedureInFolder && (
              <button
                className="p-0.5 rounded hover:bg-amber-500/20 text-muted-foreground hover:text-amber-500"
                onClick={(e) => {
                  e.stopPropagation();
                  props.onConvertProcedureInFolder!(node.path);
                }}
                title="Convert stored procedures in folder"
              >
                <Scissors className="size-3" />
              </button>
            )}
          </div>
        )}
      </div>
      {isExpanded && (
        <FolderChildren
          sortedChildren={sortedChildren}
          depth={depth}
          props={props}
          expandedFolders={expandedFolders}
          onToggleFolder={onToggleFolder}
          folderFileIdsMap={folderFileIdsMap}
        />
      )}
    </div>
  );
});

/** Flat file list with render limit */
const FlatFileList = memo(function FlatFileList({
  sortedChildren,
  props,
}: {
  sortedChildren: TreeNode[];
  props: FileTreeProps;
}) {
  const [renderLimit, setRenderLimit] = useState(FOLDER_RENDER_LIMIT);
  const rootRef = useRef<HTMLDivElement>(null);
  const visible = sortedChildren.slice(0, renderLimit);
  const remaining = sortedChildren.length - renderLimit;

  useEffect(() => {
    if (!props.onContentWidthChange || !rootRef.current) return;
    const raf = requestAnimationFrame(() => {
      props.onContentWidthChange?.(rootRef.current?.scrollWidth ?? 0);
    });
    return () => cancelAnimationFrame(raf);
  }, [visible, remaining, props.onContentWidthChange]);

  return (
    <div ref={rootRef} className="p-1 min-w-max" role="tree" aria-label="File list">
      {visible.map((node) => (
        <FileNode key={node.file?.id} node={node} depth={0} props={props} />
      ))}
      {remaining > 0 && (
        <div
          className="py-1 px-2 text-xs text-muted-foreground cursor-pointer hover:text-foreground"
          onClick={() => setRenderLimit((prev) => prev + FOLDER_RENDER_LIMIT)}
        >
          +{remaining} more...
        </div>
      )}
    </div>
  );
});

/** Renders folder children with a render limit to avoid blocking the UI */
const FolderChildren = memo(function FolderChildren({
  sortedChildren,
  depth,
  props,
  expandedFolders,
  onToggleFolder,
  folderFileIdsMap,
}: {
  sortedChildren: TreeNode[];
  depth: number;
  props: FileTreeProps;
  expandedFolders: Set<string>;
  onToggleFolder: (path: string) => void;
  folderFileIdsMap: Map<string, string[]>;
}) {
  const [renderLimit, setRenderLimit] = useState(FOLDER_RENDER_LIMIT);
  const visible = sortedChildren.slice(0, renderLimit);
  const remaining = sortedChildren.length - renderLimit;

  return (
    <div role="group">
      {visible.map((child) =>
        child.file ? (
          <FileNode key={child.file.id} node={child} depth={depth + 1} props={props} />
        ) : (
          <FolderNode
            key={child.path}
            node={child}
            depth={depth + 1}
            props={props}
            expandedFolders={expandedFolders}
            onToggleFolder={onToggleFolder}
            folderFileIdsMap={folderFileIdsMap}
          />
        )
      )}
      {remaining > 0 && (
        <div
          className="py-1 px-2 text-xs text-muted-foreground cursor-pointer hover:text-foreground"
          style={{ paddingLeft: `${(depth + 1) * 12 + 8}px` }}
          onClick={() => setRenderLimit((prev) => prev + FOLDER_RENDER_LIMIT)}
        >
          +{remaining} more...
        </div>
      )}
    </div>
  );
});

interface FileNodeProps {
  node: TreeNode;
  depth: number;
  props: FileTreeProps;
}

const FileNode = memo(function FileNode({ node, depth, props }: FileNodeProps) {
  const file = node.file;
  if (!file) return null;
  const {
    activeFileId,
    selectedFileIds,
    showCheckboxes,
    deletingFileId,
    renamingFileId,
    renameValue,
    focusedFileId,
    revealCnt,
    onSelectFile,
    onToggleSelection,
    onToggleSelectionKeyboard,
    onStartRename,
    onConfirmRename,
    onCancelRename,
    onRenameValueChange,
    onDeleteClick,
    isFileIncludedInAnalysis,
    hasLineageFile,
    canDeleteFiles,
    renameInputRef,
    isReadOnly,
  } = props;

  const isActive = activeFileId === file.id;
  const isIncluded = isFileIncludedInAnalysis(file.id);
  const hasLineage = hasLineageFile(file.path);
  const isSelected = selectedFileIds.includes(file.id);
  const isRenaming = renamingFileId === file.id;
  const isDeleting = deletingFileId === file.id;
  const isFocused = focusedFileId === file.id;

  if (isRenaming) {
    return (
      <div
        className="flex items-center gap-2 py-1 px-2"
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <FileCode className="size-4 shrink-0 text-muted-foreground" />
        <Input
          ref={renameInputRef}
          value={renameValue}
          onChange={(e) => onRenameValueChange(e.target.value)}
          className="h-7 flex-1 text-sm"
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') {
              e.preventDefault();
              onConfirmRename();
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              onCancelRename();
            }
          }}
          onBlur={onConfirmRename}
          data-testid={`rename-input-${file.id}`}
        />
      </div>
    );
  }

  const itemRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isFocused && itemRef.current) {
      itemRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [isFocused]);

  // Scroll to active file when revealCnt increments (locate button)
  const prevReveal = useRef(revealCnt);
  useEffect(() => {
    if (revealCnt && revealCnt > (prevReveal.current ?? 0) && isActive && itemRef.current) {
      itemRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    prevReveal.current = revealCnt;
  }, [revealCnt, isActive]);

  return (
    <div
      ref={itemRef}
      role="treeitem"
      aria-selected={isActive}
      className={cn(
        'flex items-center gap-2 py-1 px-2 rounded-md cursor-pointer hover:bg-muted/50 group',
        isFocused && 'bg-muted',
        isActive && 'bg-primary/10 ring-1 ring-primary/20',
      )}
      style={{ paddingLeft: `${depth * 12 + 8}px` }}
      onClick={() => onSelectFile(file.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          onSelectFile(file.id);
        } else if (e.key === ' ' && showCheckboxes && onToggleSelectionKeyboard) {
          e.preventDefault();
          onToggleSelectionKeyboard(file.id);
        } else if (e.key === ' ') {
          e.preventDefault();
          onSelectFile(file.id);
        }
      }}
      tabIndex={-1}
      data-testid={`file-tree-item-${file.id}`}
    >
      {showCheckboxes && (
        <Checkbox
          checked={isSelected}
          onClick={(e) => onToggleSelection(e, file.id)}
          className="shrink-0 border-muted-foreground"
          data-testid={`file-checkbox-${file.id}`}
        />
      )}
      {hasLineage ? (
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <FileCode className="size-4 shrink-0 text-emerald-500" />
            </TooltipTrigger>
            <TooltipContent side="right" className="text-xs">
              <p>Lineage available</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : (
        <FileCode
          className={cn('size-4 shrink-0', isIncluded ? 'text-primary' : 'text-muted-foreground')}
        />
      )}
      {file.isProcedure && <SpBadge hasTransformedContent={file.transformedContent !== null} />}
      <span className={cn('whitespace-nowrap text-sm', isActive && 'font-semibold text-primary')}>
        {file.name}
      </span>
      <span className="text-[10px] text-muted-foreground shrink-0 tabular-nums">
        {formatFileSize(file.size ?? file.content.length)}
      </span>
      {/* Hide rename/delete actions in read-only mode */}
      {!isReadOnly && (
        <>
          {isDeleting ? (
            <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
              <span className="text-xs text-destructive">Delete?</span>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 text-destructive hover:bg-destructive/10"
                onClick={(e) => onDeleteClick(e, file.id)}
                data-testid={`confirm-delete-${file.id}`}
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100">
              <TooltipProvider delayDuration={300}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 hover:bg-background/50"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        onStartRename(file.id, file.name);
                      }}
                      data-testid={`rename-file-${file.id}`}
                    >
                      <Pencil className="h-3 w-3" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    <p>
                      Rename <kbd className="ml-1 rounded bg-muted px-1 font-mono text-xs">R</kbd>
                    </p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
              {canDeleteFiles && (
                <TooltipProvider delayDuration={300}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 hover:bg-background/50 hover:text-destructive"
                        onClick={(e) => onDeleteClick(e, file.id)}
                        data-testid={`delete-file-${file.id}`}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      <p>
                        Delete <kbd className="ml-1 rounded bg-muted px-1 font-mono text-xs">D</kbd>
                      </p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
});

export function FileTree(props: FileTreeProps) {
  const { files, searchQuery, onContentWidthChange } = props;
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [renderLimit, setRenderLimit] = useState(FOLDER_RENDER_LIMIT);
  const treeRef = useRef<HTMLDivElement>(null);
  // Track if this is the initial mount to avoid collapsing on first render
  const isInitialMount = useRef(true);
  // Track previous search query to detect actual search changes
  const prevSearchQuery = useRef(searchQuery);

  // Defer file updates so content lazy-loading doesn't trigger tree rebuild on every keypress
  const deferredFiles = useDeferredValue(files);

  const tree = useMemo(() => buildFileTree(deferredFiles), [deferredFiles]);

  // Precompute folder→fileIds mapping once (avoid per-folder recursive traversal)
  const folderFileIdsMap = useMemo(() => {
    const map = new Map<string, string[]>();
    function walk(node: TreeNode) {
      if (node.path) map.set(node.path, collectFileIds(node));
      for (const child of node.children.values()) {
        if (child.children.size > 0) walk(child);
      }
    }
    walk(tree);
    return map;
  }, [tree]);

  // Check if we have any nested structure
  const hasNestedStructure = useMemo(() => {
    return files.some((f) => f.path.includes('/'));
  }, [files]);

  // When searching, auto-expand all folders that contain matched files.
  // Only collapse when search is cleared (not when files change due to lazy loading).
  useEffect(() => {
    if (!hasNestedStructure) return;

    const searchChanged = prevSearchQuery.current !== searchQuery;
    prevSearchQuery.current = searchQuery;

    // Skip collapsing on initial mount to preserve user's folder state
    if (isInitialMount.current) {
      isInitialMount.current = false;
      // On initial mount with search, expand matching folders
      if (searchQuery && searchQuery.trim()) {
        const foldersToExpand = new Set<string>();
        for (const file of files) {
          const parts = file.path.split('/').filter(Boolean);
          for (let i = 1; i < parts.length; i++) {
            foldersToExpand.add(parts.slice(0, i).join('/'));
          }
        }
        setExpandedFolders(foldersToExpand);
      }
      return;
    }

    // Only react to search query changes, not file content updates
    if (!searchChanged) return;

    if (searchQuery && searchQuery.trim()) {
      // Expand all parent folders of matched files
      const foldersToExpand = new Set<string>();
      for (const file of files) {
        const parts = file.path.split('/').filter(Boolean);
        for (let i = 1; i < parts.length; i++) {
          foldersToExpand.add(parts.slice(0, i).join('/'));
        }
      }
      setExpandedFolders(foldersToExpand);
    } else {
      // Search cleared — collapse all folders
      setExpandedFolders(new Set());
    }
  }, [files, hasNestedStructure, searchQuery]);

  // When revealCnt increments, expand parent folders to make active file visible
  useEffect(() => {
    const cnt = props.revealCnt;
    if (!cnt || !props.activeFileId || !hasNestedStructure) return;
    const activeFile = files.find((f) => f.id === props.activeFileId);
    if (!activeFile) return;
    const parts = activeFile.path.split('/').filter(Boolean);
    if (parts.length <= 1) return; // file is in root, no folders to expand
    const parents: string[] = [];
    for (let i = 1; i < parts.length; i++) {
      parents.push(parts.slice(0, i).join('/'));
    }
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      for (const p of parents) next.add(p);
      return next;
    });
  }, [props.revealCnt, props.activeFileId, files, hasNestedStructure]);

  useEffect(() => {
    if (!onContentWidthChange || !treeRef.current) return;
    const raf = requestAnimationFrame(() => {
      onContentWidthChange(treeRef.current?.scrollWidth ?? 0);
    });
    return () => cancelAnimationFrame(raf);
  }, [expandedFolders, files, onContentWidthChange, searchQuery]);

  const toggleFolder = (path: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const sortedChildren = useMemo(() => sortTreeNodes(Array.from(tree.children.values())), [tree]);

  // If no nested structure, render flat list (no need for tree)
  if (!hasNestedStructure) {
    return <FlatFileList sortedChildren={sortedChildren} props={props} />;
  }

  const visible = Math.min(sortedChildren.length, renderLimit);
  const remaining = sortedChildren.length - visible;

  return (
    <div ref={treeRef} className="p-1 min-w-max" role="tree" aria-label="File tree">
      {sortedChildren
        .slice(0, visible)
        .map((node) =>
          node.file ? (
            <FileNode key={node.file.id} node={node} depth={0} props={props} />
          ) : (
            <FolderNode
              key={node.path}
              node={node}
              depth={0}
              props={props}
              expandedFolders={expandedFolders}
              onToggleFolder={toggleFolder}
              folderFileIdsMap={folderFileIdsMap}
            />
          )
        )}
      {remaining > 0 && (
        <div
          className="flex items-center gap-1 px-1 py-1 cursor-pointer text-[11px] text-muted-foreground hover:text-foreground hover:bg-accent rounded-sm ml-4"
          onClick={() => setRenderLimit((prev) => prev + FOLDER_RENDER_LIMIT)}
        >
          +{remaining} more items...
        </div>
      )}
    </div>
  );
}
