#!/usr/bin/env bash
# 本地开发服务启停脚本 (后端 CLI serve + 前端 Vite dev)
#
# 用法:
#   ./scripts/dev-server.sh start        # 启动后端 3000 + 前端 5173
#   ./scripts/dev-server.sh stop         # 停止全部
#   ./scripts/dev-server.sh restart      # 重启全部
#   ./scripts/dev-server.sh status       # 查看状态
#
# 选项:
#   -d, --sql-dir <d> SQL 目录 (默认: 不使用 watch, 后端直接读写 app/flowscope.db)
#   -r, --release    后端使用 release 二进制 (默认: debug)
#   -b, --backend-only    只启后端
#   -f, --frontend-only   只启前端

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKEND_PORT=3000
FRONTEND_PORT=5173
SQL_DIR=""
BIN_MODE="debug"
LOG_DIR="/tmp/capybara-logs"
BE_PID_FILE="$LOG_DIR/server.pid"
FE_PID_FILE="$LOG_DIR/vite.pid"
BE_LOG="$LOG_DIR/serve.log"
FE_LOG="$LOG_DIR/vite.log"
SERVICES=()

parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            start|stop|restart|status) ACTION="$1"; shift ;;
            -d|--sql-dir)  SQL_DIR="$2"; shift 2 ;;
            -r|--release)  BIN_MODE="release"; shift ;;
            -b|--backend-only)  SERVICES=(backend); shift ;;
            -f|--frontend-only) SERVICES=(frontend); shift ;;
            *) echo "未知参数: $1" >&2; exit 1 ;;
        esac
    done
    if [[ -z "${ACTION:-}" ]]; then
        echo "用法: $0 {start|stop|restart|status} [-b|-f]" >&2
        exit 1
    fi
    if [[ ${#SERVICES[@]} -eq 0 ]]; then
        SERVICES=(backend frontend)
    fi
}

bin_path() {
    if [[ "$BIN_MODE" == "release" ]]; then
        echo "$ROOT/target/release/capybara"
    else
        echo "$ROOT/target/debug/capybara"
    fi
}

pid_alive() {
    [[ -f "$1" ]] && kill -0 "$(cat "$1")" 2>/dev/null
}

port_pid() {
    lsof -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null | head -1
}

# 清理指定端口的残留进程 (PID 文件失效时兜底, 例如手动 nohup 的服务)
rescue_port() {
    local PORT="$1" PID
    PID="$(port_pid "$PORT")"
    if [[ -n "$PID" ]]; then
        echo "[dev-server] 清理端口 $PORT 残留进程 (PID: $PID)"
        kill "$PID" 2>/dev/null || true
        sleep 1
        kill -9 "$PID" 2>/dev/null || true
    fi
}

start_backend() {
    local BIN PID
    BIN="$(bin_path)"
    if [[ ! -x "$BIN" ]]; then
        echo "[dev-server] ❌ 后端二进制不存在: $BIN" >&2
        echo "   先构建: cargo build -p capybara-cli --features serve${BIN_MODE:+ --release}" >&2
        exit 1
    fi
    if pid_alive "$BE_PID_FILE"; then
        echo "[dev-server] 后端已在运行 (PID: $(cat "$BE_PID_FILE"))"
        return 0
    fi
    if [[ -n "$(port_pid "$BACKEND_PORT")" ]]; then
        rescue_port "$BACKEND_PORT"
    fi
    if [[ -n "$SQL_DIR" ]]; then
        nohup "$BIN" --serve --port "$BACKEND_PORT" --host 0.0.0.0 --watch "$SQL_DIR" > "$BE_LOG" 2>&1 &
    else
        nohup "$BIN" --serve --port "$BACKEND_PORT" --host 0.0.0.0 > "$BE_LOG" 2>&1 &
    fi
    PID=$!
    echo "$PID" > "$BE_PID_FILE"
    echo "[dev-server] 后端启动中 (PID: $PID, port: $BACKEND_PORT, db: $([ -n "$SQL_DIR" ] && echo "$SQL_DIR/flowscope.db" || echo "app/flowscope.db"))..."
    for _ in $(seq 1 10); do
        sleep 1
        if curl -sf "http://127.0.0.1:$BACKEND_PORT/api/health" > /dev/null; then
            echo "[dev-server] ✅ 后端已就绪 (API: http://127.0.0.1:$BACKEND_PORT)"
            return 0
        fi
        if ! kill -0 "$PID" 2>/dev/null; then
            echo "[dev-server] ❌ 后端启动失败, 日志:" >&2
            tail -20 "$BE_LOG" >&2
            rm -f "$BE_PID_FILE"
            exit 1
        fi
    done
    echo "[dev-server] ⚠️ 后端启动超时, 检查日志: $BE_LOG"
    return 1
}

start_frontend() {
    local PID
    if pid_alive "$FE_PID_FILE"; then
        echo "[dev-server] 前端已在运行 (PID: $(cat "$FE_PID_FILE"))"
        return 0
    fi
    if [[ -n "$(port_pid "$FRONTEND_PORT")" ]]; then
        rescue_port "$FRONTEND_PORT"
    fi
    if [[ ! -d "$ROOT/app/node_modules" ]]; then
        echo "[dev-server] ❌ app/node_modules 不存在, 先执行: (cd app && yarn)" >&2
        exit 1
    fi
    nohup sh -c 'cd "$1" && exec yarn dev' _ "$ROOT/app" > "$FE_LOG" 2>&1 &
    PID=$!
    echo "$PID" > "$FE_PID_FILE"
    echo "[dev-server] 前端启动中 (PID: $PID, port: $FRONTEND_PORT)..."
    for _ in $(seq 1 20); do
        sleep 1
        if curl -sf "http://localhost:$FRONTEND_PORT/" > /dev/null 2>&1; then
            echo "[dev-server] ✅ 前端已就绪 (http://localhost:$FRONTEND_PORT)"
            return 0
        fi
        if ! kill -0 "$PID" 2>/dev/null; then
            echo "[dev-server] ❌ 前端启动失败, 日志:" >&2
            tail -20 "$FE_LOG" >&2
            rm -f "$FE_PID_FILE"
            exit 1
        fi
    done
    echo "[dev-server] ⚠️ 前端启动超时, 检查日志: $FE_LOG"
    return 1
}

# 递归终止进程树 (stop 时确保 vite 等子进程也被清理, 避免端口残留)
kill_tree() {
    local PID="$1" CHILD
    for CHILD in $(pgrep -P "$PID" 2>/dev/null); do
        kill_tree "$CHILD"
    done
    kill "$PID" 2>/dev/null || true
}

stop_service() {
    local NAME="$1" PID_FILE="$2" LOG_FILE="$3"
    if pid_alive "$PID_FILE"; then
        local PID
        PID="$(cat "$PID_FILE")"
        echo "[dev-server] 停止 $NAME (PID: $PID)..."
        kill_tree "$PID"
        for _ in $(seq 1 10); do
            kill -0 "$PID" 2>/dev/null || break
            sleep 1
        done
        kill -9 "$PID" 2>/dev/null || true
        rm -f "$PID_FILE"
        echo "[dev-server] ✅ $NAME 已停止"
    else
        rm -f "$PID_FILE"
        echo "[dev-server] $NAME: 未在运行"
    fi
}

do_start() {
    local SVC STARTED=0
    for SVC in "${SERVICES[@]}"; do
        if [[ "$SVC" == "backend" ]]; then
            start_backend && STARTED=1
        else
            start_frontend && STARTED=1
        fi
    done
    [[ "$STARTED" -eq 0 ]] && return 1
    echo "[dev-server] 就绪:"
    if [[ "$SERVICES" == *"backend"* ]]; then
        echo "  后端 API: http://127.0.0.1:$BACKEND_PORT"
        if [[ -n "$SQL_DIR" ]]; then
            echo "  SQL目录:  $SQL_DIR (watch 模式, db: $SQL_DIR/flowscope.db)"
        else
            echo "  数据库:   $ROOT/app/flowscope.db"
        fi
    fi
    if [[ "$SERVICES" == *"frontend"* ]]; then
        echo "  Web UI:   http://127.0.0.1:$FRONTEND_PORT (Vite dev)"
    fi
    echo "  日志:     $BE_LOG / $FE_LOG"
    echo "  停止:     $0 stop"
}

do_stop() {
    local SVC
    for SVC in "${SERVICES[@]}"; do
        if [[ "$SVC" == "backend" ]]; then
            stop_service "后端" "$BE_PID_FILE" "$BE_LOG"
            if [[ -n "$(port_pid "$BACKEND_PORT")" ]]; then
                rescue_port "$BACKEND_PORT"
            fi
        else
            stop_service "前端" "$FE_PID_FILE" "$FE_LOG"
            if [[ -n "$(port_pid "$FRONTEND_PORT")" ]]; then
                rescue_port "$FRONTEND_PORT"
            fi
        fi
    done
}

do_status() {
    local SVC
    for SVC in "${SERVICES[@]}"; do
        if [[ "$SVC" == "backend" ]]; then
            if pid_alive "$BE_PID_FILE"; then
                echo "[dev-server] ✅ 后端运行中 (PID: $(cat "$BE_PID_FILE"), http://127.0.0.1:$BACKEND_PORT)"
            elif [[ -n "$(port_pid "$BACKEND_PORT")" ]]; then
                echo "[dev-server] ⚠️ 后端运行中但 PID 文件失效 (PID: $(port_pid "$BACKEND_PORT"))"
            else
                echo "[dev-server] ⛔ 后端未运行"
            fi
        else
            if pid_alive "$FE_PID_FILE"; then
                echo "[dev-server] ✅ 前端运行中 (PID: $(cat "$FE_PID_FILE"), http://127.0.0.1:$FRONTEND_PORT)"
            elif [[ -n "$(port_pid "$FRONTEND_PORT")" ]]; then
                echo "[dev-server] ⚠️ 前端运行中但 PID 文件失效 (PID: $(port_pid "$FRONTEND_PORT"))"
            else
                echo "[dev-server] ⛔ 前端未运行"
            fi
        fi
    done
}

if [[ -n "$SQL_DIR" ]]; then
    [[ -d "$SQL_DIR" ]] || mkdir -p "$SQL_DIR"
fi
mkdir -p "$LOG_DIR"

parse_args "$@"
case "$ACTION" in
    start)   do_start ;;
    stop)    do_stop ;;
    restart) do_stop; do_start ;;
    status)  do_status ;;
esac