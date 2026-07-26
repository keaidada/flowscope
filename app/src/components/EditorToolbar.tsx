import { useState } from 'react';
import { Play, Loader2, ChevronDown, Braces, Code, Network, WrapText, Wand2, Save, Scissors, Eye, EyeOff, ChevronsDownUp, ChevronsUpDown, XCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from '@/components/ui/dropdown-menu';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import type { RunMode, Dialect, ProjectFile } from '@/lib/project-store';
import { isValidDialect, DIALECT_OPTIONS } from '@/lib/project-store';
import type { TemplateMode } from '@/types';
import { isValidTemplateMode, TEMPLATE_MODE_OPTIONS } from '@/types';
import { cn } from '@/lib/utils';

export type SqlViewMode = 'template' | 'resolved';

interface EditorToolbarProps {
  runMode: RunMode;
  onRunModeChange: (mode: RunMode) => void;
  isAnalyzing: boolean;
  backendReady: boolean;
  onAnalyze: () => void;
  allFileCount: number;
  selectedCount: number;
  sqlViewMode?: SqlViewMode;
  onSqlViewModeChange?: (mode: SqlViewMode) => void;
  showSqlViewToggle?: boolean;
  hasResolvedSql?: boolean;
  dialect?: Dialect;
  onDialectChange?: (dialect: Dialect) => void;
  templateMode?: TemplateMode;
  onTemplateModeChange?: (mode: TemplateMode) => void;
  lineWrapping?: boolean;
  onLineWrappingChange?: (wrap: boolean) => void;
  onOpenLineage?: () => void;
  hasLineageResult?: boolean;
  onOpenEtl?: () => void;
  onSave?: () => void;
  isProcedure?: boolean;
  onConvertProcedure?: () => void;
  showTransformed?: boolean;
  onToggleTransformed?: () => void;
  hasTransformedContent?: boolean;
  onFoldAll?: () => void;
  onUnfoldAll?: () => void;
  // Open file tabs
  openFiles?: ProjectFile[];
  activeFileId?: string | null;
  onOpenFile?: (fileId: string) => void;
  onCloseTab?: (fileId: string) => void;
  onCloseAllTabs?: () => void;
  onCloseOtherTabs?: (fileId: string) => void;
  onCloseTabsToLeft?: (fileId: string) => void;
  onCloseTabsToRight?: (fileId: string) => void;
}

export function EditorToolbar({
  runMode,
  onRunModeChange,
  isAnalyzing,
  backendReady,
  onAnalyze,
  allFileCount,
  selectedCount,
  sqlViewMode = 'template',
  onSqlViewModeChange,
  showSqlViewToggle = false,
  hasResolvedSql = false,
  dialect,
  onDialectChange,
  templateMode,
  onTemplateModeChange,
  lineWrapping = true,
  onLineWrappingChange,
  onOpenLineage,
  hasLineageResult = false,
  onOpenEtl,
  onSave,
  onConvertProcedure,
  showTransformed,
  onToggleTransformed,
  hasTransformedContent,
  onFoldAll,
  onUnfoldAll,
  openFiles,
  activeFileId,
  onOpenFile,
  onCloseTab,
  onCloseAllTabs,
  onCloseOtherTabs,
  onCloseTabsToLeft,
  onCloseTabsToRight,
}: EditorToolbarProps) {
  const { t } = useTranslation();
  const activeFile = openFiles?.find((f) => f.id === activeFileId);
  const [selectedForDelete, setSelectedForDelete] = useState<Set<string>>(new Set());
  const sortedFiles = [...(openFiles || [])].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="flex items-center justify-between px-3 py-2 border-b h-[44px] shrink-0 bg-muted/30 overflow-hidden gap-2">
      {/* Left: file selector dropdown + close dropdown */}
      <div className="flex items-center gap-1 min-w-0">
        {openFiles && onOpenFile && (
          <DropdownMenu>
            <DropdownMenuTrigger className="flex items-center gap-1.5 h-7 px-2 text-sm rounded hover:bg-muted/50 min-w-0 max-w-[320px]">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />
              {activeFile?.isProcedure && (
                <span className={cn(
                  'text-[9px] px-1 py-px rounded shrink-0 font-medium',
                  activeFile.transformedContent
                    ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                    : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                )}>
                  SP
                </span>
              )}
              <span className="truncate font-medium text-foreground text-xs">
                {activeFile?.name || '—'}
              </span>
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-[440px] max-w-[90vw] max-h-80 overflow-y-auto">
              {/* Sticky action bar at top */}
              <div className="sticky top-0 bg-popover z-10 border-b px-1.5 py-0.5">
                <div className="flex items-center gap-0.5 whitespace-nowrap">
                  <span className="text-[10px] font-bold text-muted-foreground shrink-0 pr-1">关闭</span>
                  <DropdownMenuItem
                    className="h-6 text-[10px] text-red-500 cursor-pointer rounded-sm"
                    disabled={selectedForDelete.size === 0}
                    onSelect={(e) => {
                      e.preventDefault();
                      for (const id of selectedForDelete) onCloseTab?.(id);
                      setSelectedForDelete(new Set());
                    }}
                  >
                    选中 ({selectedForDelete.size})
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="h-6 text-[10px] cursor-pointer rounded-sm"
                    onSelect={(e) => {
                      e.preventDefault();
                      if (selectedForDelete.size === sortedFiles.length) {
                        setSelectedForDelete(new Set());
                      } else {
                        setSelectedForDelete(new Set(sortedFiles.map((f) => f.id)));
                      }
                    }}
                  >
                    {selectedForDelete.size === sortedFiles.length ? '取消' : '全选'}
                  </DropdownMenuItem>
                  {activeFileId && onCloseTab && (
                    <DropdownMenuItem className="h-6 text-[10px] cursor-pointer rounded-sm" onSelect={(e) => { e.preventDefault(); onCloseTab(activeFileId); }}>
                      当前
                    </DropdownMenuItem>
                  )}
                  {activeFileId && onCloseOtherTabs && (
                    <DropdownMenuItem className="h-6 text-[10px] cursor-pointer rounded-sm" onSelect={(e) => { e.preventDefault(); onCloseOtherTabs(activeFileId); }}>
                      其他
                    </DropdownMenuItem>
                  )}
                  {activeFileId && onCloseTabsToLeft && (
                    <DropdownMenuItem className="h-6 text-[10px] cursor-pointer rounded-sm" onSelect={(e) => { e.preventDefault(); onCloseTabsToLeft(activeFileId); }}>
                      上方
                    </DropdownMenuItem>
                  )}
                  {activeFileId && onCloseTabsToRight && (
                    <DropdownMenuItem className="h-6 text-[10px] cursor-pointer rounded-sm" onSelect={(e) => { e.preventDefault(); onCloseTabsToRight(activeFileId); }}>
                      下方
                    </DropdownMenuItem>
                  )}
                  {onCloseAllTabs && (
                    <DropdownMenuItem className="h-6 text-[10px] cursor-pointer rounded-sm" onSelect={(e) => { e.preventDefault(); onCloseAllTabs(); }}>
                      全部
                    </DropdownMenuItem>
                  )}
                </div>
              </div>
              {/* File list */}
              {sortedFiles.map((f) => (
                <div
                  key={f.id}
                  className={cn(
                    'text-xs flex items-center gap-2 pr-1 py-1.5 px-2 cursor-pointer hover:bg-muted/50 group',
                    f.id === activeFileId && 'bg-muted/50 font-medium'
                  )}
                  onClick={() => {
                    onOpenFile(f.id);
                    setSelectedForDelete(new Set());
                  }}
                >
                  <span data-checkbox className="shrink-0 flex items-center" onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      checked={selectedForDelete.has(f.id)}
                      onCheckedChange={() => {
                        const next = new Set(selectedForDelete);
                        if (next.has(f.id)) next.delete(f.id); else next.add(f.id);
                        setSelectedForDelete(next);
                      }}
                    />
                  </span>
                  {/* Dot: green only for active file */}
                  <span className="w-1.5 h-1.5 rounded-full shrink-0">
                    {f.id === activeFileId && (
                      <span className="block w-1.5 h-1.5 rounded-full bg-green-500" />
                    )}
                  </span>
                  {f.isProcedure && (
                    <span className={cn(
                      'text-[9px] px-1 py-px rounded shrink-0 font-medium',
                      f.transformedContent
                        ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                        : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                    )}>
                      SP
                    </span>
                  )}
                  <span className="truncate flex-1">{f.name}</span>
                  {onCloseTab && (
                    <XCircle
                      className="h-3.5 w-3.5 text-muted-foreground hover:text-red-500 shrink-0 opacity-0 group-hover:opacity-100"
                      onClick={(e) => {
                        e.stopPropagation();
                        onCloseTab(f.id);
                      }}
                    />
                  )}
                </div>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      <div className="flex items-center gap-2 min-w-0 flex-1">
        {showSqlViewToggle && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0"
                  disabled={!hasResolvedSql || !onSqlViewModeChange}
                  aria-label={
                    sqlViewMode === 'template'
                      ? t('editor.switchToResolved')
                      : t('editor.switchToTemplate')
                  }
                  aria-pressed={sqlViewMode === 'resolved'}
                  onClick={() => {
                    onSqlViewModeChange?.(sqlViewMode === 'template' ? 'resolved' : 'template');
                  }}
                >
                  {sqlViewMode === 'template' ? (
                    <Braces className="h-4 w-4" />
                  ) : (
                    <Code className="h-4 w-4" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {!hasResolvedSql ? (
                  <p>{t('editor.runAnalysisToSee')}</p>
                ) : sqlViewMode === 'template' ? (
                  <p>{t('editor.viewingTemplate')}</p>
                ) : (
                  <p>{t('editor.viewingResolved')}</p>
                )}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {dialect && onDialectChange && (
          <Select
            value={dialect}
            onValueChange={(v) => {
              if (isValidDialect(v)) {
                onDialectChange(v);
              }
            }}
          >
            <SelectTrigger className="h-7 w-[120px] text-xs px-2">
              <SelectValue placeholder="Dialect" />
            </SelectTrigger>
            <SelectContent>
              {DIALECT_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {templateMode && onTemplateModeChange && (
          <Select
            value={templateMode}
            onValueChange={(v) => {
              if (isValidTemplateMode(v)) {
                onTemplateModeChange(v);
              }
            }}
          >
            <SelectTrigger className="h-7 w-[110px] text-xs px-2">
              <SelectValue placeholder="Template" />
            </SelectTrigger>
            <SelectContent>
              {TEMPLATE_MODE_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {onLineWrappingChange && (
          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className={`h-7 w-7 ${lineWrapping ? 'bg-muted' : ''}`}
                  onClick={() => onLineWrappingChange(!lineWrapping)}
                >
                  <WrapText className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>{lineWrapping ? t('editor.nowrap') : t('editor.wrap')}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
        {onFoldAll && (
          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={onFoldAll}
                >
                  <ChevronsDownUp className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>全部折叠</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
        {onUnfoldAll && (
          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={onUnfoldAll}
                >
                  <ChevronsUpDown className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>全部展开</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
        {onOpenEtl && (
          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={onOpenEtl}
                >
                  <Wand2 className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>ETL 工具</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
        {onConvertProcedure && (
          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={onConvertProcedure}
                >
                  <Scissors className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>转换存储过程</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
        {onToggleTransformed && (
          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className={`h-7 w-7 ${showTransformed ? 'bg-amber-500/10 text-amber-600' : ''}`}
                  onClick={onToggleTransformed}
                  disabled={!hasTransformedContent}
                >
                  {showTransformed ? (
                    <Eye className="h-3.5 w-3.5" />
                  ) : (
                    <EyeOff className="h-3.5 w-3.5" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>{showTransformed ? '查看原始脚本' : '查看转换结果'}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
        {onSave && (
          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={onSave}
                >
                  <Save className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>保存 ({navigator.platform.includes('Mac') ? '⌘S' : 'Ctrl+S'})</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
        {onOpenLineage && (
          <Button
            onClick={onOpenLineage}
            disabled={!backendReady || isAnalyzing}
            size="sm"
            variant="outline"
            className="h-[34px] gap-1.5 rounded-full px-3 text-xs font-medium"
          >
            <Network className="h-3.5 w-3.5" />
            <span>{hasLineageResult ? t('editor.openLineage') : t('editor.runAndShowLineage')}</span>
          </Button>
        )}
        <div className="flex items-center rounded-full overflow-hidden shadow-xs">
          <Button
            onClick={onAnalyze}
            disabled={!backendReady || isAnalyzing}
            size="sm"
            className="h-[34px] gap-1.5 bg-brand-blue-500 hover:bg-brand-blue-700 text-white font-medium rounded-none rounded-l-full border-r border-brand-blue-400/30 px-3"
          >
            {isAnalyzing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="h-3.5 w-3.5 fill-current" />
            )}
            <span className="hidden sm:inline">{t('common.run')}</span>
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="sm"
                className="h-[34px] px-3 bg-brand-blue-500 hover:bg-brand-blue-700 text-white rounded-none rounded-r-full border-l border-brand-blue-700/30"
                disabled={!backendReady || isAnalyzing}
              >
                <ChevronDown className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>{t('editor.runConfig')}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuRadioGroup
                value={runMode}
                onValueChange={(v) => onRunModeChange(v as RunMode)}
              >
                <DropdownMenuRadioItem value="current" className="text-xs justify-between">
                  <span>{t('editor.runActiveOnly')}</span>
                  <kbd className="ml-4 inline-flex h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground">
                    <span className="text-xs">⌘</span>⇧↵
                  </kbd>
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="all" className="text-xs">
                  {t('editor.runAllFiles', { count: allFileCount })}
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="custom" className="text-xs">
                  {t('editor.runSelected', { count: selectedCount })}
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              <div className="px-2 py-1.5 text-xs text-muted-foreground">
                <kbd className="inline-flex h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium">
                  <span className="text-xs">⌘</span>↵
                </kbd>
                <span className="ml-2">{t('editor.runInCurrentMode')}</span>
              </div>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  );
}
