/**
 * Backend adapter for FlowScope analysis (REST only).
 *
 * All analysis runs through the Rust CLI backend via REST API.
 * SQLite persistence is handled by the backend.
 */

import type { AnalyzeResult, Dialect } from '@pondpilot/flowscope-core';
import type { TemplateMode } from '@/types';

export interface AnalysisFile {
  name: string;
  content: string;
  isProcedure?: boolean;
  transformedContent?: string | null;
}

export interface AnalysisPayload {
  files: AnalysisFile[];
  dialect: Dialect;
  schemaSQL: string;
  hideCTEs: boolean;
  enableColumnLineage: boolean;
  enableLinting?: boolean;
  templateMode?: TemplateMode;
}

export interface AnalysisResult {
  result: AnalyzeResult | null;
  cacheKey: string;
  cacheHit: boolean;
  skipped: boolean;
  timings: {
    totalMs: number;
    cacheReadMs: number;
    schemaParseMs: number;
    analyzeMs: number;
  } | null;
}

export interface BackendAdapter {
  readonly type: 'rest';
  initialize(): Promise<void>;
  analyze(payload: AnalysisPayload): Promise<AnalysisResult>;
  getCached(_payload: AnalysisPayload): Promise<AnalysisResult | null>;
  getVersion(): Promise<string | null>;
  syncFiles(_files: Array<{ name: string; content: string }>): Promise<void>;
  clearCache(): Promise<void>;
}

export interface BackendDetectionResult {
  adapter: BackendAdapter;
  detectedType: 'rest';
}

export class RestBackendAdapter implements BackendAdapter {
  readonly type = 'rest' as const;
  private baseUrl: string;
  private version: string | null = null;

  constructor(baseUrl: string = '') {
    this.baseUrl = baseUrl;
  }

  async initialize(): Promise<void> {
    const response = await fetch(`${this.baseUrl}/api/health`);
    if (!response.ok) {
      throw new Error(`Health check failed: ${response.status}`);
    }
    const data = await response.json();
    this.version = data.version || null;
  }

  async analyze(payload: AnalysisPayload): Promise<AnalysisResult> {
    const startTime = performance.now();

    const response = await fetch(`${this.baseUrl}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sql: '',
        files: payload.files.map((f) => ({
          name: f.name,
          content: f.content,
          isProcedure: f.isProcedure || false,
          transformedContent: f.transformedContent || null,
        })),
        dialect: payload.dialect,
        hide_ctes: payload.hideCTEs,
        enable_column_lineage: payload.enableColumnLineage,
        enable_linting: payload.enableLinting ?? false,
        template_mode: payload.templateMode,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Analysis failed: ${error}`);
    }

    const result = (await response.json()) as AnalyzeResult;
    const totalMs = performance.now() - startTime;

    return {
      result,
      cacheKey: '',
      cacheHit: false,
      skipped: false,
      timings: {
        totalMs,
        cacheReadMs: 0,
        schemaParseMs: 0,
        analyzeMs: totalMs,
      },
    };
  }

  async getCached(): Promise<AnalysisResult | null> {
    return null;
  }

  async getVersion(): Promise<string | null> {
    return this.version;
  }

  async syncFiles(): Promise<void> {
    // REST backend doesn't need file syncing
  }

  async clearCache(): Promise<void> {
    // REST backend doesn't maintain a client-side cache
  }
}

/**
 * Always use REST backend. No fallback to WASM.
 */
export async function createBackendAdapter(restBaseUrl = ''): Promise<BackendDetectionResult> {
  const adapter = new RestBackendAdapter(restBaseUrl);
  await adapter.initialize();
  return { adapter, detectedType: 'rest' };
}

/** Always true — serve mode is the only supported mode now. */
export async function isRestBackendAvailable(_baseUrl = ''): Promise<boolean> {
  return true;
}

// ── Project export (REST) ─────────────────────────────────────────────

async function readProjectExportResponse(
  response: Response,
  format: 'xlsx' | 'csv' | 'json'
): Promise<{ data: Uint8Array | string; contentType: string }> {
  const contentType = response.headers.get('content-type') || 'application/octet-stream';
  if (format === 'json') {
    return { data: await response.text(), contentType };
  }
  return { data: new Uint8Array(await response.arrayBuffer()), contentType };
}

export async function projectExportViaBackend(
  baseUrl: string,
  results: AnalyzeResult[],
  format: 'xlsx' | 'csv' | 'json',
  options: { sheets?: string[]; compact?: boolean } = {}
): Promise<{ data: Uint8Array | string; contentType: string } | null> {
  try {
    const response = await fetch(`${baseUrl}/api/project-export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        results,
        format,
        sheets: options.sheets ?? null,
        compact: options.compact ?? false,
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) return null;
    return await readProjectExportResponse(response, format);
  } catch (err) {
    console.error('[backend-adapter] project-export error:', err);
    return null;
  }
}

export async function projectExportStreamViaBackend(
  baseUrl: string,
  resultJsons: AsyncIterable<string>,
  format: 'xlsx' | 'csv' | 'json',
  options: { sheets?: string[]; compact?: boolean; injectLineage?: (json: string) => string } = {}
): Promise<{ data: Uint8Array | string; contentType: string } | null> {
  let sessionId: string | null = null;
  try {
    const startResponse = await fetch(`${baseUrl}/api/project-export/start`, {
      method: 'POST',
      signal: AbortSignal.timeout(30_000),
    });
    if (!startResponse.ok) return null;
    const startData = (await startResponse.json()) as { session_id: string };
    sessionId = startData.session_id;

    const inject = options.injectLineage;
    for await (const resultJson of resultJsons) {
      const body = inject ? inject(resultJson) : resultJson;
      const addResponse = await fetch(`${baseUrl}/api/project-export/${sessionId}/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(120_000),
      });
      if (!addResponse.ok) return null;
    }

    const finishResponse = await fetch(`${baseUrl}/api/project-export/${sessionId}/finish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        format,
        sheets: options.sheets ?? null,
        compact: options.compact ?? false,
      }),
    });
    if (!finishResponse.ok) return null;

    return await readProjectExportResponse(finishResponse, format);
  } catch (err) {
    console.error('[backend-adapter] project-export streaming error:', err);
    return null;
  }
}
