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
    if (tleEdges.length > 0) {
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

      // GlobalLineage as secondary source (adds table-level info)
      const gl = result.globalLineage;
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
        const glReadTables = new Map<string, Set<string>>();
        const glWriteTables = new Map<string, Set<string>>();
        for (const edge of gl.edges) {
          const tableName = normalize(
            nodeLabelById.get(edge.from as string) || (edge.id as string)
          );
          const ps = edge.producerStatement;
          const cs = edge.consumerStatement;

          if (ps) {
            const src = idxToSource.get(ps.statementIndex);
            if (src) {
              const f = src || '__unknown__';
              if (!glWriteTables.has(f)) glWriteTables.set(f, new Set());
              glWriteTables.get(f)!.add(tableName);
            }
          }
          if (cs) {
            const src = idxToSource.get(cs.statementIndex);
            if (src) {
              const f = src || '__unknown__';
              if (!glReadTables.has(f)) glReadTables.set(f, new Set());
              glReadTables.get(f)!.add(tableName);
            }
          }
        }

        // GlobalLineage adds to table_level_edges (doesn't override)
        for (const [f, reads] of glReadTables) {
          if (!allNames.has(f)) {
            allNames.add(f);
            if (!fileReads.has(f)) fileReads.set(f, new Set());
          }
          const fr = fileReads.get(f)!;
          for (const t of reads) fr.add(t);
        }
        for (const [f, writes] of glWriteTables) {
          if (!allNames.has(f)) {
            allNames.add(f);
            if (!fileWrites.has(f)) fileWrites.set(f, new Set());
          }
          const fw = fileWrites.get(f)!;
          for (const t of writes) fw.add(t);
        }

        // Cleanup conflicts: GL overrides table_level_edges for opposite dir
        for (const [f, reads] of glReadTables) {
          const writes = fileWrites.get(f);
          if (writes) {
            for (const t of reads) writes.delete(t);
          }
        }
        for (const [f, writes] of glWriteTables) {
          const reads = fileReads.get(f);
          if (reads) {
            for (const t of writes) reads.delete(t);
          }
        }
      }

      return buildDagFromMaps(fileReads, fileWrites);
    }

    // ── Fallback: per-statement heuristic + globalLineage ─────────
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
        const qName = normalize(node.qualifiedName || node.label);
        if (hasIncoming.has(node.id)) writes.add(qName);
        else reads.add(qName);
      }
      if (reads.size > 0 || writes.size > 0) {
        stmtInfos.push({ sourceName, reads, writes });
      }
    }

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

    const fileReadsGl = new Map(fileReads0);
    const fileWritesGl = new Map(fileWrites0);
    const glReadTables = new Map<string, Set<string>>();
    const glWriteTables = new Map<string, Set<string>>();

    const gl = result.globalLineage;
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
        const tableName = normalize(
          nodeLabelById.get(edge.from as string) || (edge.id as string)
        );
        const ps = edge.producerStatement;
        const cs = edge.consumerStatement;
        if (ps) {
          const src = idxToSource.get(ps.statementIndex);
          if (src) {
            const f = src || '__unknown__';
            if (!fileWritesGl.has(f)) {
              fileWritesGl.set(f, new Set());
              fileReadsGl.set(f, new Set());
            }
            fileWritesGl.get(f)!.add(tableName);
            if (!glWriteTables.has(f)) glWriteTables.set(f, new Set());
            glWriteTables.get(f)!.add(tableName);
          }
        }
        if (cs) {
          const src = idxToSource.get(cs.statementIndex);
          if (src) {
            const f = src || '__unknown__';
            if (!fileReadsGl.has(f)) {
              fileReadsGl.set(f, new Set());
              fileWritesGl.set(f, new Set());
            }
            fileReadsGl.get(f)!.add(tableName);
            if (!glReadTables.has(f)) glReadTables.set(f, new Set());
            glReadTables.get(f)!.add(tableName);
          }
        }
      }

      // Cleanup conflicts
      for (const [f, reads] of glReadTables) {
        const writes = fileWritesGl.get(f);
        if (writes) {
          for (const t of reads) writes.delete(t);
        }
      }
      for (const [f, writes] of glWriteTables) {
        const reads = fileReadsGl.get(f);
        if (reads) {
          for (const t of writes) reads.delete(t);
        }
      }
    }

    return buildDagFromMaps(fileReadsGl, fileWritesGl);
  }, [result, tleEdges]);
}
