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
import { exportToDuckDbSql } from '@/lib/analysis-worker';
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
import type { AnalyzeResult, ExportFormat, MermaidView } from '@pondpilot/flowscope-core';
import {
  exportCsvArchive,
  exportFilename,
  exportHtml,
  exportJson,
  exportMermaid,
  exportXlsx,
  formatSchemaError,
  validateSchemaName,
} from '@pondpilot/flowscope-core';
import { useIsDarkMode } from '@pondpilot/flowscope-react';
import {
  base64UrlEncode,
  formatBytes,
  SHARE_URL_SOFT_LIMIT,
  SHARE_URL_HARD_LIMIT,
} from '@/lib/share';

// ============================================================================
// Types
// ============================================================================

export interface ExportDialogProps {
  result: AnalyzeResult | null;
  projectName: string;
  graphRef?: React.RefObject<HTMLDivElement | null>;
}

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

// ============================================================================
// Component
// ============================================================================

export function ExportDialog({
  result,
  projectName,
  graphRef,
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
  const [imageExportStatus, setImageExportStatus] = useState<'idle' | 'exporting' | 'done' | 'error'>('idle');
  const [imageExportMessage, setImageExportMessage] = useState('');

  const handleDownloadXlsx = useCallback(async () => {
    if (!result) return;
    try {
      const { filename } = await buildExportFilename(projectName, 'xlsx');
      const bytes = await exportXlsx(result);
      downloadBlob(
        toArrayBuffer(bytes),
        filename,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      toast.success('Excel export downloaded');
    } catch (err) {
      console.error('Failed to export Excel:', err);
      toast.error('Failed to export Excel');
    }
  }, [result, projectName]);

  const handleDownloadJson = useCallback(async () => {
    if (!result) return;
    try {
      const { filename } = await buildExportFilename(projectName, 'json', { compact: false });
      const jsonString = await exportJson(result, { compact: false });
      downloadBlob(jsonString, filename, 'application/json');
      toast.success('JSON export downloaded');
    } catch (err) {
      console.error('Failed to export JSON:', err);
      toast.error('Failed to export JSON');
    }
  }, [result, projectName]);

  const handleDownloadCsv = useCallback(async () => {
    if (!result) return;
    try {
      const { filename } = await buildExportFilename(projectName, 'csv');
      const bytes = await exportCsvArchive(result);
      downloadBlob(toArrayBuffer(bytes), filename, 'application/zip');
      toast.success('CSV archive downloaded');
    } catch (err) {
      console.error('Failed to export CSV archive:', err);
      toast.error('Failed to export CSV archive');
    }
  }, [result, projectName]);

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

  if (!result) {
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
        <DialogContent className="sm:max-w-md">
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

      {/* 图片导出进度弹窗 */}
      <Dialog open={imageExportOpen} onOpenChange={(open) => {
        if (!open && imageExportStatus !== 'exporting') {
          setImageExportOpen(false);
          setImageExportStatus('idle');
        }
      }}>
        <DialogContent className="sm:max-w-[360px]">
          <DialogTitle className="text-center">
            {imageExportStatus === 'exporting' ? '导出中' : imageExportStatus === 'done' ? '导出完成' : '导出失败'}
          </DialogTitle>
          <DialogDescription className="text-center">
            <div className="flex flex-col items-center gap-4 py-4">
              {imageExportStatus === 'exporting' && (
                <div className="animate-spin h-8 w-8 border-4 border-primary border-t-transparent rounded-full" />
              )}
              {imageExportStatus === 'done' && (
                <div className="h-8 w-8 rounded-full bg-green-100 dark:bg-green-900 flex items-center justify-center">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-green-600 dark:text-green-400">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </div>
              )}
              {imageExportStatus === 'error' && (
                <div className="h-8 w-8 rounded-full bg-red-100 dark:bg-red-900 flex items-center justify-center">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-red-600 dark:text-red-400">
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </div>
              )}
              <p className="text-sm">{imageExportMessage}</p>
            </div>
          </DialogDescription>
          {imageExportStatus !== 'exporting' && (
            <DialogFooter className="justify-center">
              <Button variant="outline" onClick={() => { setImageExportOpen(false); setImageExportStatus('idle'); }}>
                关闭
              </Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
