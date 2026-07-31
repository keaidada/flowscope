# Capybara v1.0

## Windows Installation

### Prerequisites
- Windows 10/11 or Windows Server 2019+
- No other dependencies required

### Quick Install
1. Download `capybara.exe` from [GitHub Releases](https://github.com/keaidada/capybara/releases/tag/v1.0)
2. Place `capybara.exe` and `install.bat` in the same directory
3. Run `install.bat` as Administrator

### Default Paths
| Directory | Path |
|-----------|------|
| Binary | `D:\tmp\capybara\capybara.exe` |
| Data (SQL files) | `D:\tmp\capybara-data` |
| Database | `D:\tmp\capybara-data\capybara.db` |

If `D:\tmp` doesn't exist, it will be created automatically.

### Manual Install
```cmd
mkdir D:\tmp\capybara
copy capybara.exe D:\tmp\capybara\
```

### Commands
```cmd
# Start web server
capybara --serve --port 3000 --watch D:\tmp\capybara-data

# Analyze single file
capybara analyze D:\tmp\capybara-data\query.sql

# Help
capybara --help
```

### Web UI
Open http://localhost:3000 in browser after starting serve mode.

## Build from Source

```bash
# Prerequisites: Rust 1.82+, Node.js 18+
cargo build -p capybara-cli --features serve --release
```
