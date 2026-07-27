// ============================================================================
// layered-layout.ts
//
// Pure algorithm module that converts a flat list of PipelineTask (each with
// comma-separated inputTable/outputTable strings) into a layered DAG layout
// suitable for left-to-right flow rendering.
//
// Pipeline:
//   1. Build script-level graph (table producers → consumers)
//   2. Detect strongly connected components (Tarjan)
//   3. Break cycles by marking one edge per SCC as "broken"
//   4. Compute layer (column) for each node via longest-path topological sort
//
// All functions are pure and exported for testability.
// ============================================================================

import type { PipelineTask } from '@/types/pipeline-matrix';

// ============================================================================
// Public types
// ============================================================================

export interface LayeredNode {
  /** Stable node id (= script/task name). */
  id: string;
  /** Display label (same as id for now, kept separate for future i18n). */
  label: string;
  /** 0-indexed column number. Layer 0 = leftmost. */
  computedLayer: number;
  /** Original naming layer extracted from task.layer (e.g. "L1", "L3"). Only used for cycle-break heuristics. */
  originalLayer?: string;
  /** Numeric form of originalLayer if parseable (used by heuristic). */
  originalLayerNum?: number;
  /** Input tables (cleaned list). */
  reads: string[];
  /** Output tables (cleaned list). */
  writes: string[];
  /** True if this node participates in a cycle. */
  isInCycle?: boolean;
}

export interface LayeredEdge {
  from: string;
  to: string;
  /** Table that mediates the from→to relationship. */
  viaTable: string;
  /** True if this edge was forcibly removed to break a cycle (rendered red dashed). */
  isBroken?: boolean;
}

export interface LayeredLayout {
  nodes: LayeredNode[];
  edges: LayeredEdge[];
  /** Total number of columns (max(layer) + 1), minimum 1. */
  layerCount: number;
  /** Cycle info, present only if any back-edges were broken. */
  cycleWarning?: {
    /** Number of edges that had to be broken. */
    count: number;
    /** The broken edges. */
    brokenEdges: LayeredEdge[];
    /** Node ids that participate in any cycle. */
    cycleNodes: string[];
  };
}

// ============================================================================
// Internal graph types
// ============================================================================

interface RawEdge {
  from: string;
  to: string;
  viaTable: string;
}

interface Graph {
  /** node id → node data */
  nodes: Map<string, LayeredNode>;
  /** node id → outgoing edge indices */
  out: Map<string, number[]>;
  /** node id → incoming edge indices */
  in: Map<string, number[]>;
  edges: RawEdge[];
}

// ============================================================================
// Step 1: build script-level graph
// ============================================================================

/** Split comma-separated table string into a cleaned list. */
export function splitTables(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw
    .split(/,\s*/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== '-');
}

/** Normalize a table name for matching: lowercase + trim. */
function normalizeTable(name: string): string {
  return name.toLowerCase().trim();
}

/** Get the "short" form (last segment after dot) for fallback matching. */
function shortName(name: string): string {
  const parts = name.split('.');
  return parts[parts.length - 1].toLowerCase().trim();
}

/** Parse "L3" / "layer2" / "physical" etc. → numeric prefix; returns undefined if no number. */
function parseLayerNum(layer: string | undefined): number | undefined {
  if (!layer) return undefined;
  const m = layer.match(/(\d+)/);
  if (!m) return undefined;
  return parseInt(m[1], 10);
}

/**
 * Build the script-level DAG from PipelineTasks.
 * Rule: if script A writes table X, and script B reads table X (A != B), add A→B edge.
 * Edges are deduped by (from, to, viaTable).
 */
export function buildScriptGraph(tasks: PipelineTask[]): Graph {
  const nodes = new Map<string, LayeredNode>();
  // Primary index: normalized full name → producers
  const tableProducers = new Map<string, Set<string>>();
  // Fallback index: short name (after last dot) → producers (for unqualified reads)
  const shortProducers = new Map<string, Set<string>>();

  // First pass: register nodes + record producers
  for (const task of tasks) {
    const id = task.taskName;
    if (!id) continue;
    if (!nodes.has(id)) {
      nodes.set(id, {
        id,
        label: id,
        computedLayer: 0,
        originalLayer: task.layer,
        originalLayerNum: parseLayerNum(task.layer),
        reads: [],
        writes: [],
      });
    }
    const node = nodes.get(id)!;
    const reads = splitTables(task.inputTable);
    const writes = splitTables(task.outputTable);
    node.reads = Array.from(new Set([...node.reads, ...reads]));
    node.writes = Array.from(new Set([...node.writes, ...writes]));

    for (const t of writes) {
      const norm = normalizeTable(t);
      if (!tableProducers.has(norm)) tableProducers.set(norm, new Set());
      tableProducers.get(norm)!.add(id);

      const short = shortName(t);
      // Only index by short name if it's actually shorter (i.e., original had a dot)
      if (short !== norm) {
        if (!shortProducers.has(short)) shortProducers.set(short, new Set());
        shortProducers.get(short)!.add(id);
      }
    }
  }

  // Second pass: edges. For each node's reads, link each producer → this node.
  const edgeKey = new Set<string>();
  const edges: RawEdge[] = [];
  const out = new Map<string, number[]>();
  const in_ = new Map<string, number[]>();

  const addEdge = (producerId: string, consumerId: string, viaTable: string) => {
    if (producerId === consumerId) return; // skip self-loop
    const key = `${producerId}\0${consumerId}\0${viaTable.toLowerCase()}`;
    if (edgeKey.has(key)) return;
    edgeKey.add(key);
    const idx = edges.length;
    edges.push({ from: producerId, to: consumerId, viaTable });
    if (!out.has(producerId)) out.set(producerId, []);
    out.get(producerId)!.push(idx);
    if (!in_.has(consumerId)) in_.set(consumerId, []);
    in_.get(consumerId)!.push(idx);
  };

  for (const [consumerId, node] of nodes) {
    for (const readTable of node.reads) {
      const norm = normalizeTable(readTable);
      // 1. Try exact (normalized) match first
      const directProducers = tableProducers.get(norm);
      if (directProducers) {
        for (const producerId of directProducers) {
          addEdge(producerId, consumerId, readTable);
        }
        continue; // exact match found, skip fallback
      }
      // 2. Fallback: short-name match (e.g., read "users" matches write "db.users")
      //    ONLY when unambiguous (exactly 1 producer has this short name) to avoid false edges
      const short = shortName(readTable);
      const fallbackProducers = shortProducers.get(short);
      if (fallbackProducers && fallbackProducers.size === 1) {
        for (const producerId of fallbackProducers) {
          addEdge(producerId, consumerId, readTable);
        }
      }
    }
  }

  return { nodes, out, in: in_, edges };
}

// ============================================================================
// Step 2: Tarjan's SCC (iterative to avoid stack overflow on large graphs)
// ============================================================================

/**
 * Find strongly connected components using iterative Tarjan.
 * Returns an array of SCCs; each SCC is a list of node ids.
 * Single-node SCCs (no self-loop) are also returned; callers filter by size>1.
 */
export function findSCCs(graph: Graph): string[][] {
  const indexCounter = { v: 0 };
  const stack: string[] = [];
  const onStack = new Set<string>();
  const indices = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const result: string[][] = [];

  // Iterative Tarjan using explicit recursion stack frames.
  // Each frame: { nodeId, neighborIter (iterator over out-edges) }
  type Frame = {
    nodeId: string;
    outEdgeIdx: number; // current position in graph.out[nodeId]
  };

  for (const startNode of graph.nodes.keys()) {
    if (indices.has(startNode)) continue;

    const work: Frame[] = [{ nodeId: startNode, outEdgeIdx: 0 }];
    while (work.length > 0) {
      const frame = work[work.length - 1];
      const v = frame.nodeId;

      if (frame.outEdgeIdx === 0) {
        // First visit: assign index/lowlink, push to stack
        indices.set(v, indexCounter.v);
        lowlink.set(v, indexCounter.v);
        indexCounter.v++;
        stack.push(v);
        onStack.add(v);
      }

      const outIdxs = graph.out.get(v) ?? [];
      let advanced = false;

      while (frame.outEdgeIdx < outIdxs.length) {
        const edgeIdx = outIdxs[frame.outEdgeIdx];
        frame.outEdgeIdx++;
        const w = graph.edges[edgeIdx].to;
        if (!indices.has(w)) {
          // Tree edge: recurse into w
          work.push({ nodeId: w, outEdgeIdx: 0 });
          advanced = true;
          break;
        } else if (onStack.has(w)) {
          // Back edge or cross edge to on-stack node
          lowlink.set(v, Math.min(lowlink.get(v)!, indices.get(w)!));
        }
      }

      if (advanced) continue;

      // All neighbors processed; check if v is root of SCC
      if (lowlink.get(v) === indices.get(v)) {
        const component: string[] = [];
        let w: string;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          component.push(w);
        } while (w !== v);
        result.push(component);
      }

      // Pop this frame and update parent's lowlink
      work.pop();
      if (work.length > 0) {
        const parent = work[work.length - 1];
        lowlink.set(
          parent.nodeId,
          Math.min(lowlink.get(parent.nodeId)!, lowlink.get(v)!),
        );
      }
    }
  }

  return result;
}

// ============================================================================
// Step 3: pick edges to break (one per non-trivial SCC)
// ============================================================================

/**
 * For each SCC with size > 1 (or single-node self-loop, though we already filter those
 * when building edges), pick exactly one edge inside the SCC to mark as broken.
 *
 * Heuristic (deterministic):
 *   1. Among edges fully inside the SCC, prefer edges where originalLayer decreases
 *      the most from→to (i.e., "backward" relative to naming convention).
 *   2. Tiebreak by largest originalLayerNum of `from`.
 *   3. Final tiebreak by alphabetical (from, to, viaTable) for stable output.
 */
export function pickBreakEdges(graph: Graph, sccs: string[][]): Set<number> {
  const breakSet = new Set<number>();

  for (const component of sccs) {
    if (component.length < 2) continue;
    const members = new Set(component);

    // Collect edges entirely within this SCC
    const candidate: Array<{ idx: number; score: number; tieA: number; tieB: string }> = [];
    for (const nodeId of component) {
      const outIdxs = graph.out.get(nodeId) ?? [];
      for (const edgeIdx of outIdxs) {
        const e = graph.edges[edgeIdx];
        if (!members.has(e.to)) continue;
        const fromLayer = graph.nodes.get(e.from)?.originalLayerNum ?? 0;
        const toLayer = graph.nodes.get(e.to)?.originalLayerNum ?? 0;
        // Higher score = more "backward" = prefer to break
        const backwardness = fromLayer - toLayer;
        candidate.push({
          idx: edgeIdx,
          score: backwardness,
          tieA: fromLayer,
          tieB: `${e.from}\0${e.to}\0${e.viaTable}`,
        });
      }
    }

    if (candidate.length === 0) continue;

    // Sort: highest backwardness first, then largest fromLayer, then alphabetical
    candidate.sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      if (a.tieA !== b.tieA) return b.tieA - a.tieA;
      return a.tieB < b.tieB ? -1 : a.tieB > b.tieB ? 1 : 0;
    });

    breakSet.add(candidate[0].idx);
  }

  return breakSet;
}

// ============================================================================
// Step 4: longest-path layering (Kahn + DP, ignoring broken edges)
// ============================================================================

/**
 * Compute layer (column) for each node using longest path from any root.
 * Broken edges are excluded from the DAG traversal.
 *
 *   layer(root) = 0
 *   layer(node) = max(layer(upstream) + 1) across all non-broken incoming edges
 *
 * Isolated nodes (no edges) end up at layer 0.
 */
export function longestPathLayers(
  graph: Graph,
  brokenEdges: Set<number>,
): Map<string, number> {
  const layer = new Map<string, number>();

  // Compute in-degree excluding broken edges
  const indeg = new Map<string, number>();
  for (const id of graph.nodes.keys()) indeg.set(id, 0);

  const liveOut = new Map<string, number[]>();
  for (const [from, idxs] of graph.out.entries()) {
    liveOut.set(
      from,
      idxs.filter((i) => !brokenEdges.has(i)),
    );
  }

  for (const [to, idxs] of graph.in.entries()) {
    let cnt = 0;
    for (const i of idxs) if (!brokenEdges.has(i)) cnt++;
    indeg.set(to, cnt);
  }

  // Kahn's algorithm, but we want longest path so we update successors on dequeue
  const queue: string[] = [];
  for (const [id, deg] of indeg.entries()) {
    if (deg === 0) {
      queue.push(id);
      layer.set(id, 0);
    }
  }

  // Remaining in-degree for tracking progress
  const remaining = new Map(indeg);

  let head = 0;
  while (head < queue.length) {
    const v = queue[head++];
    const vLayer = layer.get(v) ?? 0;
    const outs = liveOut.get(v) ?? [];
    for (const edgeIdx of outs) {
      const e = graph.edges[edgeIdx];
      const candidateLayer = vLayer + 1;
      const cur = layer.get(e.to) ?? 0;
      if (candidateLayer > cur) layer.set(e.to, candidateLayer);
      const newRem = (remaining.get(e.to) ?? 0) - 1;
      remaining.set(e.to, newRem);
      if (newRem === 0) queue.push(e.to);
    }
  }

  // Any remaining nodes (shouldn't exist if cycle breaking worked) get layer 0
  for (const id of graph.nodes.keys()) {
    if (!layer.has(id)) layer.set(id, 0);
  }

  return layer;
}

// ============================================================================
// Step 5: enforce flow direction — guarantee non-broken edges go left-to-right
// ============================================================================

/**
 * Post-processing pass that guarantees every non-broken edge goes strictly
 * left-to-right (from a lower layer to a higher layer).
 *
 * Under normal operation, longestPathLayers already guarantees this via its
 * DP update rule: layer(B) >= layer(A) + 1 for every non-broken edge A→B.
 * However, if some nodes were unreachable in Kahn's algorithm and fell back
 * to layer 0, edges within that residual cluster could violate direction.
 *
 * This function detects such violations and auto-corrects B's layer to A+1.
 * Returns the corrected layer map.
 */
export function enforceFlowDirection(
  graph: Graph,
  brokenEdges: Set<number>,
  layers: Map<string, number>,
): Map<string, number> {
  const result = new Map(layers);
  let fixed = false;

  for (const [, idxs] of graph.out.entries()) {
    for (const edgeIdx of idxs) {
      if (brokenEdges.has(edgeIdx)) continue;
      const e = graph.edges[edgeIdx];
      const fromLayer = result.get(e.from) ?? 0;
      const toLayer = result.get(e.to) ?? 0;
      if (toLayer <= fromLayer) {
        result.set(e.to, fromLayer + 1);
        fixed = true;
      }
    }
  }

  if (fixed) {
    // A single pass may not suffice if the violation cascades (A→B and B→C
    // both at layer 0). Run a full longest-path recomputation from the fixed
    // layers to propagate correctly.
    const queue: string[] = [];
    for (const [id, l] of result) {
      const liveIncoming = (graph.in.get(id) ?? []).filter(
        (i) => !brokenEdges.has(i),
      ).length;
      if (liveIncoming === 0 || l === 0) queue.push(id);
    }

    let head = 0;
    while (head < queue.length) {
      const v = queue[head++];
      const vLayer = result.get(v) ?? 0;
      const outs = (graph.out.get(v) ?? []).filter((i) => !brokenEdges.has(i));
      for (const edgeIdx of outs) {
        const e = graph.edges[edgeIdx];
        const candidate = vLayer + 1;
        const cur = result.get(e.to) ?? 0;
        if (candidate > cur) result.set(e.to, candidate);
      }
    }
  }

  return result;
}

// ============================================================================
// Top-level entry point
// ============================================================================

/**
 * Compute a layered layout from raw PipelineTasks.
 *
 * @param tasks - pipeline tasks (each with comma-separated input/output tables)
 * @returns LayeredLayout with nodes positioned by computed layer
 */
export function computeLayeredLayout(tasks: PipelineTask[]): LayeredLayout {
  const graph = buildScriptGraph(tasks);

  // Handle empty input
  if (graph.nodes.size === 0) {
    return { nodes: [], edges: [], layerCount: 1 };
  }

  // Detect cycles
  const sccs = findSCCs(graph);
  const breakSet = pickBreakEdges(graph, sccs);

  // Mark cycle nodes
  const cycleNodes = new Set<string>();
  for (const c of sccs) {
    if (c.length >= 2) for (const id of c) cycleNodes.add(id);
  }

  // Compute layers
  let layerMap = longestPathLayers(graph, breakSet);

  // Enforce left-to-right: guarantee non-broken edges never go right-to-left
  layerMap = enforceFlowDirection(graph, breakSet, layerMap);

  // Build output nodes
  const outNodes: LayeredNode[] = [];
  let maxLayer = 0;
  for (const [id, node] of graph.nodes) {
    const l = layerMap.get(id) ?? 0;
    if (l > maxLayer) maxLayer = l;
    outNodes.push({
      ...node,
      computedLayer: l,
      isInCycle: cycleNodes.has(id) || undefined,
    });
  }

  // Build output edges with broken flag
  const outEdges: LayeredEdge[] = graph.edges.map((e, idx) => ({
    from: e.from,
    to: e.to,
    viaTable: e.viaTable,
    isBroken: breakSet.has(idx) || undefined,
  }));

  const layout: LayeredLayout = {
    nodes: outNodes,
    edges: outEdges,
    layerCount: maxLayer + 1,
  };

  if (breakSet.size > 0) {
    const brokenEdges = outEdges.filter((e) => e.isBroken);
    layout.cycleWarning = {
      count: brokenEdges.length,
      brokenEdges,
      cycleNodes: Array.from(cycleNodes),
    };
  }

  return layout;
}

// ============================================================================
// Color palette helper (by computed layer index)
// ============================================================================

export interface LayerColor {
  name: string;
  border: string;
  bg: string;
  text: string;
  glow: string;
}

/** 5 distinct colors for dark theme; cycles for >5 layers. */
const LAYER_PALETTE: LayerColor[] = [
  { name: 'blue', border: '#3b6bb3', bg: '#1a2638', text: '#9bc1ff', glow: 'rgba(59,107,179,0.35)' },
  { name: 'green', border: '#2da44e', bg: '#15302e', text: '#7ee29a', glow: 'rgba(45,164,78,0.35)' },
  { name: 'yellow', border: '#d29922', bg: '#2b2410', text: '#f0c674', glow: 'rgba(210,153,34,0.35)' },
  { name: 'magenta', border: '#db61a2', bg: '#311a25', text: '#f3a0cf', glow: 'rgba(219,97,162,0.35)' },
  { name: 'purple', border: '#a371f7', bg: '#2a1530', text: '#c9a8ff', glow: 'rgba(163,113,247,0.35)' },
];

export function getLayerColor(layer: number): LayerColor {
  return LAYER_PALETTE[layer % LAYER_PALETTE.length];
}
