/**
 * Lazy file content loader.
 * During folder upload, we store File references here instead of reading content immediately.
 * When the file is first accessed (opened in editor), we read its content on demand.
 */

const pendingFiles = new Map<string, File>();

/** Register a File reference for lazy loading */
export function registerPendingFile(fileId: string, file: File): void {
  pendingFiles.set(fileId, file);
}

/** Register multiple File references at once */
export function registerPendingFiles(entries: Array<{ id: string; file: File }>): void {
  for (const { id, file } of entries) {
    pendingFiles.set(id, file);
  }
}

/** Check if a file has pending (unread) content */
export function hasPendingContent(fileId: string): boolean {
  return pendingFiles.has(fileId);
}

/**
 * Load the actual content of a pending file.
 * Returns the content string, or null if no pending file exists.
 * Once loaded, the pending reference is removed.
 */
export async function loadPendingContent(fileId: string): Promise<string | null> {
  const file = pendingFiles.get(fileId);
  if (!file) return null;
  const content = await file.text();
  pendingFiles.delete(fileId);
  return content;
}

/** Clear all pending files (e.g., on project switch) */
export function clearPendingFiles(): void {
  pendingFiles.clear();
}

/** Get count of pending files */
export function getPendingCount(): number {
  return pendingFiles.size;
}
