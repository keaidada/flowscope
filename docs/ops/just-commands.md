# just 命令速查

## 安装 & 初始化

| 命令 | 说明 |
|------|------|
| `just install` | 安装 Node 依赖 (`yarn install`) |
| `just install-rust-tools` | 安装 wasm-pack、cargo-watch、cargo-llvm-cov |
| `just install-hooks` | 安装 pre-commit hooks |
| `just setup` | 全量初始化（依赖 + 工具 + hooks + 构建） |

## 构建

| 命令 | 说明 |
|------|------|
| `just build` | 构建 WASM + TypeScript 包 |
| `just build-wasm` | 构建 WASM（release，含 wasm-opt） |
| `just build-wasm-dev` | 构建 WASM（dev，跳过 wasm-opt，快速迭代） |
| `just build-ts` | 构建 TypeScript 包（core + react + webview） |
| `just build-rust` | 构建 Rust workspace（debug） |
| `just build-rust-release` | 构建 Rust workspace（release） |
| `just build-cli` | 构建 CLI（release） |
| `just build-cli-serve` | 构建 CLI + 嵌入前端（release） |
| `just build-cli-serve-debug` | 构建 CLI + 嵌入前端（debug） |

## 开发

| 命令 | 说明 |
|------|------|
| `just dev` | 启动 Vite Dev Server (:5173) |
| `just run` | 构建 WASM(dev) + TS + 启动 dev server |
| `just cli -- <args>` | 运行 CLI（debug） |
| `just cli-release -- <args>` | 运行 CLI（release） |
| `just watch` | 监听 Rust 变更自动重建 |
| `just watch-test` | 监听变更自动运行测试 |
| `just watch-lineage` | 监听变更运行血缘测试 |

## 测试

| 命令 | 说明 |
|------|------|
| `just test` | 运行全部测试（Rust + TS） |
| `just test-rust` | `cargo test --workspace` |
| `just test-rust-release` | `cargo test --workspace --release` |
| `just test-ts` | `yarn workspaces run test` |
| `just test-core` | `cargo test -p capybara-core` |
| `just test-cli` | `cargo test -p capybara-cli` |
| `just test-cli-serve` | CLI serve 模式测试（含构建 app） |
| `just test-lineage` | 血缘引擎测试 |
| `just test-lineage-verbose` | 血缘测试（含输出） |
| `just test-lineage-filter <PATTERN>` | 按名称过滤血缘测试 |

## 质量检查

| 命令 | 说明 |
|------|------|
| `just lint` | Rust + TS lint |
| `just lint-rust` | `cargo clippy --workspace -- -D warnings` |
| `just lint-ts` | `yarn workspaces run lint` |
| `just lint-fix` | 自动修复 TS lint |
| `just typecheck` | TS 类型检查 |
| `just fmt` | 格式化（Rust + TS） |
| `just fmt-rust` | `cargo fmt --all` |
| `just fmt-ts` | Prettier 格式化 |
| `just fmt-check-rust` | 检查 Rust 格式 |
| `just fmt-check-ts` | 检查 TS 格式 |
| `just check` | 格式检查 + lint + typecheck + 测试 + schema |
| `just check-all` | 全量检查（Rust + TS + schema） |
| `just check-schema` | API schema 一致性检查 |
| `just check-generated` | 验证生成代码已提交 |

## 覆盖率

| 命令 | 说明 |
|------|------|
| `just coverage` | 生成 HTML 覆盖率报告 |
| `just coverage-lcov` | 生成 LCOV（CI/Codecov 用） |
| `just coverage-summary` | 打印覆盖率摘要 |

## 部署

| 命令 | 说明 |
|------|------|
| `just deploy` | 构建 + 部署到 Cloudflare Pages |
| `just sync-cli-serve-assets` | 同步前端到 CLI 嵌入目录 |

## 数据库 & Schema

| 命令 | 说明 |
|------|------|
| `just update-schema` | 重新生成 API schema 快照 |

## 清理

| 命令 | 说明 |
|------|------|
| `just clean` | cargo clean + 删除 node_modules |

## CLI Serve 模式常用操作

```bash
# 构建带嵌入式前端的 CLI
just build-cli-serve

# 启动服务
./target/release/capybara --serve --port 3000 --watch ./app

# 后台运行
nohup ./target/release/capybara --serve --port 3000 --watch ./app \
    > /tmp/capybara-logs/serve.log 2>&1 &

# 验证
curl http://127.0.0.1:3000/api/health
```

## 开发模式常用操作

```bash
# 首次：构建 WASM + TS
just build-wasm-dev && just build-ts

# 启动前端
just dev

# 启动后端（另一终端）
cargo build -p capybara-cli --features serve
./target/debug/capybara --serve --port 3000 --watch ./app

# 验证
curl -o /dev/null -w "前端: %{http_code}\n" http://localhost:5173/
curl http://127.0.0.1:3000/api/health
```
