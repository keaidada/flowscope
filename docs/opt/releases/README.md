# FS Releases

## v1.0.0 (Stable)

### 下载

| 文件 | 平台 | 架构 | 大小 |
|------|------|------|------|
| [flowscope-1.0.0-darwin-arm64.tar.gz](./flowscope-1.0.0-darwin-arm64.tar.gz) | macOS | Apple Silicon (M1/M2/M3/M4) | 29 MB |
| [flowscope-1.0.0-darwin-x86_64.tar.gz](./flowscope-1.0.0-darwin-x86_64.tar.gz) | macOS | Intel | 30 MB |

### 一键部署

```bash
# 1. 下载所有文件到同一目录
#    init.sh + 对应平台的 .tar.gz

# 2. 运行初始化脚本
chmod +x init.sh
./init.sh                          # 默认安装到 /opt/flowscope
# 或指定目录：
./init.sh --target ~/flowscope --arch arm64

# 3. 放入 SQL 文件
cp /path/to/your/*.sql /opt/flowscope/sql/

# 4. 启动服务
/opt/flowscope/start.sh                            # 前台运行
/opt/flowscope/start.sh --daemon                   # 后台运行
/opt/flowscope/start.sh --port 8080 --daemon       # 指定端口 + 后台

# 5. 打开浏览器
open http://localhost:3000
```

### 常用命令

```bash
./start.sh                          # 前台启动
./start.sh --daemon                 # 后台启动
./start.sh --stop                   # 停止
./start.sh --status                 # 查看状态
./start.sh --port 8080              # 指定端口
./start.sh --watch /custom/sql/dir  # 指定 SQL 目录
```

### 服务端点

| 服务 | 地址 |
|------|------|
| Web UI | `http://localhost:3000` |
| REST API | `http://localhost:3000/api` |
| OpenAPI 文档 | `http://localhost:3000/api/docs` |
| 健康检查 | `http://localhost:3000/api/health` |

### 目录结构

```
/opt/flowscope/
├── bin/flowscope        # 二进制
├── data/flowscope.db    # SQLite 数据库
├── logs/flowscope.log   # 运行日志
├── sql/                 # SQL 文件目录（被监听）
└── start.sh             # 启动脚本
```

### 功能

- ✅ SQL 血缘分析（15 种方言）
- ✅ CLI 模式（分析 / Lint / 导出）
- ✅ Serve 模式（Web UI + REST API 内嵌）
- ✅ 导出格式：table / json / mermaid / html / csv / xlsx / duckdb
- ✅ 文件监听（修改 SQL 自动重新分析）

### 系统要求

- macOS 12.0+ (Monterey)
- Apple Silicon 或 Intel
- 无需额外依赖
