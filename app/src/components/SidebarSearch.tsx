import { useState, useMemo, useCallback } from 'react';
import { Search, FileCode, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useProject } from '@/lib/project-store';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface SearchMatch {
  fileId: string;
  fileName: string;
  filePath: string;
  line: number;
  column: number;
  lineContent: string;
  matchStart: number;
  matchEnd: number;
}

export function SidebarSearch() {
  const { t } = useTranslation();
  const { currentProject, selectFile } = useProject();
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);

  const results = useMemo((): SearchMatch[] => {
    if (!currentProject || !query.trim()) return [];

    const matches: SearchMatch[] = [];
    const searchQuery = caseSensitive ? query : query.toLowerCase();

    for (const file of currentProject.files) {
      const lines = file.content.split('\n');
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
          });
          startIdx = idx + 1;
        }
      }
    }

    return matches;
  }, [currentProject, query, caseSensitive]);

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
      selectFile(match.fileId);
    },
    [selectFile]
  );

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b shrink-0">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          {t('activityBar.search')}
        </span>
      </div>

      {/* Search input */}
      <div className="px-2 py-2 border-b shrink-0 space-y-2">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('common.search')}
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
              onClick={() => selectFile(fileId)}
            >
              <FileCode className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <span className="text-xs font-medium truncate">{group.fileName}</span>
              <span className="text-[10px] text-muted-foreground ml-auto shrink-0">
                {group.matches.length}
              </span>
            </div>

            {/* Matches in file */}
            {group.matches.slice(0, 20).map((match, idx) => (
              <div
                key={idx}
                className="flex items-start gap-2 px-3 py-1 cursor-pointer hover:bg-muted/30 text-xs"
                onClick={() => handleMatchClick(match)}
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
