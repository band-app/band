#!/usr/bin/env bash
# Download a pinned Bun runtime into apps/dashboard/src-tauri/binaries/bun-<triple>
# so the macOS bundle ships its own JS runtime. Avoids relying on the user's
# host Node/Bun version (eliminates NODE_MODULE_VERSION ABI mismatches).
#
# SHA256 checksums are pinned per (version, triple) below. Update both
# BUN_VERSION and the checksum table when bumping Bun.
# Source: https://github.com/oven-sh/bun/releases/download/bun-v<version>/SHASUMS256.txt
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

# Pinned checksums. Format: "<version>:<bun-triple>" → sha256 of bun-<triple>.zip.
checksum_for() {
  case "$1:$2" in
    1.3.13:darwin-aarch64) echo "5467e3f65dba526b9fea98f0cce04efafc0c63e169733ec27b876a3ad32da190" ;;
    1.3.13:darwin-x64)     echo "e5a6c8b64f419925232d111ecb13e25f0abf55e54f792341f987623fd0778009" ;;
    1.3.13:linux-aarch64)  echo "70bae41b3908b0a120e1e58c5c8af30e74afae3b8d11b0d3fdd8e787ddfb4b22" ;;
    1.3.13:linux-x64)      echo "79c0771fa8b92c33aae41e15a0e0d307ea99d0e2f00317c71c6c53237a78e25a" ;;
    *) return 1 ;;
  esac
}

EXPECTED_SHA="$(checksum_for "$BUN_VERSION" "$BUN_TRIPLE" || true)"
if [ -z "$EXPECTED_SHA" ]; then
  echo "[download-bun] no pinned checksum for bun $BUN_VERSION / $BUN_TRIPLE" >&2
  echo "[download-bun] update the checksum_for() table in $0" >&2
  exit 1
fi

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

echo "[download-bun] verifying sha256"
ACTUAL_SHA="$(shasum -a 256 "$TMP/bun.zip" | awk '{print $1}')"
if [ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]; then
  echo "[download-bun] checksum mismatch for $URL" >&2
  echo "[download-bun]   expected: $EXPECTED_SHA" >&2
  echo "[download-bun]   actual:   $ACTUAL_SHA" >&2
  exit 1
fi

unzip -q "$TMP/bun.zip" -d "$TMP"
mv "$TMP/bun-${BUN_TRIPLE}/bun" "$DEST"
chmod +x "$DEST"

echo "[download-bun] $DEST → $("$DEST" --version)"
