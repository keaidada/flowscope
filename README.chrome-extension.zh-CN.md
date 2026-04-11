# FlowScope Chrome 扩展版

基于 [FlowScope](https://github.com/pondpilot/flowscope) 开发的 Chrome 浏览器扩展，提供隐私优先的 SQL 血缘分析能力，所有分析完全在浏览器本地运行。

## 功能特性

### 核心能力
- **SQL 血缘分析**：可视化数据在查询中的流向，涵盖表、CTE 和列
- **多文件项目**：将 SQL/HQL 文件组织成项目，分析跨文件的依赖关系
- **Schema DDL 管理**：上传 Schema DDL 文件增强血缘分析，支持文件夹组织
- **隐私优先**：所有分析均在浏览器本地运行（基于 Rust + WebAssembly），SQL 绝不会离开设备

### 视图模式
- **血缘图**：交互式有向图，支持表级和列级视图，Dagre/ELK 布局算法
- **层级树**：树状结构展示上下游依赖关系，支持搜索和键盘导航
- **矩阵视图**：依赖矩阵，支持热力图、X-Ray、聚类等高级模式
- **Schema 视图**：展示表结构、列信息和数据流来源
- **问题面板**：显示 SQL 解析警告和错误

### Chrome 扩展特性
- 点击扩展图标打开独立标签页，拥有完整的分析界面
- 支持 Hive/Spark/Snowflake/PostgreSQL/BigQuery 等多种 SQL 方言
- 支持 dbt/Jinja 模板预处理
- 支持导出 Excel、JSON、CSV、PNG、Mermaid、HTML 报告
- 项目数据持久化到 IndexedDB，重启不丢失

### 搜索功能
- **文件搜索**：全文搜索项目 SQL 文件内容，点击结果跳转到文件并高亮匹配位置
- **Schema 搜索**：搜索 Schema DDL 文件内容，点击结果打开对应 Schema 文件
- 搜索结果支持 Hover 预览上下文（匹配行上下各 5 行）
- 支持大小写敏感切换

### 批量操作
- 文件树和 Schema 侧边栏均支持批量选择和批量删除
- 支持文件/文件夹创建、重命名、拖拽导入

## 技术架构

```
Chrome 扩展 (MV3)
├── React + TypeScript (前端 UI)
├── Rust → WebAssembly (SQL 解析引擎，约 9MB)
├── IndexedDB (项目和 Schema 文件持久化)
└── CodeMirror 6 (SQL 编辑器)
```

- **SQL 解析引擎**：Rust 编写，编译为 WebAssembly，在浏览器中运行，性能接近原生
- **前端框架**：React 18 + Vite，shadcn/ui 组件库
- **状态管理**：Zustand + 自定义 hooks
- **国际化**：支持中英文切换（i18next）

## 开发环境

### 前置要求
- Node.js 18+
- Rust 1.82+
- wasm-pack
- yarn

### 安装依赖

```bash
# 安装 Node 依赖
yarn install

# 安装 Rust 工具
just install-rust-tools
```

### 构建

```bash
# 完整构建（WASM + TypeScript + App）
just build

# 仅构建 WASM（修改 Rust 代码后）
just build-wasm

# 仅构建前端
cd app && yarn build
```

### 开发

```bash
# 启动开发服务器（Vite HMR）
just dev

# 监听 Rust 代码变更自动重编译
just watch
```

### 加载 Chrome 扩展

1. 构建完成后，打开 `chrome://extensions/`
2. 开启「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择 `app/dist/` 目录
5. 点击扩展图标即可使用

### 测试

```bash
# 全部测试
just test

# Rust 核心引擎测试
just test-rust

# TypeScript 包测试
just test-ts

# 血缘引擎测试
just test-lineage
```

### 代码检查

```bash
# 格式化 + Lint + 类型检查
just check

# 仅格式化
just fmt

# 仅 Lint
just lint
```

## 项目结构

```
flowscope/
├── app/                    # Chrome 扩展前端（Vite + React）
│   ├── public/
│   │   ├── manifest.json   # Chrome MV3 清单
│   │   ├── background.js   # Service Worker
│   │   └── wasm/           # WASM 运行时文件
│   └── src/
│       ├── components/     # React 组件
│       ├── hooks/          # 自定义 Hooks
│       ├── lib/            # 工具库和状态管理
│       └── i18n/           # 国际化（中/英）
├── crates/
│   ├── flowscope-core/     # Rust 核心解析引擎
│   ├── flowscope-wasm/     # WASM 绑定层
│   ├── flowscope-cli/      # 命令行工具
│   └── flowscope-export/   # 导出功能
├── packages/
│   ├── core/               # @pondpilot/flowscope-core（npm 包）
│   └── react/              # @pondpilot/flowscope-react（React 组件）
└── scripts/                # 构建和工具脚本
```

## 当前分支改动说明

本分支 `feature/chrome-extension` 基于 `dev` 分支开发，主要改动：

### Chrome 扩展适配
- 新增 `manifest.json`（MV3）、`background.js`、PNG 图标
- Vite 配置改为相对路径，去除文件名哈希
- WASM 加载适配 Chrome 扩展环境（`chrome.runtime.getURL`）
- 内联脚本提取为外部文件以符合 CSP 策略

### 搜索增强
- 搜索面板支持「文件」和「Schema」两种搜索模式切换
- 搜索结果 Hover 预览上下文（匹配行上下各 5 行）
- 点击搜索结果跳转到文件并整行黄色高亮匹配位置
- Schema 搜索结果点击可跳转到 Schema 侧边栏并打开对应文件

### 血缘分析修复
- 修复内联子查询（`LEFT JOIN (SELECT ...) alias`）在 CTE 中不生成 DataFlow 边的 bug
- 修复 INSERT 目标表在 Schema/层级视图中不显示的问题
- 层级视图支持 `join_dependency` 边类型的上游追踪

### Schema 管理
- Schema DDL 匹配展示优化，支持加载中状态
- Schema 工具栏新建文件默认在根目录创建
- Schema 侧边栏支持搜索过滤

### 其他改进
- 文件数量上限从 1000 提升到 5000
- 文件和 Schema 批量删除功能
- 项目描述改为中文

## 许可证

Apache License 2.0
