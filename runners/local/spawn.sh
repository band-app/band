#!/bin/sh
# Runner hook "local": starts an ephemeral band-worker on the hub's machine,
# with its own HOME, BAND_HOME and state dir under $BAND_RUNNER_DIR/<worker id>.
# Contract: docs/runner-hooks.md.
#
# Optional settings (the runner's "env"):
#   BAND_WORKER_BIN   the worker: a .mjs/.js file run with $BAND_NODE, else an executable (default: band-worker)
#   BAND_IDLE_EXIT    idle time before the ephemeral worker exits, like 90s or 10m (default: the worker's 10m)
set -eu

: "${BAND_HUB_URL:?}" "${BAND_WORKER_ID:?}" "${BAND_BOOTSTRAP_TOKEN:?}"

base="${BAND_RUNNER_DIR:-${TMPDIR:-/tmp}/band-runner}/$BAND_WORKER_ID"
mkdir -p "$base/home/.band" "$base/state" "$base/work"
chmod 700 "$base"

# The repository goes where the worker serves it from; the hub learns the path from the last line.
if [ -n "${BAND_REPO_URLS:-}" ]; then
  repo="${BAND_REPO_URLS%%,*}"
  name="$(printf '%s' "${BAND_PROJECT:-repo}" | tr -c 'A-Za-z0-9_.-' '_')"
  git clone --quiet -- "$repo" "$base/work/$name"
  echo "BAND_HOST_PROJECT_PATH=$base/work/$name"
fi

worker="${BAND_WORKER_BIN:-band-worker}"
case "$worker" in
  *.mjs | *.js) set -- "${BAND_NODE:-node}" "$worker" ;;
  *) set -- "$worker" ;;
esac

# The worker reads everything else from these variables, so the token never appears in a command line.
export HOME="$base/home"
export BAND_HOME="$base/home/.band"
export BAND_WORKER_STATE_DIR="$base/state"
export BAND_WORKER_ROOTS="$base/work"
export BAND_WORKER_LABELS="${BAND_LABELS:-}"
export BAND_WORKER_EPHEMERAL=1
if [ -n "${BAND_IDLE_EXIT:-}" ]; then export BAND_WORKER_IDLE_EXIT="$BAND_IDLE_EXIT"; fi

cd "$base"
nohup "$@" >"$base/worker.log" 2>&1 </dev/null &
echo $! >"$base/pid"
echo "started worker $BAND_WORKER_ID as pid $(cat "$base/pid")"
