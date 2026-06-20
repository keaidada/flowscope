import type { PipelineTask, LayerDef, TaskLineage, TaskSchedule } from '@/types/pipeline-matrix';

// ============================================================================
// Mock 第一张表：任务血缘
// ============================================================================
const mockLineageData: TaskLineage[] = [
  {
    workflowName: 'ods_l3_fu_traffic',
    taskName: 'load_f_smartfren_active_master_l3_fu_traffic',
    taskType: 'spark_sql',
    inputTable: 'smartfren_analytic_prd.stg_cc.f_smartfren_active_master_l3_fu_traffic',
    outputTable: 'smartfren_analytic_prd.ods_cc.f_smartfren_active_master_l3_fu_traffic',
    physicalLayer: 'ods',
    logicalLayer: 'L3',
  },
  {
    workflowName: 'ods_l3_fu_traffic',
    taskName: 'load_f_usage_cdr',
    taskType: 'spark_sql',
    inputTable: 'smartfren_analytic_prd.dwh_cc.f_usage_cdr',
    outputTable: 'smartfren_analytic_prd.ods_cc.f_usage_cdr',
    physicalLayer: 'ods',
    logicalLayer: 'L3',
  },
  {
    workflowName: 'dwd_order_movement',
    taskName: 'load_f_subs_order_movement',
    taskType: 'spark_sql',
    inputTable: 'smartfren_analytic_prd.dwh_cc.f_subs_order_movement',
    outputTable: 'smartfren_analytic_prd.dwd_cc.f_subs_order_movement',
    physicalLayer: 'dwd',
    logicalLayer: 'L2',
  },
  {
    workflowName: 'dwd_traffic_daily',
    taskName: 'agg_f_traffic_daily',
    taskType: 'spark_sql',
    inputTable: 'smartfren_analytic_prd.ods_cc.f_usage_cdr',
    outputTable: 'smartfren_analytic_prd.dwd_cc.f_traffic_daily',
    physicalLayer: 'dwd',
    logicalLayer: 'L2',
  },
  {
    workflowName: 'dwd_traffic_daily',
    taskName: 'join_traffic_master',
    taskType: 'spark_sql',
    inputTable: 'smartfren_analytic_prd.dwd_cc.f_traffic_daily',
    outputTable: 'smartfren_analytic_prd.dwd_cc.f_traffic_master_joined',
    physicalLayer: 'dwd',
    logicalLayer: 'L2',
  },
  {
    workflowName: 'dws_activation_first_use',
    taskName: 'compute_first_usage',
    taskType: 'pyspark',
    inputTable: 'smartfren_analytic_prd.dwd_cc.f_traffic_master_joined',
    outputTable: 'smartfren_analytic_prd.dws_cc.f_first_usage',
    physicalLayer: 'dws',
    logicalLayer: 'L1',
  },
  {
    workflowName: 'dws_activation_first_use',
    taskName: 'flag_subs_activation',
    taskType: 'pyspark',
    inputTable: 'smartfren_analytic_prd.dwd_cc.f_subs_order_movement',
    outputTable: 'smartfren_analytic_prd.dws_cc.f_subs_activation_flag',
    physicalLayer: 'dws',
    logicalLayer: 'L1',
  },
  {
    workflowName: 'ads_subs_profile',
    taskName: 'merge_subs_profile',
    taskType: 'pyspark',
    inputTable: 'smartfren_analytic_prd.dws_cc.f_first_usage',
    outputTable: 'smartfren_analytic_prd.ads_cc.f_subs_profile',
    physicalLayer: 'ads',
    logicalLayer: 'L0',
  },
  {
    workflowName: 'ads_subs_profile',
    taskName: 'export_subs_report',
    taskType: 'spark_sql',
    inputTable: 'smartfren_analytic_prd.ads_cc.f_subs_profile',
    outputTable: 'smartfren_analytic_prd.ads_cc.f_subs_report',
    physicalLayer: 'ads',
    logicalLayer: 'L0',
  },
  {
    workflowName: 'stg_data_ingestion',
    taskName: 'ingest_raw_cdr',
    taskType: 'pyspark',
    inputTable: 'smartfren_analytic_prd.raw.cdr_raw',
    outputTable: 'smartfren_analytic_prd.stg_cc.f_cdr_staging',
    physicalLayer: 'stg',
    logicalLayer: 'L4',
  },
  {
    workflowName: 'stg_data_ingestion',
    taskName: 'ingest_raw_order',
    taskType: 'pyspark',
    inputTable: 'smartfren_analytic_prd.raw.order_raw',
    outputTable: 'smartfren_analytic_prd.stg_cc.f_order_staging',
    physicalLayer: 'stg',
    logicalLayer: 'L4',
  },
  {
    workflowName: 'ods_l3_cleanup',
    taskName: 'cleanup_duplicate_subs',
    taskType: 'spark_sql',
    inputTable: 'smartfren_analytic_prd.stg_cc.f_cdr_staging',
    outputTable: 'smartfren_analytic_prd.ods_cc.f_cdr_cleaned',
    physicalLayer: 'ods',
    logicalLayer: 'L3',
  },
  {
    workflowName: 'dwd_enrich',
    taskName: 'enrich_subs_dim',
    taskType: 'spark_sql',
    inputTable: 'smartfren_analytic_prd.dwd_cc.f_subs_order_movement',
    outputTable: 'smartfren_analytic_prd.dwd_cc.f_subs_enriched',
    physicalLayer: 'dwd',
    logicalLayer: 'L2',
  },
  {
    workflowName: 'dws_aggregation',
    taskName: 'agg_monthly_subs',
    taskType: 'pyspark',
    inputTable: 'smartfren_analytic_prd.dwd_cc.f_subs_enriched',
    outputTable: 'smartfren_analytic_prd.dws_cc.f_monthly_subs_agg',
    physicalLayer: 'dws',
    logicalLayer: 'L1',
  },
  {
    workflowName: 'ads_export',
    taskName: 'export_dashboard',
    taskType: 'pyspark',
    inputTable: 'smartfren_analytic_prd.dws_cc.f_monthly_subs_agg',
    outputTable: 'smartfren_analytic_prd.ads_cc.f_dashboard_export',
    physicalLayer: 'ads',
    logicalLayer: 'L0',
  },
];

// ============================================================================
// Mock 第二张表：调度状态
// ============================================================================
const mockScheduleData: TaskSchedule[] = [
  {
    date: '2026-06-17',
    wedataWorkflow: 'ods_l3_fu_traffic',
    wedataStatus: 'success',
    wedataSchedule: 'daily_02:00',
    airflowWorkflow: 'ods_l3_fu_traffic_dag',
    airflowStatus: 'success',
    airflowSchedule: '0 2 * * *',
    scriptChanged: false,
    scriptPath: '/etl/ods/l3_fu_traffic/load_master.py',
  },
  {
    date: '2026-06-17',
    wedataWorkflow: 'ods_l3_fu_traffic',
    wedataStatus: 'success',
    wedataSchedule: 'daily_02:00',
    airflowWorkflow: 'ods_l3_fu_traffic_dag',
    airflowStatus: 'success',
    airflowSchedule: '0 2 * * *',
    scriptChanged: false,
    scriptPath: '/etl/ods/l3_fu_traffic/load_cdr.py',
  },
  {
    date: '2026-06-17',
    wedataWorkflow: 'dwd_order_movement',
    wedataStatus: 'failed',
    wedataSchedule: 'daily_04:00',
    airflowWorkflow: 'dwd_order_movement_dag',
    airflowStatus: 'failed',
    airflowSchedule: '0 4 * * *',
    scriptChanged: true,
    scriptPath: '/etl/dwd/order_movement/load.py',
  },
  {
    date: '2026-06-17',
    wedataWorkflow: 'dwd_traffic_daily',
    wedataStatus: 'success',
    wedataSchedule: 'daily_03:00',
    airflowWorkflow: 'dwd_traffic_daily_dag',
    airflowStatus: 'success',
    airflowSchedule: '0 3 * * *',
    scriptChanged: false,
    scriptPath: '/etl/dwd/traffic_daily/agg.py',
  },
  {
    date: '2026-06-17',
    wedataWorkflow: 'dwd_traffic_daily',
    wedataStatus: 'success',
    wedataSchedule: 'daily_03:00',
    airflowWorkflow: 'dwd_traffic_daily_dag',
    airflowStatus: 'success',
    airflowSchedule: '0 3 * * *',
    scriptChanged: false,
    scriptPath: '/etl/dwd/traffic_daily/join.py',
  },
  {
    date: '2026-06-17',
    wedataWorkflow: 'dws_activation_first_use',
    wedataStatus: 'success',
    wedataSchedule: 'daily_05:00',
    airflowWorkflow: 'dws_activation_dag',
    airflowStatus: 'success',
    airflowSchedule: '0 5 * * *',
    scriptChanged: false,
    scriptPath: '/etl/dws/activation/first_use.py',
  },
  {
    date: '2026-06-17',
    wedataWorkflow: 'dws_activation_first_use',
    wedataStatus: 'running',
    wedataSchedule: 'daily_05:00',
    airflowWorkflow: 'dws_activation_dag',
    airflowStatus: 'running',
    airflowSchedule: '0 5 * * *',
    scriptChanged: true,
    scriptPath: '/etl/dws/activation/flag.py',
  },
  {
    date: '2026-06-17',
    wedataWorkflow: 'ads_subs_profile',
    wedataStatus: 'waiting',
    wedataSchedule: 'daily_06:00',
    airflowWorkflow: 'ads_subs_profile_dag',
    airflowStatus: 'waiting',
    airflowSchedule: '0 6 * * *',
    scriptChanged: false,
    scriptPath: '/etl/ads/subs_profile/merge.py',
  },
  {
    date: '2026-06-17',
    wedataWorkflow: 'ads_subs_profile',
    wedataStatus: 'waiting',
    wedataSchedule: 'daily_06:00',
    airflowWorkflow: 'ads_subs_profile_dag',
    airflowStatus: 'waiting',
    airflowSchedule: '0 6 * * *',
    scriptChanged: false,
    scriptPath: '/etl/ads/subs_profile/export.py',
  },
  {
    date: '2026-06-17',
    wedataWorkflow: 'stg_data_ingestion',
    wedataStatus: 'success',
    wedataSchedule: 'daily_01:00',
    airflowWorkflow: 'stg_ingestion_dag',
    airflowStatus: 'success',
    airflowSchedule: '0 1 * * *',
    scriptChanged: false,
    scriptPath: '/etl/stg/ingestion/cdr.py',
  },
  {
    date: '2026-06-17',
    wedataWorkflow: 'stg_data_ingestion',
    wedataStatus: 'success',
    wedataSchedule: 'daily_01:00',
    airflowWorkflow: 'stg_ingestion_dag',
    airflowStatus: 'success',
    airflowSchedule: '0 1 * * *',
    scriptChanged: false,
    scriptPath: '/etl/stg/ingestion/order.py',
  },
  {
    date: '2026-06-17',
    wedataWorkflow: 'ods_l3_cleanup',
    wedataStatus: 'success',
    wedataSchedule: 'daily_02:30',
    airflowWorkflow: 'ods_cleanup_dag',
    airflowStatus: 'success',
    airflowSchedule: '30 2 * * *',
    scriptChanged: false,
    scriptPath: '/etl/ods/l3_cleanup/dedup.py',
  },
  {
    date: '2026-06-17',
    wedataWorkflow: 'dwd_enrich',
    wedataStatus: 'success',
    wedataSchedule: 'daily_04:30',
    airflowWorkflow: 'dwd_enrich_dag',
    airflowStatus: 'success',
    airflowSchedule: '30 4 * * *',
    scriptChanged: false,
    scriptPath: '/etl/dwd/enrich/subs_dim.py',
  },
  {
    date: '2026-06-17',
    wedataWorkflow: 'dws_aggregation',
    wedataStatus: 'success',
    wedataSchedule: 'daily_05:30',
    airflowWorkflow: 'dws_agg_dag',
    airflowStatus: 'success',
    airflowSchedule: '30 5 * * *',
    scriptChanged: false,
    scriptPath: '/etl/dws/aggregation/monthly.py',
  },
  {
    date: '2026-06-17',
    wedataWorkflow: 'ads_export',
    wedataStatus: 'waiting',
    wedataSchedule: 'daily_07:00',
    airflowWorkflow: 'ads_export_dag',
    airflowStatus: 'waiting',
    airflowSchedule: '0 7 * * *',
    scriptChanged: true,
    scriptPath: '/etl/ads/export/dashboard.py',
  },
];

// ============================================================================
// 层级定义（Y 轴）
// ============================================================================
export const LAYER_DEFS: LayerDef[] = [
  { key: 'L4', label: 'L4 · STG', type: 'physical', order: 0 },
  { key: 'L3', label: 'L3 · ODS', type: 'physical', order: 1 },
  { key: 'L2', label: 'L2 · DWD', type: 'physical', order: 2 },
  { key: 'L1', label: 'L1 · DWS', type: 'physical', order: 3 },
  { key: 'L0', label: 'L0 · ADS', type: 'physical', order: 4 },
];

// ============================================================================
// 合并：从两张表生成 PipelineTask[]
// ============================================================================
export function buildPipelineTasks(): {
  tasks: PipelineTask[];
  layers: LayerDef[];
  taskNames: string[];
} {
  const scheduleMap = new Map<string, TaskSchedule>();
  for (const s of mockScheduleData) {
    // 用 workflowName + scriptPath 作为 key 匹配
    scheduleMap.set(`${s.wedataWorkflow}::${s.scriptPath}`, s);
  }

  const tasks: PipelineTask[] = [];
  let id = 0;

  for (const lineage of mockLineageData) {
    // 尝试匹配调度信息
    const schedule = mockScheduleData.find(
      (s) => s.wedataWorkflow === lineage.workflowName
    );

    tasks.push({
      id: String(id++),
      taskName: lineage.taskName,
      workflowName: lineage.workflowName,
      taskType: lineage.taskType,
      inputTable: lineage.inputTable,
      outputTable: lineage.outputTable,
      layer: lineage.logicalLayer,
      layerType: 'logical',
      schedule,
    });
  }

  const taskNames = [...new Set(tasks.map((t) => t.taskName))].sort((a, b) =>
    a.localeCompare(b)
  );

  return { tasks, layers: LAYER_DEFS, taskNames };
}

// ============================================================================
// 按（taskName × layer）构建矩阵格点
// ============================================================================
export interface MatrixCell {
  x: number; // 列索引（taskName）
  y: number; // 行索引（layer）
  tasks: PipelineTask[];
}

export function buildMatrixGrid(
  tasks: PipelineTask[],
  taskNames: string[],
  layers: LayerDef[]
): MatrixCell[][] {
  // 初始化空网格
  const grid: MatrixCell[][] = layers.map((_, y) =>
    taskNames.map((_, x) => ({ x, y, tasks: [] }))
  );

  for (const task of tasks) {
    const x = taskNames.indexOf(task.taskName);
    const y = layers.findIndex((l) => l.key === task.layer);
    if (x >= 0 && y >= 0) {
      grid[y][x].tasks.push(task);
    }
  }

  return grid;
}
