# Contributing to Capybara

Thank you for your interest in contributing to Capybara! This document provides guidelines and instructions for setting up your development environment and contributing to the project.

## Development Setup

### Prerequisites

- Rust (latest stable) - Install via [rustup](https://rustup.rs/)
- Node.js >= 18.0.0
- Yarn >= 1.22.0
- wasm-pack - Install via `cargo install wasm-pack`

### Initial Setup

1. Clone the repository:
```bash
git clone https://github.com/keaidada/flowscope.git
cd capybara
```

2. Install dependencies:
```bash
yarn install
```

3. Build the project:
```bash
just build
```

4. Run tests:
```bash
just test
```

## Project Structure

Capybara is organized as a monorepo with the following structure:

- `crates/` - Rust workspace
  - `capybara-core/` - Core lineage engine
  - `capybara-wasm/` - WASM bindings
  - `capybara-cli/` - CLI wrapper
  - `capybara-export/` - Export helpers
- `packages/` - NPM workspace
  - `core/` - TypeScript wrapper (@pondpilot/capybara-core)
  - `react/` - React components (@pondpilot/capybara-react)
- `app/` - Demo Vite application
- `vscode/` - VS Code extension + webview UI
- `docs/` - Documentation

## Development Workflow

### Making Changes

1. Create a new branch:
```bash
git checkout -b feature/your-feature-name
```

2. Make your changes
3. Run tests:
```bash
just test
```

4. Run linters:
```bash
just check
```

5. Format code:
```bash
just fmt
```

6. Keep docs in sync:
```bash
# See docs/README.md for canonical references.
```

### Running the Demo

```bash
just dev
```

## Code Style

### Rust
- Follow standard Rust conventions
- Run `cargo fmt` before committing
- Run `cargo clippy` and address warnings

### TypeScript
- Use strict TypeScript
- Single quotes for strings
- Trailing commas in multiline structures
- Run `just fmt` before committing

## Code Generation

- Dialect semantic specs in `crates/capybara-core/specs/dialect-semantics/` are compiled into `crates/capybara-core/src/generated/` by `build.rs`.
- API schema snapshots live in `docs/api_schema.json` and can be refreshed with `just update-schema`.

## Testing

- Write unit tests for all new functionality
- Ensure all tests pass before submitting a PR
- Add integration tests for complex features
- Test fixtures should be added to `crates/capybara-core/tests/fixtures/`

## Pull Request Process

1. Update documentation for any new features
2. Add tests for your changes
3. Ensure all tests pass
4. Update CHANGELOG.md if applicable
5. Submit PR with a clear description of changes
6. Address review feedback

## Reporting Issues

When reporting issues, please include:

- Capybara version
- Operating system
- Node.js and Rust versions
- Steps to reproduce
- Expected vs actual behavior
- Any error messages or logs

## License

By contributing to Capybara, you agree that your contributions will be licensed under the Apache 2.0 License.

## Questions?

Feel free to open an issue for questions or join our discussions!
