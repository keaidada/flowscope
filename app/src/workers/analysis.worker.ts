import {
  analyzeSql,
  ensureAnalyzerReady,
  getEngineVersion,
  exportToDuckDbSql,
  mergeProgressiveInit,
  mergeProgressiveAdd,
  mergeProgressiveExport,
} from '@pondpilot/capybara-core';
import type { AnalyzeResult, Dialect } from '@pondpilot/capybara-core';
import { parseSchemaSQL } from '../lib/schema-parser';
import {
  readCachedAnalysisResult,
  writeCachedAnalysisResult,
  clearAnalysisCache,
} from '../lib/analysis-cache';
import { buildAnalysisCacheKey } from '../lib/analysis-hash';
import { ANALYSIS_CACHE_MAX_BYTES } from '../lib/constants';
import type { TemplateMode } from '../types';

export interface AnalysisWorkerPayload {
  files?: Array<{
    name: string;
    content: string;
    isProcedure?: boolean;
    transformedContent?: string | null;
  }>;
  fileNames?: string[];
  dialect: Dialect;
  schemaSQL: string;
  hideCTEs: boolean;
  enableColumnLineage: boolean;
  enableLinting?: boolean;
  templateMode?: TemplateMode;
}

export interface SyncFilesPayload {
  files: Array<{ name: string; content: string }>;
  replace?: boolean;
}

export interface ExportPayload {
  /** Single result to export (legacy / single-file). */
  result?: AnalyzeResult;
  /** Multiple results to merge in worker before export. */
  results?: AnalyzeResult[];
  /** Optional schema name to prefix all tables/views (e.g., "lineage") */
  schema?: string;
  /** Export format: "duckdb" | "xlsx" | "csv" | "json" — defaults to "duckdb" */
  format?: 'duckdb' | 'xlsx' | 'csv' | 'json';
  /** Sheet selection for xlsx/csv/json exports */
  sheets?: string[];
  /** Compact JSON (only for format: "json") */
  compact?: boolean;
}

/** Streaming export: one AnalyzeResult as a JSON string.
 *  String transfer bypasses structured-clone OOM (zero-copy string path). */
export interface ExportChunkPayload {
  /** JSON-serialized AnalyzeResult */
  resultJson: string;
}

export interface ExportStartPayload {
  format: 'xlsx' | 'csv' | 'json';
  sheets?: string[];
  compact?: boolean;
  /** Total chunks expected (used to skip merge if only 1 chunk). */
  totalChunks: number;
}

export interface AnalysisWorkerRequest {
  type:
    | 'init'
    | 'analyze'
    | 'get-cache'
    | 'get-version'
    | 'sync-files'
    | 'clear-files'
    | 'clear-cache'
    | 'export'
    | 'export-stream-start'
    | 'export-stream-chunk'
    | 'export-stream-finish';
  requestId: string;
  payload?: AnalysisWorkerPayload;
  syncPayload?: SyncFilesPayload;
  exportPayload?: ExportPayload;
  exportStartPayload?: ExportStartPayload;
  exportChunkPayload?: ExportChunkPayload;
  cacheMaxBytes?: number;
  knownCacheKey?: string | null;
}

export interface AnalysisWorkerTimings {
  totalMs: number;
  cacheReadMs: number;
  schemaParseMs: number;
  analyzeMs: number;
}

/**
 * Error codes for worker operations.
 * Must be kept in sync with AnalysisErrorCode in types/index.ts
 */
export const WorkerErrorCode = {
  MISSING_FILE_CONTENT: 'MISSING_FILE_CONTENT',
  NO_FILES_AVAILABLE: 'NO_FILES_AVAILABLE',
} as const;

export type WorkerErrorCode = (typeof WorkerErrorCode)[keyof typeof WorkerErrorCode];

export interface AnalysisWorkerResponse {
  type:
    | 'init-result'
    | 'analyze-result'
    | 'cache-result'
    | 'version-result'
    | 'sync-result'
    | 'clear-cache-result'
    | 'export-result'
    | 'batch-progress';
  requestId: string;
  result?: AnalyzeResult | null;
  cacheKey?: string;
  cacheHit?: boolean;
  skipResult?: boolean;
  timings?: AnalysisWorkerTimings;
  version?: string;
  /** SQL statements for DuckDB export */
  exportSql?: string;
  /** Binary export data (XLSX, CSV zip) — transferred as ArrayBuffer via postMessage */
  exportBytes?: ArrayBuffer;
  error?: string;
  /** Structured error code for programmatic handling */
  errorCode?: WorkerErrorCode;
  /** Batch progress indicator, e.g. "批次 3/9" */
  batchProgress?: string | null;
  batchFile?: string;
  batchIndex?: number;
  batchTotal?: number;
  completedFiles?: number;
  totalFiles?: number;
}

let wasmReady = false;
const fileCache = new Map<string, string>();

// ── Progressive streaming export: chunks merged into WASM one-by-one ──
// No JS array accumulation — each chunk is JSON.parsed → mergeProgressiveAdd
// → immediately released from JS heap. The merged result lives in WASM.
let streamFormat = '';
let streamSheets: string[] | undefined;
let streamCompact = false;
let streamRequestId = '';
let streamChunkCount = 0;

/**
 * Worker-side error with structured error code.
 * The code is extracted in the message handler and sent in the response.
 */
class WorkerError extends Error {
  code: WorkerErrorCode;

  constructor(code: WorkerErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'WorkerError';
  }
}

function nowMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

async function ensureWasmReady(): Promise<void> {
  if (wasmReady) {
    return;
  }
  await ensureAnalyzerReady();
  wasmReady = true;
}

type WorkerFile = {
  name: string;
  content: string;
  isProcedure?: boolean;
  transformedContent?: string | null;
};

function resolveFiles(payload: AnalysisWorkerPayload): WorkerFile[] {
  if (payload.files && payload.files.length > 0) {
    return payload.files;
  }

  if (!payload.fileNames || payload.fileNames.length === 0) {
    return [];
  }

  return payload.fileNames.map((name) => {
    const content = fileCache.get(name);
    if (content === undefined) {
      throw new WorkerError(
        WorkerErrorCode.MISSING_FILE_CONTENT,
        `Missing file content for ${name}`
      );
    }
    return { name, content };
  });
}

function resolvePayload(
  payload: AnalysisWorkerPayload
): AnalysisWorkerPayload & { files: WorkerFile[] } {
  const files = resolveFiles(payload);
  if (files.length === 0) {
    throw new WorkerError(WorkerErrorCode.NO_FILES_AVAILABLE, 'No files available for analysis');
  }
  return {
    ...payload,
    files,
  };
}

async function buildImportedSchema(
  payload: AnalysisWorkerPayload & { files: WorkerFile[] }
): Promise<{
  schema:
    | {
        allowImplied: boolean;
        tables: Array<{
          name: string;
          schema?: string;
          catalog?: string;
          columns?: Array<{ name: string; dataType?: string }>;
        }>;
      }
    | undefined;
  schemaErrors: string[];
}> {
  if (!payload.schemaSQL.trim()) {
    return { schema: undefined, schemaErrors: [] };
  }

  const { tables, errors } = await parseSchemaSQL(payload.schemaSQL, payload.dialect, analyzeSql);
  const schema =
    tables.length > 0
      ? {
          allowImplied: true,
          tables,
        }
      : undefined;

  return { schema, schemaErrors: errors };
}

async function runAnalysis(
  payload: AnalysisWorkerPayload,
  cacheMaxBytes: number,
  knownCacheKey?: string | null
): Promise<AnalysisWorkerResponse> {
  const totalStart = nowMs();
  const resolvedPayload = resolvePayload(payload);

  const cacheKey = buildAnalysisCacheKey({
    files: resolvedPayload.files,
    dialect: resolvedPayload.dialect,
    schemaSQL: resolvedPayload.schemaSQL,
    hideCTEs: resolvedPayload.hideCTEs,
    enableColumnLineage: resolvedPayload.enableColumnLineage,
    enableLinting: resolvedPayload.enableLinting,
    templateMode: resolvedPayload.templateMode,
  });

  if (knownCacheKey && knownCacheKey === cacheKey) {
    return {
      type: 'analyze-result',
      requestId: '',
      cacheKey,
      cacheHit: true,
      skipResult: true,
      timings: {
        totalMs: nowMs() - totalStart,
        cacheReadMs: 0,
        schemaParseMs: 0,
        analyzeMs: 0,
      },
    };
  }

  const cacheReadStart = nowMs();
  let cached: AnalyzeResult | null = null;
  try {
    cached = await readCachedAnalysisResult(cacheKey);
  } catch {
    cached = null;
  }
  const cacheReadMs = nowMs() - cacheReadStart;

  if (cached) {
    return {
      type: 'analyze-result',
      requestId: '',
      result: cached,
      cacheKey,
      cacheHit: true,
      timings: {
        totalMs: nowMs() - totalStart,
        cacheReadMs,
        schemaParseMs: 0,
        analyzeMs: 0,
      },
    };
  }

  const schemaStart = nowMs();
  const { schema, schemaErrors } = await buildImportedSchema(resolvedPayload);
  const schemaParseMs = nowMs() - schemaStart;

  const templateConfig =
    resolvedPayload.templateMode && resolvedPayload.templateMode !== 'raw'
      ? { mode: resolvedPayload.templateMode, context: {} }
      : undefined;

  const options = {
    enableColumnLineage: resolvedPayload.enableColumnLineage,
    hideCtes: resolvedPayload.hideCTEs,
    lint: { enabled: resolvedPayload.enableLinting ?? false },
  };

  // Batch analysis: split files to avoid WASM memory exhaustion
  const BATCH_SIZE = 120;
  const allFiles = resolvedPayload.files;
  const batches: Array<Array<{ name: string; content: string }>> = [];
  for (let i = 0; i < allFiles.length; i += BATCH_SIZE) {
    batches.push(allFiles.slice(i, i + BATCH_SIZE));
  }

  const analyzeStart = nowMs();
  let mergedResult: AnalyzeResult | null = null;
  let firstBatchError: string | null = null;

  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    const firstFile = batch[0]?.name ?? '';
    const progress = batches.length > 1 ? `批次 ${bi + 1}/${batches.length}` : undefined;

    // Send progress with file info
    const completedCount = bi * BATCH_SIZE;
    self.postMessage({
      type: 'batch-progress',
      batchProgress: progress ?? null,
      batchFile: firstFile,
      batchIndex: bi,
      batchTotal: batches.length,
      completedFiles: completedCount,
      totalFiles: allFiles.length,
    });

    const analysisRequest: Parameters<typeof analyzeSql>[0] & {
      templateConfig?: { mode: string; context: Record<string, unknown> };
    } = {
      sql: '',
      files: batch,
      dialect: resolvedPayload.dialect,
      schema,
      options,
    };
    if (templateConfig) {
      analysisRequest.templateConfig = templateConfig;
    }

    try {
      const batchResult = await analyzeSql(analysisRequest);
      mergedResult = mergedResult ? mergeBatchResults(mergedResult, batchResult) : batchResult;
    } catch (err) {
      if (!firstBatchError) {
        firstBatchError = err instanceof Error ? err.message : String(err);
      }
      // Continue with next batch — don't fail the whole analysis
    }
  }

  if (!mergedResult) {
    throw new Error(firstBatchError || 'All batches failed');
  }

  // Clear batch progress
  if (batches.length > 1) {
    self.postMessage({ type: 'batch-progress', batchProgress: null });
  }

  // Attach schema errors
  if (schemaErrors.length > 0) {
    const schemaIssues = schemaErrors.map((errorMessage) => ({
      severity: 'warning' as const,
      code: 'SCHEMA_PARSE_ERROR',
      message: `Schema DDL: ${errorMessage}`,
      locations: [],
    }));
    mergedResult.issues = [...(mergedResult.issues || []), ...schemaIssues];
  }

  const analyzeMs = nowMs() - analyzeStart;

  try {
    await writeCachedAnalysisResult(cacheKey, mergedResult, cacheMaxBytes);
  } catch {
    // Cache write failure is non-critical
  }

  return {
    type: 'analyze-result',
    requestId: '',
    result: mergedResult,
    cacheKey,
    cacheHit: false,
    timings: {
      totalMs: nowMs() - totalStart,
      cacheReadMs,
      schemaParseMs,
      analyzeMs,
    },
  };
}

/** Merge two AnalyzeResult objects from different batches. */
function mergeBatchResults(a: AnalyzeResult, b: AnalyzeResult): AnalyzeResult {
  // statements: concat (each batch has different files)
  const statements = [...a.statements, ...b.statements];

  // globalLineage.nodes: merge by id, union statementRefs
  const nodeMap = new Map<string, (typeof a.globalLineage.nodes)[0]>();
  for (const node of a.globalLineage.nodes) {
    nodeMap.set(node.id, { ...node, statementRefs: [...node.statementRefs] });
  }
  for (const node of b.globalLineage.nodes) {
    const existing = nodeMap.get(node.id);
    if (existing) {
      // Merge statementRefs — dedup by (statementIndex, sourceName)
      const existingKeys = new Set(
        existing.statementRefs.map((r: any) => `${r.statementIndex}|${r.sourceName ?? ''}`)
      );
      for (const ref of node.statementRefs) {
        const key = `${ref.statementIndex}|${(ref as any).sourceName ?? ''}`;
        if (!existingKeys.has(key)) {
          existing.statementRefs.push(ref);
        }
      }
    } else {
      nodeMap.set(node.id, { ...node, statementRefs: [...node.statementRefs] });
    }
  }
  const nodes = [...nodeMap.values()];

  // globalLineage.edges: concat, dedup by edge id
  const edgeIds = new Set(a.globalLineage.edges.map((e) => e.id));
  const edges = [...a.globalLineage.edges];
  for (const e of b.globalLineage.edges) {
    if (!edgeIds.has(e.id)) {
      edgeIds.add(e.id);
      edges.push(e);
    }
  }

  const globalLineage = { ...a.globalLineage, nodes, edges };

  // issues: concat
  const issues = [...a.issues, ...b.issues];

  // summary: aggregate
  const summary = {
    ...a.summary,
    statementCount: a.summary.statementCount + b.summary.statementCount,
    tableCount: nodeMap.size,
    joinCount: a.summary.joinCount + b.summary.joinCount,
    complexityScore: Math.max(a.summary.complexityScore, b.summary.complexityScore),
    hasErrors: a.summary.hasErrors || b.summary.hasErrors,
    issueCount: {
      errors: a.summary.issueCount.errors + b.summary.issueCount.errors,
      warnings: a.summary.issueCount.warnings + b.summary.issueCount.warnings,
      infos: a.summary.issueCount.infos + b.summary.issueCount.infos,
    },
  };

  return {
    statements,
    globalLineage,
    issues,
    summary,
    resolvedSchema: a.resolvedSchema,
  };
}

async function getCachedAnalysis(payload: AnalysisWorkerPayload): Promise<AnalysisWorkerResponse> {
  const totalStart = nowMs();
  const resolvedPayload = resolvePayload(payload);

  const cacheKey = buildAnalysisCacheKey({
    files: resolvedPayload.files,
    dialect: resolvedPayload.dialect,
    schemaSQL: resolvedPayload.schemaSQL,
    hideCTEs: resolvedPayload.hideCTEs,
    enableColumnLineage: resolvedPayload.enableColumnLineage,
    enableLinting: resolvedPayload.enableLinting,
    templateMode: resolvedPayload.templateMode,
  });

  const cacheReadStart = nowMs();
  let cached: AnalyzeResult | null = null;
  try {
    cached = await readCachedAnalysisResult(cacheKey);
  } catch {
    cached = null;
  }
  const cacheReadMs = nowMs() - cacheReadStart;

  return {
    type: 'cache-result',
    requestId: '',
    result: cached,
    cacheKey,
    cacheHit: Boolean(cached),
    timings: {
      totalMs: nowMs() - totalStart,
      cacheReadMs,
      schemaParseMs: 0,
      analyzeMs: 0,
    },
  };
}

/**
 * Export the progressively-merged result (already in WASM memory from mergeProgressiveAdd calls).
 */
async function doProgressiveExport(): Promise<void> {
  const format = streamFormat;
  const sheets = streamSheets;
  const compact = streamCompact;
  const requestId = streamRequestId;

  // Reset
  streamFormat = '';
  streamSheets = undefined;
  streamCompact = false;
  streamRequestId = '';
  streamChunkCount = 0;

  try {
    const bytes = await mergeProgressiveExport({
      format: format as 'xlsx' | 'csv' | 'json',
      sheets,
      compact,
    });
    // #region debug-point S:worker-progressive-export-done
    fetch('http://127.0.0.1:7777/event', {
      method: 'POST',
      body: JSON.stringify({
        sessionId: 'export-csv-failure',
        runId: 'post-fix',
        hypothesisId: 'S',
        location: 'analysis.worker.ts:doProgressiveExport:done',
        msg: `[DEBUG] worker progressive export done format=${format}`,
        data: { format, byteLength: bytes.length },
        ts: Date.now(),
      }),
    }).catch(() => {});
    // #endregion

    if (format === 'json') {
      const text = new TextDecoder().decode(bytes);
      self.postMessage({ type: 'export-result' as const, requestId, exportSql: text });
    } else {
      const buf = bytes.buffer as ArrayBuffer;
      const sliced = buf.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      (self as unknown as Worker).postMessage(
        { type: 'export-result' as const, requestId, exportBytes: sliced },
        [sliced]
      );
    }
  } catch (error) {
    // #region debug-point T:worker-progressive-export-catch
    fetch('http://127.0.0.1:7777/event', {
      method: 'POST',
      body: JSON.stringify({
        sessionId: 'export-csv-failure',
        runId: 'post-fix',
        hypothesisId: 'T',
        location: 'analysis.worker.ts:doProgressiveExport:catch',
        msg: `[DEBUG] worker progressive export catch format=${format}`,
        data: { format, errorMessage: error instanceof Error ? error.message : String(error) },
        ts: Date.now(),
      }),
    }).catch(() => {});
    // #endregion
    self.postMessage({
      type: 'export-result' as const,
      requestId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

self.onmessage = async (event: MessageEvent<AnalysisWorkerRequest>) => {
  const { type, requestId, payload, syncPayload, exportPayload, cacheMaxBytes, knownCacheKey } =
    event.data;

  try {
    if (type === 'sync-files') {
      if (!syncPayload) {
        const response: AnalysisWorkerResponse = {
          type: 'sync-result',
          requestId,
          error: 'Missing sync payload',
        };
        self.postMessage(response);
        return;
      }

      if (syncPayload.replace) {
        fileCache.clear();
      }

      for (const file of syncPayload.files) {
        fileCache.set(file.name, file.content);
      }

      const response: AnalysisWorkerResponse = {
        type: 'sync-result',
        requestId,
      };
      self.postMessage(response);
      return;
    }

    if (type === 'clear-files') {
      fileCache.clear();
      const response: AnalysisWorkerResponse = {
        type: 'sync-result',
        requestId,
      };
      self.postMessage(response);
      return;
    }

    if (type === 'clear-cache') {
      try {
        await clearAnalysisCache();
        const response: AnalysisWorkerResponse = {
          type: 'clear-cache-result',
          requestId,
        };
        self.postMessage(response);
      } catch (error) {
        const response: AnalysisWorkerResponse = {
          type: 'clear-cache-result',
          requestId,
          error: error instanceof Error ? error.message : 'Failed to clear analysis cache',
        };
        self.postMessage(response);
      }
      return;
    }

    if (type === 'init') {
      await ensureWasmReady();
      const response: AnalysisWorkerResponse = {
        type: 'init-result',
        requestId,
      };
      self.postMessage(response);
      return;
    }

    if (type === 'get-version') {
      await ensureWasmReady();
      const response: AnalysisWorkerResponse = {
        type: 'version-result',
        requestId,
        version: getEngineVersion(),
      };
      self.postMessage(response);
      return;
    }

    // ── Progressive streaming export: merge each chunk into WASM immediately ──
    if (type === 'export-stream-start') {
      const { exportStartPayload: start } = event.data;
      if (!start) {
        self.postMessage({
          type: 'export-result',
          requestId,
          error: 'Missing export-start payload',
        });
        return;
      }
      await ensureWasmReady();
      mergeProgressiveInit();
      // #region debug-point U:worker-stream-start
      fetch('http://127.0.0.1:7777/event', {
        method: 'POST',
        body: JSON.stringify({
          sessionId: 'export-csv-failure',
          runId: 'post-fix',
          hypothesisId: 'U',
          location: 'analysis.worker.ts:streamStart',
          msg: `[DEBUG] worker stream start format=${start.format}`,
          data: { format: start.format },
          ts: Date.now(),
        }),
      }).catch(() => {});
      // #endregion
      streamFormat = start.format;
      streamSheets = start.sheets;
      streamCompact = start.compact ?? false;
      streamRequestId = requestId;
      streamChunkCount = 0;
      return;
    }

    if (type === 'export-stream-chunk') {
      const { exportChunkPayload: chunk } = event.data;
      if (!streamRequestId || !chunk?.resultJson) {
        self.postMessage({ type: 'export-result', requestId, error: 'Unexpected export chunk' });
        return;
      }
      try {
        // Parse → merge into WASM → drop JS object immediately
        const result: AnalyzeResult = JSON.parse(chunk.resultJson);
        mergeProgressiveAdd(result);
        streamChunkCount++;
        // #region debug-point V:worker-stream-chunk
        fetch('http://127.0.0.1:7777/event', {
          method: 'POST',
          body: JSON.stringify({
            sessionId: 'export-csv-failure',
            runId: 'post-fix',
            hypothesisId: 'V',
            location: 'analysis.worker.ts:streamChunk',
            msg: '[DEBUG] worker stream chunk merged',
            data: { chunkCount: streamChunkCount, jsonSize: chunk.resultJson.length },
            ts: Date.now(),
          }),
        }).catch(() => {});
        // #endregion
      } catch (e) {
        self.postMessage({
          type: 'export-result',
          requestId: streamRequestId,
          error: `Chunk parse error: ${e}`,
        });
      }
      return;
    }

    if (type === 'export-stream-finish') {
      if (!streamRequestId || streamChunkCount === 0) {
        self.postMessage({ type: 'export-result', requestId, error: 'No streaming export data' });
        return;
      }
      // #region debug-point W:worker-stream-finish
      fetch('http://127.0.0.1:7777/event', {
        method: 'POST',
        body: JSON.stringify({
          sessionId: 'export-csv-failure',
          runId: 'post-fix',
          hypothesisId: 'W',
          location: 'analysis.worker.ts:streamFinish',
          msg: '[DEBUG] worker stream finish received',
          data: { requestId, streamChunkCount },
          ts: Date.now(),
        }),
      }).catch(() => {});
      // #endregion
      await doProgressiveExport();
      return;
    }

    if (type === 'export') {
      if (!exportPayload) {
        self.postMessage({
          type: 'export-result' as const,
          requestId,
          error: 'Missing export payload',
        });
        return;
      }

      await ensureWasmReady();

      const format = exportPayload.format ?? 'duckdb';

      // DuckDB export: use result directly
      if (format === 'duckdb') {
        const exportResult = exportPayload.result!;
        const sql = await exportToDuckDbSql(exportResult, exportPayload.schema);
        self.postMessage({ type: 'export-result' as const, requestId, exportSql: sql });
        return;
      }

      // Merge + export in one Rust-side operation
      let allResults: AnalyzeResult[] = [];
      if (exportPayload.results && exportPayload.results.length > 0) {
        allResults = exportPayload.results;
      } else if (exportPayload.result) {
        allResults = [exportPayload.result];
      }

      if (allResults.length === 0) {
        self.postMessage({
          type: 'export-result' as const,
          requestId,
          error: 'No results to export',
        });
        return;
      }

      try {
        // Progressive merge: one at a time into WASM memory
        mergeProgressiveInit();
        for (const r of allResults) {
          mergeProgressiveAdd(r);
        }
        const bytes = await mergeProgressiveExport({
          format: format as 'xlsx' | 'csv' | 'json',
          sheets: exportPayload.sheets,
          compact: exportPayload.compact,
        });

        if (format === 'json') {
          const text = new TextDecoder().decode(bytes);
          self.postMessage({ type: 'export-result' as const, requestId, exportSql: text });
        } else {
          const buf = bytes.buffer as ArrayBuffer;
          const sliced = buf.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
          (self as unknown as Worker).postMessage(
            { type: 'export-result' as const, requestId, exportBytes: sliced },
            [sliced]
          );
        }
      } catch (error) {
        self.postMessage({
          type: 'export-result' as const,
          requestId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    if (!payload) {
      const response: AnalysisWorkerResponse = {
        type: type === 'get-cache' ? 'cache-result' : 'analyze-result',
        requestId,
        error: 'Missing analysis payload',
      };
      self.postMessage(response);
      return;
    }

    await ensureWasmReady();

    if (type === 'get-cache') {
      const cacheResponse = await getCachedAnalysis(payload);
      cacheResponse.requestId = requestId;
      self.postMessage(cacheResponse);
      return;
    }

    const resolvedCacheMaxBytes = cacheMaxBytes ?? ANALYSIS_CACHE_MAX_BYTES;
    const analysisResponse = await runAnalysis(payload, resolvedCacheMaxBytes, knownCacheKey);
    analysisResponse.requestId = requestId;
    self.postMessage(analysisResponse);
  } catch (error) {
    const response: AnalysisWorkerResponse = {
      type: type === 'get-cache' ? 'cache-result' : 'analyze-result',
      requestId,
      error: error instanceof Error ? error.message : String(error),
      // Include error code for programmatic handling without string matching
      errorCode: error instanceof WorkerError ? error.code : undefined,
    };
    self.postMessage(response);
  }
};
