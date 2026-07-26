# FlowScope 运维脚本指南

本目录包含 FlowScope 项目部署、安装、运维相关的全部脚本和说明。

## 文档索引

| 文档 | 说明 |
|------|------|
| [一键安装部署](./setup.md) | 从零到运行的完整流程，包含 precheck、一键脚本 |
| [服务管理](./services.md) | 启动、停止、重启、日志查看 |
| [健康检查](./health-check.md) | 部署前 precheck、服务状态检查、端口检测 |
| [just 命令速查](./just-commands.md) | 全部 `just` 命令分类速查表 |

## 快速开始

```bash
# 1. 克隆仓库
git clone https://github.com/keaidada/flowscope.git
cd flowscope

# 2. 一键安装 + 构建 + 启动
just setup && just build-cli-serve
./target/release/flowscope --serve --port 3000

# 3. 打开浏览器
open http://localhost:3000
```

## 架构概览

```
FlowScope 运行模式
├── 开发模式 (dev)
│   ├── 前端: Vite Dev Server (:5173)
│   └── 后端: CLI Serve (:3000)
│       └── 数据库: SQLite (./app/flowscope.db)
│
├── 生产模式 (serve)
│   ├── 单体: CLI --serve --features serve
│   │   ├── 嵌入式前端 (rust-embed)
│   │   ├── REST API
│   │   └── 文件监听 (--watch)
│   └── 数据库: SQLite
│
└── 纯前端模式 (WASM)
    ├── 浏览器内运行 WASM 引擎
    └── IndexedDB 存储
```
