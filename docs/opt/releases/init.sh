#!/usr/bin/env bash
# ============================================================================
# FS (FlowScope) Serve 模式 — 初始化脚本
#
# 用途：首次部署时运行，完成以下操作：
#   1. 检查系统环境
#   2. 解压二进制到目标目录
#   3. 创建数据目录
#   4. 生成默认配置
#   5. 验证安装
#
# 用法：
#   chmod +x init.sh
#   ./init.sh [--target /tmp/flowscope] [--arch arm64|x86_64]
#
# 默认安装路径：/tmp/flowscope
# ============================================================================

set -euo pipefail

# ── 默认参数 ──────────────────────────────────────────────────────────────
INSTALL_DIR="/tmp/flowscope"
ARCH=""
SCRIPT_DIR="$(cd "$(dirname "$0")" &>/dev/null && pwd)"

# ── 颜色 ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log()   { echo -e "${GREEN}[FS]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }
info()  { echo -e "${BLUE}[INFO]${NC} $1"; }

# ── 解析参数 ──────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case $1 in
        --target)
            INSTALL_DIR="$2"
            shift 2
            ;;
        --arch)
            ARCH="$2"
            shift 2
            ;;
        --help|-h)
            echo "用法: ./init.sh [--target /tmp/flowscope] [--arch arm64|x86_64]"
            echo ""
            echo "选项:"
            echo "  --target <dir>    安装目录 (默认: /tmp/flowscope)"
            echo "  --arch <arch>     CPU 架构: arm64 或 x86_64 (默认: 自动检测)"
            exit 0
            ;;
        *)
            error "未知参数: $1 (用 --help 查看用法)"
            ;;
    esac
done

# ── 1. 检查系统环境 ────────────────────────────────────────────────────────
log "=== FS Serve 模式初始化 ==="
echo ""

# 检测操作系统
OS="$(uname -s)"
case "$OS" in
    Darwin) OS_NAME="macOS" ;;
    Linux)  OS_NAME="Linux" ;;
    *)      error "不支持的操作系统: $OS (仅支持 macOS / Linux)" ;;
esac
info "操作系统: $OS_NAME"

# 检测/确认 CPU 架构
if [[ -z "$ARCH" ]]; then
    ARCH="$(uname -m)"
    case "$ARCH" in
        arm64|aarch64) ARCH="arm64" ;;
        x86_64|amd64)  ARCH="x86_64" ;;
        *)             error "不支持的 CPU 架构: $ARCH" ;;
    esac
fi
info "CPU 架构: $ARCH"

# 查找对应二进制包
TARBALL=""
if [[ "$OS_NAME" == "macOS" ]]; then
    case "$ARCH" in
        arm64)
            TARBALL="$SCRIPT_DIR/flowscope-1.0.0-darwin-arm64.tar.gz"
            ;;
        x86_64)
            TARBALL="$SCRIPT_DIR/flowscope-1.0.0-darwin-x86_64.tar.gz"
            ;;
    esac
fi

if [[ -z "$TARBALL" ]] || [[ ! -f "$TARBALL" ]]; then
    error "未找到二进制包: ${TARBALL:-无匹配}
请确认对应平台 ($OS_NAME-$ARCH) 的 .tar.gz 文件在本目录下。"
fi
info "二进制包: $(basename "$TARBALL")"

# ── 2. 创建安装目录 ────────────────────────────────────────────────────────
echo ""
log "创建安装目录: $INSTALL_DIR"

if [[ -d "$INSTALL_DIR" ]]; then
    warn "目录已存在: $INSTALL_DIR"
    read -rp "覆盖安装？(y/N) " confirm
    [[ "$confirm" =~ ^[Yy]$ ]] || { info "已取消"; exit 0; }
    # 备份旧的数据库
    if [[ -f "$INSTALL_DIR/data/flowscope.db" ]]; then
        BACKUP="$INSTALL_DIR/data/flowscope.db.bak.$(date +%Y%m%d%H%M%S)"
        cp "$INSTALL_DIR/data/flowscope.db" "$BACKUP"
        info "已备份数据库: $BACKUP"
    fi
fi

mkdir -p "$INSTALL_DIR"/{bin,data,logs,sql}
info "目录结构:
  $INSTALL_DIR/bin/    二进制
  $INSTALL_DIR/data/   数据库
  $INSTALL_DIR/logs/   日志
  $INSTALL_DIR/sql/    SQL 文件目录"

# ── 3. 解压二进制 ──────────────────────────────────────────────────────────
echo ""
log "解压二进制..."
tar -xzf "$TARBALL" -C "$INSTALL_DIR/bin/"
chmod +x "$INSTALL_DIR/bin/flowscope"
info "二进制已安装: $INSTALL_DIR/bin/flowscope"

# ── 4. 验证安装 ────────────────────────────────────────────────────────────
echo ""
log "验证安装..."
BIN_VERSION="$("$INSTALL_DIR/bin/flowscope" --version 2>&1)"
if [[ $? -eq 0 ]]; then
    info "版本: $BIN_VERSION"
else
    error "二进制验证失败，请检查系统兼容性"
fi

# ── 5. 生成启动脚本 ─────────────────────────────────────────────────────────
echo ""
log "生成启动脚本..."

cat > "$INSTALL_DIR/start.sh" << 'STARTEOF'
#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# FS Serve 模式 — 启动脚本
#
# 用法：
#   ./start.sh                          # 前台运行，默认端口 3000
#   ./start.sh --port 8080              # 指定端口
#   ./start.sh --daemon                 # 后台运行
#   ./start.sh --watch /path/to/sql     # 监听 SQL 目录
#   ./start.sh --port 8080 --watch ./sql --daemon
#
# 停止后台进程：
#   ./start.sh --stop
#
# 查看状态：
#   ./start.sh --status
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" &>/dev/null && pwd)"
BIN="$SCRIPT_DIR/bin/flowscope"
PID_FILE="$SCRIPT_DIR/logs/flowscope.pid"
LOG_FILE="$SCRIPT_DIR/logs/flowscope.log"
DB_DIR="$SCRIPT_DIR/data"
SQL_DIR="$SCRIPT_DIR/sql"

# 默认参数
PORT=3000
WATCH_DIR="$SQL_DIR"
DAEMON=false
EXTRA_ARGS=""

# 解析参数
while [[ $# -gt 0 ]]; do
    case $1 in
        --port)      PORT="$2"; shift 2 ;;
        --watch)     WATCH_DIR="$2"; shift 2 ;;
        --daemon)    DAEMON=true; shift ;;
        --stop)      [[ -f "$PID_FILE" ]] && kill "$(cat "$PID_FILE")" && rm "$PID_FILE" && echo "已停止" || echo "未在运行"; exit 0 ;;
        --status)    [[ -f "$PID_FILE" ]] && echo "运行中 (PID: $(cat "$PID_FILE"))" || echo "未运行"; exit 0 ;;
        --help|-h)
            echo "用法: ./start.sh [选项]"
            echo ""
            echo "选项:"
            echo "  --port <n>       端口号 (默认: 3000)"
            echo "  --watch <dir>    SQL 文件监听目录 (默认: ./sql)"
            echo "  --daemon         后台运行"
            echo "  --stop           停止后台进程"
            echo "  --status         查看运行状态"
            exit 0
            ;;
        *) EXTRA_ARGS="$EXTRA_ARGS $1"; shift ;;
    esac
done

# 确保目录存在
mkdir -p "$DB_DIR" "$LOG_FILE" "$WATCH_DIR" 2>/dev/null || mkdir -p "$DB_DIR" "$(dirname "$LOG_FILE")" "$WATCH_DIR"

# 构建启动命令
CMD="$BIN --serve --port $PORT --db-path $DB_DIR/flowscope.db --watch $WATCH_DIR $EXTRA_ARGS"

echo "============================================"
echo "  FS Serve 模式启动"
echo "============================================"
echo "  端口:     $PORT"
echo "  SQL 目录: $WATCH_DIR"
echo "  数据库:   $DB_DIR/flowscope.db"
echo "  日志:     $LOG_FILE"
echo "============================================"
echo ""

if $DAEMON; then
    # 后台运行
    if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
        echo "已在运行 (PID: $(cat "$PID_FILE"))，如需重启请先 --stop"
        exit 1
    fi
    nohup $CMD > "$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"
    sleep 1
    if kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
        echo "✅ 已启动 (PID: $(cat "$PID_FILE"))"
        echo ""
        echo "  Web UI:  http://localhost:$PORT"
        echo "  API:     http://localhost:$PORT/api"
        echo "  健康检查: curl http://localhost:$PORT/api/health"
        echo ""
        echo "  停止: ./start.sh --stop"
        echo "  状态: ./start.sh --status"
        echo "  日志: tail -f $LOG_FILE"
    else
        echo "❌ 启动失败，请查看日志: $LOG_FILE"
        rm -f "$PID_FILE"
        exit 1
    fi
else
    # 前台运行
    echo "按 Ctrl+C 停止"
    echo ""
    exec $CMD 2>&1 | tee "$LOG_FILE"
fi
STARTEOF

chmod +x "$INSTALL_DIR/start.sh"
info "启动脚本: $INSTALL_DIR/start.sh"

# ── 6. 创建示例 SQL 目录 ────────────────────────────────────────────────────
if [[ ! -f "$INSTALL_DIR/sql/.gitkeep" ]]; then
    touch "$INSTALL_DIR/sql/.gitkeep"
    info "SQL 目录已创建: $INSTALL_DIR/sql/ (放入 .sql/.hql 文件即可)"
fi

# ── 完成 ────────────────────────────────────────────────────────────────────
echo ""
log "=== ✅ 初始化完成 ==="
echo ""
echo "  下一步："
echo "    1. 把 SQL 文件放入 $INSTALL_DIR/sql/"
echo "    2. 启动服务："
echo "       $INSTALL_DIR/start.sh"
echo "       或后台运行："
echo "       $INSTALL_DIR/start.sh --daemon"
echo ""
echo "    3. 打开浏览器：http://localhost:3000"
echo ""
echo "  常用命令："
echo "    启动(前台):  $INSTALL_DIR/start.sh"
echo "    启动(后台):  $INSTALL_DIR/start.sh --daemon"
echo "    停止:        $INSTALL_DIR/start.sh --stop"
echo "    状态:        $INSTALL_DIR/start.sh --status"
echo "    指定端口:    $INSTALL_DIR/start.sh --port 8080"
echo ""
