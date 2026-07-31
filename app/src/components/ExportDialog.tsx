import { useCallback, useState, type JSX } from 'react';
import { toPng, toSvg } from 'html-to-image';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { gzipSync, strToU8 } from 'fflate';
import {
  Download,
  Image,
  FileJson,
  FileSpreadsheet,
  FileCode,
  FileText,
  FileDown,
  Database,
  ExternalLink,
  X,
} from 'lucide-react';
import { exportToDuckDbSql, exportStreamLazy } from '@/lib/analysis-worker';
import { streamUniqueProjectResultJsons } from '@/lib/analysis-cache';
import { projectExportStreamViaBackend, isRestBackendAvailable } from '@/lib/backend-adapter';
import { extractSchemaFromResult } from './AnalysisView';
import { loadTableLevelEdges } from '@/lib/server-db';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from './ui/dropdown-menu';
import { Button } from './ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Checkbox } from './ui/checkbox';
import type { AnalyzeResult, ExportFormat, MermaidView } from '@pondpilot/capybara-core';
import {
  exportFilename,
  exportHtml,
  exportMermaid,
  formatSchemaError,
  validateSchemaName,
} from '@pondpilot/capybara-core';
import { useIsDarkMode } from '@pondpilot/capybara-react';
import {
  base64UrlEncode,
  formatBytes,
  SHARE_URL_SOFT_LIMIT,
  SHARE_URL_HARD_LIMIT,
} from '@/lib/share';

// ============================================================================
// Lineage computation — mirrors Schema module logic
// ============================================================================

/** Compute lineage entries matching the Schema module's logic.
 *  Extracts (script, inputTable, outputTable) triples from flow edges. */
function computeLineageFromSchema(result: AnalyzeResult) {
  const entries: Array<{ script: string; inputTable: string; outputTable: string }> = [];
  const seen = new Set<string>();

  const schema = extractSchemaFromResult(result, null);

  for (const table of schema) {
    const fullName = [table.catalog, table.schema, table.name].filter(Boolean).join('.');
    const incomingSources = (table.columns || [])
      .filter((col) => col.name.startsWith('← '))
      .map((col) => col.name.replace('← ', ''));

    for (const src of incomingSources) {
      const key = `${src}→${fullName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ script: '', inputTable: src, outputTable: fullName });
    }
  }

  // Per-script entries for script attribution
  const scriptEntries: Array<{ script: string; inputTable: string; outputTable: string }> = [];
  const scriptSeen = new Set<string>();
  const scripts = [...new Set(result.statements.map((s) => s.sourceName).filter(Boolean))];
  for (const script of scripts) {
    const miniResult: AnalyzeResult = {
      ...result,
      statements: result.statements.filter(
        (s) => s.sourceName === script
      ) as AnalyzeResult['statements'],
    };
    const miniSchema = extractSchemaFromResult(miniResult, script!);
    for (const table of miniSchema) {
      const fullName = [table.catalog, table.schema, table.name].filter(Boolean).join('.');
      const incomingSources = (table.columns || [])
        .filter((col) => col.name.startsWith('← '))
        .map((col) => col.name.replace('← ', ''));
      for (const src of incomingSources) {
        const key = `${script}::${src}→${fullName}`;
        if (scriptSeen.has(key)) continue;
        scriptSeen.add(key);
        scriptEntries.push({ script: script!, inputTable: src, outputTable: fullName });
      }
    }
  }

  // Deduplicate: if a per-script entry already covers the same (input→output) pair,
  // skip the global version of it.
  const scriptPairKeys = new Set(scriptEntries.map((e) => `${e.inputTable}→${e.outputTable}`));
  return [
    ...scriptEntries,
    ...entries.filter((e) => !scriptPairKeys.has(`${e.inputTable}→${e.outputTable}`)),
  ];
}

// ============================================================================
// Types
// ============================================================================

export interface ExportDialogProps {
  result: AnalyzeResult | null;
  projectName: string;
  graphRef?: React.RefObject<HTMLDivElement | null>;
  /** Project ID — when provided, export includes ALL project file results. */
  activeProjectId?: string | null;
}

// Sheet types available for selective export
const ALL_SHEETS = [
  { key: 'scripts', label: 'Scripts' },
  { key: 'tables', label: 'Tables' },
  { key: 'column_mappings', label: 'Column Mappings' },
  { key: 'table_dependencies', label: 'Dependency Matrix' },
  { key: 'lineage', label: 'Lineage' },
  { key: 'issues', label: 'Issues' },
  { key: 'summary', label: 'Summary' },
  { key: 'resolved_schema', label: 'Resolved Schema' },
] as const;

type SheetKey = (typeof ALL_SHEETS)[number]['key'];

// ============================================================================
// Helpers
// ============================================================================

async function buildExportFilename(
  projectName: string,
  format: ExportFormat,
  options: { view?: MermaidView; compact?: boolean; exportedAt?: Date } = {}
): Promise<{ filename: string; exportedAt: Date }> {
  const exportedAt = options.exportedAt ?? new Date();
  const filename = await exportFilename({
    projectName,
    exportedAt,
    format,
    view: options.view,
    compact: options.compact,
  });
  return { filename, exportedAt };
}

function downloadBlob(content: BlobPart, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.download = filename;
  link.href = url;
  link.click();
  URL.revokeObjectURL(url);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function sanitizeProjectName(name: string): string {
  return name
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .toLowerCase();
}

// ============================================================================
// PondPilot Integration
// ============================================================================

const PONDPILOT_URL = 'https://app.pondpilot.io';

/**
 * Create a PondPilot shareable URL for the given SQL content.
 * Uses gzip compression for efficient URL encoding.
 */
function createPondPilotUrl(
  name: string,
  sqlContent: string
): { url: string; compressedSize: number } {
  const payload = JSON.stringify({ name, content: sqlContent });
  const compressed = gzipSync(strToU8(payload), { level: 9 });
  const encoded = base64UrlEncode(compressed);
  return {
    url: `${PONDPILOT_URL}/shared-script/${encoded}`,
    compressedSize: encoded.length,
  };
}

// ============================================================================
// Component
// ============================================================================

export function ExportDialog({
  result,
  projectName,
  graphRef,
  activeProjectId,
}: ExportDialogProps): JSX.Element | null {
  const { t } = useTranslation();
  const isDarkMode = useIsDarkMode();

  // DuckDB export dialog state
  const [duckDbDialogOpen, setDuckDbDialogOpen] = useState(false);
  const [schemaInput, setSchemaInput] = useState('');
  const [schemaError, setSchemaError] = useState<string | undefined>();
  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState<string | undefined>();
  const [imageExportOpen, setImageExportOpen] = useState(false);
  const [imageExportStatus, setImageExportStatus] = useState<
    'idle' | 'exporting' | 'done' | 'error'
  >('idle');
  const [imageExportMessage, setImageExportMessage] = useState('');

  // Sheet selection dialog
  const [sheetDialogOpen, setSheetDialogOpen] = useState(false);
  const [pendingExportFormat, setPendingExportFormat] = useState<'csv' | 'xlsx' | 'json' | null>(
    null
  );
  const [selectedSheets, setSelectedSheets] = useState<Set<SheetKey>>(
    new Set(ALL_SHEETS.map((s) => s.key))
  );

  /**
   * Export all project results.
   *
   * Preferred path: stream raw per-file JSON blobs to the Rust backend so
   * merge/export happens outside the browser heap. Fallback to the Worker
   * path only when the REST backend is unavailable.
   */
  const handleSheetExport = useCallback(
    async (format: 'csv' | 'xlsx' | 'json') => {
      if (!result && !activeProjectId) return;
      setIsExporting(true);
      try {
        const { filename } = await buildExportFilename(projectName, format);
        const sheetNames =
          selectedSheets.size > 0 ? (Array.from(selectedSheets) as string[]) : undefined;

        const onDone = (output: Uint8Array | string) => {
          if (typeof output === 'string') {
            downloadBlob(output, filename, 'application/json');
          } else {
            const mime =
              format === 'csv'
                ? 'application/zip'
                : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
            downloadBlob(toArrayBuffer(output), filename, mime);
          }
          toast.success(`${format.toUpperCase()} export downloaded`);
        };

        if (activeProjectId) {
          // 预加载物化表级血缘(table_level_edges,穿透 CTE),injectLineage 优先用;fallback schema 推断
          let preloadedLineage: Array<{
            script: string;
            inputTable: string;
            outputTable: string;
          }> | null = null;
          try {
            const tlEdges = await loadTableLevelEdges(activeProjectId);
            if (tlEdges.length > 0) {
              preloadedLineage = tlEdges.map(([from, to, script]) => ({
                script,
                inputTable: from,
                outputTable: to,
              }));
            }
          } catch {
            /* fallback to computeLineageFromSchema */
          }
          const lineageInjector = (resultJson: string): string => {
            try {
              const parsed = JSON.parse(resultJson);
              parsed.precomputedLineage = preloadedLineage ?? computeLineageFromSchema(parsed);
              return JSON.stringify(parsed);
            } catch {
              return resultJson;
            }
          };
          const uniqueResultJsons = streamUniqueProjectResultJsons(activeProjectId);
          const firstChunk = await uniqueResultJsons.next();
          if (firstChunk.done) {
            if (!result) {
              toast.error('No analysis results to export');
              return;
            }
            // Stream is empty but result exists in React state.  Serialize it once
            // and send through the backend to avoid structuredClone OOM via worker postMessage.
            const restAvailable = await isRestBackendAvailable('');
            if (restAvailable) {
              const singleJson = JSON.stringify(result);
              const output = await projectExportStreamViaBackend(
                '',
                (async function* () {
                  yield singleJson;
                })(),
                format,
                { sheets: sheetNames, injectLineage: lineageInjector }
              );
              if (!output) {
                throw new Error('Backend project export failed');
              }
              onDone(output.data);
              setSheetDialogOpen(false);
              return;
            }
            // no backend — use the original single-result path as last resort
          } else {
            const restAvailable = await isRestBackendAvailable('');

            if (restAvailable) {
              const output = await projectExportStreamViaBackend(
                '',
                (async function* () {
                  yield firstChunk.value;
                  yield* uniqueResultJsons;
                })(),
                format,
                { sheets: sheetNames, injectLineage: lineageInjector }
              );
              if (!output) {
                throw new Error('Backend project export failed');
              }

              onDone(output.data);
              setSheetDialogOpen(false);
              return;
            }

            const jsonIterator = (async function* () {
              yield firstChunk.value;
              yield* uniqueResultJsons;
            })()[Symbol.asyncIterator]();
            const output = await exportStreamLazy(
              async () => {
                const next = await jsonIterator.next();
                if (next.done) {
                  return null;
                }
                return JSON.parse(next.value) as AnalyzeResult;
              },
              format,
              { sheets: sheetNames }
            );
            onDone(output);
            setSheetDialogOpen(false);
            return;
          }
        }

        // Single result fallback
        if (!result) {
          toast.error('No analysis results to export');
          return;
        }
        const output = await exportStreamLazy(async () => result, format, { sheets: sheetNames });
        onDone(output);
        setSheetDialogOpen(false);
      } catch (err) {
        console.error(`Failed to export ${format.toUpperCase()}:`, err);
        toast.error(`Failed to export ${format.toUpperCase()}`);
      } finally {
        setIsExporting(false);
      }
    },
    [result, activeProjectId, projectName, selectedSheets]
  );

  const handleOpenSheetDialog = useCallback((format: 'csv' | 'xlsx' | 'json') => {
    setPendingExportFormat(format);
    setSheetDialogOpen(true);
  }, []);

  const toggleSheet = useCallback((key: SheetKey) => {
    setSelectedSheets((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const toggleAllSheets = useCallback(() => {
    setSelectedSheets((prev) => {
      if (prev.size === ALL_SHEETS.length) return new Set();
      return new Set(ALL_SHEETS.map((s) => s.key));
    });
  }, []);

  const handleDownloadXlsx = useCallback(async () => {
    handleOpenSheetDialog('xlsx');
  }, [handleOpenSheetDialog]);

  const handleDownloadJson = useCallback(async () => {
    handleOpenSheetDialog('json');
  }, [handleOpenSheetDialog]);

  const handleDownloadCsv = useCallback(async () => {
    handleOpenSheetDialog('csv');
  }, [handleOpenSheetDialog]);

  const handleDownloadPng = useCallback(async () => {
    if (!graphRef?.current) {
      toast.error('Graph not available for export');
      return;
    }

    setImageExportOpen(true);
    setImageExportStatus('exporting');
    setImageExportMessage('正在生成高清 PNG 图片...');

    // 等待弹窗渲染后再开始生成（toPng 会阻塞主线程）
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    try {
      const backgroundColor = isDarkMode ? '#1e293b' : '#ffffff';
      const dataUrl = await toPng(graphRef.current, {
        backgroundColor,
        pixelRatio: 3,
      });
      const { filename } = await buildExportFilename(projectName, 'png');
      const link = document.createElement('a');
      link.download = filename;
      link.href = dataUrl;
      link.click();
      setImageExportStatus('done');
      setImageExportMessage('PNG 导出完成！');
    } catch (err) {
      console.error('Failed to export image:', err);
      setImageExportStatus('error');
      setImageExportMessage('PNG 导出失败，请重试');
    }
  }, [graphRef, projectName, isDarkMode]);

  const handleDownloadSvg = useCallback(async () => {
    if (!graphRef?.current) {
      toast.error('Graph not available for export');
      return;
    }

    setImageExportOpen(true);
    setImageExportStatus('exporting');
    setImageExportMessage('正在生成 SVG 矢量图...');

    // 等待弹窗渲染后再开始生成
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    try {
      const backgroundColor = isDarkMode ? '#1e293b' : '#ffffff';
      const dataUrl = await toSvg(graphRef.current, { backgroundColor });
      const { filename } = await buildExportFilename(projectName, 'mermaid');
      const svgFilename = filename.replace(/\.\w+$/, '.svg');
      const link = document.createElement('a');
      link.download = svgFilename;
      link.href = dataUrl;
      link.click();
      setImageExportStatus('done');
      setImageExportMessage('SVG 导出完成！');
    } catch (err) {
      console.error('Failed to export SVG:', err);
      setImageExportStatus('error');
      setImageExportMessage('SVG 导出失败，请重试');
    }
  }, [graphRef, projectName, isDarkMode]);

  const handleDownloadMermaid = useCallback(async () => {
    if (!result) return;
    try {
      const { filename } = await buildExportFilename(projectName, 'mermaid', { view: 'all' });
      const content = await exportMermaid(result, 'all');
      downloadBlob(content, filename, 'text/markdown');
      toast.success('Mermaid export downloaded');
    } catch (err) {
      console.error('Failed to export Mermaid:', err);
      toast.error('Failed to export Mermaid');
    }
  }, [result, projectName]);

  const handleDownloadHtml = useCallback(async () => {
    if (!result) return;
    try {
      const { filename, exportedAt } = await buildExportFilename(projectName, 'html');
      const content = await exportHtml(result, { projectName, exportedAt });
      downloadBlob(content, filename, 'text/html');
      toast.success('HTML export downloaded');
    } catch (err) {
      console.error('Failed to export HTML:', err);
      toast.error('Failed to export HTML');
    }
  }, [result, projectName]);

  const handleOpenDuckDbDialog = useCallback(() => {
    setSchemaInput('');
    setSchemaError(undefined);
    setExportError(undefined);
    setDuckDbDialogOpen(true);
  }, []);

  const handleSchemaInputChange = useCallback((value: string) => {
    setSchemaInput(value);
    // Only validate if non-empty (schema is optional)
    const trimmed = value.trim();
    setSchemaError(trimmed ? validateSchemaName(trimmed) : undefined);
  }, []);

  const handleDuckDbExport = useCallback(async () => {
    if (!result) return;

    setIsExporting(true);
    setExportError(undefined);
    try {
      const schema = schemaInput.trim() || undefined;
      const sql = await exportToDuckDbSql(result, schema);
      const { filename } = await buildExportFilename(projectName, 'sql');
      downloadBlob(sql, filename, 'text/sql');
      toast.success(
        schema ? `DuckDB SQL export downloaded (schema: ${schema})` : 'DuckDB SQL export downloaded'
      );
      setDuckDbDialogOpen(false);
    } catch (err) {
      console.error('Failed to export DuckDB SQL:', err);
      toast.error('Failed to export DuckDB SQL');
    } finally {
      setIsExporting(false);
    }
  }, [result, projectName, schemaInput]);

  const handleOpenInPondPilot = useCallback(async () => {
    if (!result) return;

    setIsExporting(true);
    setExportError(undefined);
    try {
      const schema = schemaInput.trim() || undefined;
      const sql = await exportToDuckDbSql(result, schema);
      const fileName = `${sanitizeProjectName(projectName)}-lineage`;
      const { url, compressedSize } = createPondPilotUrl(fileName, sql);

      if (compressedSize > SHARE_URL_HARD_LIMIT) {
        setExportError(
          'File is too large for URL sharing. Please download the SQL file and open it in PondPilot manually.'
        );
        return;
      }

      if (compressedSize > SHARE_URL_SOFT_LIMIT) {
        toast.warning('Large export may not work in all browsers', {
          description: `Compressed size: ${formatBytes(compressedSize)}`,
        });
      }

      window.open(url, '_blank');
      setDuckDbDialogOpen(false);
    } catch (err) {
      console.error('Failed to open in PondPilot:', err);
      const message = err instanceof Error ? err.message : String(err);
      setExportError(`Failed to open in PondPilot: ${message}`);
    } finally {
      setIsExporting(false);
    }
  }, [result, projectName, schemaInput]);

  if (!result && !activeProjectId) {
    return null;
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="h-8 gap-2 px-2 w-full justify-start">
            <Download className="h-4 w-4" />
            <span className="text-sm">{t('export.exportLineage')}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuLabel>Data Formats</DropdownMenuLabel>
          <DropdownMenuItem onClick={handleDownloadXlsx}>
            <FileSpreadsheet className="size-4 mr-2" />
            Excel (.xlsx)
          </DropdownMenuItem>
          <DropdownMenuItem onClick={handleDownloadJson}>
            <FileJson className="size-4 mr-2" />
            JSON
          </DropdownMenuItem>
          <DropdownMenuItem onClick={handleDownloadCsv}>
            <FileDown className="size-4 mr-2" />
            CSV Archive (.zip)
          </DropdownMenuItem>
          <DropdownMenuItem onClick={handleOpenDuckDbDialog}>
            <Database className="size-4 mr-2" />
            DuckDB SQL
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Visual Formats</DropdownMenuLabel>
          <DropdownMenuItem onClick={handleDownloadPng}>
            <Image className="size-4 mr-2" />
            PNG Image (3x)
          </DropdownMenuItem>
          <DropdownMenuItem onClick={handleDownloadSvg}>
            <Image className="size-4 mr-2" />
            SVG (矢量图)
          </DropdownMenuItem>
          <DropdownMenuItem onClick={handleDownloadMermaid}>
            <FileCode className="size-4 mr-2" />
            Mermaid (.md)
          </DropdownMenuItem>
          <DropdownMenuItem onClick={handleDownloadHtml}>
            <FileText className="size-4 mr-2" />
            HTML Report
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={duckDbDialogOpen} onOpenChange={setDuckDbDialogOpen}>
        <DialogContent size="md">
          <DialogClose className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground">
            <X className="h-4 w-4" />
            <span className="sr-only">Close</span>
          </DialogClose>
          <DialogHeader>
            <DialogTitle>Export to DuckDB SQL</DialogTitle>
            <DialogDescription>
              Optionally specify a schema name to prefix all tables and views.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="schema-name">Schema name (optional)</Label>
              <Input
                id="schema-name"
                placeholder="e.g., lineage"
                value={schemaInput}
                onChange={(e) => handleSchemaInputChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !schemaError && !isExporting) {
                    handleDuckDbExport();
                  }
                }}
                disabled={isExporting}
              />
              {schemaError && (
                <p className="text-sm text-destructive">{formatSchemaError(schemaError)}</p>
              )}
              <p className="text-sm text-muted-foreground">
                Leave empty to create tables without a schema prefix.
              </p>
            </div>
          </div>
          {exportError && <p className="text-sm text-destructive">{exportError}</p>}
          <DialogFooter className="sm:justify-center">
            <Button onClick={handleDuckDbExport} disabled={!!schemaError || isExporting}>
              <Download className="size-4 mr-2" />
              {isExporting ? t('common.exporting') : t('common.download')}
            </Button>
            <Button
              variant="outline"
              onClick={handleOpenInPondPilot}
              disabled={!!schemaError || isExporting}
            >
              <ExternalLink className="size-4 mr-2" />
              PondPilot
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Sheet Selection Dialog */}
      <Dialog open={sheetDialogOpen} onOpenChange={setSheetDialogOpen}>
        <DialogContent size="sm">
          <DialogClose className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground">
            <X className="h-4 w-4" />
            <span className="sr-only">Close</span>
          </DialogClose>
          <DialogHeader>
            <DialogTitle>Select Sheets</DialogTitle>
            <DialogDescription>
              Choose which datasets to include in the{' '}
              {pendingExportFormat === 'csv'
                ? 'CSV archive'
                : pendingExportFormat === 'xlsx'
                  ? 'Excel workbook'
                  : 'JSON file'}
              .
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2 py-2">
            <div className="flex items-center gap-2 pb-1 border-b">
              <Checkbox
                id="sheet-all"
                checked={selectedSheets.size === ALL_SHEETS.length}
                onCheckedChange={toggleAllSheets}
              />
              <Label htmlFor="sheet-all" className="font-medium cursor-pointer">
                Select All
              </Label>
            </div>
            {ALL_SHEETS.map((sheet) => (
              <div key={sheet.key} className="flex items-center gap-2">
                <Checkbox
                  id={`sheet-${sheet.key}`}
                  checked={selectedSheets.has(sheet.key)}
                  onCheckedChange={() => toggleSheet(sheet.key)}
                />
                <Label htmlFor={`sheet-${sheet.key}`} className="cursor-pointer text-sm">
                  {sheet.label}
                </Label>
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button
              onClick={() => pendingExportFormat && handleSheetExport(pendingExportFormat)}
              disabled={selectedSheets.size === 0 || isExporting}
            >
              <Download className="size-4 mr-2" />
              {isExporting ? t('common.exporting') : t('common.download')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 图片导出进度弹窗 */}
      <Dialog
        open={imageExportOpen}
        onOpenChange={(open) => {
          if (!open && imageExportStatus !== 'exporting') {
            setImageExportOpen(false);
            setImageExportStatus('idle');
          }
        }}
      >
        <DialogContent size="sm">
          <DialogTitle className="text-center">
            {imageExportStatus === 'exporting'
              ? '导出中'
              : imageExportStatus === 'done'
                ? '导出完成'
                : '导出失败'}
          </DialogTitle>
          <DialogDescription className="text-center">
            <div className="flex flex-col items-center gap-4 py-4">
              {imageExportStatus === 'exporting' && (
                <div className="animate-spin h-8 w-8 border-4 border-primary border-t-transparent rounded-full" />
              )}
              {imageExportStatus === 'done' && (
                <div className="text-green-500 text-4xl">&#10003;</div>
              )}
              {imageExportStatus === 'error' && (
                <div className="text-destructive text-4xl">&#10007;</div>
              )}
              <p className="text-sm text-muted-foreground">{imageExportMessage}</p>
            </div>
          </DialogDescription>
          <DialogFooter className="justify-center">
            <Button
              variant="outline"
              onClick={() => {
                setImageExportOpen(false);
                setImageExportStatus('idle');
              }}
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
