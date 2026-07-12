/**
 * Web Worker for ELK layout computation.
 * Runs on a separate thread to avoid blocking the main thread.
 */
import ELK from 'elkjs/lib/elk.bundled.js';

export interface ElkLayoutRequest {
  id: number;
  nodes: { id: string; width: number; height: number }[];
  edges: { id: string; sources: string[]; targets: string[] }[];
}

export interface ElkLayoutResponse {
  id: number;
  positions: Record<string, { x: number; y: number }>;
}

self.onmessage = async (e: MessageEvent<ElkLayoutRequest>) => {
  const { id, nodes, edges } = e.data;

  try {
    const elk = new ELK();
    const graph = {
      id: 'root',
      layoutOptions: {
        'elk.algorithm': 'layered',
        'elk.direction': 'RIGHT',
        'elk.layered.spacing.nodeNodeBetweenLayers': '150',
        'elk.spacing.nodeNode': '80',
      },
      children: nodes,
      edges,
    };

    const result = await elk.layout(graph);

    const positions: Record<string, { x: number; y: number }> = {};
    result.children?.forEach((c: any) => {
      positions[c.id] = { x: c.x ?? 0, y: c.y ?? 0 };
    });

    self.postMessage({ id, positions } satisfies ElkLayoutResponse);
  } catch (err) {
    // Post error back — caller will fall back to dagre
    self.postMessage({ id, positions: {} });
    console.error('[ELK Worker] layout failed:', err);
  }
};
