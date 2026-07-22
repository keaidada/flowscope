/**
 * Module-level cache for DOM-measured handle Y positions.
 * Key: `${nodeId}:${type}:${qname}`  where type is 'r' (read) or 'w' (write)
 * Value: Y offset from node top (px)
 *
 * InsightsScriptNode measures actual row positions after render and writes here.
 * TableEdge reads from here for accurate edge endpoints.
 * Falls back to scriptNodeLayout constants on cache miss.
 */
export const handlePositionCache = new Map<string, number>();

/** Read a measured handle position, or undefined if not yet measured. */
export function getHandleY(nodeId: string, type: 'r' | 'w', qname: string): number | undefined {
  return handlePositionCache.get(`${nodeId}:${type}:${qname}`);
}

/** Write a measured handle position. */
export function setHandleY(nodeId: string, type: 'r' | 'w', qname: string, y: number): void {
  handlePositionCache.set(`${nodeId}:${type}:${qname}`, y);
}

/** Clear all cached positions for a node (e.g., on unmount or collapse). */
export function clearNodeHandleY(nodeId: string): void {
  const prefix = `${nodeId}:`;
  for (const key of handlePositionCache.keys()) {
    if (key.startsWith(prefix)) handlePositionCache.delete(key);
  }
}
