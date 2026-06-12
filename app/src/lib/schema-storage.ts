/**
 * SQLite-WASM based storage for schema files.
 */

import { getDb, esc, persist } from './duckdb';

export interface StoredSchemaFile {
  id: string;
  name: string;
  path: string;
  content: string;
}

/** Save schema files for a project (replaces existing) */
export async function saveSchemaFiles(projectId: string, files: StoredSchemaFile[]): Promise<void> {
  try {
    const db = await getDb();
    db.run(`DELETE FROM schema_files WHERE project_id = '${esc(projectId)}'`);

    if (files.length === 0) {
      persist();
      return;
    }

    db.run('BEGIN TRANSACTION');
    const stmt = db.prepare(
      'INSERT INTO schema_files (project_id, file_id, name, path, content) VALUES (?, ?, ?, ?, ?)'
    );
    for (const f of files) {
      stmt.run([projectId, f.id, f.name, f.path, f.content]);
    }
    stmt.free();
    db.run('COMMIT');
    persist();
  } catch (error) {
    console.error(`[schema-storage] Failed to save schema files for project ${projectId}:`, error);
  }
}

/** Load schema files for a project */
export async function loadSchemaFiles(projectId: string): Promise<StoredSchemaFile[]> {
  try {
    const db = await getDb();
    const stmt = db.prepare(
      `SELECT file_id, name, path, content FROM schema_files WHERE project_id = ? ORDER BY path`
    );
    stmt.bind([projectId]);

    const rows: StoredSchemaFile[] = [];
    while (stmt.step()) {
      const row = stmt.get();
      rows.push({
        id: String(row[0]),
        name: String(row[1]),
        path: String(row[2]),
        content: String(row[3]),
      });
    }
    stmt.free();
    return rows;
  } catch (error) {
    console.error(`[schema-storage] Failed to load schema files for project ${projectId}:`, error);
    return [];
  }
}

/** Delete stored schema files for a project */
export async function deleteSchemaFiles(projectId: string): Promise<void> {
  try {
    const db = await getDb();
    db.run(`DELETE FROM schema_files WHERE project_id = '${esc(projectId)}'`);
    persist();
  } catch (error) {
    console.error(
      `[schema-storage] Failed to delete schema files for project ${projectId}:`,
      error
    );
  }
}
