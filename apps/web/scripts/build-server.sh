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

  # Copy claude-agent-sdk platform-specific native binary.
  # SDK 0.2.x ships a native `claude` binary per platform via optional
  # dependency packages named @anthropic-ai/claude-agent-sdk-<platform>-<arch>
  # (and -musl on Linux). At runtime the SDK resolves
  #   require.resolve("@anthropic-ai/claude-agent-sdk-<platform>-<arch>/claude")
  # so the platform package directory needs to be present under
  # dist/node_modules/. Copy whichever variants exist for the current
  # platform.
  CLAUDE_SDK_PLATFORM_PKGS=""
  case "$(uname -s)" in
    Darwin)
      case "$(uname -m)" in
        arm64) CLAUDE_SDK_PLATFORM_PKGS="@anthropic-ai/claude-agent-sdk-darwin-arm64" ;;
        x86_64) CLAUDE_SDK_PLATFORM_PKGS="@anthropic-ai/claude-agent-sdk-darwin-x64" ;;
      esac
      ;;
    Linux)
      case "$(uname -m)" in
        aarch64|arm64) CLAUDE_SDK_PLATFORM_PKGS="@anthropic-ai/claude-agent-sdk-linux-arm64 @anthropic-ai/claude-agent-sdk-linux-arm64-musl" ;;
        x86_64) CLAUDE_SDK_PLATFORM_PKGS="@anthropic-ai/claude-agent-sdk-linux-x64 @anthropic-ai/claude-agent-sdk-linux-x64-musl" ;;
      esac
      ;;
  esac

  for PKG in $CLAUDE_SDK_PLATFORM_PKGS; do
    PKG_SRC="$(find "$MONO_ROOT/node_modules/.pnpm" -maxdepth 4 -path "*/$PKG" -type d 2>/dev/null | head -1)"
    if [ -n "$PKG_SRC" ] && [ -f "$PKG_SRC/claude" ]; then
      mkdir -p "dist/node_modules/$PKG"
      cp "$PKG_SRC/package.json" "dist/node_modules/$PKG/"
      cp "$PKG_SRC/claude" "dist/node_modules/$PKG/"
      chmod +x "dist/node_modules/$PKG/claude"
    fi
  done

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
