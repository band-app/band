#!/bin/sh
# Runner hook "local": stops the worker spawn.sh started and removes its directory.
set -eu

: "${BAND_WORKER_ID:?}"
base="${BAND_RUNNER_DIR:-${TMPDIR:-/tmp}/band-runner}/$BAND_WORKER_ID"

if [ -f "$base/pid" ]; then
  pid="$(cat "$base/pid")"
  kill "$pid" 2>/dev/null || true
  echo "stopped pid $pid"
fi
rm -rf "$base"
