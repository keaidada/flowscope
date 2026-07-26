import { useMemo } from 'react';
import type { AnalyzeResult } from '@pondpilot/flowscope-core';
import type { PipelineTask, TaskSchedule } from '@/types/pipeline-matrix';

const EMPTY_SCHEDULE: TaskSchedule = {
  date: '-',
  wedataWorkflow: '-',
  wedataStatus: 'unknown',
  wedataSchedule: '-',
  airflowWorkflow: '-',
  airflowStatus: 'unknown',
  airflowSchedule: '-',
  scriptChanged: false,
  scriptPath: '',
};

export interface PipelineData {
  tasks: PipelineTask[];
  taskNames: string[];
  scripts: string[];
}

/**
 * Build a file-level pipeline DAG from AnalyzeResult.
 *
 * Uses TWO data sources:
 * 1. globalLineage edges (same as graph view) for reliable file dependencies
 * 2. Per-statement node/edge scanning for discovering individual files when
 *    sourceNames are all the same (concatenated SQL files)
 *
 * Layers are computed via topological sort with max(upstream) + 1 to
 * ensure a file that depends on L1+L4 is at least L5.
 */
export function usePipelineData(result: AnalyzeResult | null): PipelineData {
  return useMemo(() => {
    if (!result || !result.statements || result.statements.length === 0) {
      return { tasks: [], taskNames: [], scripts: [] };
    }

    // ── Data source 1: per-statement read/write (discovers individual files) ──
    type StmtInfo = {
      sourceName: string;
      reads: Set<string>;
      writes: Set<string>;
    };
    const stmtInfos: StmtInfo[] = [];

    for (const stmt of result.statements) {
      const sourceName = stmt.sourceName || '';
      const physical = stmt.nodes.filter(
        (n) =>
          (n.type === 'table' || n.type === 'view') &&
          (n.resolutionSource || (n.qualifiedName || n.label).includes('.'))
      );
      const physicalIds = new Set(physical.map((n) => n.id));
      const hasIncoming = new Set<string>();
      for (const edge of stmt.edges) {
        if (edge.type !== 'ownership' && physicalIds.has(edge.to)) {
          hasIncoming.add(edge.to);
        }
      }
      const reads = new Set<string>();
      const writes = new Set<string>();
      for (const node of physical) {
        const qName = node.qualifiedName || node.label;
        if (hasIncoming.has(node.id)) writes.add(qName);
        else reads.add(qName);
      }
      if (reads.size > 0 || writes.size > 0) {
        stmtInfos.push({ sourceName, reads, writes });
      }
    }

    // Aggregate to file level
    const fileReads0 = new Map<string, Set<string>>();
    const fileWrites0 = new Map<string, Set<string>>();
    for (const info of stmtInfos) {
      const f = info.sourceName;
      if (!fileReads0.has(f)) {
        fileReads0.set(f, new Set());
        fileWrites0.set(f, new Set());
      }
      for (const t of info.reads) fileReads0.get(f)!.add(t);
      for (const t of info.writes) fileWrites0.get(f)!.add(t);
    }

    // ── Data source 2: globalLineage edges for cross-file dependencies ──
    const gl = result.globalLineage;
    const fileReads = new Map(fileReads0);
    const fileWrites = new Map(fileWrites0);

    if (gl) {
      const idxToSource = new Map<number, string>();
      for (let i = 0; i < result.statements.length; i++) {
        const src = result.statements[i].sourceName || '';
        if (src) idxToSource.set(i, src);
      }
      const nodeLabelById = new Map<string, string>();
      for (const node of gl.nodes) {
        nodeLabelById.set(node.id as string, node.label as string);
      }
      for (const edge of gl.edges) {
        const tableName = nodeLabelById.get(edge.from as string) || (edge.id as string);
        const ps = edge.producerStatement;
        const cs = edge.consumerStatement;
        if (ps) {
          const src = idxToSource.get(ps.statementIndex);
          if (src) {
            const f = src || '__unknown__';
            if (!fileWrites.has(f)) {
              fileWrites.set(f, new Set());
              fileReads.set(f, new Set());
            }
            fileWrites.get(f)!.add(tableName);
          }
        }
        if (cs) {
          const src = idxToSource.get(cs.statementIndex);
          if (src) {
            const f = src || '__unknown__';
            if (!fileReads.has(f)) {
              fileReads.set(f, new Set());
              fileWrites.set(f, new Set());
            }
            fileReads.get(f)!.add(tableName);
          }
        }
      }
    }

    // ── Build cross-file DAG ──
    const upstream = new Map<string, Set<string>>();
    const downstream = new Map<string, Set<string>>();
    const allFiles = new Set([...fileReads.keys(), ...fileWrites.keys()]);
    for (const f of allFiles) {
      upstream.set(f, new Set());
      downstream.set(f, new Set());
    }
    for (const [fileB, readTables] of fileReads) {
      for (const table of readTables) {
        for (const [fileA, writeTables] of fileWrites) {
          if (fileA === fileB) continue;
          if (writeTables.has(table)) {
            upstream.get(fileB)!.add(fileA);
            downstream.get(fileA)!.add(fileB);
          }
        }
      }
    }

    // ── Topological sort: max(upstream layers) + 1 ──
    const indegree = new Map<string, number>();
    for (const f of allFiles) indegree.set(f, upstream.get(f)?.size ?? 0);
    const layer = new Map<string, number>();
    const bfsQueue: string[] = [];
    for (const [f, deg] of indegree) {
      if (deg === 0) {
        layer.set(f, 1);
        bfsQueue.push(f);
      }
    }
    while (bfsQueue.length > 0) {
      const cur = bfsQueue.shift()!;
      for (const dep of downstream.get(cur) || []) {
        let maxUp = 0;
        for (const u of upstream.get(dep) ?? []) maxUp = Math.max(maxUp, layer.get(u) ?? 0);
        const newDeg = (indegree.get(dep) ?? 1) - 1;
        indegree.set(dep, newDeg);
        if (newDeg === 0 && !layer.has(dep)) {
          layer.set(dep, maxUp + 1);
          bfsQueue.push(dep);
        }
      }
    }
    for (const f of allFiles) {
      if (!layer.has(f)) layer.set(f, 1);
    }

    // ── Build PipelineTask[] ──
    let id = 0;
    const rawTasks: PipelineTask[] = [];
    for (const file of allFiles) {
      const lvl = layer.get(file) ?? 1;
      rawTasks.push({
        id: String(id++),
        taskName: file,
        workflowName: '',
        taskType: (upstream.get(file)?.size ?? 0) === 0 ? 'source' : 'file',
        inputTable: [...(fileReads.get(file) ?? [])].join(', ') || '-',
        outputTable: [...(fileWrites.get(file) ?? [])].join(', ') || '-',
        layer: `L${lvl}`,
        layerType: 'logical',
        schedule: { ...EMPTY_SCHEDULE, scriptPath: file },
      });
    }

    rawTasks.sort((a, b) => {
      const lvlA = parseInt(a.layer.slice(1));
      const lvlB = parseInt(b.layer.slice(1));
      if (lvlA !== lvlB) return lvlA - lvlB;
      return a.taskName.localeCompare(b.taskName);
    });

    const scripts = [...new Set(rawTasks.map((t) => t.taskName))].sort((a, b) =>
      a.localeCompare(b)
    );
    return { tasks: rawTasks, taskNames: scripts, scripts };
  }, [result]);
}
