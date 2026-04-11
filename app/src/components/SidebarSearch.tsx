import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { Search, FileCode, X, Database, ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useProject } from '@/lib/project-store';
import { loadSchemaFiles, type StoredSchemaFile } from '@/lib/schema-storage';
import { emitSchemaFileSelect } from '@/lib/schema-events';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type SearchMode = 'files' | 'schema';

interface SearchMatch {
  fileId: string;
  fileName: string;
  filePath: string;
  line: number;
  column: number;
  lineContent: string;
  matchStart: number;
  matchEnd: number;
  /** Character offset of match start within the file content */
  charStart: number;
  /** Character offset of match end within the file content */
  charEnd: number;
}

/** Context lines around a match for hover preview */
interface MatchContext {
  lines: { lineNum: number; text: string; isMatch: boolean }[];
}

interface SidebarSearchProps {
  /** Called when user wants to open a schema file — switches sidebar to schema view */
  onOpenSchemaFile?: (fileId: string) => void;
  /** Called to highlight a span in the SQL editor */
  onHighlightSpan?: (span: { start: number; end: number }) => void;
}

/** Build file content index for fast context lookup */
type FileContentIndex = Map<string, string[]>;

function buildContentIndex(
  files: Array<{ id: string; content: string }>
): FileContentIndex {
  const index = new Map<string, string[]>();
  for (const file of files) {
    index.set(file.id, file.content.split('\n'));
  }
  return index;
}

function getMatchContext(
  contentIndex: FileContentIndex,
  match: SearchMatch,
  contextSize = 5
): MatchContext {
  const fileLines = contentIndex.get(match.fileId);
  if (!fileLines) return { lines: [] };

  const startLine = Math.max(0, match.line - 1 - contextSize);
  const endLine = Math.min(fileLines.length, match.line + contextSize);
  const result: MatchContext = { lines: [] };

  for (let i = startLine; i < endLine; i++) {
    result.lines.push({
      lineNum: i + 1,
      text: fileLines[i],
      isMatch: i + 1 === match.line,
    });
  }

  return result;
}

function searchInFiles(
  files: Array<{ id: string; name: string; path: string; content: string }>,
  query: string,
  caseSensitive: boolean
): SearchMatch[] {
  if (!query.trim() || files.length === 0) return [];

  const matches: SearchMatch[] = [];
  const searchQuery = caseSensitive ? query : query.toLowerCase();

  for (const file of files) {
    const lines = file.content.split('\n');
    let charOffset = 0; // character offset from start of file
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const searchLine = caseSensitive ? line : line.toLowerCase();
      let startIdx = 0;
      while (true) {
        const idx = searchLine.indexOf(searchQuery, startIdx);
        if (idx === -1) break;
        matches.push({
          fileId: file.id,
          fileName: file.name,
          filePath: file.path,
          line: i + 1,
          column: idx + 1,
          lineContent: line,
          matchStart: idx,
          matchEnd: idx + query.length,
          charStart: charOffset + idx,
          charEnd: charOffset + idx + query.length,
        });
        startIdx = idx + 1;
      }
      charOffset += line.length + 1; // +1 for newline character
    }
  }

  return matches;
}

export function SidebarSearch({ onOpenSchemaFile, onHighlightSpan }: SidebarSearchProps) {
  const { t } = useTranslation();
  const { currentProject, selectFile, activeProjectId } = useProject();
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [searchMode, setSearchMode] = useState<SearchMode>('files');
  const [schemaFiles, setSchemaFiles] = useState<StoredSchemaFile[]>([]);
  const [hoveredMatch, setHoveredMatch] = useState<SearchMatch | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const tooltipRef = useRef<HTMLDivElement>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load schema files when switching to schema mode or project changes
  useEffect(() => {
    if (searchMode === 'schema' && activeProjectId) {
      loadSchemaFiles(activeProjectId).then(setSchemaFiles);
    }
  }, [searchMode, activeProjectId]);

  // File search results
  const fileResults = useMemo((): SearchMatch[] => {
    if (searchMode !== 'files' || !currentProject) return [];
    return searchInFiles(currentProject.files, query, caseSensitive);
  }, [currentProject, query, caseSensitive, searchMode]);

  // Schema search results
  const schemaResults = useMemo((): SearchMatch[] => {
    if (searchMode !== 'schema') return [];
    return searchInFiles(schemaFiles, query, caseSensitive);
  }, [schemaFiles, query, caseSensitive, searchMode]);

  const results = searchMode === 'files' ? fileResults : schemaResults;

  // Content index for hover context preview
  const contentIndex = useMemo<FileContentIndex>(() => {
    if (searchMode === 'files' && currentProject) {
      return buildContentIndex(currentProject.files);
    }
    return buildContentIndex(schemaFiles);
  }, [searchMode, currentProject, schemaFiles]);

  // Group by file
  const groupedResults = useMemo(() => {
    const groups = new Map<string, { fileName: string; filePath: string; matches: SearchMatch[] }>();
    for (const match of results) {
      if (!groups.has(match.fileId)) {
        groups.set(match.fileId, {
          fileName: match.fileName,
          filePath: match.filePath,
          matches: [],
        });
      }
      groups.get(match.fileId)!.matches.push(match);
    }
    return groups;
  }, [results]);

  const totalFiles = groupedResults.size;
  const totalMatches = results.length;

  const handleMatchClick = useCallback(
    (match: SearchMatch) => {
      if (searchMode === 'files') {
        selectFile(match.fileId);
        if (onHighlightSpan) {
          // Delay slightly to let file switch complete before highlighting
          setTimeout(() => onHighlightSpan({ start: match.charStart, end: match.charEnd }), 50);
        }
      } else {
        if (onOpenSchemaFile) {
          onOpenSchemaFile(match.fileId);
        }
        // Delay emit to let Schema sidebar mount and register its listener
        setTimeout(() => emitSchemaFileSelect({
          fileId: match.fileId,
          span: { start: match.charStart, end: match.charEnd },
        }), 100);
      }
    },
    [selectFile, searchMode, onOpenSchemaFile, onHighlightSpan]
  );

  const handleFileHeaderClick = useCallback(
    (fileId: string) => {
      if (searchMode === 'files') {
        selectFile(fileId);
      } else {
        if (onOpenSchemaFile) {
          onOpenSchemaFile(fileId);
        }
        setTimeout(() => emitSchemaFileSelect({ fileId }), 100);
      }
    },
    [selectFile, searchMode, onOpenSchemaFile]
  );

  const handleMouseEnter = useCallback(
    (e: React.MouseEvent, match: SearchMatch) => {
      const rect = e.currentTarget.getBoundingClientRect();
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = setTimeout(() => {
        setHoveredMatch(match);
        setTooltipPos({ x: rect.right + 8, y: rect.top });
      }, 300);
    },
    []
  );

  const handleMouseLeave = useCallback(() => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    setHoveredMatch(null);
  }, []);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    };
  }, []);

  // Hover preview context
  const previewContext = useMemo(() => {
    if (!hoveredMatch) return null;
    return getMatchContext(contentIndex, hoveredMatch);
  }, [hoveredMatch, contentIndex]);

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b shrink-0">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          {t('activityBar.search')}
        </span>
      </div>

      {/* Mode toggle */}
      <div className="flex items-center gap-1 px-2 pt-2 shrink-0">
        <Button
          variant={searchMode === 'files' ? 'secondary' : 'ghost'}
          size="sm"
          className="h-6 px-2 text-[11px] gap-1"
          onClick={() => setSearchMode('files')}
        >
          <FileCode className="h-3 w-3" />
          {t('search.modeFiles')}
        </Button>
        <Button
          variant={searchMode === 'schema' ? 'secondary' : 'ghost'}
          size="sm"
          className="h-6 px-2 text-[11px] gap-1"
          onClick={() => setSearchMode('schema')}
        >
          <Database className="h-3 w-3" />
          {t('search.modeSchema')}
        </Button>
      </div>

      {/* Search input */}
      <div className="px-2 py-2 border-b shrink-0 space-y-2">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={searchMode === 'files' ? t('search.placeholderFiles') : t('search.placeholderSchema')}
            className="h-7 pl-7 pr-8 text-xs bg-muted/30 border-transparent focus:border-border"
            autoFocus
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant={caseSensitive ? 'secondary' : 'ghost'}
            size="sm"
            className="h-5 px-1.5 text-[10px] font-mono"
            onClick={() => setCaseSensitive(!caseSensitive)}
            title={t('search.caseSensitive')}
          >
            Aa
          </Button>
          {query && (
            <span className="text-[10px] text-muted-foreground">
              {t('search.resultCount', { matches: totalMatches, files: totalFiles })}
            </span>
          )}
        </div>
      </div>

      {/* Results */}
      <div className="flex-1 overflow-y-auto">
        {/* Schema mode: empty hint */}
        {searchMode === 'schema' && schemaFiles.length === 0 && !query && (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">
            {t('search.noSchemaFiles')}
          </div>
        )}

        {query && totalMatches === 0 && (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">
            {t('search.noResults')}
          </div>
        )}

        {Array.from(groupedResults.entries()).map(([fileId, group]) => (
          <div key={fileId} className="border-b border-border/50">
            {/* File header */}
            <div
              className="flex items-center gap-1.5 px-3 py-1.5 bg-muted/20 cursor-pointer hover:bg-muted/40"
              onClick={() => handleFileHeaderClick(fileId)}
            >
              {searchMode === 'files' ? (
                <FileCode className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              ) : (
                <Database className="h-3.5 w-3.5 text-blue-500 shrink-0" />
              )}
              <span className="text-xs font-medium truncate">{group.fileName}</span>
              <span className="text-[10px] text-muted-foreground ml-auto shrink-0 flex items-center gap-1">
                {group.matches.length}
                <ExternalLink className="h-2.5 w-2.5" />
              </span>
            </div>

            {/* Matches in file */}
            {group.matches.slice(0, 20).map((match, idx) => (
              <div
                key={idx}
                className="flex items-start gap-2 px-3 py-1 text-xs cursor-pointer hover:bg-muted/30"
                onClick={() => handleMatchClick(match)}
                onMouseEnter={(e) => handleMouseEnter(e, match)}
                onMouseLeave={handleMouseLeave}
              >
                <span className="text-muted-foreground shrink-0 w-8 text-right font-mono text-[10px] pt-0.5">
                  {match.line}
                </span>
                <span className="truncate leading-5">
                  <HighlightedLine
                    line={match.lineContent}
                    matchStart={match.matchStart}
                    matchEnd={match.matchEnd}
                  />
                </span>
              </div>
            ))}
            {group.matches.length > 20 && (
              <div className="px-3 py-1 text-[10px] text-muted-foreground italic">
                +{group.matches.length - 20} more
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Hover preview tooltip */}
      {hoveredMatch && previewContext && previewContext.lines.length > 0 && (
        <div
          ref={tooltipRef}
          className="fixed z-50 bg-popover border border-border rounded-md shadow-lg p-2 max-w-[400px] min-w-[280px] pointer-events-none"
          style={{
            left: tooltipPos.x,
            top: Math.max(8, Math.min(tooltipPos.y, window.innerHeight - 300)),
          }}
        >
          <div className="text-[10px] text-muted-foreground mb-1 font-medium truncate">
            {hoveredMatch.fileName}:{hoveredMatch.line}
          </div>
          <div className="font-mono text-[10px] leading-4 overflow-hidden">
            {previewContext.lines.map((l) => (
              <div
                key={l.lineNum}
                className={cn(
                  'flex whitespace-pre',
                  l.isMatch && 'bg-yellow-300/70 dark:bg-yellow-700/50 rounded-sm font-medium'
                )}
              >
                <span className="text-muted-foreground w-6 text-right mr-2 shrink-0 select-none">
                  {l.lineNum}
                </span>
                <span className="truncate">{l.text || ' '}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function HighlightedLine({
  line,
  matchStart,
  matchEnd,
}: {
  line: string;
  matchStart: number;
  matchEnd: number;
}) {
  const trimStart = Math.max(0, matchStart - 30);
  const trimEnd = Math.min(line.length, matchEnd + 60);
  const prefix = trimStart > 0 ? '…' : '';
  const suffix = trimEnd < line.length ? '…' : '';

  const before = line.slice(trimStart, matchStart);
  const matched = line.slice(matchStart, matchEnd);
  const after = line.slice(matchEnd, trimEnd);

  return (
    <>
      {prefix}
      <span className="text-muted-foreground">{before}</span>
      <span className={cn('bg-yellow-200 dark:bg-yellow-800/60 text-foreground font-medium rounded-sm px-0.5')}>
        {matched}
      </span>
      <span className="text-muted-foreground">{after}</span>
      {suffix}
    </>
  );
}
