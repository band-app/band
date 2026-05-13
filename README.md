# Band

IDE-agnostic agent orchestrator. A desktop app for managing AI coding agents across multiple workspaces and projects, with a built-in code editor, terminal, chat, LSP support, and a CLI for programmatic control.

```
┌──────────────────────────────────────────┐
│  Desktop App (Electron + React 19)       │
│  - Project & workspace management        │
│  - Code editor (CodeMirror 6 + LSP)      │
│  - Integrated terminal & chat            │
│  - Agent status overview                 │
└──────────────┬───────────────────────────┘
               │
       Web Server (Node.js)
   (data, state, git, LSP, agents)
        http://localhost:3456
               │
               ▼
         ┌─────────┐
         │  Band   │
         │   CLI   │
         └─────────┘
               │
               ▼
   AI Agent (claude, cursor, etc.)
```

## Install

### Stable

Download the latest signed `.dmg` from [GitHub Releases](https://github.com/band-app/band/releases/latest), open it, and drag **Band** to `/Applications`. First launch should open without Gatekeeper warnings — releases are signed and notarized with an Apple Developer ID.

Auto-update is built in (via `electron-updater`): the app checks daily and prompts before installing.

The desktop app is fully self-contained — it ships its own Node.js runtime (Electron's bundled Node 22.x) and runs the web server under that. End users do **not** need to install Node.js separately.

### Nightly

Bleeding-edge builds from the `main` branch are published to a single rolling [`nightly` release](https://github.com/band-app/band/releases/tag/nightly) every day at 04:00 UTC. Nightly builds:

- Use a `<version>-nightly.<date>.<sha>` version label so you can see what you're running in **Settings → About**.
- Are **not** wired to the stable updater channel — you must download new nightlies manually.
- May be unstable. Use for testing pre-release features only.

### Build from source (unsigned)

```bash
pnpm install
pnpm build:desktop
open apps/desktop/dist-builder/*.dmg
```

Local builds are unsigned — see [CONTRIBUTING.md](CONTRIBUTING.md#building-locally-vs-signed-releases) for how macOS handles them.

## Project Structure

```
apps/
  desktop/            Electron desktop shell (main + preload + electron-builder)
  web/                Node.js web server (tRPC, git ops, LSP, coding agents) + React renderer
  cli/                Band CLI (Rust) — programmatic workspace management
  website/            Marketing website (Astro)
packages/
  dashboard-core/     Shared dashboard UI (CodeMirror, components)
  coding-agent/       Coding agent integration
  logger/             Shared logging (pino)
  ui/                 Shared UI components
```

## Prerequisites

The packaged desktop app ships its own Node runtime via Electron, so end users only need macOS. The prerequisites below apply when **building from source**.

- [Node.js](https://nodejs.org) v22.5+ — required to drive `pnpm install`, run the test suite, and build the web bundle (we use the built-in `node:sqlite` module)
- [pnpm](https://pnpm.io) v10+
- [Rust](https://rustup.rs) (for the CLI)
- macOS

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

## Running the Desktop App

### Development

```bash
# From the repo root:
pnpm dev:desktop
```

This builds the CLI and web server, then starts the Electron app. Hot-reloading is enabled for the React frontend (via Vite); the main and preload bundles are watched by `tsc --watch` and Electron is restarted whenever they change.

### Production Build

```bash
pnpm build:desktop
```

Produces a `.dmg` (and `.zip` for `electron-updater` diff downloads) at `apps/desktop/dist-builder/`.

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

The server runs on `http://localhost:3456` by default (configurable via `PORT` env var). It is started automatically by the Electron desktop app in production.

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

### Desktop Shell (Electron + TypeScript)

```bash
cd apps/desktop

# Compile main + preload bundles:
pnpm build

# Run the Electron app against an already-running web server:
pnpm dev
```
