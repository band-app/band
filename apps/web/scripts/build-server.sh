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

# Copy node-pty native module
mkdir -p dist/node_modules/node-pty/prebuilds
cp node_modules/node-pty/package.json dist/node_modules/node-pty/
cp -R node_modules/node-pty/lib dist/node_modules/node-pty/
cp -RL node_modules/node-pty/prebuilds/* dist/node_modules/node-pty/prebuilds/
chmod +x dist/node_modules/node-pty/prebuilds/*/spawn-helper 2>/dev/null || true

# Copy better-sqlite3 native module
mkdir -p dist/node_modules/better-sqlite3/build/Release
cp node_modules/better-sqlite3/package.json dist/node_modules/better-sqlite3/
cp -R node_modules/better-sqlite3/lib dist/node_modules/better-sqlite3/
cp -RL node_modules/better-sqlite3/build/Release/better_sqlite3.node dist/node_modules/better-sqlite3/build/Release/

# Copy Drizzle migrations
rm -rf dist/migrations
cp -R src/lib/db/migrations dist/migrations
