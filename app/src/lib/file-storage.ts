/**
 * SQLite-WASM based file storage for project files.
 * Each file is a row — partial updates are cheap.
 */

import type { ProjectFile } from './project-store';
import { getDb, esc, flushPersistNow } from './duckdb';

/** Save all files for a project (replaces existing atomically) */
export async function saveProjectFiles(projectId: string, files: ProjectFile[]): Promise<void> {
  const db = await getDb();

  // Wrap DELETE + INSERTs in a single transaction for atomicity
  db.run('BEGIN TRANSACTION');
  try {
    db.run(`DELETE FROM project_files WHERE project_id = '${esc(projectId)}'`);

    if (files.length > 0) {
      const stmt = db.prepare(
        'INSERT INTO project_files (project_id, file_id, name, path, content, language) VALUES (?, ?, ?, ?, ?, ?)'
      );
      for (const f of files) {
        try {
          console.log('[file-storage] saving file:', { projectId, fileId: f.id, path: f.path });
        } catch (_) { /* ignore log error */ }
        stmt.run([projectId, f.id, f.name, f.path, f.content, f.language]);
      }
      stmt.free();
    }

    db.run('COMMIT');
  } catch (error) {
    // Rollback on any error to preserve existing data
    try { db.run('ROLLBACK'); } catch (_) { /* best effort */ }
    console.error(`[file-storage] Failed to save files for project ${projectId}:`, error);
    throw error;
  }

  // Persist SQLite DB to OPFS/IndexedDB — this can fail if storage is full
  try {
    await flushPersistNow();
  } catch (persistError) {
    console.error('[file-storage] DB persist failed after commit:', persistError);
    // The transaction already committed to the in-memory DB; the persist error
    // means the data won't survive a page refresh.
    throw new Error('存储空间不足或写入失败，刷新页面后数据可能丢失。请检查磁盘空间。');
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
    console.log(`[file-storage] loaded ${rows.length} files for project ${projectId}`);
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
    await flushPersistNow();
  } catch (error) {
    console.error(`[file-storage] Failed to delete files for project ${projectId}:`, error);
    throw error;
  }
}
