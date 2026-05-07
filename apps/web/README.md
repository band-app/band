# @band-app/server

Web server + dashboard frontend for Band. Provides the tRPC API, WebSocket layer, and bundled UI consumed by the Electron desktop app and (optionally) standalone npm consumers.

## Runtime: Node.js 22.5+

This package runs under [Node.js](https://nodejs.org) v22.5 or newer. The shebang on `bin/band-server.mjs` is `#!/usr/bin/env node`.

```bash
# Run the server
band-server
# or:
node dist/start-server.mjs
```

## SQLite via `node:sqlite`

SQLite is provided by Node's built-in [`node:sqlite`](https://nodejs.org/api/sqlite.html) module — no native module ships in the bundle. This eliminates the `NODE_MODULE_VERSION` ABI mismatch that affects packages like `better-sqlite3`: whatever Node the user runs supplies `node:sqlite` directly, so the binary always matches the runtime.

`node:sqlite` is at **Stability 1.2 — Release Candidate** in current Node, available unflagged since 22.13.0. The API has been stable across Node 22.5 → 23.x → 24.x. The startup `ExperimentalWarning` can be silenced with `NODE_OPTIONS='--no-warnings=ExperimentalWarning'` (the test and e2e scripts in `package.json` already do this).

We were briefly on `bun:sqlite` (PR #353) to dodge the same ABI problem, but Bun's `node:http` shim doesn't fire `upgrade` events on `httpServer.on("upgrade", …)`, breaking tRPC subscription, terminal, and LSP WebSockets ([oven-sh/bun#18945](https://github.com/oven-sh/bun/issues/18945), [#5951](https://github.com/oven-sh/bun/issues/5951), [#24107](https://github.com/oven-sh/bun/issues/24107)). `node:sqlite` gets us the same ABI-stability win without changing the JS runtime.

## Install

Node v22.5+ must be on `PATH` first.

```bash
# 1. Install Node.js 22.5+ (https://nodejs.org)

# 2. Install the package
npm i -g @band-app/server     # or: pnpm add -g

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
pnpm dev:web          # vite dev (Node runtime, in-process)
pnpm --filter @band-app/server build
pnpm --filter @band-app/server test    # vitest under Node
```

The vitest suite, the production bundle (`dist/start-server.mjs`), and the Playwright e2e helper all run under Node.

## Bundle layout (`dist/`)

```
dist/
├── start-server.mjs           # esbuild bundle, entry point
├── client/                    # built dashboard frontend (vite)
├── server/                    # SSR server bundle
├── migrations/                # drizzle SQL migrations
├── openapi.json               # generated tRPC OpenAPI spec
└── node_modules/              # only externalized native deps + helpers
    ├── node-pty/              # native PTY (.node + spawn-helper, NAPI — ABI-stable)
    ├── typescript/
    ├── typescript-language-server/
    └── @openai/codex/         # Codex SDK package.json (codex CLI is system-installed)
```

No SQLite native module ships in the bundle.
