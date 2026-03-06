# Band





IDE-agnostic agent orchestrator. A central dashboard for managing AI coding agents across multiple workspaces and projects, with IDE extensions that report agent status in real time.

```
┌─────────────────────────────────────┐
│  Dashboard (Tauri + React)          │
│  - Project & worktree management    │
│  - Agent status overview            │
│  - Click to launch/focus IDE        │
│  - Watches ~/.band/status/*.json    │
└──────────────┬──────────────────────┘
               │
    Shared Status Protocol
  (~/.band/status/{workspaceId}.json)
               │
       ┌───────┴───────┐
       ▼               ▼
  ┌─────────┐    ┌─────────┐
  │ VS Code │    │ (future │
  │  Ext.   │    │  IDEs)  │
  └────┬────┘    └─────────┘
       ▼
   AI Agent (claude, cursor, etc.)
```

## Project Structure

```
apps/
  dashboard/          Tauri + React desktop app
    src/              React frontend (TailwindCSS v4, Zustand)
    src-tauri/        Rust backend (git ops, file watcher, process spawning)
extensions/
  vscode/             VS Code extension
    src/              TypeScript source
packages/
  shared/             Shared TypeScript types (status protocol)
```

## Prerequisites

- [Node.js](https://nodejs.org) v18+
- [pnpm](https://pnpm.io) v9+
- [Rust](https://rustup.rs) (for Tauri dashboard)
- macOS (dashboard uses AppleScript for window focus)

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

This starts the Vite dev server on `http://localhost:1420` and opens the Tauri window. Hot-reloading is enabled for both the React frontend and Rust backend.

### Production Build

```bash
pnpm build:dashboard
```

This produces a `.dmg` installer at `apps/dashboard/src-tauri/target/release/bundle/dmg/`.

## Running the VS Code Extension

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
# Launch a new VS Code window with the extension loaded:
code --extensionDevelopmentPath="$(pwd)"
```

### How the Extension Works

The extension activates when it detects a `.band/config.yaml` in the workspace. It then:

1. Sets up the editor layout (splits) based on config
2. Creates terminals and runs configured commands (dev server, AI agent)
3. Opens Simple Browser for preview URLs
4. Monitors terminal output for agent status changes
5. Writes status to `~/.band/status/{workspaceId}.json`

## Usage

### 1. Register a Project

Open the dashboard and click **"+ New"**. Browse to a git repository or paste its path. This registers the repo and discovers existing worktrees.

### 2. Create a Workspace

Click **"+ workspace"** next to a project name. Enter a branch name and optionally a base branch. This creates a new git worktree at `~/.band/worktrees/{project}/{branch}/`.

### 3. Open in VS Code

Click any workspace row in the dashboard. This opens VS Code at the worktree path. If the worktree has a `.band/config.yaml`, the VS Code extension will automatically set up terminals, browser, and start monitoring.

### 4. Monitor Agent Status

Once an AI agent is running in a monitored terminal, the VS Code extension detects status changes and writes them to `~/.band/status/`. The dashboard watches this directory and updates in real time:

| Status | Icon | Meaning |
|--------|------|---------|
| idle | − | No agent activity |
| working | ● | Agent is actively processing |
| needs_input | ⚠ | Agent is waiting for user input |
| done | ✓ | Agent finished its task |
| error | ✗ | Agent encountered an error |

## Workspace Config

Create a `.band/config.yaml` in any worktree to configure the VS Code extension:

```yaml
workspaceId: "my-app-feature-auth"
project: "my-app"

layout:
  orientation: horizontal
  groups:
    - size: 0.6               # left: code editing
    - size: 0.4               # right: browser preview
      browser:
        url: "http://localhost:3000"
        pinned: true

terminals:
  - name: "dev server"
    command: "pnpm dev"
  - name: "claude"
    command: "claude"
    monitor: true             # enable agent status detection

agent:
  name: "claude-code"
  patterns:                   # regex patterns for status detection
    working: "\\b(Thinking|Reading|Writing|Searching)\\b"
    needs_input: "\\b(Y/n|yes/no|approve|deny|permission)\\b"
    error: "\\b(Error|Failed|error:)\\b"
    done: "\\b(Done|Completed|finished)\\b"
```

## Shared Status Protocol

IDE extensions communicate with the dashboard via JSON files in `~/.band/status/`:

```
~/.band/
  state.json              # Registered projects and worktrees
  status/                 # Agent status files (one per workspace)
    {workspaceId}.json
```

Each status file:

```json
{
  "workspaceId": "my-app-feature-auth",
  "project": "my-app",
  "branch": "feature-auth",
  "worktreePath": "/Users/you/.band/worktrees/my-app/feature-auth",
  "ide": "vscode",
  "pid": 12345,
  "agent": {
    "name": "claude-code",
    "status": "working",
    "lastActivity": "2026-03-03T10:30:00Z",
    "summary": "Reading src/auth.ts"
  }
}
```

Any IDE extension can write to this directory using the same schema. The dashboard watches it with a file system watcher and emits real-time events to the React frontend.

## Development

### Dashboard (Tauri + React)

```bash
cd apps/dashboard

# Frontend dev server only (no Tauri window):
pnpm dev

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
