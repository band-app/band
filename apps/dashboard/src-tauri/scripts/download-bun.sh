#!/usr/bin/env bash
# Download a pinned Bun runtime into apps/dashboard/src-tauri/binaries/bun-<triple>
# so the macOS bundle ships its own JS runtime. Avoids relying on the user's
# host Node/Bun version (eliminates NODE_MODULE_VERSION ABI mismatches).
set -euo pipefail

BUN_VERSION="${BUN_VERSION:-1.3.13}"
TARGET="${TARGET:-$(rustc -vV | sed -n 's/host: //p')}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="$SCRIPT_DIR/../binaries"
DEST="$BIN_DIR/bun-$TARGET"

mkdir -p "$BIN_DIR"

case "$TARGET" in
  aarch64-apple-darwin) BUN_TRIPLE="darwin-aarch64" ;;
  x86_64-apple-darwin)  BUN_TRIPLE="darwin-x64" ;;
  aarch64-unknown-linux-gnu) BUN_TRIPLE="linux-aarch64" ;;
  x86_64-unknown-linux-gnu)  BUN_TRIPLE="linux-x64" ;;
  *)
    echo "[download-bun] unsupported target: $TARGET" >&2
    exit 1
    ;;
esac

if [ -x "$DEST" ]; then
  EXISTING="$("$DEST" --version 2>/dev/null || echo "")"
  if [ "$EXISTING" = "$BUN_VERSION" ]; then
    echo "[download-bun] $DEST already at $BUN_VERSION"
    exit 0
  fi
fi

URL="https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-${BUN_TRIPLE}.zip"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "[download-bun] fetching $URL"
curl -fsSL "$URL" -o "$TMP/bun.zip"
unzip -q "$TMP/bun.zip" -d "$TMP"
mv "$TMP/bun-${BUN_TRIPLE}/bun" "$DEST"
chmod +x "$DEST"

echo "[download-bun] $DEST → $("$DEST" --version)"
