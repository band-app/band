#!/usr/bin/env bash
# Wrapper script for the band CLI binary.
# Looks for the Cargo-built binary relative to this script's location.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Prefer release build, fall back to debug
if [ -x "$SCRIPT_DIR/target/release/band" ]; then
  exec "$SCRIPT_DIR/target/release/band" "$@"
elif [ -x "$SCRIPT_DIR/target/debug/band" ]; then
  exec "$SCRIPT_DIR/target/debug/band" "$@"
else
  echo "error: band binary not found. Run 'pnpm --filter @band-app/cli build' first." >&2
  exit 1
fi
