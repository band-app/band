# Band

IDE-agnostic agent orchestrator — dashboard + VS Code extension. A desktop app for managing AI coding agents across multiple workspaces and projects, with a built-in code editor, terminal, chat, LSP support, and a CLI for programmatic control.

```
┌──────────────────────────────────────────┐
│  Dashboard (Tauri v2 + React 19)         │
│  - Project & workspace management        │
│  - Code editor (CodeMirror 6 + LSP)      │
│  - Integrated terminal & chat            │
│  - Agent status overview                 │
│  - Window management (focus, positioning)│
└──────────────┬───────────────────────────┘
               │
       Web Server (Node.js)
   (data, state, git, LSP, agents)
        http://localhost:3456
               │
       ┌───────┴───────┐
       ▼               ▼
  ┌─────────┐    ┌─────────┐
  │ VS Code │    │  Band   │
  │  Ext.   │    │   CLI   │
  └────┬────┘    └─────────┘
       ▼
   AI Agent (claude, cursor, etc.)
```

## Project Structure

```
apps/
  dashboard/          Tauri v2 desktop app (Rust backend + React frontend)
  web/                Node.js web server (tRPC, git ops, LSP, coding agents)
  cli/                Band CLI (Rust) — programmatic workspace management
  website/            Marketing website (Astro)
extensions/
  vscode/             VS Code extension
packages/
  dashboard-core/     Shared dashboard UI (CodeMirror, components)
  coding-agent/       Coding agent integration
  logger/             Shared logging (pino)
  ui/                 Shared UI components
```

## Prerequisites

- [Node.js](https://nodejs.org) v22+
- [pnpm](https://pnpm.io) v10+
- [Rust](https://rustup.rs) (for Tauri dashboard and CLI)
- macOS (dashboard uses native window management)

### Install Rust (if not already installed)

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

## Setup

```bash
# Clone and install dependencies
git clone <repo-url>
cd band
pnpm install
```

## Running the Dashboard

### Development

```bash
# From the repo root:
pnpm dev:dashboard

# Or from the dashboard directory:
cd apps/dashboard
pnpm tauri dev
```

This builds the CLI and web server, then starts the Tauri app. Hot-reloading is enabled for the React frontend and Rust backend.

### Production Build

```bash
pnpm build:dashboard
```

This produces a `.dmg` installer at `apps/dashboard/src-tauri/target/release/bundle/dmg/`.

## Web Server

The web server (`apps/web`) is the backend for the dashboard. It handles:

- **Git operations** — diff, commit, branch management via tRPC
- **LSP** — spawns and proxies language servers (TypeScript, etc.) over WebSocket
- **Coding agents** — manages agent sessions and task execution
- **File serving** — serves the dashboard frontend

```bash
# Development:
pnpm dev:web

# Build:
pnpm build:web
```

The server runs on `http://localhost:3456` by default (configurable via `PORT` env var). It is started automatically by the Tauri dashboard in production.

## Band CLI

The CLI is a thin client for the web server, used for programmatic workspace management:

```bash
band projects list              # List registered projects
band workspaces list            # List workspaces
band workspaces create          # Create a new workspace (git worktree)
band tasks list                 # List coding agent tasks
band tunnels start              # Start a tunnel
band settings                   # View settings
```

All state and operations happen server-side. The CLI connects to the running Band server.

## VS Code Extension

### Build

```bash
pnpm build:extension

# Or from the extension directory:
cd extensions/vscode
pnpm build
```

### Install in VS Code

1. Build the extension
2. Open VS Code
3. Run `Extensions: Install from VSIX...` from the command palette (if packaged) **or** for development:

```bash
cd extensions/vscode
code --extensionDevelopmentPath="$(pwd)"
```

### How the Extension Works

The extension activates when it detects a `.band/config.yaml` in the workspace. It then:

1. Sets up the editor layout (splits) based on config
2. Creates terminals and runs configured commands (dev server, AI agent)
3. Opens Simple Browser for preview URLs
4. Monitors terminal output for agent status changes
5. Writes status to `~/.band/status/{workspaceId}.json`

## Development

### Lint & Format

```bash
# Check
pnpm check

# Fix
pnpm lint:fix
pnpm format:fix
```

### Testing

```bash
pnpm test
```

This project uses integration tests as the primary testing approach — see `CLAUDE.md` for the testing strategy.

### Dashboard (Tauri + React)

```bash
cd apps/dashboard

# Full Tauri dev (frontend + Rust backend + native window):
pnpm tauri dev

# Check Rust compilation:
cd src-tauri && cargo check
```

### VS Code Extension

```bash
cd extensions/vscode

# Build once:
pnpm build

# Watch mode (rebuilds on file change):
pnpm watch

# Test in VS Code:
code --extensionDevelopmentPath="$(pwd)"
```

### Adding a New IDE Extension

To add support for another IDE (IntelliJ, Xcode, etc.):

1. Create a new directory under `extensions/`
2. On workspace open, read `.band/config.yaml`
3. Monitor agent terminal output using the patterns from config
4. Write status JSON to `~/.band/status/{workspaceId}.json`
5. Clean up the status file when the workspace closes

The dashboard will automatically pick up status from any IDE that writes to `~/.band/status/`.
