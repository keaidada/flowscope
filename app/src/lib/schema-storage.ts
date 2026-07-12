/**
 * SQLite-based storage for schema files.
 *
 * All storage goes through the Rust backend SQLite via REST API.
 */

import * as serverDb from './server-db';

export interface StoredSchemaFile {
  id: string;
  name: string;
  path: string;
  content: string;
}

/** Save schema files for a project (replaces existing) */
export async function saveSchemaFiles(projectId: string, files: StoredSchemaFile[]): Promise<void> {
  await serverDb.saveSchemaFiles(projectId, files.map(f => ({
    name: f.name,
    path: f.path,
    content: f.content,
    size: new TextEncoder().encode(f.content).length,
    created_at: Date.now(),
    updated_at: Date.now(),
  })));
  // Table/column metadata is extracted by the Rust backend
  // when POST /api/db/schema-files is called.
}

/** Load schema files for a project */
export async function loadSchemaFiles(projectId: string): Promise<StoredSchemaFile[]> {
  const files = await serverDb.loadSchemaFiles(projectId);
  return files.map(f => ({
    id: f.path,  // use path as stable identifier
    name: f.name,
    path: f.path,
    content: f.content,
  }));
}

/** Delete stored schema files for a project */
export async function deleteSchemaFiles(projectId: string): Promise<void> {
  await serverDb.saveSchemaFiles(projectId, []);
}
