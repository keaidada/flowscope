# 数据洞察（Data Insights）功能需求文档

> **状态**：Draft v1.0
> **作者**：需求对齐阶段
> **更新**：2026-07-19
> **变更**：v1.0 — 在全局血缘图中新增"数据洞察"tab，复用现有GraphView组件

## 1. 背景与目标

### 1.1 背景

当前 FlowScope 已具备完整的 SQL 血缘解析能力和成熟的全局血缘关系图（GraphView），以"图"的形式展示**表与字段**的血缘关系。

**现有 GraphView 特性**：
- 使用 React Flow 实现
- 支持表节点（`TableNode`）展开/折叠字段列表
- 支持字段节点（`ColumnNode`）高亮相关路径
- 支持多种布局算法（dagre、elk等）
- 支持搜索、筛选、缩放等完整交互

**现有数据**：
- `lineage_nodes`：3758 条记录（包含所有节点）
- `lineage_edges`：39987 条记录（包含所有边）
- 有 378 个脚本包含物理表节点

### 1.2 目标

**在全局血缘图中新增"数据洞察"tab**，通过**数据映射**复用现有 GraphView 组件，展示**脚本与表**的关系：

1. **复用现有组件**：GraphView、TableNode、ColumnNode、布局算法等
2. **数据映射**：脚本 → 表（类似现有的 表 → 字段 关系）
3. **UI 设计**：参考现有的表与字段混合模式

**数据映射关系**：

| 维度 | 现有 GraphView | 数据洞察模式 |
|------|----------------|-------------|
| 父节点 | 表（TableNode） | 脚本（复用TableNode） |
| 子节点 | 字段（ColumnNode） | 表（复用ColumnNode） |
| 数据来源 | `globalLineage.nodes` + `edges` | `lineage_nodes` + `lineage_edges` |
| 高亮机制 | 点击字段高亮相关字段 | 点击表高亮相关脚本 |
| 展开内容 | 字段列表 | 表列表（读取/写入/临时表） |

### 1.3 非目标

- **不做**新增独立的数据洞察页面
- **不做**G6图（使用现有的React Flow GraphView）
- **不做**影响仿真 / what-if
- **不做**权限 / 数据治理 / 数据质量监控
- **不做**字段级血缘流转
- **不做**列表视图（表格形式的表/脚本浏览）

---

## 2. 本期范围

| 范围 | 在 / 不在 |
|------|----------|
| 在全局血缘图中新增"数据洞察"tab | ✅ 在 |
| 复用现有 GraphView 组件 | ✅ 在 |
| 脚本与表的混合模式可视化 | ✅ 在 |
| 数据映射：脚本→表（类似表→字段） | ✅ 在 |
| 脚本节点展开/折叠表列表 | ✅ 在 |
| 搜索、筛选、层级范围选择 | ✅ 在 |
| 独立的数据洞察页面 | ❌ 不做 |
| 表列表 + 详情（表格视图） | ❌ 不做 |
| 脚本列表 + 详情（表格视图） | ❌ 不做 |
| G6图 | ❌ 不做 |
| 字段级血缘流转 | ❌ 不做 |

**技术方案**：复用现有组件，只修改数据映射关系。

---

## 3. 功能需求

### 3.1 在全局血缘图中新增"数据洞察"tab

在现有的 `GlobalLineageView` 组件中新增 `insights` 模式，与其他 tab（graph、list、matrix）并列。

```typescript
// packages/react/src/types/lineage.ts
export type LineageViewMode = 'script' | 'table';
export type GlobalLineageMode = 'graph' | 'list' | 'matrix' | 'insights';

// app/src/components/GlobalLineageView.tsx
export function GlobalLineageView({ result, mode, onModeChange, ... }) {
  return (
    <div className="flex flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-2">
        <Button onClick={() => onModeChange('graph')}>Graph</Button>
        <Button onClick={() => onModeChange('list')}>List</Button>
        <Button onClick={() => onModeChange('matrix')}>Matrix</Button>
        {/* 新增数据洞察tab */}
        <Button onClick={() => onModeChange('insights')}>数据洞察</Button>
      </div>

      {/* Content */}
      <div className="flex-1">
        {mode === 'graph' && <GraphView result={result} />}
        {mode === 'list' && <GlobalLineageListView result={result} />}
        {mode === 'matrix' && <TaskLayerMatrix result={result} />}
        {mode === 'insights' && <InsightsGraphView result={result} />}
      </div>
    </div>
  );
}
```

### 3.2 数据洞察模式（InsightsGraphView）

创建 `InsightsGraphView` 组件，直接复用 `GraphView`，但传入转换后的数据。

```typescript
// app/src/components/InsightsGraphView.tsx
import { GraphView } from '@pondpilot/flowscope-react';
import { convertLineageToInsightsGraph } from './utils/data-mapper';

export function InsightsGraphView({ result }: { result: AnalyzeResult | null }) {
  if (!result) {
    return <div className="p-4">请先分析 SQL 脚本</div>;
  }

  // 将血缘数据转换为洞察视图的数据结构
  const insightsGraph = convertLineageToInsightsGraph(result);

  return <GraphView result={insightsGraph} />;
}
```

### 3.3 数据映射逻辑

创建数据转换工具，将 `lineage_nodes` + `lineage_edges` 转换为 GraphView 需要的数据结构。

```typescript
// app/src/components/utils/data-mapper.ts
import type { AnalyzeResult, Node, Edge } from '@pondpilot/flowscope-core';

/**
 * 将血缘数据转换为洞察视图的数据结构
 * 脚本 → 表（类似表 → 字段）
 */
export function convertLineageToInsightsGraph(lineageResult: AnalyzeResult): AnalyzeResult {
  // 从 lineage_nodes 中提取脚本信息
  const scripts = extractScripts(lineageResult);

  // 从 lineage_nodes 中提取表信息
  const tables = extractTables(lineageResult);

  // 构建脚本 → 表的关系（类似表 → 字段的关系）
  const nodes = buildInsightsNodes(scripts, tables);
  const edges = buildInsightsEdges(scripts, tables);

  // 构建类似 globalLineage 的数据结构
  return {
    ...lineageResult,
    globalLineage: {
      nodes,
      edges,
    },
  };
}

/**
 * 提取脚本信息
 */
function extractScripts(lineageResult: AnalyzeResult): ScriptInfo[] {
  const scriptMap = new Map<string, ScriptInfo>();

  // 从 lineage_nodes 中提取脚本
  for (const node of lineageResult.globalLineage?.nodes ?? []) {
    if (node.file_path) {
      const scriptPath = node.file_path;
      if (!scriptMap.has(scriptPath)) {
        scriptMap.set(scriptPath, {
          id: `script:${scriptPath}`,
          name: scriptPath.split('/').pop() || scriptPath,
          path: scriptPath,
          type: 'script',
        });
      }
    }
  }

  return Array.from(scriptMap.values());
}

/**
 * 提取表信息
 */
function extractTables(lineageResult: AnalyzeResult): TableInfo[] {
  const tableMap = new Map<string, TableInfo>();

  // 从 lineage_nodes 中提取物理表
  for (const node of lineageResult.globalLineage?.nodes ?? []) {
    if (node.type === 'table' && node.qualified_name) {
      const qualifiedName = node.qualified_name;
      if (!tableMap.has(qualifiedName)) {
        tableMap.set(qualifiedName, {
          id: `table:${qualifiedName}`,
          name: qualifiedName.split('.').pop() || qualifiedName,
          qualifiedName,
          type: 'table',
        });
      }
    }
  }

  return Array.from(tableMap.values());
}

/**
 * 构建节点数据
 * 脚本节点（复用TableNode）+ 表节点（复用ColumnNode）
 */
function buildInsightsNodes(scripts: ScriptInfo[], tables: TableInfo[]): Node[] {
  const nodes: Node[] = [];

  // 脚本节点（对应 TableNode）
  for (const script of scripts) {
    nodes.push({
      id: script.id,
      type: 'table',  // 使用 table 类型，复用 TableNode 组件
      label: script.name,
      qualifiedName: script.name,
      nodeType: 'script',
      data: {
        tableId: script.id,
        tableName: script.name,
        columns: tables.map(t => ({  // 表列表（对应字段列表）
          id: t.id,
          name: t.name,
          qualifiedName: t.qualifiedName,
          dataType: 'table',
        })),
        isExpanded: false,
      },
    });
  }

  // 表节点（对应 ColumnNode）
  for (const table of tables) {
    nodes.push({
      id: table.id,
      type: 'column',  // 使用 column 类型，复用 ColumnNode 组件
      label: table.name,
      nodeType: 'table',
      data: {
        columnId: table.id,
        columnName: table.name,
        dataType: 'table',
        isHighlighted: false,
      },
    });
  }

  return nodes;
}

/**
 * 构建边数据
 * 脚本 → 表（对应表 → 字段）
 */
function buildInsightsEdges(scripts: ScriptInfo[], tables: TableInfo[]): Edge[] {
  const edges: Edge[] = [];
  const scriptTableMap = buildScriptTableMap(scripts, tables);

  // 构建脚本 → 表的边（对应表 → 字段的边）
  for (const [scriptId, tableInfos] of scriptTableMap) {
    for (const tableInfo of tableInfos) {
      edges.push({
        id: `${scriptId}-${tableInfo.id}-${tableInfo.relation}`,
        from: scriptId,
        to: tableInfo.id,
        type: 'ownership',  // 使用 ownership 类型，对应表-字段关系
        label: tableInfo.relation === 'read' ? '读取' : '写入',
      });
    }
  }

  return edges;
}

/**
 * 构建脚本 → 表的关系映射
 */
function buildScriptTableMap(scripts: ScriptInfo[], tables: TableInfo[]): Map<string, TableRelation[]> {
  // 这里需要从 lineage_edges 中提取脚本与表的关系
  // 具体实现根据实际的 lineage_edges 数据结构
  return new Map();
}

interface ScriptInfo {
  id: string;
  name: string;
  path: string;
  type: 'script';
}

interface TableInfo {
  id: string;
  name: string;
  qualifiedName: string;
  type: 'table';
}

interface TableRelation {
  id: string;
  relation: 'read' | 'write';
}
```

### 3.4 脚本节点设计（复用TableNode）

脚本节点直接复用现有的 `TableNode` 组件，但显示的内容是：

**表名** → **脚本名**：
```typescript
<TableNode
  tableName="B10_CSTMZT_PUSH_VID_ATTR_INFO.HQL"  // 显示脚本名
  columns={[
    { id: 'table:sum_db.b10_info_vid', name: 'b10_info_vid' },    // 表列表（对应字段列表）
    { id: 'table:sum_db.s01_usr_actv_analy', name: 's01_usr_actv_analy' },
    { id: 'table:sum_db.b10_cstmzt_push_vid_attr_info', name: 'b10_cstmzt_push_vid_attr_info' },
  ]}
/>
```

**展开内容映射**：
- 表名显示 → 脚本名显示
- 字段列表 → 表列表
- 字段类型 → 表类型（物理表/临时表）
- 字段高亮 → 表高亮

### 3.5 表节点设计（复用ColumnNode）

表节点直接复用现有的 `ColumnNode` 组件，但显示的内容是：

**字段名** → **表名**：
```typescript
<ColumnNode
  columnName="b10_info_vid"  // 显示表名
  dataType="table"  // 表类型
  isHighlighted={false}
/>
```

**UI 显示映射**：
- 字段名 → 表名
- 数据类型 → 表类型（物理表/临时表）
- 高亮状态 → 高亮状态（点击相关脚本时高亮）
- 图标 → `Table2` 图标

---

## 4. 技术方案

### 4.1 前端

#### 4.1.1 新增组件

```
app/src/components/
├── InsightsGraphView.tsx              # 新增：数据洞察视图组件
├── GlobalLineageView.tsx              # 修改：新增 insights 模式
└── utils/
    └── data-mapper.ts                  # 新增：数据映射工具
```

#### 4.1.2 复用现有组件

- **`GraphView`**：主可视化组件（完全复用）
- **`TableNode`**：复用为脚本节点
- **`ColumnNode`**：复用为表节点
- **`SimpleTableNode`**：复用为折叠状态的脚本节点
- **`AnimatedEdge`**：复用边组件
- **布局算法**：完全复用（dagre、elk等）
- **高亮机制**：完全复用
- **搜索、筛选**：完全复用

#### 4.1.3 修改文件清单

| 文件 | 修改内容 | 工作量 |
|------|----------|--------|
| `app/src/components/GlobalLineageView.tsx` | 新增 insights tab 按钮和渲染逻辑 | 小 |
| `app/src/components/InsightsGraphView.tsx` | 新增文件，转换数据并调用 GraphView | 中 |
| `app/src/components/utils/data-mapper.ts` | 新增文件，实现数据映射逻辑 | 大 |
| `packages/react/src/components/GraphView.tsx` | 无修改（完全复用） | - |
| `packages/react/src/components/TableNode.tsx` | 无修改（完全复用） | - |
| `packages/react/src/components/ColumnNode.tsx` | 无修改（完全复用） | - |

### 4.2 后端

**后端无需修改**，数据在前端进行转换和映射。

### 4.3 数据流

```
SQLite (lineage_nodes, lineage_edges)
    ↓
前端数据转换 (data-mapper.ts)
    ↓
复用 GraphView 组件
    ↓
用户看到脚本 → 表的可视化
```

---

## 5. 验收标准

| # | 标准 |
|---|------|
| 1 | 全局血缘图中新增"数据洞察"tab，与其他tab并列显示 |
| 2 | 脚本节点使用 TableNode 样式，显示脚本名和表列表 |
| 3 | 表节点使用 ColumnNode 样式，显示表名和类型 |
| 4 | 脚本节点可展开/折叠，显示读取和写入的表列表 |
| 5 | 点击表节点时高亮相关脚本节点 |
| 6 | 点击脚本节点时高亮相关表节点 |
| 7 | 搜索功能支持搜索脚本名和表名 |
| 8 | 布局算法正常工作（dagre、elk等） |
| 9 | 缩放、平移等交互功能正常 |
| 10 | 支持导出为图片或JSON |
| 11 | 界面布局与现有 GraphView 保持一致 |
| 12 | 性能满足要求（< 1秒加载） |

---

## 6. 里程碑

| 里程碑 | 内容 | 预估 |
|--------|------|------|
| M1 | 需求对齐（本文档） | 当前 |
| M2 | 数据映射逻辑实现（data-mapper.ts） | 2天 |
| M3 | InsightsGraphView 组件开发 | 1天 |
| M4 | GlobalLineageView 集成 insights 模式 | 0.5天 |
| M5 | 联调 + 验收 | 0.5天 |

**总预估**：4天

---

## 7. 待对齐问题

> 以下需要在启动前对齐：

1. **tab 顺序**：数据洞察tab 在工具栏中的位置？（建议放在最后）
2. **tab 标签**：使用"数据洞察"还是"Insights"？建议使用中文
3. **默认模式**：进入数据洞察模式后，是否默认展开所有脚本节点？（建议不展开）
4. **表列表显示**：脚本节点展开后，表列表如何排序？（建议按读取/写入分组）
5. **图标选择**：脚本节点使用什么图标？（建议使用 FileCode）
6. **高亮颜色**：点击相关节点时，高亮颜色是否与现有 GraphView 一致？（建议一致）

---

## 8. 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| 数据映射逻辑复杂 | 中 | 仔细测试脚本与表的关系，确保数据完整性 |
| 组件复用不兼容 | 低 | GraphView、TableNode、ColumnNode 是通用组件，兼容性良好 |
| 性能问题 | 低 | 数据在前端转换，后端无额外开销，性能影响小 |
| 用户体验不一致 | 低 | 与现有 GraphView 保持相同的交互和视觉风格 |

---

**待你 review 后对齐 §7 的问题，然后启动 M2**。