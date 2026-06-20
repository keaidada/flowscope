import { useMemo } from 'react';
import type { AnalyzeResult } from '@pondpilot/flowscope-core';
import type { PipelineTask, TaskSchedule } from '@/types/pipeline-matrix';

// ============================================================================
// 从 sourceName 推断任务类型
// ============================================================================
function inferTaskType(sourceName: string): string {
  const lower = sourceName.toLowerCase();
  if (lower.endsWith('.py') || lower.includes('/python/') || lower.includes('/pyspark/')) return 'pyspark';
  if (lower.endsWith('.sql') || lower.includes('/sql/')) return 'spark_sql';
  if (lower.endsWith('.sh') || lower.includes('/shell/')) return 'shell';
  return 'spark_sql';
}

// ============================================================================
// 从 sourceName 提取简短任务名
// ============================================================================
function extractTaskName(sourceName: string): string {
  const name = sourceName.split('/').pop() || sourceName;
  return name.replace(/\.(py|sql|sh|scala|java)$/, '');
}

// ============================================================================
// 从 sourceName 推断工作流名
// ============================================================================
function extractWorkflowName(sourceName: string): string {
  const parts = sourceName.replace(/^\//, '').split('/');
  for (let i = parts.length - 2; i >= 0; i--) {
    const part = parts[i];
    if (part === 'etl' || part === 'src' || part === 'scripts' || part === 'pipelines') continue;
    return part;
  }
  if (parts.length >= 2) return parts[parts.length - 2];
  return parts[0] || sourceName;
}

// ============================================================================
// Empty schedule template
// ============================================================================
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

// ============================================================================
// 拓扑层级：L1=无下游任务，L2..Ln=下游最大深度+1
// ============================================================================
function computeTopoLevels(tasks: PipelineTask[]): PipelineTask[] {
  // Build index: output table → producing task ids
  const producerByTable = new Map<string, string[]>();
  // Build index: task id → task
  const taskById = new Map<string, PipelineTask>();

  for (const task of tasks) {
    taskById.set(task.id, task);
    if (task.outputTable && task.outputTable !== '-') {
      const tables = task.outputTable.split(', ');
      for (const tbl of tables) {
        if (!producerByTable.has(tbl)) producerByTable.set(tbl, []);
        producerByTable.get(tbl)!.push(task.id);
      }
    }
  }

  // Build downstream edges: for each task, find which tasks consume its output
  const downstream = new Map<string, Set<string>>();
  const indegree = new Map<string, number>();

  for (const task of tasks) {
    downstream.set(task.id, new Set());
    indegree.set(task.id, 0);
  }

  for (const task of tasks) {
    const inputTables = task.inputTable !== '-' ? task.inputTable.split(', ') : [];
    for (const inputTbl of inputTables) {
      const producers = producerByTable.get(inputTbl);
      if (producers) {
        for (const producerId of producers) {
          if (producerId !== task.id) {
            // Task depends on producer → producer → task (producer is upstream)
            downstream.get(producerId)!.add(task.id);
            indegree.set(task.id, (indegree.get(task.id) || 0) + 1);
          }
        }
      }
    }
  }

  // Compute levels via topological order, starting from leaves (L1 = no downstream)
  const level = new Map<string, number>();
  const visited = new Set<string>();
  const leafIds: string[] = [];

  // Find leaf nodes: tasks that produce nothing consumed by any other task
  for (const task of tasks) {
    if (downstream.get(task.id)!.size === 0) {
      leafIds.push(task.id);
    }
  }

  // BFS from leaves upward, assign levels
  // Also handle disconnected tasks
  const upstream = new Map<string, Set<string>>();
  for (const task of tasks) upstream.set(task.id, new Set());
  for (const [tid, deps] of downstream) {
    for (const depId of deps) {
      upstream.get(depId)!.add(tid);
    }
  }

  const queue: string[] = [...leafIds];
  for (const leafId of queue) {
    level.set(leafId, 1);
    visited.add(leafId);
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    // Walk upstream: tasks that feed into current
    for (const upId of upstream.get(current) || []) {
      if (visited.has(upId)) continue;
      // Only set level when ALL downstreams are visited
      const allDownstreamVisited = [...(downstream.get(upId) || [])].every((d) => visited.has(d));
      if (allDownstreamVisited) {
        const maxDownstreamLevel = Math.max(
          0,
          ...[...(downstream.get(upId) || [])].map((d) => level.get(d) || 0)
        );
        level.set(upId, maxDownstreamLevel + 1);
        visited.add(upId);
        queue.push(upId);
      }
    }
  }

  // For isolated tasks and tasks whose upstream chain wasn't reached
  // (e.g., no downstream at all), assign L1
  for (const task of tasks) {
    if (!level.has(task.id)) {
      // Check if it's a pure consumer (has downstream but some were unreachable)
      // or truly isolated
      level.set(task.id, 1);
    }
  }

  // Apply levels
  return tasks.map((task) => ({
    ...task,
    layer: `L${level.get(task.id) || 1}`,
  }));
}

// ============================================================================
// Hook: 从 AnalyzeResult 构建 PipelineTask[]
// ============================================================================
export interface PipelineData {
  tasks: PipelineTask[];
  taskNames: string[];
  scripts: string[];
}

export function usePipelineData(result: AnalyzeResult | null): PipelineData {
  return useMemo(() => {
    if (!result || !result.statements || result.statements.length === 0) {
      return { tasks: [], taskNames: [], scripts: [] };
    }

    // 按 sourceName 分组
    const scriptMap = new Map<
      string,
      {
        sourceName: string;
        inputTables: Set<string>;
        outputTables: Set<string>;
      }
    >();

    for (const stmt of result.statements) {
      const sourceName = stmt.sourceName || '(unknown)';
      if (!scriptMap.has(sourceName)) {
        scriptMap.set(sourceName, {
          sourceName,
          inputTables: new Set(),
          outputTables: new Set(),
        });
      }
      const entry = scriptMap.get(sourceName)!;

      for (const node of stmt.nodes) {
        if (node.type === 'cte' || node.type === 'column') continue;

        const qName = node.qualifiedName || node.label;
        if (!qName) continue;

        if (node.resolutionSource === 'implied') {
          entry.outputTables.add(qName);
        } else {
          entry.inputTables.add(qName);
        }
      }
    }

    // Build raw tasks
    let id = 0;
    let rawTasks: PipelineTask[] = [];

    for (const [, entry] of scriptMap) {
      const taskName = extractTaskName(entry.sourceName);
      const workflowName = extractWorkflowName(entry.sourceName);
      const taskType = inferTaskType(entry.sourceName);

      for (const outputTable of entry.outputTables) {
        rawTasks.push({
          id: String(id++),
          taskName,
          workflowName,
          taskType,
          inputTable: [...entry.inputTables].sort().join(', ') || '-',
          outputTable,
          layer: 'L1', // placeholder
          layerType: 'logical',
          schedule: { ...EMPTY_SCHEDULE, scriptPath: entry.sourceName },
        });
      }

      if (entry.outputTables.size === 0 && entry.inputTables.size > 0) {
        rawTasks.push({
          id: String(id++),
          taskName,
          workflowName,
          taskType,
          inputTable: [...entry.inputTables].sort().join(', '),
          outputTable: '-',
          layer: 'L1',
          layerType: 'logical',
          schedule: { ...EMPTY_SCHEDULE, scriptPath: entry.sourceName },
        });
      }
    }

    // Compute topological levels
    const tasks = computeTopoLevels(rawTasks);

    const scripts = [...new Set(tasks.map((t) => t.taskName))].sort((a, b) =>
      a.localeCompare(b)
    );

    return { tasks, taskNames: scripts, scripts };
  }, [result]);
}
