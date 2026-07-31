# 服务管理

## 开发模式（双服务）

### 启动

```bash
mkdir -p /tmp/capybara-logs

# 前端 Dev Server (:5173)
cd app && nohup npx vite --host > /tmp/capybara-logs/dev.log 2>&1 &

# 后端 CLI Serve (:3000)
./target/debug/capybara --serve --port 3000 --watch ./app \
    > /tmp/capybara-logs/serve.log 2>&1 &
```

### 停止

```bash
pkill -f "vite"
pkill -f "capybara --serve"
```

### 重启

```bash
pkill -f "capybara --serve"; sleep 1
./target/debug/capybara --serve --port 3000 --watch ./app \
    > /tmp/capybara-logs/serve.log 2>&1 &
```

## 生产模式（单体 CLI）

### 启动

```bash
nohup ./target/release/capybara --serve --port 3000 --watch ./app \
    > /var/log/capybara.log 2>&1 &
echo $! > /tmp/capybara.pid
```

### 停止

```bash
kill "$(cat /tmp/capybara.pid)"
# 或
pkill -f "capybara --serve"
```

### 重启（零停机可选）

```bash
PID=$(cat /tmp/capybara.pid)
kill $PID
sleep 2
nohup ./target/release/capybara --serve --port 3000 --watch ./app \
    > /var/log/capybara.log 2>&1 &
echo $! > /tmp/capybara.pid
```

## systemd 服务（推荐生产环境）

```ini
# /etc/systemd/system/capybara.service
[Unit]
Description=Capybara SQL Lineage Analyzer
After=network.target

[Service]
Type=simple
User=capybara
WorkingDirectory=/opt/capybara
ExecStart=/opt/capybara/capybara --serve --port 3000 --watch /opt/capybara/app
Restart=always
RestartSec=5
Environment=RUST_LOG=info

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable capybara
sudo systemctl start capybara
sudo systemctl status capybara
```

## 日志管理

| 日志文件 | 内容 |
|---------|------|
| `/tmp/capybara-logs/dev.log` | 前端 Vite Dev Server 日志 |
| `/tmp/capybara-logs/serve.log` | 后端 CLI Serve 日志 |
| `/var/log/capybara.log` | 生产模式日志 |

```bash
# 实时查看日志
tail -f /tmp/capybara-logs/serve.log

# systemd 日志
journalctl -u capybara -f
```

## CLI 参数

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `--serve` | 启动 HTTP 服务器 | - |
| `--port <PORT>` | 监听端口 | 3000 |
| `--watch <DIR>` | 监听文件变更的目录 | - |
| `--db-path <PATH>` | SQLite 数据库路径 | `./app/capybara.db` |

## 数据库备份

```bash
# 备份
cp app/capybara.db app/capybara.db.$(date +%Y%m%d).bak

# 恢复
cp app/capybara.db.20240101.bak app/capybara.db
```
