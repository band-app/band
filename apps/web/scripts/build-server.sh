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
  --external:@vscode/ripgrep \
  --external:prettier \
  --banner:js="import{createRequire as __cr}from'module';import{fileURLToPath as __fu}from'url';import{dirname as __dn}from'path';const require=__cr(import.meta.url);const __filename=__fu(import.meta.url);const __dirname=__dn(__filename);"

# Copy native modules into dist/ for self-contained builds (Electron app).
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

  # -----------------------------------------------------------------------
  # Copy @vscode/ripgrep wrapper + platform-specific binaries into dist/.
  # The wrapper (lib/index.js) does:
  #   createRequire(import.meta.url).resolve(`@vscode/ripgrep-${platform}-${arch}/bin/rg`)
  # so the platform package must be resolvable as a sibling in node_modules.
  #
  # `electron-builder` emits both x64 and arm64 macOS artifacts from the same
  # `apps/web/dist`, so we must ship binaries for BOTH architectures of the
  # host OS — otherwise the off-arch DMG dies at startup with
  # "Could not find @vscode/ripgrep-darwin-x64". pnpm is told to install
  # cross-arch optional deps via `supportedArchitectures` in
  # `pnpm-workspace.yaml`; if the off-arch package is still missing here
  # (older pnpm install, fork without the workspace setting) we warn loudly
  # but don't fail — the host-arch binary alone keeps single-arch builds
  # working.
  # -----------------------------------------------------------------------

  RG_REAL="$(cd node_modules/@vscode/ripgrep && pwd -P)"
  mkdir -p dist/node_modules/@vscode/ripgrep/lib
  cp "$RG_REAL/package.json" dist/node_modules/@vscode/ripgrep/
  cp "$RG_REAL/lib/index.js" dist/node_modules/@vscode/ripgrep/lib/
  cp "$RG_REAL/lib/index.d.ts" dist/node_modules/@vscode/ripgrep/lib/ 2>/dev/null || true

  RG_HOST_PLATFORM="$(node -e 'console.log(process.platform)')"
  RG_HOST_ARCH="$(node -e 'console.log(process.arch)')"

  # Pick the arch matrix to ship for the current build OS. Electron desktop
  # builds (`apps/desktop/electron-builder.yml`) target macOS only and emit
  # both x64 + arm64 DMGs, so on darwin we MUST ship both archs. Linux is
  # included for symmetry — `apps/web` advertises `"os": ["darwin", "linux"]`
  # in package.json and consumers of the npm package may run on either arch.
  case "$RG_HOST_PLATFORM" in
    darwin) RG_ARCHES="x64 arm64" ;;
    linux)  RG_ARCHES="x64 arm64" ;;
    win32)  RG_ARCHES="x64 arm64" ;;
    *)      RG_ARCHES="$RG_HOST_ARCH" ;;
  esac

  RG_BIN_NAME="$([ "$RG_HOST_PLATFORM" = "win32" ] && echo "rg.exe" || echo "rg")"

  for arch in $RG_ARCHES; do
    pkg="@vscode/ripgrep-${RG_HOST_PLATFORM}-${arch}"
    # Under pnpm's strict layout, the platform-specific package is hoisted
    # only into `@vscode/ripgrep`'s own sandbox, not into the workspace's
    # top-level node_modules — so we resolve it from the wrapper's directory.
    pkg_json="$(cd "$RG_REAL" && node -e "try{console.log(require.resolve('${pkg}/package.json'))}catch{}" 2>/dev/null || true)"
    if [ -z "$pkg_json" ]; then
      if [ "$arch" = "$RG_HOST_ARCH" ]; then
        # Missing host arch is fatal on darwin/linux/win32 builds — find-in-files
        # would break for every user of the bundle.
        echo "ERROR: host-arch ripgrep package ${pkg} not found; aborting build" >&2
        exit 1
      else
        echo "WARNING: cross-arch ripgrep package ${pkg} not found; ${RG_HOST_PLATFORM}-${arch} users of this bundle will fail at startup. Re-run \`pnpm install\` after pulling pnpm-workspace.yaml changes." >&2
        continue
      fi
    fi
    pkg_dir="$(dirname "$pkg_json")"
    mkdir -p "dist/node_modules/${pkg}/bin"
    cp "$pkg_dir/package.json" "dist/node_modules/${pkg}/"
    cp "$pkg_dir/bin/$RG_BIN_NAME" "dist/node_modules/${pkg}/bin/"
    chmod +x "dist/node_modules/${pkg}/bin/$RG_BIN_NAME"
  done

  # SQLite is provided by Node's built-in `node:sqlite` (Stability 1.2 RC,
  # available unflagged since Node 22.13). No native module ships in the
  # bundle for SQLite — the user's `node` binary supplies it.

  # -----------------------------------------------------------------------
  # Prettier — used by `workspace.formatFile` for in-process formatting.
  # We can't bundle it: prettier's CJS shim redeclares `__filename`, which
  # collides with the esbuild banner's `const __filename` at the top of
  # the bundled output (SyntaxError: Identifier '__filename' has already
  # been declared). Marked `--external:prettier` and copied here so the
  # runtime `createRequire(...)` lookup resolves cleanly.
  #
  # Lives inside the NPM_PUBLISH guard because npm consumers install
  # prettier from `apps/web/package.json::dependencies` instead — the
  # bundled `--external:prettier` reference is resolved from the
  # consumer's node_modules at install time. The copy here is purely for
  # self-contained desktop / Electron builds where there is no
  # `npm install` step on the user's machine.
  # -----------------------------------------------------------------------
  PRETTIER_REAL="$(cd node_modules/prettier && pwd -P)"
  mkdir -p dist/node_modules/prettier
  cp -RL "$PRETTIER_REAL"/* dist/node_modules/prettier/

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
  # makes the Electron app balloon to ~300MB. Band users are developers using
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
