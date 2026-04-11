/**
 * Simple event bus for cross-component communication.
 * Used to notify SidebarSchema to select a specific file from search results.
 */

export interface SchemaFileSelectPayload {
  fileId: string;
  /** Character offset span to highlight in the editor */
  span?: { start: number; end: number };
}

type SchemaFileSelectHandler = (payload: SchemaFileSelectPayload) => void;

const handlers = new Set<SchemaFileSelectHandler>();

export function onSchemaFileSelect(handler: SchemaFileSelectHandler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

export function emitSchemaFileSelect(payload: SchemaFileSelectPayload): void {
  for (const handler of handlers) {
    handler(payload);
  }
}
