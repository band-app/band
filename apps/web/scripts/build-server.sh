#!/usr/bin/env bash
set -euo pipefail

# Generate OpenAPI spec from tRPC router (static TypeScript analysis)
mkdir -p dist
pnpm exec trpc-openapi ./src/trpc/router.ts -o dist/openapi.json --title "Band API" --version "1.0.0"

# Bundle the server entry point
esbuild start-server.ts \
  --bundle \
  --platform=node \
  --format=esm \
  --outfile=dist/start-server.mjs \
  --external:./server/server.js \
  --external:node-pty \
  --banner:js="import{createRequire as __cr}from'module';import{fileURLToPath as __fu}from'url';import{dirname as __dn}from'path';const require=__cr(import.meta.url);const __filename=__fu(import.meta.url);const __dirname=__dn(__filename);"

# Copy native modules into dist/ for self-contained builds (Tauri app).
# When building for npm publish, skip this — npm consumers install native
# modules as regular dependencies.
if [ "${NPM_PUBLISH:-}" != "1" ]; then
  # Clean stale native modules from previous builds
  rm -rf dist/node_modules

  # Copy node-pty native module.
  # node-pty resolves its .node binary via: build/Release, build/Debug,
  # then prebuilds/<platform>-<arch> (see lib/utils.js).
  # On macOS/Windows, prebuilt binaries ship under prebuilds/.
  # On Linux, node-pty compiles from source into build/Release/.
  mkdir -p dist/node_modules/node-pty
  cp -RL node_modules/node-pty/package.json dist/node_modules/node-pty/
  cp -RL node_modules/node-pty/lib dist/node_modules/node-pty/

  PTY_REAL="$(cd node_modules/node-pty && pwd -P)"

  # Copy build/Release if it exists (compiled from source, typical on Linux)
  if [ -d "$PTY_REAL/build/Release" ]; then
    mkdir -p dist/node_modules/node-pty/build/Release
    cp "$PTY_REAL"/build/Release/*.node dist/node_modules/node-pty/build/Release/
  fi

  # Copy platform-specific prebuilds (macOS/Windows ship these)
  if [ -d "$PTY_REAL/prebuilds" ]; then
    mkdir -p dist/node_modules/node-pty/prebuilds
    PLATFORM="$(uname -s | tr '[:upper:]' '[:lower:]')"
    case "$PLATFORM" in
      darwin) PREBUILD_GLOB="darwin-*" ;;
      linux)  PREBUILD_GLOB="linux-*" ;;
      *)      PREBUILD_GLOB="*" ;;
    esac
    for dir in "$PTY_REAL"/prebuilds/$PREBUILD_GLOB; do
      [ -d "$dir" ] || continue
      target="dist/node_modules/node-pty/prebuilds/$(basename "$dir")"
      mkdir -p "$target"
      find "$dir" -maxdepth 1 -type f ! -name '*.pdb' -exec cp {} "$target/" \;
    done
    chmod +x dist/node_modules/node-pty/prebuilds/*/spawn-helper 2>/dev/null || true
  fi

  # SQLite is provided by Node's built-in `node:sqlite` (Stability 1.2 RC,
  # available unflagged since Node 22.13). No native module ships in the
  # bundle for SQLite — the user's `node` binary supplies it.

  # -----------------------------------------------------------------------
  # Bundle typescript-language-server + typescript for LSP support.
  # typescript-language-server's cli.mjs is a self-contained bundle — it
  # only imports Node built-ins at the top level.  It locates tsserver via
  # createRequire(import.meta.url).resolve('typescript'), so typescript
  # must be resolvable from within the package directory.
  # -----------------------------------------------------------------------

  # typescript-language-server package
  TS_LSP_REAL="$(cd node_modules/typescript-language-server && pwd -P)"
  mkdir -p dist/node_modules/typescript-language-server/lib
  cp "$TS_LSP_REAL/package.json" dist/node_modules/typescript-language-server/
  cp "$TS_LSP_REAL/lib/cli.mjs" dist/node_modules/typescript-language-server/lib/
  cp "$TS_LSP_REAL/lib/cli.mjs.map" dist/node_modules/typescript-language-server/lib/ 2>/dev/null || true

  # typescript package — needed by the language server for tsserver
  TS_REAL="$(cd node_modules/typescript && pwd -P)"
  mkdir -p dist/node_modules/typescript/lib
  mkdir -p dist/node_modules/typescript/bin
  cp "$TS_REAL/package.json" dist/node_modules/typescript/
  cp "$TS_REAL/bin/tsserver" dist/node_modules/typescript/bin/
  cp "$TS_REAL/lib/tsserver.js" dist/node_modules/typescript/lib/
  cp "$TS_REAL/lib/_tsserver.js" dist/node_modules/typescript/lib/
  cp "$TS_REAL/lib/typescript.js" dist/node_modules/typescript/lib/

  # .bin shims — simple wrappers that work with any basedir (no hardcoded
  # pnpm-store paths).  The LSP manager adds this directory to PATH.
  mkdir -p dist/node_modules/.bin

  cat > dist/node_modules/.bin/typescript-language-server <<'SHIM'
#!/bin/sh
basedir=$(dirname "$(echo "$0" | sed -e 's,\\,/,g')")
exec node "$basedir/../typescript-language-server/lib/cli.mjs" "$@"
SHIM
  chmod +x dist/node_modules/.bin/typescript-language-server

  cat > dist/node_modules/.bin/tsserver <<'SHIM'
#!/bin/sh
basedir=$(dirname "$(echo "$0" | sed -e 's,\\,/,g')")
exec node "$basedir/../typescript/bin/tsserver" "$@"
SHIM
  chmod +x dist/node_modules/.bin/tsserver

  # Resolve the monorepo root (where the pnpm store lives).
  # The SDK packages below are deps of packages/coding-agent, not apps/web,
  # so they only exist in the root node_modules/.pnpm store.
  MONO_ROOT="$(cd ../.. && pwd)"

  # NOTE: We deliberately do NOT bundle the @anthropic-ai/claude-agent-sdk
  # platform-specific native binary (~206MB on macOS arm64). Bundling it
  # makes the Tauri app balloon to ~300MB. Band users are developers using
  # AI coding agents, so they already have `claude` installed on PATH —
  # the SDK resolves it from there at runtime.

  # Copy Codex SDK package.json so createRequire(import.meta.url).resolve("@openai/codex/package.json")
  # works from dist/. The actual codex CLI binary is expected to be installed on the user's system.
  CODEX_PKG_DIR="$(find "$MONO_ROOT/node_modules/.pnpm" -path "*/@openai/codex/package.json" -type f 2>/dev/null | head -1)"
  if [ -n "$CODEX_PKG_DIR" ]; then
    mkdir -p dist/node_modules/@openai/codex
    cp "$CODEX_PKG_DIR" dist/node_modules/@openai/codex/
  fi
fi

# Copy Drizzle migrations
rm -rf dist/migrations
cp -R src/lib/db/migrations dist/migrations
