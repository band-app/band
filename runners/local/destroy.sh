#!/bin/sh
# Runner hook "local": stops the worker spawn.sh started and removes its directory.
# Called with BAND_WORKER_ID for a machine the hub knows, or with only BAND_MACHINE_HANDLE (the pid
# spawn.sh printed) for one it has lost track of. A handle is only trusted when one of this
# runner's directories holds that pid, so the hook never kills a process it did not start.
set -eu

root="${BAND_RUNNER_DIR:-${TMPDIR:-/tmp}/band-runner}"
base=""
if [ -n "${BAND_WORKER_ID:-}" ]; then
  base="$root/$BAND_WORKER_ID"
elif [ -n "${BAND_MACHINE_HANDLE:-}" ]; then
  for dir in "$root"/*/; do
    [ -f "${dir}pid" ] || continue
    if [ "$(cat "${dir}pid")" = "$BAND_MACHINE_HANDLE" ]; then base="${dir%/}"; break; fi
  done
  if [ -z "$base" ]; then
    echo "no machine with handle $BAND_MACHINE_HANDLE"
    exit 0
  fi
else
  echo "BAND_WORKER_ID or BAND_MACHINE_HANDLE is required" >&2
  exit 1
fi

if [ -f "$base/pid" ]; then
  pid="$(cat "$base/pid")"
  kill "$pid" 2>/dev/null || true
  # The worker may still be writing its state while it shuts down. Wait for it, so rm finds a quiet directory.
  i=0
  while kill -0 "$pid" 2>/dev/null; do
    i=$((i + 1))
    if [ "$i" -eq 50 ]; then kill -9 "$pid" 2>/dev/null || true; fi
    if [ "$i" -gt 100 ]; then break; fi
    sleep 0.1
  done
  echo "stopped pid $pid"
fi
rm -rf "$base" || { sleep 1; rm -rf "$base"; }
