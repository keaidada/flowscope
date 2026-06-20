import { useMemo } from 'react';
import type { AnalyzeResult } from '@pondpilot/flowscope-core';
import type { PipelineTask, TaskSchedule } from '@/types/pipeline-matrix';

// ============================================================================
// 层级推断：从表路径中提取物理层 → 映射到逻辑层
// ============================================================================
const SCHEMA_LAYER_MAP: Record<string, { physical: string; logical: string }> = {
  raw: { physical: 'raw', logical: 'L5' },
  stg: { physical: 'stg', logical: 'L4' },
  ods: { physical: 'ods', logical: 'L3' },
  dwd: { physical: 'dwd', logical: 'L2' },
  dws: { physical: 'dws', logical: 'L1' },
  ads: { physical: 'ads', logical: 'L0' },
  app: { physical: 'app', logical: 'L0' },
};

function inferLayer(qualifiedName: string): { physical: string; logical: string } {
  const parts = qualifiedName.split('.');
  // e.g. "smartfren_analytic_prd.ods_cc.f_usage_cdr" → schema = "ods_cc"
  if (parts.length >= 2) {
    const schema = parts[parts.length - 2].toLowerCase();
    for (const [prefix, layer] of Object.entries(SCHEMA_LAYER_MAP)) {
      if (schema.startsWith(prefix)) return layer;
    }
  }
  // fallback: check if the name itself contains layer prefix
  const lower = qualifiedName.toLowerCase();
  for (const [prefix, layer] of Object.entries(SCHEMA_LAYER_MAP)) {
    if (lower.includes(`_${prefix}_`) || lower.startsWith(`${prefix}_`)) return layer;
  }
  return { physical: 'unknown', logical: '?' };
}

// ============================================================================
// 从 table name 推断任务类型
// ============================================================================
function inferTaskType(sourceName: string): string {
  const lower = sourceName.toLowerCase();
  if (lower.endsWith('.py') || lower.includes('/python/') || lower.includes('/pyspark/')) return 'pyspark';
  if (lower.endsWith('.sql') || lower.includes('/sql/')) return 'spark_sql';
  if (lower.endsWith('.sh') || lower.includes('/shell/')) return 'shell';
  return 'spark_sql'; // default
}

// ============================================================================
// 从 sourceName 提取简短任务名
// ============================================================================
function extractTaskName(sourceName: string): string {
  // Remove extension and leading path
  const name = sourceName.split('/').pop() || sourceName;
  return name.replace(/\.(py|sql|sh|scala|java)$/, '');
}

// ============================================================================
// 从 sourceName 推断工作流名
// ============================================================================
function extractWorkflowName(sourceName: string): string {
  // e.g. "/etl/ods/l3_fu_traffic/load.py" → "ods_l3_fu_traffic"
  const parts = sourceName.replace(/^\//, '').split('/');
  // Find the path segment that looks like a workflow/domain directory
  for (let i = parts.length - 2; i >= 0; i--) {
    const part = parts[i];
    // Skip common prefixes like "etl", "src", "scripts"
    if (part === 'etl' || part === 'src' || part === 'scripts' || part === 'pipelines') continue;
    return part;
  }
  // Fallback: use the directory name before the file
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
// Hook: 从 AnalyzeResult 构建 PipelineTask[]
// ============================================================================
export interface PipelineData {
  tasks: PipelineTask[];
  taskNames: string[];
  /** 按 taskName 去重后的脚本列表（用于矩阵 X 轴） */
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
        layers: Set<string>;
      }
    >();

    for (const stmt of result.statements) {
      const sourceName = stmt.sourceName || '(unknown)';
      if (!scriptMap.has(sourceName)) {
        scriptMap.set(sourceName, {
          sourceName,
          inputTables: new Set(),
          outputTables: new Set(),
          layers: new Set(),
        });
      }
      const entry = scriptMap.get(sourceName)!;

      for (const node of stmt.nodes) {
        // Skip CTEs and columns
        if (node.type === 'cte' || node.type === 'column') continue;

        const qName = node.qualifiedName || node.label;
        if (!qName) continue;

        // implied → INSERT/UPDATE/DELETE target → output table (write)
        // imported → schema-resolved → input table (read)
        // unknown → could be either, default to read
        if (node.resolutionSource === 'implied') {
          entry.outputTables.add(qName);
        } else {
          entry.inputTables.add(qName);
        }

        // Collect layer info
        const layer = inferLayer(qName);
        if (layer.logical !== '?') {
          entry.layers.add(layer.logical);
        }
      }
    }

    // Build PipelineTask[]
    let id = 0;
    const tasks: PipelineTask[] = [];

    for (const [, entry] of scriptMap) {
      const layerLogical = entry.layers.size > 0
        ? [...entry.layers].sort()[0]
        : '?';

      const taskName = extractTaskName(entry.sourceName);
      const workflowName = extractWorkflowName(entry.sourceName);
      const taskType = inferTaskType(entry.sourceName);

      for (const outputTable of entry.outputTables) {
        // One task per output table (more granular)
        const layer = inferLayer(outputTable);
        tasks.push({
          id: String(id++),
          taskName,
          workflowName,
          taskType,
          inputTable: [...entry.inputTables].sort().join(', ') || '-',
          outputTable,
          layer: layer.logical,
          layerType: 'logical',
          schedule: { ...EMPTY_SCHEDULE, scriptPath: entry.sourceName },
        });
      }

      // If no output tables (e.g., pure SELECT), still create one entry
      if (entry.outputTables.size === 0 && entry.inputTables.size > 0) {
        tasks.push({
          id: String(id++),
          taskName,
          workflowName,
          taskType,
          inputTable: [...entry.inputTables].sort().join(', '),
          outputTable: '-',
          layer: layerLogical,
          layerType: 'logical',
          schedule: { ...EMPTY_SCHEDULE, scriptPath: entry.sourceName },
        });
      }
    }

    const scripts = [...new Set(tasks.map((t) => t.taskName))].sort((a, b) =>
      a.localeCompare(b)
    );

    return { tasks, taskNames: scripts, scripts };
  }, [result]);
}
