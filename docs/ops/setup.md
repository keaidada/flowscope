# 一键安装部署

## 前置条件 (Precheck)

### 系统要求

| 依赖 | 最低版本 | 检查命令 |
|------|---------|---------|
| Rust | 1.82+ | `rustc --version` |
| Node.js | 18+ | `node --version` |
| Yarn | 1.22+ | `yarn --version` |
| wasm-pack | 0.13+ | `wasm-pack --version` |
| just | 1.0+ | `just --version` |

### Precheck 脚本

```bash
#!/usr/bin/env bash
# scripts/precheck.sh — 部署前环境检查
set -euo pipefail

echo "=== FlowScope Precheck ==="

PASS=0
FAIL=0

check() {
    local name=$1
    local cmd=$2
    local min_ver=$3
    if command -v "$cmd" &>/dev/null; then
        local ver=$($cmd --version 2>&1 | head -1)
        echo "  ✅ $name: $ver"
        PASS=$((PASS + 1))
    else
        echo "  ❌ $name: 未安装 (需要 $min_ver+)"
        FAIL=$((FAIL + 1))
    fi
}

check "Rust"   "rustc"   "1.82"
check "Node"   "node"    "18"
check "Yarn"   "yarn"    "1.22"
check "wasm-pack" "wasm-pack" "0.13"
check "just"   "just"    "1.0"

echo ""
echo "结果: $PASS 通过, $FAIL 失败"

if [ "$FAIL" -gt 0 ]; then
    echo ""
    echo "请安装缺失的依赖："
    echo "  Rust:      https://rustup.rs/"
    echo "  Node.js:   https://nodejs.org/"
    echo "  Yarn:      npm install -g yarn"
    echo "  wasm-pack: cargo install wasm-pack"
    echo "  just:      cargo install just"
    exit 1
fi

echo "✅ 所有依赖就绪！"
```

### 一键安装

```bash
# 安装 Rust 工具链（首次）
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"

# 安装 Node.js（推荐 nvm）
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
nvm install 18
nvm use 18

# 安装 just + wasm-pack
cargo install just
cargo install wasm-pack

# 克隆并构建
git clone https://github.com/keaidada/flowscope.git
cd flowscope
```

## 数据库初始化

FlowScope 使用 SQLite，**首次启动自动创建**（`open_db()` → `migrate()` → `create_tables()`），无需手动初始化。

### 自动初始化流程

```
flowscope --serve 启动
  └─ open_db("./app/flowscope.db")
       ├─ PRAGMA journal_mode = WAL
       ├─ PRAGMA foreign_keys = ON
       ├─ migrate()          ← 按 PRAGMA user_version 逐版本迁移 (v0→v1→...→v5)
       └─ create_tables()    ← CREATE TABLE IF NOT EXISTS (14 张表)
```

### 手动初始化（可选）

如果需要在启动前预建数据库（如 CI 环境或容器构建时）：

```bash
# 创建 app 目录（数据库默认路径 ./app/flowscope.db）
mkdir -p ./app

# 启动一次即自动建库，然后 Ctrl+C 退出
./target/release/flowscope --serve --port 3000 &
sleep 2 && kill %1

# 验证
sqlite3 ./app/flowscope.db ".tables"
sqlite3 ./app/flowscope.db "SELECT name FROM pragma_table_info('projects');"
```

### 数据库迁移版本

| 版本 | 说明 |
|------|------|
| v0 → v1 | 时间字段从 INTEGER (Unix ms) → TEXT (RFC3339) |
| v1 → v2 | 添加 `file_name`, `dir_path` 列 |
| v2 → v3 | 添加 `script_name`, `dir_path` 到 `table_level_edges` |
| v3 → v4 | 添加 `project_directories` 表 + `dir_id` 列 |
| v4 → v5 | 添加 `lineage_anomalies` 表 + 软删除支持 |

### 数据库配置

| PRAGMA | 值 | 说明 |
|--------|-----|------|
| `journal_mode` | WAL | Write-Ahead Logging，并发读写 |
| `synchronous` | NORMAL | 平衡性能与安全 |
| `foreign_keys` | ON | 外键约束（`column_metadata` → `table_metadata` CASCADE） |
| `cache_size` | -200000 | 200MB 内存缓存 |
| `temp_store` | MEMORY | 临时表存内存 |
| `wal_autocheckpoint` | 1000 | 每 1000 页自动 checkpoint |

### 自定义数据库路径

```bash
# CLI 启动时指定（代码里暂未暴露 --db-path 参数，默认 ./app/flowscope.db）
# 可通过环境变量或修改代码实现：
FLOWSCOPE_DB=./data/custom.db ./target/release/flowscope --serve --port 3000
```

## 部署方式

### 方式一：开发模式（前后端分离）

```bash
# 1. 构建 WASM（首次或 Rust 源码变更后）
just build-wasm-dev

# 2. 构建 TypeScript 包
just build-ts

# 3. 启动前端 Dev Server (:5173)
just dev

# 4. 启动后端 CLI Serve (:3000)
cargo build -p flowscope-cli --features serve
./target/debug/flowscope --serve --port 3000 --watch ./app
```

### 方式二：生产模式（单体 CLI，嵌入式前端）

```bash
# 一键构建（自动构建前端 + 嵌入到 CLI）
just build-cli-serve

# 运行
./target/release/flowscope --serve --port 3000 --watch ./app

# 后台运行 + 日志
nohup ./target/release/flowscope --serve --port 3000 --watch ./app \
  > /var/log/flowscope.log 2>&1 &
```

### 方式三：纯前端模式（WASM）

```bash
# 构建前端（含 WASM）
just build-wasm
just build-ts
cd app && yarn build

# 部署 dist/ 到任意静态服务器
npx serve app/dist
# 或部署到 Cloudflare Pages
just deploy
```

## 一键部署脚本

```bash
#!/usr/bin/env bash
# scripts/deploy.sh — 一键部署 FlowScope
set -euo pipefail

PORT=${1:-3000}
WATCH_DIR=${2:-./app}
LOG_DIR="/tmp/flowscope-logs"
PID_FILE="/tmp/flowscope.pid"

mkdir -p "$LOG_DIR"

echo "=== FlowScope 一键部署 ==="

# Step 1: Precheck
echo "[1/6] 环境检查..."
bash scripts/precheck.sh

# Step 2: 安装依赖
echo "[2/6] 安装依赖..."
yarn install --frozen-lockfile

# Step 3: 构建 WASM
echo "[3/6] 构建 WASM..."
just build-wasm-dev

# Step 4: 构建 CLI（含嵌入式前端）
echo "[4/6] 构建 CLI..."
just build-cli-serve

# Step 5: 初始化数据库（首次部署自动建库 + 迁移）
echo "[5/6] 初始化数据库..."
mkdir -p "$WATCH_DIR"
# 启动一次让 open_db() 自动建库，验证后停止
./target/release/flowscope --serve --port "$PORT" &
TMP_PID=$!
sleep 2
if curl -sf "http://127.0.0.1:$PORT/api/health" | grep -q "ok"; then
    echo "  数据库初始化成功"
    TABLES=$(sqlite3 "$WATCH_DIR/flowscope.db" "SELECT COUNT(*) FROM sqlite_master WHERE type='table';" 2>/dev/null || echo "?")
    echo "  表数量: $TABLES"
    kill $TMP_PID 2>/dev/null
    wait $TMP_PID 2>/dev/null
else
    echo "  ❌ 数据库初始化失败"
    kill $TMP_PID 2>/dev/null
    exit 1
fi

# Step 6: 启动服务
echo "[6/6] 启动服务..."
if [ -f "$PID_FILE" ] && kill -0 "$(cat $PID_FILE)" 2>/dev/null; then
    echo "  停止旧进程..."
    kill "$(cat $PID_FILE)"
    sleep 2
fi

nohup ./target/release/flowscope --serve --port "$PORT" --watch "$WATCH_DIR" \
    > "$LOG_DIR/serve.log" 2>&1 &
echo $! > "$PID_FILE"

sleep 3

# 验证
if curl -sf "http://127.0.0.1:$PORT/api/health" | grep -q "ok"; then
    echo ""
    echo "✅ 部署成功！"
    echo "   地址: http://127.0.0.1:$PORT"
    echo "   日志: $LOG_DIR/serve.log"
    echo "   PID:  $(cat $PID_FILE)"
else
    echo "❌ 部署失败，请检查日志: $LOG_DIR/serve.log"
    exit 1
fi
```

## Docker 部署（可选）

```dockerfile
# Dockerfile
FROM rust:1.82-slim AS builder
WORKDIR /app
RUN apt-get update && apt-get install -y nodejs npm
RUN npm install -g yarn
RUN cargo install just wasm-pack

COPY . .
RUN just build-cli-serve

FROM debian:bookworm-slim
WORKDIR /app
COPY --from=builder /app/target/release/flowscope .
COPY --from=builder /app/app ./app
EXPOSE 3000
CMD ["./flowscope", "--serve", "--port", "3000", "--watch", "./app"]
```

```bash
docker build -t flowscope .
docker run -d -p 3000:3000 -v $(pwd)/app:/app/app flowscope
```
