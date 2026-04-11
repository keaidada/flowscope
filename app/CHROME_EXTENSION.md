# FlowScope Chrome Extension

Privacy-first SQL lineage analysis that runs entirely in your browser sidebar.

## Features

- **SQL Lineage Visualization** — Visualize data flows across tables, CTEs, and columns
- **Multi-File Projects** — Organize SQL files into projects and analyze dependencies
- **Privacy First** — All analysis runs locally via WASM. Your SQL never leaves your browser
- **Side Panel** — Runs in Chrome's side panel, always accessible while browsing

## Build

```bash
# From the repository root
cd app
yarn install
yarn build:extension
```

The built extension will be in `app/dist/`.

## Load in Chrome (Developer Mode)

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable **Developer mode** (toggle in top-right corner)
3. Click **Load unpacked**
4. Select the `app/dist/` directory
5. The FlowScope icon will appear in your toolbar
6. Click the icon to open the side panel

## Usage

1. Click the FlowScope icon in Chrome toolbar to open the side panel
2. Import SQL files or paste SQL directly
3. Click "Run" to analyze and visualize lineage
4. Use the Lineage, Hierarchy, Matrix, and Schema tabs to explore results

## Architecture

- **Side Panel** — Full FlowScope app runs in Chrome's side panel
- **WASM Engine** — SQL analysis powered by Rust compiled to WebAssembly
- **Web Workers** — WASM runs in a Web Worker to keep the UI responsive
- **IndexedDB** — Projects and files are persisted locally
