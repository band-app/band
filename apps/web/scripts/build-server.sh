#!/usr/bin/env bash
set -euo pipefail

# Bundle the server entry point
esbuild start-server.ts \
  --bundle \
  --platform=node \
  --format=esm \
  --outfile=dist/start-server.mjs \
  --external:./server/server.js \
  --external:node-pty \
  --external:better-sqlite3 \
  --banner:js="import{createRequire}from'module';import{fileURLToPath as __fu}from'url';import{dirname as __dn}from'path';const require=createRequire(import.meta.url);const __filename=__fu(import.meta.url);const __dirname=__dn(__filename);"

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
fi

# Copy Drizzle migrations
rm -rf dist/migrations
cp -R src/lib/db/migrations dist/migrations
