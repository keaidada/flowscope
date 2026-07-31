# Architecture Overview

## Component Summary

Capybara is a Rust + TypeScript monorepo with a WASM boundary and optional UI layers.

1. **Core Engine (Rust)**
   - `capybara-core`: SQL parsing and lineage analysis.
   - `capybara-wasm`: WASM bindings exposing JSON APIs.
   - `capybara-export`: Export helpers (DuckDB/SQL text) used by CLI and JS tooling.
   - `capybara-cli`: CLI wrapper around the core engine.

2. **JS/TS Runtime Layer**
   - `@pondpilot/capybara-core`: TypeScript API + WASM loader.

3. **UI & Integrations**
   - `@pondpilot/capybara-react`: React visualization components.
   - `app/`: Demo Vite app.
   - `vscode/`: VS Code extension + webview UI.

## Data Flow

```text
[Host App] --(SQL + schema + options)--> [@pondpilot/capybara-core]
    --(JSON)--> [capybara-wasm]
        --(Rust analysis)--> [capybara-core]
        --(JSON result)--> [@pondpilot/capybara-core]
            --(typed result)--> [Host App / @pondpilot/capybara-react]
```

## Responsibilities

### Core Engine (`capybara-core`)
- Parses SQL with `sqlparser-rs`.
- Produces statement-level lineage graphs and a global graph.
- Emits structured issues for unsupported syntax and partial lineage.
- Uses dialect semantics generated from `crates/capybara-core/specs/dialect-semantics/`.

### WASM Boundary (`capybara-wasm`)
- Bridges JSON request/response payloads.
- Avoids exposing Rust internals to JS consumers.

### TypeScript Wrapper (`@pondpilot/capybara-core`)
- Initializes WASM modules.
- Provides `analyzeSql`, `splitStatements`, and completion APIs.
- Exposes strongly typed results and issue codes.

### UI Layer (`@pondpilot/capybara-react`)
- Renders lineage graphs and diagnostics.
- Consumes typed results without re-running analysis.

## Related Docs

- API shape: `api-types.md`
- Engine behavior: `core-engine-spec.md`
- Workspace layout: `workspace-structure.md`
