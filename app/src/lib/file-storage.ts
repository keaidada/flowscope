/**
 * SQLite-based file storage for project files.
 *
 * All storage goes through the Rust backend SQLite via REST API.
 */

import type { ProjectFile } from './project-store';
import * as serverDb from './server-db';

/** Save all files for a project (replaces existing atomically) */
export async function saveProjectFiles(projectId: string, files: ProjectFile[]): Promise<void> {
  await serverDb.saveProjectFiles(
    projectId,
    files.map((f) => ({
      name: f.name,
      path: f.path,
      content: f.content,
      language: f.language,
      size: f.size || new TextEncoder().encode(f.content).length,
      dialect: f.dialect || '',
      is_procedure: f.isProcedure ? 1 : 0,
      transformed_content: f.transformedContent || '',
      dbt_content: f.dbtContent || '',
      created_at: '',
      updated_at: '',
    }))
  );
}

/** Load all files for a project (with content) */
export async function loadProjectFiles(projectId: string): Promise<ProjectFile[]> {
  const files = await serverDb.loadProjectFiles(projectId);
  return files.map((f) => ({
    id: f.path,
    name: f.name,
    path: f.path,
    content: f.content,
    language: f.language as ProjectFile['language'],
    size: f.size,
    dialect: (f as any).dialect || '',
    isProcedure: (f as any).is_procedure ? true : false,
    transformedContent: (f as any).transformed_content || null,
    dbtContent: (f as any).dbt_content || null,
  }));
}

/** Load file metadata only (no content — content is '') */
export async function loadProjectFilesMeta(projectId: string): Promise<ProjectFile[]> {
  const files = await serverDb.loadFilesMeta(projectId);
  return files.map((f) => ({
    id: f.path,
    name: f.name,
    path: f.path,
    content: '',
    language: (f.language || 'sql') as ProjectFile['language'],
    size: f.size,
    dialect: (f as any).dialect || '',
    isProcedure: (f.is_procedure ?? 0) !== 0,
    transformedContent: (f.has_transformed_content ?? 0) !== 0 ? '' : null,
  }));
}

/** Load content for a single file */
export async function loadFileContent(
  projectId: string,
  filePath: string
): Promise<{
  content: string | null;
  isProcedure?: boolean;
  transformedContent?: string | null;
  dbtContent?: string | null;
} | null> {
  const resp = await serverDb.loadFileContent(projectId, filePath);
  if (resp.content === null && resp.is_procedure === null) return null;
  return {
    content: resp.content,
    isProcedure: (resp.is_procedure ?? 0) !== 0,
    transformedContent: resp.transformed_content || null,
    dbtContent: (resp as any).dbt_content || null,
  };
}

/** Load content for multiple files (batch) */
export async function loadFileContentsBatch(
  projectId: string,
  paths: string[]
): Promise<Map<string, string>> {
  return serverDb.loadFileContentsBatch(projectId, paths);
}

/** Load content + metadata for multiple files (batch, returns transformed_content too) */
export async function loadFileContentsWithMetaBatch(
  projectId: string,
  paths: string[]
): Promise<Map<string, serverDb.FileContentResult>> {
  return serverDb.loadFileContentsWithMetaBatch(projectId, paths);
}

/** Upsert files incrementally (does NOT delete other files) */
export async function upsertProjectFiles(projectId: string, files: ProjectFile[]): Promise<void> {
  await serverDb.upsertProjectFiles(
    projectId,
    files.map((f) => ({
      name: f.name,
      path: f.path,
      content: f.content,
      language: f.language,
      size: f.size || new TextEncoder().encode(f.content).length,
      dialect: f.dialect || '',
      is_procedure: f.isProcedure ? 1 : 0,
      transformed_content: f.transformedContent || '',
      dbt_content: f.dbtContent || '',
      created_at: '',
      updated_at: '',
    })) as never
  );
}

/** Delete files by paths */
export async function deleteProjectFilesByPaths(projectId: string, paths: string[]): Promise<void> {
  await serverDb.deleteProjectFilesByPaths(projectId, paths);
}

/** Rename a file or folder server-side (metadata-only, no content needed) */
export async function renameProjectFile(
  projectId: string,
  oldPath: string,
  newPath: string,
  newName: string,
  isFolder: boolean
): Promise<void> {
  await serverDb.renameProjectFile(projectId, oldPath, newPath, newName, isFolder);
}

// ── dbt fusion API helpers ─────────────────────────────────────────────

function apiBase(): string {
  if (typeof window !== 'undefined') {
    const port = (window as unknown as { __FSCOPE_PORT__?: number }).__FSCOPE_PORT__;
    if (port) return `http://localhost:${port}`;
  }
  return '';
}

/** Convert a SQL file to dbt format */
export async function convertToDbt(
  projectId: string,
  filePath: string
): Promise<{ dbt_content: string; model_count: number; source_count: number; warnings: string[] }> {
  const res = await fetch(`${apiBase()}/api/convert-dbt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_id: projectId, file_path: filePath }),
  });
  if (!res.ok) throw new Error(`Convert failed: ${res.status}`);
  return res.json();
}

/** Batch convert a folder's SQL files to dbt in one request.
 *  Passes file contents as fallback (used when DB content is empty).
 */
export async function convertToDbtBatch(
  projectId: string,
  folderPath: string,
  files: { path: string; content: string }[]
): Promise<{
  success: number;
  errors: number;
  skipped: number;
  total: number;
  successPaths: string[];
  errorPaths: string[];
}> {
  const res = await fetch(`${apiBase()}/api/convert-dbt-batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_id: projectId, folder_path: folderPath, files }),
  });
  if (!res.ok) throw new Error(`Batch convert failed: ${res.status}`);
  return res.json();
}

/** Extract DML statements from a SQL file */
export async function extractDml(
  projectId: string,
  filePath: string
): Promise<{ statements: string[]; count: number }> {
  const res = await fetch(`${apiBase()}/api/extract-dml`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_id: projectId, file_path: filePath }),
  });
  if (!res.ok) throw new Error(`Extract DML failed: ${res.status}`);
  return res.json();
}

/** Save dbt_content for a file */
export async function saveDbtContent(
  projectId: string,
  filePath: string,
  dbtContent: string
): Promise<void> {
  const res = await fetch(`${apiBase()}/api/files/dbt-content`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_id: projectId, file_path: filePath, dbt_content: dbtContent }),
  });
  if (!res.ok) throw new Error(`Save dbt failed: ${res.status}`);
}

/** Delete stored files for a project */
export async function deleteProjectFiles(projectId: string): Promise<void> {
  await serverDb.saveProjectFiles(projectId, []);
}
