# FS Releases

## v1.0.0 (Stable)

| 文件 | 平台 | 架构 | 大小 |
|------|------|------|------|
| [flowscope-1.0.0-darwin-arm64.tar.gz](./flowscope-1.0.0-darwin-arm64.tar.gz) | macOS | Apple Silicon (M1/M2/M3/M4) | 29 MB |

### 安装

```bash
# 解压
tar -xzf flowscope-1.0.0-darwin-arm64.tar.gz

# 移到 PATH
sudo mv flowscope /usr/local/bin/

# 验证
flowscope --version
# → flowscope 1.0.0
```

### 功能

- ✅ SQL 血缘分析（15 种方言）
- ✅ CLI 模式（分析 / Lint / 导出）
- ✅ Serve 模式（Web UI + REST API）
- ✅ 导出格式：table / json / mermaid / html / csv / xlsx / duckdb

### 快速验证

```bash
# 分析单个文件
flowscope query.sql

# 启动本地服务（带 Web UI）
flowscope --serve --port 3000 --open
```

### 系统要求

- macOS 12.0+ (Monterey)
- Apple Silicon (M1/M2/M3/M4)
- 无需额外依赖（静态链接）
