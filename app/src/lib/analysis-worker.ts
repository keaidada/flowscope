import type { AnalyzeResult } from '@pondpilot/flowscope-core';
import type {
  AnalysisWorkerPayload,
  AnalysisWorkerRequest,
  AnalysisWorkerResponse,
  AnalysisWorkerTimings,
  ExportPayload,
  SyncFilesPayload,
  WorkerErrorCode,
} from '../workers/analysis.worker';
import { buildFileSyncKey } from './analysis-hash';
import { AnalysisError, AnalysisErrorCode } from '../types';

// Debug flag for analysis worker logging - only enabled in development
const ANALYSIS_WORKER_DEBUG = !!(import.meta as { env?: { DEV?: boolean } }).env?.DEV;

// Safe time measurement function with fallback
function nowMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

/**
 * Map worker error codes to application error codes.
 * This keeps the error handling consistent across the application.
 */
function mapWorkerErrorCode(code: WorkerErrorCode | undefined): AnalysisErrorCode | undefined {
  if (!code) return undefined;
  // WorkerErrorCode values match AnalysisErrorCode values by design
  return code as AnalysisErrorCode;
}

interface PendingRequest {
  resolve: (value: AnalysisWorkerResponse) => void;
  reject: (error: Error) => void;
  onProgress?: (progress: BatchProgress) => void;
}

export interface BatchProgress {
  batchProgress?: string | null;
  batchFile?: string;
  batchIndex?: number;
  batchTotal?: number;
  completedFiles?: number;
  totalFiles?: number;
}

export interface AnalysisWorkerResult {
  result: AnalyzeResult | null;
  cacheKey: string;
  cacheHit: boolean;
  skipped: boolean;
  timings: AnalysisWorkerTimings | null;
}

let workerInstance: Worker | null = null;
let requestCounter = 0;
const pendingRequests = new Map<string, PendingRequest>();
let lastSyncedFileKey: string | null = null;

function isWorkerSupported(): boolean {
  return typeof Worker !== 'undefined';
}

function getWorker(): Worker {
  if (!workerInstance) {
    workerInstance = new Worker(new URL('../workers/analysis.worker.ts', import.meta.url), {
      type: 'module',
    });

    workerInstance.onmessage = (event: MessageEvent<AnalysisWorkerResponse>) => {
      const response = event.data;

      // Batch progress updates: forward to callback without resolving the pending request
      if (response.type === 'batch-progress') {
        for (const [, pending] of pendingRequests) {
          pending.onProgress?.({
            batchProgress: response.batchProgress,
            batchFile: response.batchFile,
            batchIndex: response.batchIndex,
            batchTotal: response.batchTotal,
            completedFiles: response.completedFiles,
            totalFiles: response.totalFiles,
          });
        }
        return;
      }

      const pending = pendingRequests.get(response.requestId);
      if (!pending) {
        return;
      }
      pendingRequests.delete(response.requestId);

      if (response.error) {
        // Create structured error with code for programmatic handling
        const errorCode = mapWorkerErrorCode(response.errorCode);
        if (errorCode) {
          pending.reject(new AnalysisError(errorCode, response.error));
        } else {
          pending.reject(new Error(response.error));
        }
        return;
      }

      pending.resolve(response);
    };

    workerInstance.onerror = (error) => {
      for (const [requestId, pending] of pendingRequests) {
        pending.reject(new Error(`Worker error: ${error.message}`));
        pendingRequests.delete(requestId);
      }
    };
  }

  return workerInstance;
}

function sendRequest(
  message: Omit<AnalysisWorkerRequest, 'requestId'>,
  onProgress?: (progress: BatchProgress) => void
): Promise<AnalysisWorkerResponse> {
  if (!isWorkerSupported()) {
    return Promise.reject(new Error('Web Workers are not supported in this environment'));
  }

  const requestId = `analysis-${(requestCounter += 1)}`;
  const worker = getWorker();

  return new Promise((resolve, reject) => {
    pendingRequests.set(requestId, { resolve, reject, onProgress });
    worker.postMessage({ ...message, requestId });
  });
}

async function yieldToMainThread(): Promise<void> {
  await new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame !== 'undefined') {
      requestAnimationFrame(() => resolve());
      return;
    }
    setTimeout(resolve, 0);
  });
}

export async function syncAnalysisFiles(files: SyncFilesPayload['files']): Promise<void> {
  const syncStart = nowMs();
  const nextKey = buildFileSyncKey({ files });
  if (nextKey === lastSyncedFileKey) {
    if (ANALYSIS_WORKER_DEBUG)
      console.log(`[syncAnalysisFiles] Skipped (cache hit), ${files.length} files`);
    return;
  }

  if (ANALYSIS_WORKER_DEBUG)
    console.log(`[syncAnalysisFiles] Starting sync of ${files.length} files`);

  if (files.length === 0) {
    await sendRequest({ type: 'clear-files' });
    lastSyncedFileKey = nextKey;
    if (ANALYSIS_WORKER_DEBUG)
      console.log(`[syncAnalysisFiles] Cleared files in ${(nowMs() - syncStart).toFixed(1)}ms`);
    return;
  }

  const chunkSize = 5;
  for (let index = 0; index < files.length; index += chunkSize) {
    const chunk = files.slice(index, index + chunkSize);
    await sendRequest({
      type: 'sync-files',
      syncPayload: {
        files: chunk,
        replace: index === 0,
      },
    });
    await yieldToMainThread();
  }

  lastSyncedFileKey = nextKey;
  if (ANALYSIS_WORKER_DEBUG)
    console.log(`[syncAnalysisFiles] Completed in ${(nowMs() - syncStart).toFixed(1)}ms`);
}

export async function initializeAnalysisWorker(): Promise<void> {
  await sendRequest({ type: 'init' });
}

export async function clearAnalysisWorkerCache(): Promise<void> {
  await sendRequest({ type: 'clear-cache' });
}

export interface AnalyzeWorkerOptions {
  cacheMaxBytes?: number;
  knownCacheKey?: string | null;
  /** Called when the worker posts batch progress updates */
  onProgress?: (progress: BatchProgress) => void;
}

export async function analyzeWithWorker(
  payload: AnalysisWorkerPayload,
  options?: AnalyzeWorkerOptions
): Promise<AnalysisWorkerResult> {
  const response = await sendRequest({
    type: 'analyze',
    payload,
    cacheMaxBytes: options?.cacheMaxBytes,
    knownCacheKey: options?.knownCacheKey,
  }, options?.onProgress);

  if (!response.cacheKey) {
    throw new Error('Worker returned an empty cache key');
  }

  const skipped = Boolean(response.skipResult);
  if (!response.result && !skipped) {
    throw new Error('Worker returned an empty analysis result');
  }

  return {
    result: response.result ?? null,
    cacheKey: response.cacheKey,
    cacheHit: Boolean(response.cacheHit),
    skipped,
    timings: response.timings ?? null,
  };
}

export async function getCachedAnalysis(
  payload: AnalysisWorkerPayload
): Promise<AnalysisWorkerResult | null> {
  const response = await sendRequest({ type: 'get-cache', payload });

  if (!response.result || !response.cacheKey) {
    return null;
  }

  return {
    result: response.result,
    cacheKey: response.cacheKey,
    cacheHit: Boolean(response.cacheHit),
    skipped: false,
    timings: response.timings ?? null,
  };
}

export async function getAnalysisWorkerVersion(): Promise<string | null> {
  const response = await sendRequest({ type: 'get-version' });
  return response.version ?? null;
}

export function terminateAnalysisWorker(): void {
  if (workerInstance) {
    workerInstance.terminate();
    workerInstance = null;
  }
  lastSyncedFileKey = null;
  for (const [requestId, pending] of pendingRequests) {
    pending.reject(new Error('Worker terminated'));
    pendingRequests.delete(requestId);
  }
}

/**
 * Export analysis result to SQL statements for DuckDB.
 *
 * @param result - The analysis result to export
 * @param schema - Optional schema name to prefix all tables/views (e.g., "lineage")
 * @returns SQL statements (DDL + INSERT) for DuckDB
 */
export async function exportToDuckDbSql(result: AnalyzeResult, schema?: string): Promise<string> {
  const response = await sendExportRequest({
    result,
    schema,
    format: 'duckdb',
  });

  if (!response.exportSql) {
    throw new Error('Worker returned empty export SQL');
  }

  return response.exportSql;
}

/**
 * Export analysis result as XLSX via worker (off main thread).
 * Accepts either a single result or an array of results to merge in the worker.
 */
export async function exportToXlsxWorker(
  result: AnalyzeResult | AnalyzeResult[],
  sheets?: string[]
): Promise<Uint8Array> {
  const payload = Array.isArray(result)
    ? { results: result, format: 'xlsx' as const, sheets }
    : { result, format: 'xlsx' as const, sheets };
  const response = await sendExportRequest(payload);

  if (!response.exportBytes) {
    throw new Error('Worker returned empty XLSX data');
  }

  return new Uint8Array(response.exportBytes);
}

/**
 * Export analysis result as CSV ZIP via worker (off main thread).
 * Accepts either a single result or an array of results to merge in the worker.
 */
export async function exportToCsvWorker(
  result: AnalyzeResult | AnalyzeResult[],
  sheets?: string[]
): Promise<Uint8Array> {
  const payload = Array.isArray(result)
    ? { results: result, format: 'csv' as const, sheets }
    : { result, format: 'csv' as const, sheets };
  const response = await sendExportRequest(payload);

  if (!response.exportBytes) {
    throw new Error('Worker returned empty CSV data');
  }

  return new Uint8Array(response.exportBytes);
}

/**
 * Export analysis result as JSON via worker (off main thread).
 * Accepts either a single result or an array of results to merge in the worker.
 */
export async function exportToJsonWorker(
  result: AnalyzeResult | AnalyzeResult[],
  options: { compact?: boolean; sheets?: string[] } = {}
): Promise<string> {
  const payload = Array.isArray(result)
    ? { results: result, format: 'json' as const, sheets: options.sheets, compact: options.compact }
    : { result, format: 'json' as const, sheets: options.sheets, compact: options.compact };
  const response = await sendExportRequest(payload);

  if (!response.exportSql) {
    throw new Error('Worker returned empty JSON');
  }

  return response.exportSql;
}

/**
 * Send an export request that may return binary data via transferable ArrayBuffer.
 */
async function sendExportRequest(
  payload: {
    result?: AnalyzeResult;
    results?: AnalyzeResult[];
    schema?: string;
    format?: 'duckdb' | 'xlsx' | 'csv' | 'json';
    sheets?: string[];
    compact?: boolean;
  }
): Promise<AnalysisWorkerResponse & { exportBytes?: ArrayBuffer }> {
  if (!isWorkerSupported()) {
    throw new Error('Web Workers are not supported in this environment');
  }

  const requestId = `export-${(requestCounter += 1)}`;
  const worker = getWorker();

  return new Promise((resolve, reject) => {
    const handleMessage = (event: MessageEvent<AnalysisWorkerResponse>) => {
      const response = event.data;
      if (response.requestId !== requestId) return;

      worker.removeEventListener('message', handleMessage);

      if (response.error) {
        const errorCode = mapWorkerErrorCode(response.errorCode);
        if (errorCode) {
          reject(new AnalysisError(errorCode, response.error));
        } else {
          reject(new Error(response.error));
        }
        return;
      }

      // Capture the transferred bytes if present
      resolve({ ...response, exportBytes: event.data?.exportBytes });
    };

    worker.addEventListener('message', handleMessage);
    worker.postMessage({
      type: 'export' as const,
      requestId,
      exportPayload: {
        result: payload.result,
        results: payload.results,
        schema: payload.schema,
        format: payload.format ?? 'duckdb',
        sheets: payload.sheets,
        compact: payload.compact,
      } as ExportPayload,
    });
  });
}

/**
 * Streaming export: sends results one at a time to the worker to avoid
 * structured-clone OOM when merging large AnalyzeResult arrays.
 *
 * @param results - Array of AnalyzeResult objects (sent one-by-one to worker)
 * @param format - Export format
 * @param options - Sheets selection, compact JSON flag
 */
export async function exportStream(
  results: AnalyzeResult[],
  format: 'xlsx' | 'csv' | 'json',
  options: { sheets?: string[]; compact?: boolean } = {}
): Promise<Uint8Array | string> {
  if (!isWorkerSupported()) {
    throw new Error('Web Workers are not supported in this environment');
  }

  if (results.length === 0) {
    throw new Error('No results to export');
  }

  const requestId = `export-stream-${(requestCounter += 1)}`;
  const worker = getWorker();

  return new Promise((resolve, reject) => {
    const handleMessage = (event: MessageEvent<AnalysisWorkerResponse>) => {
      const response = event.data;
      if (response.requestId !== requestId) return;

      worker.removeEventListener('message', handleMessage);

      if (response.error) {
        reject(new Error(response.error));
        return;
      }

      if (response.exportBytes) {
        resolve(new Uint8Array(response.exportBytes));
      } else if (response.exportSql) {
        resolve(response.exportSql);
      } else {
        reject(new Error('Worker returned empty export data'));
      }
    };

    worker.addEventListener('message', handleMessage);

    // Send start
    // #region debug-point O:stream-start-sent
    fetch("http://127.0.0.1:7777/event",{method:"POST",body:JSON.stringify({sessionId:"export-csv-failure",runId:"post-fix",hypothesisId:"O",location:"analysis-worker.ts:streamStart",msg:`[DEBUG] export stream start sent format=${format}`,data:{format},ts:Date.now()})}).catch(()=>{});
    // #endregion
    worker.postMessage({
      type: 'export-stream-start' as const,
      requestId,
      exportStartPayload: {
        format,
        sheets: options.sheets,
        compact: options.compact,
        totalChunks: results.length,
      },
    });

    // Send chunks (stringified to bypass structured-clone OOM)
    for (const result of results) {
      worker.postMessage({
        type: 'export-stream-chunk' as const,
        requestId,
        exportChunkPayload: { resultJson: JSON.stringify(result) },
      });
    }

    // Send finish
    worker.postMessage({
      type: 'export-stream-finish' as const,
      requestId,
    });
  });
}

type ExportStreamChunkFn = () => Promise<AnalyzeResult | null>;

/**
 * Streaming export with a lazy iterator — each result is fetched on demand
 * and immediately sent to the worker. The main thread never holds more
 * than one result at a time.
 *
 * @param next - Async function returning next result or null when done
 * @param format - Export format
 * @param options - Sheets selection, compact JSON flag
 */
export async function exportStreamLazy(
  next: ExportStreamChunkFn,
  format: 'xlsx' | 'csv' | 'json',
  options: { sheets?: string[]; compact?: boolean } = {}
): Promise<Uint8Array | string> {
  if (!isWorkerSupported()) {
    throw new Error('Web Workers are not supported in this environment');
  }

  // Ensure the worker has completed its WASM init path before any export-stream messages.
  await initializeAnalysisWorker();

  const requestId = `export-stream-${(requestCounter += 1)}`;
  const worker = getWorker();

  return new Promise((resolve, reject) => {
    let chunkCount = 0;

    const handleMessage = (event: MessageEvent<AnalysisWorkerResponse>) => {
      const response = event.data;
      if (response.requestId !== requestId) return;

      worker.removeEventListener('message', handleMessage);

      if (response.error) {
        reject(new Error(response.error));
        return;
      }

      if (response.exportBytes) {
        resolve(new Uint8Array(response.exportBytes));
      } else if (response.exportSql) {
        resolve(response.exportSql);
      } else {
        reject(new Error('Worker returned empty export data'));
      }
    };

    worker.addEventListener('message', handleMessage);

    // Send start
    worker.postMessage({
      type: 'export-stream-start' as const,
      requestId,
      exportStartPayload: {
        format,
        sheets: options.sheets,
        compact: options.compact,
        totalChunks: 0,
      },
    });

    // Pump chunks — stringify to bypass structured-clone OOM
    const pump = async () => {
      try {
        const result = await next();
        if (result) {
          chunkCount++;
          // Send as JSON string — string postMessage uses zero-copy fast path,
          // entirely bypassing structured clone (prevents browser OOM crash)
          const jsonStr = JSON.stringify(result);
          // #region debug-point P:stream-chunk-sent
          fetch("http://127.0.0.1:7777/event",{method:"POST",body:JSON.stringify({sessionId:"export-csv-failure",runId:"post-fix",hypothesisId:"P",location:"analysis-worker.ts:streamChunk",msg:`[DEBUG] export stream chunk sent format=${format}`,data:{format,chunkCount,jsonSize:jsonStr.length},ts:Date.now()})}).catch(()=>{});
          // #endregion
          worker.postMessage({
            type: 'export-stream-chunk' as const,
            requestId,
            exportChunkPayload: { resultJson: jsonStr },
          });
          queueMicrotask(pump);
        } else {
          if (chunkCount === 0) {
            reject(new Error('No results to export'));
          } else {
            // #region debug-point Q:stream-finish-sent
            fetch("http://127.0.0.1:7777/event",{method:"POST",body:JSON.stringify({sessionId:"export-csv-failure",runId:"post-fix",hypothesisId:"Q",location:"analysis-worker.ts:streamFinish",msg:`[DEBUG] export stream finish sent format=${format}`,data:{format,chunkCount},ts:Date.now()})}).catch(()=>{});
            // #endregion
            worker.postMessage({
              type: 'export-stream-finish' as const,
              requestId,
            });
          }
        }
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    };
    pump();
  });
}
