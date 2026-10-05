#!/bin/sh
# Runner hook "local": prints the pid of every worker spawn.sh started that is still running, one
# per line. The hub destroys the ones it has no record of. Contract: docs/runner-hooks.md.
set -eu

root="${BAND_RUNNER_DIR:-${TMPDIR:-/tmp}/band-runner}"
for dir in "$root"/*/; do
  [ -f "${dir}pid" ] || continue
  pid="$(cat "${dir}pid")"
  if kill -0 "$pid" 2>/dev/null; then echo "$pid"; fi
done
