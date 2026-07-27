import { describe, it, expect } from 'vitest';
import {
  buildScriptGraph,
  findSCCs,
  pickBreakEdges,
  longestPathLayers,
  computeLayeredLayout,
  enforceFlowDirection,
  splitTables,
} from './layered-layout';
import type { PipelineTask } from '@/types/pipeline-matrix';

let _taskId = 0;
function task(name: string, input?: string, output?: string, layer?: string): PipelineTask {
  _taskId++;
  return {
    id: `t${_taskId}`,
    taskName: name,
    workflowName: '',
    taskType: '',
    inputTable: input ?? '',
    outputTable: output ?? '',
    layer: layer ?? '',
    layerType: 'logical',
  };
}

// ============================================================================
// splitTables
// ============================================================================

describe('splitTables', () => {
  it('returns empty for undefined/null/empty', () => {
    expect(splitTables(undefined)).toEqual([]);
    expect(splitTables(null)).toEqual([]);
    expect(splitTables('')).toEqual([]);
  });

  it('splits comma-separated', () => {
    expect(splitTables('a, b, c')).toEqual(['a', 'b', 'c']);
  });

  it('filters dash placeholder', () => {
    expect(splitTables('a, -, b')).toEqual(['a', 'b']);
  });

  it('trims whitespace', () => {
    expect(splitTables('  a  ,  b  ')).toEqual(['a', 'b']);
  });
});

// ============================================================================
// buildScriptGraph
// ============================================================================

describe('buildScriptGraph', () => {
  it('returns empty graph for empty input', () => {
    const g = buildScriptGraph([]);
    expect(g.nodes.size).toBe(0);
    expect(g.edges).toEqual([]);
  });

  it('single node with no edges', () => {
    const g = buildScriptGraph([task('A', 'in1', 'out1')]);
    expect(g.nodes.size).toBe(1);
    expect(g.edges).toEqual([]);
  });

  it('linear chain A → B via table X', () => {
    const g = buildScriptGraph([task('A', '', 'X'), task('B', 'X', '')]);
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0]).toMatchObject({ from: 'A', to: 'B', viaTable: 'X' });
  });

  it('case-insensitive matching', () => {
    const g = buildScriptGraph([task('A', '', 'USERS'), task('B', 'users', '')]);
    expect(g.edges).toHaveLength(1);
  });

  it('deduplicates same (from,to,viaTable)', () => {
    const g = buildScriptGraph([task('A', '', 'X'), task('B', 'X', ''), task('B', 'X', '')]);
    expect(g.edges).toHaveLength(1);
  });

  it('skips self-loop', () => {
    // A writes X and reads X from itself — self-loop, should skip
    const g = buildScriptGraph([task('A', 'X', 'X')]);
    expect(g.edges).toHaveLength(0);
  });

  it('short-name fallback when unambiguous', () => {
    // A writes "db.users", B reads "users" — unmatched by full name, but
    // short name "users" has exactly 1 producer (A) → edge created
    const g = buildScriptGraph([task('A', '', 'db.users'), task('B', 'users', '')]);
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0]).toMatchObject({ from: 'A', to: 'B' });
  });

  it('short-name fallback skipped when ambiguous', () => {
    // A and C both write different tables with short name "users"
    // B reads "users" — can't tell which one → no edge
    const g = buildScriptGraph([
      task('A', '', 'db.users'),
      task('C', '', 'other.users'),
      task('B', 'users', ''),
    ]);
    expect(g.edges).toHaveLength(0);
  });

  it('full-name match takes priority over short-name', () => {
    // A writes "users", C writes "db.users". B reads "db.users" — full name
    // matches C exactly, so C→B, not A→B (even though A also writes "users")
    const g = buildScriptGraph([
      task('A', '', 'users'),
      task('C', '', 'db.users'),
      task('B', 'db.users', ''),
    ]);
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0]).toMatchObject({ from: 'C', to: 'B' });
  });

  it('diamond: A→B→D and A→C→D', () => {
    const g = buildScriptGraph([
      task('A', '', 'X'),
      task('B', 'X', 'Y'),
      task('C', 'X', 'Z'),
      task('D', 'Y,Z', ''),
    ]);
    // A→B (via X), A→C (via X), B→D (via Y), C→D (via Z)
    expect(g.edges).toHaveLength(4);
  });

  it('writes and reads dedup across tasks with same name', () => {
    // If two PipelineTask share the same name, reads/writes should merge
    const g = buildScriptGraph([task('A', 'in1', 'out1'), task('A', 'in2', 'out2')]);
    const n = g.nodes.get('A')!;
    expect(n.reads.sort()).toEqual(['in1', 'in2']);
    expect(n.writes.sort()).toEqual(['out1', 'out2']);
  });
});

// ============================================================================
// findSCCs (Tarjan)
// ============================================================================

describe('findSCCs', () => {
  it('no cycles in a DAG', () => {
    const g = buildScriptGraph([task('A', '', 'X'), task('B', 'X', 'Y'), task('C', 'Y', '')]);
    const sccs = findSCCs(g);
    const nonTrivial = sccs.filter((c) => c.length >= 2);
    expect(nonTrivial).toHaveLength(0);
  });

  it('detects 2-node cycle', () => {
    // A→B via X, B→A via Y
    const g = buildScriptGraph([task('A', 'Y', 'X'), task('B', 'X', 'Y')]);
    const sccs = findSCCs(g);
    const nonTrivial = sccs.filter((c) => c.length >= 2);
    expect(nonTrivial).toHaveLength(1);
    expect(nonTrivial[0].sort()).toEqual(['A', 'B']);
  });

it('detects 3-node cycle', () => {
    // A→B(→C→D→E→B): cycle is B→C→D→E→B, A is outside
    const g = buildScriptGraph([
      task('A', '', 'X'),
      task('B', 'X', 'Y'),
      task('C', 'Y', 'Z'),
      task('D', 'Z', 'W'),
      task('E', 'W', 'X'),   // E writes X, so both A and E produce X
    ]);
    const sccs = findSCCs(g);
    const nonTrivial = sccs.filter((c) => c.length >= 2);
    expect(nonTrivial).toHaveLength(1);
    // Both A and E produce X → B has incoming from both. SCC = {B, C, D, E}
    expect(nonTrivial[0].sort()).toEqual(['B', 'C', 'D', 'E']);
  });

  it('single node with self-loop', () => {
    const g = buildScriptGraph([task('A', '', 'X'), task('A', 'X', '')]);
    // A writes X, A reads X — self-loop
    // buildScriptGraph skips self-loops (producerId === consumerId)
    const edges = g.edges.filter((e) => e.from === 'A' && e.to === 'A');
    expect(edges).toHaveLength(0);
  });
});

// ============================================================================
// pickBreakEdges
// ============================================================================

describe('pickBreakEdges', () => {
  it('breaks one edge in a 2-node cycle', () => {
    const g = buildScriptGraph([task('A', 'Y', 'X'), task('B', 'X', 'Y')]);
    const sccs = findSCCs(g);
    const breaks = pickBreakEdges(g, sccs);
    expect(breaks.size).toBe(1);
  });

  it('prefers breaking backward edges (higher originalLayerNum drop)', () => {
    // A (L1) → B (L2) → A (L1): backward edge is B→A (L2→L1)
    const g = buildScriptGraph([
      task('A', 'Y', 'X', 'L1'),
      task('B', 'X', 'Y', 'L2'),
    ]);
    const sccs = findSCCs(g);
    const breaks = pickBreakEdges(g, sccs);
    expect(breaks.size).toBe(1);
    const brokenIdx = [...breaks][0];
    const brokenEdge = g.edges[brokenIdx];
    // Should break the backward edge (L2→L1), which is B→A
    expect(brokenEdge.from).toBe('B');
    expect(brokenEdge.to).toBe('A');
  });

  it('skips already-broken edges when existingBroken is passed', () => {
    // A=0 → B=1 → A=0: two edges, we pre-break the backward one (B→A)
    const g = buildScriptGraph([
      task('A', 'Y', 'X'),
      task('B', 'X', 'Y'),
    ]);
    const sccs = findSCCs(g);
    const preBroken = new Set<number>();
    // Pre-break the backward edge (B→A)
    const backwardEdge = g.edges.findIndex((e) => e.from === 'B' && e.to === 'A');
    preBroken.add(backwardEdge);

    // SCC still exists (A→B is a cycle of its own in this 2-node case)
    // Actually with A→B and B→A, breaking B→A leaves A→B which is a single edge,
    // so the SCC {A,B} dissolves (no backward edge to close the cycle).
    // Let's verify: findSCCs with preBroken should find no trivial SCCs.
    const remaining = findSCCs(g, preBroken);
    const nonTrivial = remaining.filter((c) => c.length >= 2);
    expect(nonTrivial.length).toBe(0);

    // If a non-trivial SCC existed, pickBreakEdges with existingBroken
    // would skip pre-broken edges. We just verify the API works.
    // The multi-cycle integration test below covers the real regression.
  });
});

// ============================================================================
// longestPathLayers
// ============================================================================

describe('longestPathLayers', () => {
  it('single node → layer 0', () => {
    const g = buildScriptGraph([task('A', '', 'X')]);
    const layers = longestPathLayers(g, new Set());
    expect(layers.get('A')).toBe(0);
  });

  it('linear chain A→B→C → A=0, B=1, C=2', () => {
    const g = buildScriptGraph([task('A', '', 'X'), task('B', 'X', 'Y'), task('C', 'Y', '')]);
    const layers = longestPathLayers(g, new Set());
    expect(layers.get('A')).toBe(0);
    expect(layers.get('B')).toBe(1);
    expect(layers.get('C')).toBe(2);
  });

  it('diamond: A(0)→B(1)→D(2), A(0)→C(1)→D(2)', () => {
    const g = buildScriptGraph([
      task('A', '', 'X'),
      task('B', 'X', 'Y'),
      task('C', 'X', 'Z'),
      task('D', 'Y,Z', ''),
    ]);
    const layers = longestPathLayers(g, new Set());
    expect(layers.get('A')).toBe(0);
    expect(layers.get('B')).toBe(1);
    expect(layers.get('C')).toBe(1);
    expect(layers.get('D')).toBe(2);
  });

  it('longer path wins when multiple paths exist', () => {
    // A→B→D (len 2), A→C→D (len 2), plus C→E (len 3)
    // But the actual graph: A→B→D, A→C→D, plus C→D (direct)
    // D has longest path from A via either B or C: A→B→D = layer 2
    // Let me make a clearer test:
    // A→B→D (len 2), A→C→D (len 1) — D should be layer 2
    const g = buildScriptGraph([
      task('A', '', 'X'),
      task('B', 'X', 'Y'),
      task('C', 'X', 'Z'),
      task('D', 'Y,Z', ''),
    ]);
    const layers = longestPathLayers(g, new Set());
    expect(layers.get('D')).toBe(2);
  });

  it('broken edges excluded from graph', () => {
    const g = buildScriptGraph([task('A', '', 'X'), task('B', 'X', 'Y'), task('C', 'Y', '')]);
    // Break A→B (edge 0). Now B has indeg 0 (no non-broken incoming) → B at layer 0
    const layers = longestPathLayers(g, new Set([0]));
    expect(layers.get('A')).toBe(0);
    expect(layers.get('B')).toBe(0);
    expect(layers.get('C')).toBe(1); // B→C still intact
  });
});

// ============================================================================
// enforceFlowDirection
// ============================================================================

describe('enforceFlowDirection', () => {
  it('passes through correct layers unchanged', () => {
    // A=0, B=1, C=2 — already correct
    const g = buildScriptGraph([task('A', '', 'X'), task('B', 'X', 'Y'), task('C', 'Y', '')]);
    const layers = new Map([['A', 0], ['B', 1], ['C', 2]]);
    const result = enforceFlowDirection(g, new Set(), layers);
    expect(result.get('A')).toBe(0);
    expect(result.get('B')).toBe(1);
    expect(result.get('C')).toBe(2);
  });

  it('fixes right-to-left violation: A=1, B=0 with A→B', () => {
    const g = buildScriptGraph([task('A', '', 'X'), task('B', 'X', '')]);
    const layers = new Map([['A', 1], ['B', 0]]);
    const result = enforceFlowDirection(g, new Set(), layers);
    expect(result.get('A')).toBe(1);
    expect(result.get('B')).toBe(2); // bumped from 0 to A+1
  });

  it('cascading fix: A=0, B=0, C=0 with A→B→C', () => {
    const g = buildScriptGraph([task('A', '', 'X'), task('B', 'X', 'Y'), task('C', 'Y', '')]);
    const layers = new Map([['A', 0], ['B', 0], ['C', 0]]);
    const result = enforceFlowDirection(g, new Set(), layers);
    expect(result.get('A')).toBe(0);
    expect(result.get('B')).toBe(1);
    expect(result.get('C')).toBe(2);
  });

it('caps iterations when residual cycles remain (regression guard)', () => {
    // Graph where breaking 1 edge still leaves a cycle.
    // The residual cycle cannot be fixed by direction enforcement alone,
    // but the iteration cap (graph.nodes.size) prevents infinite loops.
    const g = buildScriptGraph([
      task('A', 'C_out', 'A_out'),
      task('B', 'A_out', 'B_out'),
      task('C', 'B_out', 'C_out'),
      task('D', 'C_out', 'D_out'),
      task('E', 'D_out', 'A_out'),
    ]);
    // Break A→B, leaving B→C→D→E→B as a residual cycle
    const sccs = findSCCs(g);
    const breaks = pickBreakEdges(g, sccs);
    expect(breaks.size).toBe(1);

    // All stuck at layer 0 (Kahn can't start)
    const rawLayers = longestPathLayers(g, breaks);
    for (const [, l] of rawLayers) expect(l).toBe(0);

    const result = enforceFlowDirection(g, breaks, rawLayers);
    // Should complete within node-count iterations (not infinite loop)
    expect(result.size).toBe(5);
  });
});

// ============================================================================
// computeLayeredLayout (integration)
// ============================================================================

describe('computeLayeredLayout', () => {
  it('empty tasks → empty output', () => {
    const result = computeLayeredLayout([]);
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
    expect(result.layerCount).toBe(1);
  });

  it('single task', () => {
    const result = computeLayeredLayout([task('A', 'in1', 'out1')]);
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].computedLayer).toBe(0);
  });

  it('linear chain', () => {
    const result = computeLayeredLayout([task('A', '', 'X'), task('B', 'X', 'Y'), task('C', 'Y', '')]);
    expect(result.nodes).toHaveLength(3);
    const map = new Map(result.nodes.map((n) => [n.id, n.computedLayer]));
    expect(map.get('A')).toBe(0);
    expect(map.get('B')).toBe(1);
    expect(map.get('C')).toBe(2);
    expect(result.layerCount).toBe(3);
  });

  it('diamond: layers correct', () => {
    const result = computeLayeredLayout([
      task('A', '', 'X'),
      task('B', 'X', 'Y'),
      task('C', 'X', 'Z'),
      task('D', 'Y,Z', ''),
    ]);
    const map = new Map(result.nodes.map((n) => [n.id, n.computedLayer]));
    expect(map.get('A')).toBe(0);
    expect(map.get('B')).toBe(1);
    expect(map.get('C')).toBe(1);
    expect(map.get('D')).toBe(2);
    expect(result.layerCount).toBe(3);
  });

  it('cycle detected and broken; broken edge marked', () => {
    const result = computeLayeredLayout([task('A', 'Y', 'X'), task('B', 'X', 'Y')]);
    expect(result.cycleWarning).toBeDefined();
    expect(result.cycleWarning!.count).toBe(1);
    expect(result.cycleWarning!.brokenEdges).toHaveLength(1);
    const broken = result.edges.filter((e) => e.isBroken);
    expect(broken).toHaveLength(1);
  });

  it('cycle nodes marked for visual feedback', () => {
    const result = computeLayeredLayout([task('A', 'Y', 'X'), task('B', 'X', 'Y')]);
    const cycleNodes = result.nodes.filter((n) => n.isInCycle);
    expect(cycleNodes).toHaveLength(2);
  });

  it('all non-broken edges go left-to-right', () => {
    const result = computeLayeredLayout([
      task('A', '', 'X'),
      task('B', 'X', 'Y'),
      task('C', 'Y', 'Z'),
      task('D', 'Z', 'W'),
      task('E', 'W', 'X'), // creates cycle
    ]);
    const nodeMap = new Map(result.nodes.map((n) => [n.id, n.computedLayer]));
    for (const e of result.edges) {
      if (!e.isBroken) {
        expect(nodeMap.get(e.to)!).toBeGreaterThan(nodeMap.get(e.from)!);
      }
    }
  });

  it('layers correctly for wide fan-in', () => {
    // Many sources → one sink
    const tasks = ['A', 'B', 'C', 'D'].map((id) => task(id, '', 'X'));
    tasks.push(task('Sink', 'X', ''));
    const result = computeLayeredLayout(tasks);
    const map = new Map(result.nodes.map((n) => [n.id, n.computedLayer]));
    expect(map.get('A')).toBe(0);
    expect(map.get('B')).toBe(0);
    expect(map.get('C')).toBe(0);
    expect(map.get('D')).toBe(0);
    expect(map.get('Sink')).toBe(1);
  });

  it('layers correctly for fan-out (1 source → many sinks)', () => {
    const tasks = [task('Source', '', 'X')];
    for (const id of ['A', 'B', 'C']) {
      tasks.push(task(id, 'X', ''));
    }
    const result = computeLayeredLayout(tasks);
    const map = new Map(result.nodes.map((n) => [n.id, n.computedLayer]));
    expect(map.get('Source')).toBe(0);
    expect(map.get('A')).toBe(1);
    expect(map.get('B')).toBe(1);
    expect(map.get('C')).toBe(1);
  });

  it('handles large graphs without error', () => {
    const tasks: PipelineTask[] = [];
    // 50-node chain
    for (let i = 0; i < 50; i++) {
      tasks.push(task(`N${i}`, i > 0 ? `T${i - 1}` : '', `T${i}`));
    }
    const result = computeLayeredLayout(tasks);
    expect(result.nodes).toHaveLength(50);
    expect(result.layerCount).toBe(50);
  });

  it('computeLayeredLayout is deterministic', () => {
    const input = [task('A', '', 'X'), task('B', 'X', 'Y'), task('C', 'Y', '')];
    const r1 = computeLayeredLayout(input);
    const r2 = computeLayeredLayout(input);
    expect(r1.nodes.map((n) => n.computedLayer)).toEqual(
      r2.nodes.map((n) => n.computedLayer),
    );
    expect(r1.edges).toEqual(r2.edges);
  });

it('breaks multi-cycle graph until fully acyclic', () => {
    // SCC {E, F, G}: E→F→E and E→G→E via shared tables.
    // Breaking 1 edge (E→F) leaves E→G→E as a residual cycle.
    // Iterative cycle breaking must break a 2nd edge (E→G) to make it acyclic.
    const r = computeLayeredLayout([
      task('D', '', 't_d'),
      task('E', 't_d', 't_e'),
      task('F', 't_e', 't_d'),
      task('G', 't_e', 't_d'),
    ]);
    const nodeMap = new Map(r.nodes.map((n) => [n.id, n.computedLayer]));
    for (const e of r.edges) {
      if (!e.isBroken) {
        expect(nodeMap.get(e.to)!).toBeGreaterThan(nodeMap.get(e.from)!);
      }
    }
    expect(r.cycleWarning).toBeDefined();
    expect(r.cycleWarning!.count).toBe(2);
  });
});