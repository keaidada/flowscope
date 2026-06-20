// ============================================================================
// 第一张表：任务血缘
// ============================================================================
export interface TaskLineage {
  /** 工作流名字 */
  workflowName: string;
  /** 任务名字（脚本名） */
  taskName: string;
  /** 任务类型：etl 具体哪个类型 */
  taskType: string;
  /** 输入表 */
  inputTable: string;
  /** 输出表 */
  outputTable: string;
  /** 物理层级 */
  physicalLayer: string;
  /** 逻辑层级 */
  logicalLayer: string;
}

// ============================================================================
// 第二张表：调度状态
// ============================================================================
export interface TaskSchedule {
  /** 日期 */
  date: string;
  /** WeData 工作流 */
  wedataWorkflow: string;
  /** WeData 状态 */
  wedataStatus: string;
  /** WeData 调度情况 */
  wedataSchedule: string;
  /** Airflow 工作流 */
  airflowWorkflow: string;
  /** Airflow 状态 */
  airflowStatus: string;
  /** Airflow 调度情况 */
  airflowSchedule: string;
  /** 脚本是否有变化 */
  scriptChanged: boolean;
  /** 脚本地址（本地） */
  scriptPath: string;
}

// ============================================================================
// 合并后的任务节点（用于矩阵展示）
// ============================================================================
export interface PipelineTask {
  /** 唯一 ID */
  id: string;
  /** 任务名（脚本名） — X 轴 */
  taskName: string;
  /** 工作流名 */
  workflowName: string;
  /** 任务类型 */
  taskType: string;
  /** 输入表 */
  inputTable: string;
  /** 输出表 */
  outputTable: string;
  /** 层级（物理层 or 逻辑层）— Y 轴 */
  layer: string;
  /** 层级类型 */
  layerType: 'physical' | 'logical';
  /** 调度信息 */
  schedule?: TaskSchedule;
}

// ============================================================================
// 层级定义（Y 轴）
// ============================================================================
export interface LayerDef {
  key: string;
  label: string;
  type: 'physical' | 'logical';
  order: number;
}
