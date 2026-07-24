import { Play, Loader2, ChevronDown, Braces, Code, FileCode, Network, WrapText, Wand2, Save, Scissors } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
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
import type { RunMode, Dialect } from '@/lib/project-store';
import { isValidDialect, DIALECT_OPTIONS } from '@/lib/project-store';
import type { TemplateMode } from '@/types';
import { isValidTemplateMode, TEMPLATE_MODE_OPTIONS } from '@/types';

export type SqlViewMode = 'template' | 'resolved';

interface EditorToolbarProps {
  runMode: RunMode;
  onRunModeChange: (mode: RunMode) => void;
  isAnalyzing: boolean;
  backendReady: boolean;
  onAnalyze: () => void;
  allFileCount: number;
  selectedCount: number;
  activeFileName?: string;
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
  isConverting?: boolean;
}

export function EditorToolbar({
  runMode,
  onRunModeChange,
  isAnalyzing,
  backendReady,
  onAnalyze,
  allFileCount,
  selectedCount,
  activeFileName,
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
  isConverting,
}: EditorToolbarProps) {
  const { t } = useTranslation();

  return (
    <div className="flex items-center justify-between px-3 py-2 border-b h-[44px] shrink-0 bg-muted/30 overflow-hidden gap-2">
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <div className="flex items-center gap-1.5 min-w-0 text-sm text-muted-foreground">
          <FileCode className="h-4 w-4 shrink-0" />
          <span className="truncate font-medium text-foreground">
            {activeFileName || t('editor.noFileSelected')}
          </span>
        </div>

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
                  disabled={isConverting}
                >
                  {isConverting ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Scissors className="h-3.5 w-3.5" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>转换存储过程</p>
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
