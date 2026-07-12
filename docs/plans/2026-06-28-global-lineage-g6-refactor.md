# 全局血缘 — 功能清单 & G6 重构方案

> 创建：2026-06-28 | 分支: `feature/g6-antv-poc`

---

## 一、全局血缘入口

`GlobalLineageView` 组件是全局血缘的统一入口，提供 3 种视图模式切换：

```
分析 SQL → AnalyzeResult → 三种视图
                              ├── Graph  (关系图 — React Flow)
                              ├── List   (列表 — 分页表格)
                              └── Matrix (脚本调度矩阵 — SVG)
```

**默认模式**: `list`（避免直接渲染万级节点图造成崩溃）

---

## 二、关系图 (Graph) — 当前实现 React Flow

> 文件: `packages/react/src/components/GraphView.tsx` (~1100 行) + 20+ 子组件

### 2.1 数据层

| 组件/工具 | 说明 |
|-----------|------|
| `buildTableGraphInWorker` | Web Worker 中按表血缘构建图 |
| `buildScriptGraphInWorker` | Web Worker 中按脚本血缘构建图 |
| `useLineageStore` (Zustand) | `viewMode`, `collapsedNodeIds`, `showColumnEdges`, `searchTerm` 等状态 |
| `useLineage` | 封装 store + actions |

### 2.2 视图模式

| 模式 | 说明 |
|------|------|
| **Table 模式** | 按表血缘构建 DAG，表为节点，数据流为边 |
| **Script 模式** | 按脚本血缘构建 DAG，脚本文件为节点，可展开显示脚本内表 |
| **混合模式** | Script 模式下可切换显示脚本内表节点 |

### 2.3 自定义节点类型（4 种）

| 节点 | 说明 | 文件 |
|------|------|------|
| `TableNode` | 展开列模式：显示 schema.table、列列表、类型图标、影响分数 | `TableNode.tsx` |
| `SimpleTableNode` | 折叠模式：简化标签，只显示表名 | `SimpleTableNode.tsx` |
| `ScriptNode` | 脚本文件路径、可展开内部表节点 | `ScriptNode.tsx` |
| `ColumnNode` | 列级血缘节点 | `ColumnNode.tsx` |

### 2.4 布局引擎

| 算法 | 说明 | 限制 |
|------|------|------|
| dagre | Sugiyama 分层布局，Web Worker 异步 | 无限制 |
| ELK | ELK Layered 布局，Web Worker 异步 | > 2000 节点自动降级 dagre |

切换：`LayoutSelector.tsx` 右上角

### 2.5 增量布局

已有 layout 位置的节点保持不动，新节点的坐标由 dagre 补算并折叠到现有视角（`layout.ts`）。

### 2.6 交互功能

| 功能 | 说明 | 实现位置 |
|------|------|----------|
| **搜索 (Ctrl+F)** | 高亮匹配节点 + 聚焦模式（隐藏非匹配）| `GraphSearchControl.tsx` |
| **搜索建议** | 自动补全 | `useSearchSuggestions.ts` |
| **表筛选** | 多选表名过滤 | `TableFilterDropdown.tsx` |
| **展开/折叠** | 一键全部展开/折叠，点击单个表切换 | `useLineageStore` |
| **列级血缘** | 切换表级 / 列级连线显示 | `showColumnEdges` toggle |
| **点击节点** | 选中 + 高亮邻居 + 源文件定位跳转 | `handleNodeClick` |
| **Tooltip** | 悬停显示详细 tooltip（React 组件）| `GraphTooltip` |
| **MiniMap** | 右下角可点击导航，> 2000 节点隐藏 | `ClickableMiniMap` |
| **视口恢复** | 切换视图后恢复上次视口位置 | `ViewportHandler` |
| **图例** | 左上角面板，显示表/view/CTE 颜色 | `Legend.tsx` |
| **布局进度** | 底部左下角进度指示 | `LayoutProgressIndicator.tsx` |
| **错误边界** | 捕获渲染异常 | `GraphErrorBoundary` |
| **性能监控** | `GRAPH_DEBUG` 时间戳日志 | `debug.ts` |
| **平移/缩放** | Scroll→平移，Pinch/Ctrl+滚轮→缩放 | React Flow 内置 |

---

## 三、列表视图 (List)

> 文件: `app/src/components/GlobalLineageListView.tsx` (~600 行)

### 3.1 功能

| 功能 | 说明 |
|------|------|
| 分词搜索 | 按表名模糊匹配 |
| 状态筛选 | source / bridge / sink / isolated 4 种角色（绿色/蓝色/紫色/灰色） |
| 快速视图 | All / Hotspots (top 20%) / Bridge / Source / Sink / Isolated |
| 排序 | 影响分 / 上游数 / 下游数 / 文件数 / 表名 |
| 分页 | 50 / 100 / 200 / 500 可选，显示总页数 |
| 文件分组模式 | 按 script 文件分组展示，可展开/折叠 |
| 条目详情 | 点击展开上下游列表、影响分、OpenGraph 跳转 |
| 导航 | 点击 OpenGraph → 切到关系图并聚焦该节点 |
| 复位筛选 | 一键清空所有筛选条件 |
| 轻量模式 | 大数据集时按需加载详情 |

### 3.2 数据层

| Hook | 说明 |
|------|------|
| `useGlobalLineageData` | 聚合 `globalLineage` 为 `TableEntry[]`，计算 impact/status/上下游 |

---

## 四、矩阵视图 (Matrix) — 脚本调度层

> 文件: `app/src/components/TaskLayerMatrix.tsx` (~850 行)

### 4.1 功能

| 功能 | 说明 |
|------|------|
| 层级分层 (L1-Ln) | 按拓扑排序的文件级 DAG 行层级排列 |
| 文件任务节点 | 每个 script 文件作为一个方框/TaskCircle，用类型颜色标记 |
| 依赖连线 | 箭头连线表示文件间读写依赖 |
| 行背景色 | 每层不同颜色背景 |
| 缩放/平移 | Ctrl+滚轮缩放，滚轮平移 |
| 搜索 | 按脚本名搜索 |
| 点击高亮 | 点击节点高亮上下游路径 |
| 详情弹窗 | MiniTaskMatrix 内嵌子 DAG（单个脚本的表图） |

### 4.2 数据层

| Hook | 说明 |
|------|------|
| `usePipelineData` | 从 `statements` 聚合文件级 DAG 为 `PipelineTask[]`（任务+层级） |

---

## 五、Workspace 集成

> 文件: `app/src/components/Workspace.tsx`

| 功能 | 位置 |
|------|------|
| Debug 模式开关 | 右上角设置下拉菜单 |
| 清理血缘缓存按钮 | 右上角设置下拉菜单（`handleClearGlobalLineage`） |
| 默认模式 | `'list'`（避免大图直接崩溃） |
| 全局血缘全屏 | 全局血缘打开时替换侧边栏为全屏视图 |

---

## 六、新功能：G6 关系图

### 6.1 目标

使用 [@antv/g6](https://g6.antv.antgroup.com/) (Canvas 渲染) **重新实现关系图**，解决 React Flow DOM 渲染万级节点时的性能瓶颈：

| 问题 | React Flow (DOM) | G6 (Canvas) |
|------|-------------------|-------------|
| 1000 节点 | 正常 | 正常 |
| 5000 节点 | 明显卡顿 | 流畅 |
| 10000 节点 | 页面崩溃 | 流畅（视口裁剪） |

### 6.2 新增组件

| 组件 | 说明 |
|------|------|
| `G6GraphView.tsx` | G6 Canvas 关系图组件，复刻 React Flow GraphView 全部功能 |

### 6.3 功能对照（G6 需复刻）

| 功能 | 说明 | 状态 |
|------|------|------|
| Canvas 渲染 | 替换 DOM 节点渲染 | 待实现 |
| dagre / ELK 布局 | 布局切换（dagre 内置，ELK 动态 import） | 待实现 |
| 视图模式 (Table/Script) | 线图切换到 Script 模式 | 待实现 |
| 自定义节点着色 | 5 种类型颜色（table/view/cte/m.view/external） | 待实现 |
| 曲线边 + 表名标签 | 边标签显示表名 | 待实现 |
| 悬停高亮邻居 | hover-activate behavior | 待实现 |
| 点击选中 + 高亮邻居 | click + highlight state | 待实现 |
| 搜索 (Ctrl+F) | 搜索栏 + 匹配计数 + 聚焦模式 | 待实现 |
| 表筛选 | 多选表名过滤 | 待实现 |
| 展开/折叠 | 一键展开/折叠所有表 | 待实现 |
| 列级血缘 | 切换列级/表级连线 | 待实现 |
| Tooltip | HTML 浮动提示 | 待实现 |
| MiniMap | G6 内置插件 | 待实现 |
| 背景点阵 | G6 内置插件 | 待实现 |
| 图例 | 面板叠层 | 待实现 |
| 布局进度 | 中央 spinner | 待实现 |
| 视口恢复 | 保存/恢复 | 待实现 |
| 双指缩放 / 滚动平移 | 自定义 wheel handler | 待实现 |
| TableNode 详情（列级展开）| Canvas 内自定义绘制 | 待评估 |
| ScriptNode（脚本展开） | Canvas 内自定义绘制 | 待评估 |

### 6.4 实现策略

1. **保留原有 React Flow GraphView**，不修改
2. 新增 `G6GraphView.tsx` 组件
3. 在 `GlobalLineageView` 工具栏增加按钮切换 `graph`（React Flow）↔ `g6`（G6 Canvas）
4. 先实现基础图渲染 + 核心交互，再逐步补全高级功能
5. 列级/脚本展开这类复杂自定义节点可放到第二阶段

### 6.5 关键依赖

```json
{
  "@antv/g6": "^5.1.1",
  "elkjs": "^0.9.x"  // 已有
}
```

### 6.6 性能对比指标

| 指标 | React Flow | G6 Canvas | 说明 |
|------|-----------|-----------|------|
| 首次渲染 (< 500 节点) | ~800ms | 待测 | 含布局 |
| 首次渲染 (1000-5000 节点) | 3-15s | 待测 | 严重卡顿 |
| 首次渲染 (> 10000 节点) | 崩溃 | 待测 | 目标：<5s |
| 内存占用 (5000 节点) | ~500MB+ | 待测 | DOM 是内存大户 |
| 帧率 (拖拽/缩放) | < 10 FPS (5000 节点) | 待测 | 目标：60 FPS |
| 包大小 | ~200KB | ~500KB | G6 更大但一次加载 |

---

## 七、相关文件清单

```
# 入口
app/src/components/GlobalLineageView.tsx
app/src/components/Workspace.tsx

# 关系图 (React Flow)
packages/react/src/components/GraphView.tsx
packages/react/src/components/TableNode.tsx
packages/react/src/components/SimpleTableNode.tsx
packages/react/src/components/ScriptNode.tsx
packages/react/src/components/ColumnNode.tsx
packages/react/src/components/AnimatedEdge.tsx
packages/react/src/components/ViewModeSelector.tsx
packages/react/src/components/GraphSearchControl.tsx
packages/react/src/components/TableFilterDropdown.tsx
packages/react/src/components/Legend.tsx
packages/react/src/components/LayoutSelector.tsx
packages/react/src/components/LayoutProgressIndicator.tsx
packages/react/src/components/ui/graph-tooltip.tsx
packages/react/src/utils/layout.ts
packages/react/src/utils/graphBuilders.ts
packages/react/src/utils/graphBuilderWorkerService.ts
packages/react/src/store.ts
packages/react/src/types.ts

# G6 关系图 (新增)
app/src/components/G6GraphView.tsx

# 列表
app/src/components/GlobalLineageListView.tsx
app/src/hooks/useGlobalLineageData.ts

# 矩阵
app/src/components/TaskLayerMatrix.tsx
app/src/hooks/usePipelineData.ts
app/src/types/pipeline-matrix.ts
```
