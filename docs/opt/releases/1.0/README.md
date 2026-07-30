# FlowScope v1.0

## Windows Installation

### Prerequisites
- Windows 10/11 or Windows Server 2019+
- No other dependencies required

### Quick Install
1. Download `flowscope.exe` from [GitHub Releases](https://github.com/keaidada/flowscope/releases/tag/v1.0)
2. Place `flowscope.exe` and `install.bat` in the same directory
3. Run `install.bat` as Administrator

### Default Paths
| Directory | Path |
|-----------|------|
| Binary | `D:\tmp\flowscope\flowscope.exe` |
| Data (SQL files) | `D:\tmp\flowscope-data` |
| Database | `D:\tmp\flowscope-data\flowscope.db` |

If `D:\tmp` doesn't exist, it will be created automatically.

### Manual Install
```cmd
mkdir D:\tmp\flowscope
copy flowscope.exe D:\tmp\flowscope\
```

### Commands
```cmd
# Start web server
flowscope --serve --port 3000 --watch D:\tmp\flowscope-data

# Analyze single file
flowscope analyze D:\tmp\flowscope-data\query.sql

# Help
flowscope --help
```

### Web UI
Open http://localhost:3000 in browser after starting serve mode.

## Build from Source

```bash
# Prerequisites: Rust 1.82+, Node.js 18+
cargo build -p flowscope-cli --features serve --release
```
