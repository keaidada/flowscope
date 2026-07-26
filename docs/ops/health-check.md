# 健康检查

## 部署前 Precheck

### 环境检查脚本

```bash
#!/usr/bin/env bash
# scripts/precheck.sh
set -euo pipefail

echo "=== FlowScope 部署前检查 ==="

# 1. 依赖版本检查
echo ""
echo "[1] 依赖版本"
echo "  Rust:     $(rustc --version 2>/dev/null || echo '未安装')"
echo "  Node:     $(node --version 2>/dev/null || echo '未安装')"
echo "  Yarn:     $(yarn --version 2>/dev/null || echo '未安装')"
echo "  wasm-pack: $(wasm-pack --version 2>/dev/null || echo '未安装')"
echo "  just:     $(just --version 2>/dev/null || echo '未安装')"

# 2. 构建产物检查
echo ""
echo "[2] 构建产物"
BINS=("./target/debug/flowscope" "./target/release/flowscope")
for bin in "${BINS[@]}"; do
    if [ -f "$bin" ]; then
        SIZE=$(du -h "$bin" | cut -f1)
        echo "  ✅ $bin ($SIZE)"
    fi
done
WASM="packages/core/wasm/flowscope_wasm_bg.wasm"
if [ -f "$WASM" ]; then
    echo "  ✅ $WASM ($(du -h $WASM | cut -f1))"
else
    echo "  ⚠️  WASM 未构建 (运行 just build-wasm-dev)"
fi

# 3. 端口检查
echo ""
echo "[3] 端口占用"
for port in 3000 5173; do
    if lsof -i ":$port" -t &>/dev/null; then
        PID=$(lsof -i ":$port" -t | head -1)
        echo "  ⚠️  端口 $port 被占用 (PID: $PID)"
    else
        echo "  ✅ 端口 $port 可用"
    fi
done

# 4. 数据库检查
echo ""
echo "[4] 数据库"
DB="./app/flowscope.db"
if [ -f "$DB" ]; then
    SIZE=$(du -h "$DB" | cut -f1)
    TABLES=$(sqlite3 "$DB" "SELECT COUNT(*) FROM sqlite_master WHERE type='table';" 2>/dev/null || echo "?")
    echo "  ✅ $DB ($SIZE, $TABLES 张表)"
else
    echo "  ℹ️  数据库不存在（首次运行会自动创建）"
fi

echo ""
echo "=== 检查完成 ==="
```

### 运行 Precheck

```bash
bash scripts/precheck.sh
```

## 服务健康检查

### 一键检查脚本

```bash
#!/usr/bin/env bash
# scripts/health-check.sh — 服务状态检查
set -euo pipefail

PASS=0; FAIL=0

check_url() {
    local name=$1; local url=$2; local expect=$3
    local resp
    resp=$(curl -sf -o /dev/null -w "%{http_code}" "$url" 2>/dev/null || echo "000")
    if [ "$resp" = "$expect" ] || [ "$resp" = "200" ]; then
        echo "  ✅ $name ($url): $resp"
        PASS=$((PASS + 1))
    else
        echo "  ❌ $name ($url): $resp (期望 $expect)"
        FAIL=$((FAIL + 1))
    fi
}

check_api() {
    local name=$1; local url=$2; local grep_str=$3
    local resp
    resp=$(curl -sf "$url" 2>/dev/null || echo "")
    if echo "$resp" | grep -q "$grep_str"; then
        echo "  ✅ $name: OK"
        PASS=$((PASS + 1))
    else
        echo "  ❌ $name: 响应异常"
        FAIL=$((FAIL + 1))
    fi
}

echo "=== FlowScope 服务健康检查 ==="
echo ""

# 前端
echo "[1] 前端服务"
check_url "Vite Dev"  "http://localhost:5173/"  "200"
echo ""

# 后端 API
echo "[2] 后端 API"
check_api  "Health"   "http://127.0.0.1:3000/api/health"  "ok"
check_api  "Config"   "http://127.0.0.1:3000/api/config"  "dialect"
check_url  "Projects" "http://127.0.0.1:3000/api/db/projects" "200"
echo ""

# 数据库
echo "[3] 数据库"
DB="./app/flowscope.db"
if [ -f "$DB" ]; then
    SIZE=$(du -h "$DB" | cut -f1)
    PROJECTS=$(sqlite3 "$DB" "SELECT COUNT(*) FROM projects WHERE status=1;" 2>/dev/null || echo "?")
    FILES=$(sqlite3 "$DB" "SELECT COUNT(*) FROM project_files WHERE status=1;" 2>/dev/null || echo "?")
    NODES=$(sqlite3 "$DB" "SELECT COUNT(*) FROM lineage_nodes WHERE status=1;" 2>/dev/null || echo "?")
    echo "  ✅ 文件: $SIZE"
    echo "  ✅ 项目: $PROJECTS, 文件: $FILES, 血缘节点: $NODES"
else
    echo "  ❌ 数据库不存在"
    FAIL=$((FAIL + 1))
fi
echo ""

# 进程检查
echo "[4] 进程"
if pgrep -f "flowscope --serve" >/dev/null; then
    PID=$(pgrep -f "flowscope --serve" | head -1)
    echo "  ✅ flowscope --serve 运行中 (PID: $PID)"
    PASS=$((PASS + 1))
else
    echo "  ❌ flowscope --serve 未运行"
    FAIL=$((FAIL + 1))
fi
echo ""

echo "=== 结果: $PASS 通过, $FAIL 失败 ==="
[ "$FAIL" -eq 0 ] && echo "✅ 全部健康" || echo "❌ 存在异常"
```

### REST API 端点

| 端点 | 方法 | 说明 | 期望响应 |
|------|------|------|---------|
| `/api/health` | GET | 健康检查 | `{"status":"ok","version":"1.0.0"}` |
| `/api/config` | GET | 服务配置 | `{"dialect":"generic",...}` |
| `/api/db/projects` | GET | 项目列表 | `[...]` |
| `/api/analyze` | POST | 血缘分析 | `{...}` |
| `/api/db/project-files?projectId=X` | GET | 项目文件 | `[...]` |

### 快速验证

```bash
# 健康检查
curl http://127.0.0.1:3000/api/health
# {"status":"ok","version":"1.0.0"}

# 前端
curl -o /dev/null -w "%{http_code}" http://localhost:5173/
# 200

# 数据库统计
sqlite3 app/flowscope.db "
SELECT 'projects', COUNT(*) FROM projects WHERE status=1
UNION ALL SELECT 'files', COUNT(*) FROM project_files WHERE status=1
UNION ALL SELECT 'lineage_nodes', COUNT(*) FROM lineage_nodes WHERE status=1
UNION ALL SELECT 'lineage_edges', COUNT(*) FROM lineage_edges WHERE status=1;"
```
