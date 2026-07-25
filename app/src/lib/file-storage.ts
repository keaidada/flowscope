/**
 * SQLite-based file storage for project files.
 *
 * All storage goes through the Rust backend SQLite via REST API.
 */

import type { ProjectFile } from './project-store';
import * as serverDb from './server-db';

/** Save all files for a project (replaces existing atomically) */
export async function saveProjectFiles(projectId: string, files: ProjectFile[]): Promise<void> {
  await serverDb.saveProjectFiles(projectId, files.map(f => ({
    name: f.name,
    path: f.path,
    content: f.content,
    language: f.language,
    size: f.size || new TextEncoder().encode(f.content).length,
    dialect: f.dialect || '',
    is_procedure: f.isProcedure ? 1 : 0,
    transformed_content: f.transformedContent || '',
    created_at: '',
    updated_at: new Date().toISOString(),
  })));
}

/** Load all files for a project (with content) */
export async function loadProjectFiles(projectId: string): Promise<ProjectFile[]> {
  const files = await serverDb.loadProjectFiles(projectId);
  return files.map(f => ({
    id: f.path,
    name: f.name,
    path: f.path,
    content: f.content,
    language: f.language as ProjectFile['language'],
    size: f.size,
    dialect: (f as any).dialect || '',
    isProcedure: (f as any).is_procedure ? true : false,
    transformedContent: (f as any).transformed_content || '',
  }));
}

/** Load file metadata only (no content — content is '') */
export async function loadProjectFilesMeta(projectId: string): Promise<ProjectFile[]> {
  const files = await serverDb.loadFilesMeta(projectId);
  return files.map(f => ({
    id: f.path,
    name: f.name,
    path: f.path,
    content: '',
    language: (f.language || 'sql') as ProjectFile['language'],
    size: f.size,
    dialect: (f as any).dialect || '',
    isProcedure: (f.is_procedure ?? 0) !== 0,
    transformedContent: (f as any).transformed_content || null,
  }));
}

/** Load content for a single file */
export async function loadFileContent(projectId: string, filePath: string): Promise<{ content: string | null; isProcedure?: boolean; transformedContent?: string | null } | null> {
  const resp = await serverDb.loadFileContent(projectId, filePath);
  if (resp.content === null && resp.is_procedure === null) return null;
  return {
    content: resp.content,
    isProcedure: (resp.is_procedure ?? 0) !== 0,
    transformedContent: resp.transformed_content || null,
  };
}

/** Load content for multiple files (batch) */
export async function loadFileContentsBatch(
  projectId: string,
  paths: string[]
): Promise<Map<string, string>> {
  return serverDb.loadFileContentsBatch(projectId, paths);
}

/** Upsert files incrementally (does NOT delete other files) */
export async function upsertProjectFiles(projectId: string, files: ProjectFile[]): Promise<void> {
  await serverDb.upsertProjectFiles(projectId, files.map(f => ({
    name: f.name,
    path: f.path,
    content: f.content,
    language: f.language,
    size: f.size || new TextEncoder().encode(f.content).length,
    dialect: f.dialect || '',
    is_procedure: f.isProcedure ? 1 : 0,
    transformed_content: f.transformedContent || '',
    created_at: '',
    updated_at: new Date().toISOString(),
  })) as never);
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

/** Delete stored files for a project */
export async function deleteProjectFiles(projectId: string): Promise<void> {
  await serverDb.saveProjectFiles(projectId, []);
}
