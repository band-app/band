# @band-app/server

Web server + dashboard frontend for Band. Provides the tRPC API, WebSocket layer, and bundled UI consumed by the Tauri desktop app and (optionally) standalone npm consumers.

## Runtime: Bun (required)

This package requires the [Bun](https://bun.sh) runtime — not Node.js.

```bash
# Install Bun
curl -fsSL https://bun.sh/install | bash

# Run the server
band-server
# or:
bun dist/start-server.mjs
```

### Why Bun

- **`bun:sqlite`** — built-in, eliminates the `better-sqlite3` native module and its `NODE_MODULE_VERSION` ABI mismatch (the bundled `.node` was built against one Node version, the user's `node` may be a different one → `ERR_DLOPEN_FAILED`).
- **Stable N-API ABI** — `node-pty` and other native deps load cleanly across Bun patch versions.
- **Single binary** — the desktop app ships its own Bun at `Band.app/Contents/MacOS/bun`, so end-users of the desktop app don't need Bun (or anything else) installed.

### Node.js is *not* supported

The shebang on `bin/band-server.mjs` is `#!/usr/bin/env bun`. Running under Node throws at module load (`Cannot find package 'bun:sqlite'`).

## Install

Bun must be on `PATH` first — the `band-server` shebang is `#!/usr/bin/env bun`. Without it you'll see `env: bun: No such file or directory`.

```bash
# 1. Install Bun
curl -fsSL https://bun.sh/install | bash

# 2. Install the package
npm i -g @band-app/server     # or: pnpm add -g, bun add -g

# 3. Run
band-server                   # starts on PORT (default 3456)
```

Environment:

| Var | Default | Notes |
|---|---|---|
| `PORT` | `3456` | TCP port to bind |
| `HOME/.band` | — | State directory (sqlite db, settings, logs) |

## Development

```bash
pnpm install          # at repo root
pnpm dev:web          # vite dev (Bun runtime, in-process)
pnpm --filter @band-app/server build
pnpm --filter @band-app/server test    # vitest under Node
```

Dev runs vite under Bun (`bun --bun vite dev`) so SSR module evaluation can resolve `bun:sqlite`. Tests run vitest under Node and use `better-sqlite3` directly (kept as a devDependency). The production bundle (`dist/start-server.mjs`) uses `bun:sqlite` and runs under Bun.

`tests/sync-state.test.ts` is excluded from vitest because it imports `src/lib/db/connection.ts` which statically imports `bun:sqlite`. Re-enable when the suite migrates to `bun test`.

## Bundle layout (`dist/`)

```
dist/
├── start-server.mjs           # esbuild bundle, entry point
├── client/                    # built dashboard frontend (vite)
├── server/                    # SSR server bundle
├── migrations/                # drizzle SQL migrations
├── openapi.json               # generated tRPC OpenAPI spec
└── node_modules/              # only externalized native deps + helpers
    ├── node-pty/              # native PTY (.node + spawn-helper)
    ├── typescript/
    ├── typescript-language-server/
    ├── @anthropic-ai/         # Claude Agent SDK platform binary
    └── @openai/codex/         # Codex SDK package.json (codex CLI is system-installed)
```

No `better-sqlite3` ships in the bundle — SQLite is `bun:sqlite`.
