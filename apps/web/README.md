# @band-app/server

Web server + dashboard frontend for Band. Provides the tRPC API, WebSocket layer, and bundled UI consumed by the Tauri desktop app and (optionally) standalone npm consumers.

## Runtime: Node.js

This package runs under [Node.js](https://nodejs.org) v22+. The shebang on `bin/band-server.mjs` is `#!/usr/bin/env node`.

```bash
# Run the server
band-server
# or:
node dist/start-server.mjs
```

### `better-sqlite3` and the NODE_MODULE_VERSION risk (interim)

SQLite is provided by the [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3) native module. The `.node` binary shipped inside the bundle is built against the Node version used during `pnpm install`. At runtime, the host `node` must match that ABI; if it doesn't, `require("better-sqlite3")` fails with `ERR_DLOPEN_FAILED` / "was compiled against a different Node.js version".

This is a known interim trade-off. We previously experimented with bundling [Bun](https://bun.sh) + `bun:sqlite` to avoid the ABI mismatch, but Bun's `node:http` shim does not fire `upgrade` events on `httpServer.on("upgrade", …)` (see [oven-sh/bun#18945](https://github.com/oven-sh/bun/issues/18945), [#5951](https://github.com/oven-sh/bun/issues/5951), [#24107](https://github.com/oven-sh/bun/issues/24107)), which silently breaks our tRPC subscription, terminal, and LSP WebSockets.

The planned [Electron migration](#) replaces the host-Node dependency with an embedded runtime whose ABI we control. Until then, the desktop app expects a system `node` on `PATH`.

## Install

Node v22+ must be on `PATH` first.

```bash
# 1. Install Node.js 22+ (https://nodejs.org)

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
    ├── node-pty/              # native PTY (.node + spawn-helper)
    ├── better-sqlite3/        # native SQLite (.node)
    ├── bindings/              # better-sqlite3 .node loader
    ├── file-uri-to-path/      # bindings dependency
    ├── typescript/
    ├── typescript-language-server/
    └── @openai/codex/         # Codex SDK package.json (codex CLI is system-installed)
```
