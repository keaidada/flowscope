# 服务管理

## 开发模式（双服务）

### 启动

```bash
mkdir -p /tmp/flowscope-logs

# 前端 Dev Server (:5173)
cd app && nohup npx vite --host > /tmp/flowscope-logs/dev.log 2>&1 &

# 后端 CLI Serve (:3000)
./target/debug/flowscope --serve --port 3000 --watch ./app \
    > /tmp/flowscope-logs/serve.log 2>&1 &
```

### 停止

```bash
pkill -f "vite"
pkill -f "flowscope --serve"
```

### 重启

```bash
pkill -f "flowscope --serve"; sleep 1
./target/debug/flowscope --serve --port 3000 --watch ./app \
    > /tmp/flowscope-logs/serve.log 2>&1 &
```

## 生产模式（单体 CLI）

### 启动

```bash
nohup ./target/release/flowscope --serve --port 3000 --watch ./app \
    > /var/log/flowscope.log 2>&1 &
echo $! > /tmp/flowscope.pid
```

### 停止

```bash
kill "$(cat /tmp/flowscope.pid)"
# 或
pkill -f "flowscope --serve"
```

### 重启（零停机可选）

```bash
PID=$(cat /tmp/flowscope.pid)
kill $PID
sleep 2
nohup ./target/release/flowscope --serve --port 3000 --watch ./app \
    > /var/log/flowscope.log 2>&1 &
echo $! > /tmp/flowscope.pid
```

## systemd 服务（推荐生产环境）

```ini
# /etc/systemd/system/flowscope.service
[Unit]
Description=FlowScope SQL Lineage Analyzer
After=network.target

[Service]
Type=simple
User=flowscope
WorkingDirectory=/opt/flowscope
ExecStart=/opt/flowscope/flowscope --serve --port 3000 --watch /opt/flowscope/app
Restart=always
RestartSec=5
Environment=RUST_LOG=info

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable flowscope
sudo systemctl start flowscope
sudo systemctl status flowscope
```

## 日志管理

| 日志文件 | 内容 |
|---------|------|
| `/tmp/flowscope-logs/dev.log` | 前端 Vite Dev Server 日志 |
| `/tmp/flowscope-logs/serve.log` | 后端 CLI Serve 日志 |
| `/var/log/flowscope.log` | 生产模式日志 |

```bash
# 实时查看日志
tail -f /tmp/flowscope-logs/serve.log

# systemd 日志
journalctl -u flowscope -f
```

## CLI 参数

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `--serve` | 启动 HTTP 服务器 | - |
| `--port <PORT>` | 监听端口 | 3000 |
| `--watch <DIR>` | 监听文件变更的目录 | - |
| `--db-path <PATH>` | SQLite 数据库路径 | `./app/flowscope.db` |

## 数据库备份

```bash
# 备份
cp app/flowscope.db app/flowscope.db.$(date +%Y%m%d).bak

# 恢复
cp app/flowscope.db.20240101.bak app/flowscope.db
```
