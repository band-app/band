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
  --external:better-sqlite3 \
  --banner:js="import{createRequire as __cr}from'module';import{fileURLToPath as __fu}from'url';import{dirname as __dn}from'path';const require=__cr(import.meta.url);const __filename=__fu(import.meta.url);const __dirname=__dn(__filename);"

# Copy native modules into dist/ for self-contained builds (Tauri app).
# When building for npm publish, skip this — npm consumers install native
# modules as regular dependencies.
if [ "${NPM_PUBLISH:-}" != "1" ]; then
  # Copy node-pty native module (only current platform prebuilds, no debug symbols)
  mkdir -p dist/node_modules/node-pty/prebuilds
  cp -RL node_modules/node-pty/package.json dist/node_modules/node-pty/
  cp -RL node_modules/node-pty/lib dist/node_modules/node-pty/
  PTY_PREBUILDS="$(cd node_modules/node-pty/prebuilds && pwd -P)"
  PLATFORM="$(uname -s | tr '[:upper:]' '[:lower:]')"
  case "$PLATFORM" in
    darwin) PREBUILD_GLOB="darwin-*" ;;
    linux)  PREBUILD_GLOB="linux-*" ;;
    *)      PREBUILD_GLOB="*" ;;
  esac
  for dir in "$PTY_PREBUILDS"/$PREBUILD_GLOB; do
    [ -d "$dir" ] || continue
    target="dist/node_modules/node-pty/prebuilds/$(basename "$dir")"
    mkdir -p "$target"
    find "$dir" -maxdepth 1 -type f ! -name '*.pdb' -exec cp {} "$target/" \;
  done
  chmod +x dist/node_modules/node-pty/prebuilds/*/spawn-helper 2>/dev/null || true

  # Copy better-sqlite3 native module and its dependencies
  mkdir -p dist/node_modules/better-sqlite3/build/Release
  cp node_modules/better-sqlite3/package.json dist/node_modules/better-sqlite3/
  cp -R node_modules/better-sqlite3/lib dist/node_modules/better-sqlite3/
  cp -RL node_modules/better-sqlite3/build/Release/better_sqlite3.node dist/node_modules/better-sqlite3/build/Release/

  # better-sqlite3 uses 'bindings' (+ file-uri-to-path) to locate .node at runtime
  SQLITE_REAL="$(cd node_modules/better-sqlite3 && pwd -P)"
  SQLITE_PEERS="$(dirname "$SQLITE_REAL")"
  BINDINGS_REAL="$(cd "$SQLITE_PEERS/bindings" && pwd -P)"
  BINDINGS_PEERS="$(dirname "$BINDINGS_REAL")"
  mkdir -p dist/node_modules/bindings
  cp -RL "$BINDINGS_REAL"/* dist/node_modules/bindings/
  mkdir -p dist/node_modules/file-uri-to-path
  cp -RL "$BINDINGS_PEERS/file-uri-to-path"/* dist/node_modules/file-uri-to-path/

  # Resolve the monorepo root (where the pnpm store lives).
  # The SDK packages below are deps of packages/coding-agent, not apps/web,
  # so they only exist in the root node_modules/.pnpm store.
  MONO_ROOT="$(cd ../.. && pwd)"

  # Copy claude-agent-sdk CLI script.
  # The SDK resolves cli.js via join(dirname(import.meta.url), "..", "cli.js").
  # After esbuild bundling import.meta.url points to dist/start-server.mjs,
  # so the SDK looks for dist/cli.js.
  CLAUDE_SDK_CLI="$(find "$MONO_ROOT/node_modules/.pnpm" -path "*/@anthropic-ai/claude-agent-sdk/cli.js" -type f 2>/dev/null | head -1)"
  if [ -n "$CLAUDE_SDK_CLI" ]; then
    cp "$CLAUDE_SDK_CLI" dist/cli.js
  fi

  # Copy Codex CLI platform binary.
  # The Codex SDK uses createRequire(import.meta.url).resolve("@openai/codex/package.json")
  # which resolves from dist/, so we mirror the package structure in dist/node_modules/.
  CODEX_PKG_DIR="$(find "$MONO_ROOT/node_modules/.pnpm" -path "*/@openai/codex/package.json" -type f 2>/dev/null | head -1)"
  if [ -n "$CODEX_PKG_DIR" ]; then
    CODEX_DIR="$(dirname "$CODEX_PKG_DIR")"
    CODEX_PEERS="$(dirname "$CODEX_DIR")"
    mkdir -p dist/node_modules/@openai/codex
    cp "$CODEX_PKG_DIR" dist/node_modules/@openai/codex/
    # Copy platform-specific binary package (e.g. @openai/codex-darwin-arm64)
    for platform_dir in "$CODEX_PEERS"/codex-"$PLATFORM"-*; do
      [ -d "$platform_dir" ] || continue
      pkg_name="$(basename "$platform_dir")"
      mkdir -p "dist/node_modules/@openai/$pkg_name"
      cp -RL "$platform_dir"/* "dist/node_modules/@openai/$pkg_name/"
    done
  fi
fi

# Copy Drizzle migrations
rm -rf dist/migrations
cp -R src/lib/db/migrations dist/migrations
