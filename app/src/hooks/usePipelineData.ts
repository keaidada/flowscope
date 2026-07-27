import { useMemo, useState, useEffect } from 'react';
import type { AnalyzeResult } from '@pondpilot/flowscope-core';
import type { PipelineTask, TaskSchedule } from '@/types/pipeline-matrix';
import { loadTableLevelEdges } from '@/lib/server-db';
import { useProject } from '@/lib/project-store';

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
 * Build a file-level pipeline DAG from AnalyzeResult + table_level_edges.
 *
 * Data sources (priority order):
 * 1. table_level_edges (DB materialized, authoritative read/write direction)
 * 2. globalLineage edges (producerStatement/consumerStatement)
 * 3. Per-statement node/edge heuristic (fallback)
 *
 * table_level_edges format: [from_table, to_table, script]
 *   - from_table = what the script READS
 *   - to_table   = what the script WRITES
 */

function normalize(s: string): string {
  return s.toLowerCase().trim();
}

function buildDagFromMaps(
  fileReads: Map<string, Set<string>>,
  fileWrites: Map<string, Set<string>>,
): { tasks: PipelineTask[]; taskNames: string[]; scripts: string[] } {
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
}

export function usePipelineData(result: AnalyzeResult | null): PipelineData {
  const { activeProjectId } = useProject();

  // Fetch table_level_edges from server (authoritative source)
  const [tleEdges, setTleEdges] = useState<Array<[string, string, string]>>([]);
  useEffect(() => {
    if (!activeProjectId) return;
    let cancelled = false;
    loadTableLevelEdges(activeProjectId)
      .then((edges) => {
        if (!cancelled) setTleEdges(edges);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [activeProjectId]);

  return useMemo(() => {
    if (!result || !result.statements || result.statements.length === 0) {
      return { tasks: [], taskNames: [], scripts: [] };
    }

    const fileReads = new Map<string, Set<string>>();
    const fileWrites = new Map<string, Set<string>>();
    const allNames = new Set<string>();

    // ── Data source 1: table_level_edges (authoritative) ──────────
    // format: [from_table, to_table, script]
    //   from_table → read  |  to_table → write

    // table_level_edges not yet loaded → return empty
    if (tleEdges.length === 0) return { tasks: [], taskNames: [], scripts: [] };

    for (const [fromTable, toTable, file] of tleEdges) {
        const script = normalize(file);
        if (!script) continue;
        allNames.add(script);

        const reads = normalize(fromTable);
        const writes = normalize(toTable);

        if (reads && reads !== '-') {
          if (!fileReads.has(script)) fileReads.set(script, new Set());
          fileReads.get(script)!.add(reads);
        }
        if (writes && writes !== '-') {
          if (!fileWrites.has(script)) fileWrites.set(script, new Set());
          fileWrites.get(script)!.add(writes);
        }
      }

      return buildDagFromMaps(fileReads, fileWrites);
  }, [result, tleEdges]);
}
