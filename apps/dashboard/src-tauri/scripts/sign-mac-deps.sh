#!/usr/bin/env bash
# Sign nested macOS native binaries (.node, .dylib, helper executables) inside
# bundled web resources before Tauri assembles the .app. Tauri's bundler does
# not recursively sign these, and notarization rejects unsigned executables.
#
# Required env: APPLE_SIGNING_IDENTITY
# Optional env: SKIP_NATIVE_SIGN=1 (for unsigned local dev builds)
set -euo pipefail

if [ "${SKIP_NATIVE_SIGN:-0}" = "1" ]; then
  echo "[sign-mac-deps] SKIP_NATIVE_SIGN=1 — skipping"
  exit 0
fi

if [ -z "${APPLE_SIGNING_IDENTITY:-}" ]; then
  echo "[sign-mac-deps] APPLE_SIGNING_IDENTITY not set — skipping (unsigned dev build)"
  exit 0
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[sign-mac-deps] non-macOS host — skipping"
  exit 0
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
ENTITLEMENTS="$REPO_ROOT/apps/dashboard/src-tauri/entitlements.plist"
WEB_DIST="$REPO_ROOT/apps/web/dist"

if [ ! -d "$WEB_DIST" ]; then
  echo "[sign-mac-deps] $WEB_DIST not found — run pnpm build:web first" >&2
  exit 1
fi

if [ ! -f "$ENTITLEMENTS" ]; then
  echo "[sign-mac-deps] entitlements not found at $ENTITLEMENTS" >&2
  exit 1
fi

TARGETS_FILE="$(mktemp)"
trap 'rm -f "$TARGETS_FILE"' EXIT
find "$WEB_DIST" \
  -type f \
  \( -name "*.node" -o -name "*.dylib" -o -name "spawn-helper" \) \
  > "$TARGETS_FILE" 2>/dev/null || true

COUNT=$(wc -l < "$TARGETS_FILE" | tr -d ' ')
if [ "$COUNT" -eq 0 ]; then
  echo "[sign-mac-deps] no native binaries found"
  exit 0
fi

echo "[sign-mac-deps] signing $COUNT native binaries with identity: $APPLE_SIGNING_IDENTITY"
while IFS= read -r f; do
  [ -z "$f" ] && continue
  echo "  → $f"
  codesign \
    --force \
    --sign "$APPLE_SIGNING_IDENTITY" \
    --options runtime \
    --timestamp \
    --entitlements "$ENTITLEMENTS" \
    "$f"
done < "$TARGETS_FILE"

echo "[sign-mac-deps] verify"
while IFS= read -r f; do
  [ -z "$f" ] && continue
  codesign --verify --strict --verbose=1 "$f"
done < "$TARGETS_FILE"

echo "[sign-mac-deps] done"
