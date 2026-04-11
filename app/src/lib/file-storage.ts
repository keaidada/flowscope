/**
 * IndexedDB-based file storage for project files.
 * Unlike localStorage (5-10MB, synchronous, blocks UI),
 * IndexedDB supports hundreds of MB and is fully async.
 */

import type { ProjectFile } from './project-store';

const DB_NAME = 'flowscope-files';
const DB_VERSION = 1;
const STORE_NAME = 'project-files';

/** Cached DB connection — reuse instead of opening every time */
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

/** Save all files for a project */
export async function saveProjectFiles(projectId: string, files: ProjectFile[]): Promise<void> {
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
    console.error(`[file-storage] Failed to save files for project ${projectId}:`, error);
  }
}

/** Load all files for a project */
export async function loadProjectFiles(projectId: string): Promise<ProjectFile[]> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(projectId);
    const result = await new Promise<ProjectFile[] | undefined>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return result || [];
  } catch (error) {
    console.error(`[file-storage] Failed to load files for project ${projectId}:`, error);
    return [];
  }
}

/** Delete stored files for a project */
export async function deleteProjectFiles(projectId: string): Promise<void> {
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
    console.error(`[file-storage] Failed to delete files for project ${projectId}:`, error);
  }
}
