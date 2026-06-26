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

function isSparkTempTable(name: string): boolean {
  return name.split('.').some((part) =>
    part.toUpperCase().startsWith('TEMP_')
  );
}

/**
 * Build a file-level pipeline DAG from AnalyzeResult.
 *
 * Approach:
 * 1. Each statement has a sourceName (file path) and nodes/edges (table graph).
 * 2. For each statement, collect what tables it READS and what tables it WRITES.
 * 3. Aggregate to file level: file → { reads: Set<table>, writes: Set<table> }
 * 4. Build cross-file DAG: file A writes table T, file B reads table T → A → B edge
 * 5. Topological sort → file layers (L1, L2, ...)
 */
export function usePipelineData(result: AnalyzeResult | null): PipelineData {
  return useMemo(() => {
    if (!result || !result.statements || result.statements.length === 0) {
      return { tasks: [], taskNames: [], scripts: [] };
    }

    // ── isPhysicalTable ──
    const tempNames = new Set<string>();
    if (result.resolvedSchema?.tables) {
      for (const t of result.resolvedSchema.tables) {
        if (t.temporary) {
          tempNames.add(t.name);
          if (t.schema) tempNames.add(`${t.schema}.${t.name}`);
          if (t.catalog && t.schema) tempNames.add(`${t.catalog}.${t.schema}.${t.name}`);
        }
      }
    }

    const isPhysical = (node: {
      type: string;
      qualifiedName?: string;
      label: string;
      resolutionSource?: string;
    }): boolean => {
      if (node.type !== 'table' && node.type !== 'view') return false;
      const qName = node.qualifiedName || node.label;
      if (tempNames.has(qName) || tempNames.has(node.label)) return false;
      if (isSparkTempTable(qName) || isSparkTempTable(node.label)) return false;
      if (node.resolutionSource) return true;
      return qName.includes('.');
    };

    // ── Step 1: per-statement read/write sets ──
    type StmtInfo = {
      sourceName: string;
      reads: Set<string>;   // input tables
      writes: Set<string>;  // output tables
    };
    const stmtInfos: StmtInfo[] = [];

    for (const stmt of result.statements) {
      const sourceName = stmt.sourceName || '';

      const physical = stmt.nodes.filter(isPhysical);
      const physicalIds = new Set(physical.map((n) => n.id));

      // Tables receiving data_flow edges = writes (INSERT/MERGE targets, intermediates)
      // Tables with only outgoing edges = reads (SELECT sources)
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
        if (!hasIncoming.has(node.id)) {
          reads.add(qName);
        } else {
          writes.add(qName);
        }
      }

      stmtInfos.push({ sourceName, reads, writes });
    }

    // ── Step 2: aggregate to file level ──
    const fileReads = new Map<string, Set<string>>();
    const fileWrites = new Map<string, Set<string>>();

    for (const info of stmtInfos) {
      const f = info.sourceName;
      if (!fileReads.has(f)) fileReads.set(f, new Set());
      if (!fileWrites.has(f)) fileWrites.set(f, new Set());
      for (const t of info.reads) fileReads.get(f)!.add(t);
      for (const t of info.writes) fileWrites.get(f)!.add(t);
    }

    // ── Step 3: build table → producing files index ──
    const tableToFiles = new Map<string, Set<string>>();
    for (const [file, tables] of fileWrites) {
      for (const t of tables) {
        if (!tableToFiles.has(t)) tableToFiles.set(t, new Set());
        tableToFiles.get(t)!.add(file);
      }
    }

    // ── Step 4: cross-file DAG ──
    // B → upstream ≡ { files that produce any table that B reads }
    const upstream = new Map<string, Set<string>>();
    const downstream = new Map<string, Set<string>>();
    const allFiles = new Set([...fileReads.keys(), ...fileWrites.keys()]);
    for (const f of allFiles) {
      upstream.set(f, new Set());
      downstream.set(f, new Set());
    }

    for (const [fileB, readTables] of fileReads) {
      for (const table of readTables) {
        const producers = tableToFiles.get(table);
        if (!producers) continue;
        for (const fileA of producers) {
          if (fileA !== fileB) {
            upstream.get(fileB)!.add(fileA);
            downstream.get(fileA)!.add(fileB);
          }
        }
      }
    }

    // ── Step 5: topological sort → file layers ──
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
      const curLayer = layer.get(cur)!;
      for (const dep of downstream.get(cur) || []) {
        const newDeg = (indegree.get(dep) ?? 1) - 1;
        indegree.set(dep, newDeg);
        if (newDeg === 0 && !layer.has(dep)) {
          layer.set(dep, curLayer + 1);
          bfsQueue.push(dep);
        }
      }
    }

    for (const f of allFiles) {
      if (!layer.has(f)) layer.set(f, 1);
    }

    // ── Step 6: build PipelineTask[] ──
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
      a.localeCompare(b),
    );

    return { tasks: rawTasks, taskNames: scripts, scripts };
  }, [result]);
}
