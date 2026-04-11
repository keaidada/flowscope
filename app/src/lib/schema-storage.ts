/**
 * IndexedDB-based storage for schema files.
 * Mirrors the pattern in file-storage.ts but uses a separate store
 * so schema files are independent of project SQL files.
 */

export interface StoredSchemaFile {
  id: string;
  name: string;
  path: string;
  content: string;
}

const DB_NAME = 'flowscope-schema';
const DB_VERSION = 1;
const STORE_NAME = 'schema-files';

let cachedDB: IDBDatabase | null = null;

function openDB(): Promise<IDBDatabase> {
  if (cachedDB) return Promise.resolve(cachedDB);

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => {
      cachedDB = request.result;
      cachedDB.onclose = () => {
        cachedDB = null;
      };
      resolve(cachedDB);
    };
    request.onerror = () => reject(request.error);
  });
}

/** Save schema files for a project */
export async function saveSchemaFiles(projectId: string, files: StoredSchemaFile[]): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put(files, projectId);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (error) {
    console.error(`[schema-storage] Failed to save schema files for project ${projectId}:`, error);
  }
}

/** Load schema files for a project */
export async function loadSchemaFiles(projectId: string): Promise<StoredSchemaFile[]> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(projectId);
    const result = await new Promise<StoredSchemaFile[] | undefined>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return result || [];
  } catch (error) {
    console.error(`[schema-storage] Failed to load schema files for project ${projectId}:`, error);
    return [];
  }
}

/** Delete stored schema files for a project */
export async function deleteSchemaFiles(projectId: string): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.delete(projectId);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (error) {
    console.error(
      `[schema-storage] Failed to delete schema files for project ${projectId}:`,
      error
    );
  }
}
