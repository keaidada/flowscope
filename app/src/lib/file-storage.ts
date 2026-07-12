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
    created_at: Date.now(),
    updated_at: Date.now(),
  })));
}

/** Load all files for a project */
export async function loadProjectFiles(projectId: string): Promise<ProjectFile[]> {
  const files = await serverDb.loadProjectFiles(projectId);
  return files.map(f => ({
    id: f.path,  // use path as stable identifier
    name: f.name,
    path: f.path,
    content: f.content,
    language: f.language as ProjectFile['language'],
    size: f.size,
  }));
}

/** Delete stored files for a project */
export async function deleteProjectFiles(projectId: string): Promise<void> {
  await serverDb.saveProjectFiles(projectId, []);
}
