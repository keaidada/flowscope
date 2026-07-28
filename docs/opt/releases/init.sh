#!/usr/bin/env bash
# ============================================================================
# FS (FlowScope) Serve 模式 — 一键初始化 + 启动脚本
#
# 功能：
#   1. 检测运行环境（自动安装缺失依赖）
#   2. 解压二进制
#   3. 创建目录结构
#   4. 启动服务
#   5. 打印访问地址
#
# 用法：
#   chmod +x init.sh
#   ./init.sh                              # 前台运行，默认端口 3000
#   ./init.sh --port 8080                  # 指定端口
#   ./init.sh --daemon                     # 后台运行
#   ./init.sh --target /tmp/flowscope      # 指定安装目录
#   ./init.sh --sql-dir /path/to/sql       # 指定 SQL 目录
# ============================================================================

set -euo pipefail

# ── 默认参数 ──────────────────────────────────────────────────────────────
INSTALL_DIR="/tmp/flowscope"
PORT=3000
DAEMON=false
SQL_DIR=""
ARCH=""
SCRIPT_DIR="$(cd "$(dirname "$0")" &>/dev/null && pwd)"

# ── 颜色 ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

log()   { echo -e "${GREEN}[FS]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }
info()  { echo -e "${BLUE}[INFO]${NC} $1"; }
step()  { echo -e "${CYAN}[STEP]${NC} $1"; }

# ── 解析参数 ──────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case $1 in
        --target)     INSTALL_DIR="$2"; shift 2 ;;
        --port)       PORT="$2"; shift 2 ;;
        --daemon)     DAEMON=true; shift ;;
        --sql-dir)    SQL_DIR="$2"; shift 2 ;;
        --arch)       ARCH="$2"; shift 2 ;;
        --help|-h)
            echo "用法: ./init.sh [选项]"
            echo ""
            echo "选项:"
            echo "  --target <dir>     安装目录 (默认: /tmp/flowscope)"
            echo "  --port <n>         端口号 (默认: 3000)"
            echo "  --daemon           后台运行"
            echo "  --sql-dir <dir>    SQL 文件目录 (默认: 安装目录/sql)"
            echo "  --arch <arch>      CPU 架构 arm64|x86_64 (默认: 自动检测)"
            exit 0
            ;;
        *) error "未知参数: $1 (用 --help 查看用法)" ;;
    esac
done

# 没指定 SQL 目录就用安装目录下的 sql
[[ -z "$SQL_DIR" ]] && SQL_DIR="$INSTALL_DIR/sql"

echo ""
echo -e "${CYAN}╔══════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║  FS Serve 模式 — 一键安装 + 启动            ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════════╝${NC}"
echo ""

# ============================================================================
# STEP 1: 检测运行环境
# ============================================================================
step "1/5 检测运行环境..."

# --- 操作系统 ---
OS="$(uname -s)"
case "$OS" in
    Darwin) OS_NAME="macOS" ;;
    Linux)  OS_NAME="Linux" ;;
    *)      error "不支持的操作系统: $OS (仅支持 macOS / Linux)" ;;
esac
info "操作系统: $OS_NAME"

# --- CPU 架构 ---
if [[ -z "$ARCH" ]]; then
    ARCH="$(uname -m)"
    case "$ARCH" in
        arm64|aarch64) ARCH="arm64" ;;
        x86_64|amd64)  ARCH="x86_64" ;;
        *)             error "不支持的 CPU 架构: $ARCH" ;;
    esac
fi
info "CPU 架构: $ARCH"

# --- 查找二进制包 ---
TARBALL=""
if [[ "$OS_NAME" == "macOS" ]]; then
    case "$ARCH" in
        arm64)  TARBALL="$SCRIPT_DIR/flowscope-1.0.0-darwin-arm64.tar.gz" ;;
        x86_64) TARBALL="$SCRIPT_DIR/flowscope-1.0.0-darwin-x86_64.tar.gz" ;;
    esac
fi

if [[ -z "$TARBALL" ]] || [[ ! -f "$TARBALL" ]]; then
    error "未找到二进制包: ${TARBALL:-无匹配}
请确认对应平台 ($OS_NAME-$ARCH) 的 .tar.gz 文件与 init.sh 在同一目录。"
fi
info "二进制包: $(basename "$TARBALL")"

# --- 端口占用检查 ---
if command -v lsof &>/dev/null; then
    if lsof -i:"$PORT" &>/dev/null; then
        warn "端口 $PORT 已被占用"
        # 尝试杀掉占用进程
        PID=$(lsof -ti:"$PORT" 2>/dev/null | head -1)
        if [[ -n "$PID" ]]; then
            info "停止占用进程 (PID: $PID)..."
            kill "$PID" 2>/dev/null || true
            sleep 1
        fi
    fi
fi
info "端口: $PORT ✅"

echo ""
log "环境检测通过 ✅"

# ============================================================================
# STEP 2: 创建目录 + 解压二进制
# ============================================================================
step "2/5 安装二进制..."

# 备份旧数据库
if [[ -f "$INSTALL_DIR/data/flowscope.db" ]]; then
    BACKUP="$INSTALL_DIR/data/flowscope.db.bak.$(date +%Y%m%d%H%M%S)"
    cp "$INSTALL_DIR/data/flowscope.db" "$BACKUP"
    info "已备份旧数据库: $BACKUP"
fi

mkdir -p "$INSTALL_DIR"/{bin,data,logs,sql}

# 清理可能残留的旧数据库文件（避免 schema 不兼容）
rm -f "$INSTALL_DIR/data/flowscope.db"*


tar -xzf "$TARBALL" -C "$INSTALL_DIR/bin/"
chmod +x "$INSTALL_DIR/bin/flowscope"

# 拷贝内置示例 SQL 文件
for f in "$SCRIPT_DIR"/*.sql; do
    [[ -f "$f" ]] && cp "$f" "$INSTALL_DIR/sql/" && info "内置 SQL: $(basename "$f")"
done

echo ""
log "目录结构:"
echo "  $INSTALL_DIR/bin/     → 二进制"
echo "  $INSTALL_DIR/data/    → 数据库"
echo "  $INSTALL_DIR/logs/    → 日志"
echo "  $INSTALL_DIR/sql/     → SQL 文件"
echo ""

# ============================================================================
# STEP 3: 验证二进制
# ============================================================================
step "3/5 验证二进制..."

BIN_VERSION="$("$INSTALL_DIR/bin/flowscope" --version 2>&1)" || error "二进制验证失败"
info "版本: $BIN_VERSION ✅"

# ============================================================================
# STEP 4: 启动服务
# ============================================================================
step "4/5 启动服务..."

PID_FILE="$INSTALL_DIR/logs/flowscope.pid"
LOG_FILE="$INSTALL_DIR/logs/flowscope.log"
DB_PATH="$INSTALL_DIR/data/flowscope.db"

CMD="$INSTALL_DIR/bin/flowscope --serve --port $PORT --watch $SQL_DIR"

if $DAEMON; then
    # --- 后台运行 ---
    nohup $CMD > "$LOG_FILE" 2>&1 &
    SERVER_PID=$!
    echo $SERVER_PID > "$PID_FILE"
    
    # 等待启动（最多 10 秒）
    info "等待服务启动..."
    READY=false
    for i in $(seq 1 10); do
        sleep 1
        if curl -sf "http://localhost:$PORT/api/health" &>/dev/null; then
            READY=true
            break
        fi
        # 检查进程是否还活着
        if ! kill -0 $SERVER_PID 2>/dev/null; then
            echo ""
            error "服务启动失败，请查看日志:
  $LOG_FILE"
        fi
        printf "."
    done
    echo ""
    
    if $READY; then
        log "服务已启动 ✅ (PID: $SERVER_PID)"
    else
        warn "服务可能还在启动中，请稍后检查:
  curl http://localhost:$PORT/api/health
  tail -f $LOG_FILE"
    fi
else
    # --- 前台运行 ---
    log "前台启动 (按 Ctrl+C 停止)"
    echo ""
    
    # 在后台先启动，等健康检查通过后再决定是否前台 attach
    nohup $CMD > "$LOG_FILE" 2>&1 &
    SERVER_PID=$!
    echo $SERVER_PID > "$PID_FILE"
    
    info "等待服务启动..."
    READY=false
    for i in $(seq 1 10); do
        sleep 1
        if curl -sf "http://localhost:$PORT/api/health" &>/dev/null; then
            READY=true
            break
        fi
        if ! kill -0 $SERVER_PID 2>/dev/null; then
            echo ""
            error "服务启动失败，请查看日志:
  $LOG_FILE"
        fi
        printf "."
    done
    echo ""
    
    if $READY; then
        log "服务已启动 ✅ (PID: $SERVER_PID)"
    else
        warn "服务可能还在启动中"
    fi
fi

# ============================================================================
# STEP 5: 打印访问信息
# ============================================================================
step "5/5 完成！"

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  ✅ FS Serve 已启动                                 ║${NC}"
echo -e "${GREEN}╠══════════════════════════════════════════════════════╣${NC}"
echo -e "${GREEN}║                                                      ║${NC}"
echo -e "${GREEN}║  🌐 Web UI:        http://localhost:${PORT}             ║${NC}"
echo -e "${GREEN}║  🔌 REST API:      http://localhost:${PORT}/api         ║${NC}"
echo -e "${GREEN}║  📖 API 文档:      http://localhost:${PORT}/api/docs    ║${NC}"
echo -e "${GREEN}║  ❤️  健康检查:     curl http://localhost:${PORT}/api/health${NC}"
echo -e "${GREEN}║                                                      ║${NC}"
echo -e "${GREEN}╠══════════════════════════════════════════════════════╣${NC}"
echo -e "${GREEN}║  📁 安装路径                                       ║${NC}"
echo -e "${GREEN}║     二进制:   $INSTALL_DIR/bin/flowscope${NC}"
printf "${GREEN}║     数据库:   %s${NC}\n" "$DB_PATH"
printf "${GREEN}║     日志:     %s${NC}\n" "$LOG_FILE"
printf "${GREEN}║     SQL:      %s${NC}\n" "$SQL_DIR"
echo -e "${GREEN}║                                                      ║${NC}"
echo -e "${GREEN}╠══════════════════════════════════════════════════════╣${NC}"
echo -e "${GREEN}║  🔧 常用命令                                        ║${NC}"
echo -e "${GREEN}║     查看日志:  tail -f $LOG_FILE${NC}"
echo -e "${GREEN}║     停止服务:  kill \$(cat $PID_FILE)${NC}"
echo -e "${GREEN}║     状态检查:  curl http://localhost:${PORT}/api/health${NC}"
echo -e "${GREEN}║                                                      ║${NC}"
if [[ -n "$SQL_DIR" ]] && [[ ! "$(ls -A "$SQL_DIR" 2>/dev/null)" ]]; then
echo -e "${GREEN}║  ⚠️  SQL 目录为空，请放入 .sql/.hql 文件:           ║${NC}"
echo -e "${GREEN}║     cp /path/to/*.sql $SQL_DIR/${NC}"
echo -e "${GREEN}║                                                      ║${NC}"
fi
echo -e "${GREEN}╚══════════════════════════════════════════════════════╝${NC}"
echo ""
