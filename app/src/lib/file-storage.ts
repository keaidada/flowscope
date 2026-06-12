/**
 * SQLite-WASM based file storage for project files.
 * Each file is a row — partial updates are cheap.
 */

import type { ProjectFile } from './project-store';
import { getDb, esc, persist } from './duckdb';

/** Save all files for a project (replaces existing) */
export async function saveProjectFiles(projectId: string, files: ProjectFile[]): Promise<void> {
  try {
    const db = await getDb();
    db.run(`DELETE FROM project_files WHERE project_id = '${esc(projectId)}'`);

    if (files.length === 0) {
      persist();
      return;
    }

    db.run('BEGIN TRANSACTION');
    const stmt = db.prepare(
      'INSERT INTO project_files (project_id, file_id, name, path, content, language) VALUES (?, ?, ?, ?, ?, ?)'
    );
    for (const f of files) {
      stmt.run([projectId, f.id, f.name, f.path, f.content, f.language]);
    }
    stmt.free();
    db.run('COMMIT');
    persist();
  } catch (error) {
    console.error(`[file-storage] Failed to save files for project ${projectId}:`, error);
  }
}

/** Load all files for a project */
export async function loadProjectFiles(projectId: string): Promise<ProjectFile[]> {
  try {
    const db = await getDb();
    const stmt = db.prepare(
      `SELECT file_id, name, path, content, language FROM project_files WHERE project_id = ? ORDER BY path`
    );
    stmt.bind([projectId]);

    const rows: ProjectFile[] = [];
    while (stmt.step()) {
      const row = stmt.get();
      rows.push({
        id: String(row[0]),
        name: String(row[1]),
        path: String(row[2]),
        content: String(row[3]),
        language: String(row[4]) as ProjectFile['language'],
      });
    }
    stmt.free();
    return rows;
  } catch (error) {
    console.error(`[file-storage] Failed to load files for project ${projectId}:`, error);
    return [];
  }
}

/** Delete stored files for a project */
export async function deleteProjectFiles(projectId: string): Promise<void> {
  try {
    const db = await getDb();
    db.run(`DELETE FROM project_files WHERE project_id = '${esc(projectId)}'`);
    persist();
  } catch (error) {
    console.error(`[file-storage] Failed to delete files for project ${projectId}:`, error);
  }
}
