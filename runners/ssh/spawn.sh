#!/bin/sh
# Runner hook "ssh": starts band-worker on another machine over ssh.
# Contract: docs/runner-hooks.md.
#
# Settings (the runner's "env"):
#   BAND_SSH_TARGET       user@host (required)
#   BAND_SSH_OPTS         extra ssh options, split on spaces (for example "-p 2222 -i /keys/runner")
#   BAND_WORKER_CMD       how to start the worker on the target (default: band-worker, for example "npx --yes @band-app/worker")
#   BAND_SSH_DIR          directory on the target for the worker's files (default: .band-runner, under its home)
#   BAND_SSH_CLONE_LOCAL  set to 1 when the target sees the hub's file system, so a repository with no origin URL can be cloned from its path
#   BAND_IDLE_EXIT        idle time before the ephemeral worker exits (default: the worker's 10m)
#
# BAND_HUB_URL must be reachable from the target. A worker accepts plain http only for a loopback hub.
# The remote script, which carries the bootstrap token, goes over ssh's stdin, so the token is in no command line.
set -eu

: "${BAND_SSH_TARGET:?}" "${BAND_HUB_URL:?}" "${BAND_WORKER_ID:?}" "${BAND_BOOTSTRAP_TOKEN:?}"

q() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

dir="${BAND_SSH_DIR:-.band-runner}/$BAND_WORKER_ID"
cmd="${BAND_WORKER_CMD:-band-worker}"
name="$(printf '%s' "${BAND_REPO:-repo}" | tr -c 'A-Za-z0-9_.-' '_')"

# A local path means nothing to another machine, unless it shares the hub's file system.
repo="${BAND_REPO_URLS:-}"
repo="${repo%%,*}"
case "$repo" in
  /*) [ -n "${BAND_SSH_CLONE_LOCAL:-}" ] || repo="" ;;
esac

idle=""
if [ -n "${BAND_IDLE_EXIT:-}" ]; then idle="export BAND_WORKER_IDLE_EXIT=$(q "$BAND_IDLE_EXIT")"; fi

# shellcheck disable=SC2086
ssh -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new ${BAND_SSH_OPTS:-} \
  -- "$BAND_SSH_TARGET" 'sh -s' <<REMOTE
set -eu
mkdir -p $(q "$dir")
cd $(q "$dir")
base="\$(pwd)"
mkdir -p "\$base/home/.band" "\$base/state" "\$base/work"
chmod 700 "\$base"
if [ -n $(q "$repo") ]; then
  if [ -z $(q "${BAND_CLONE_BY_HUB:-}") ]; then git clone --quiet -- $(q "$repo") "\$base/work/$name"; fi
  echo "BAND_HOST_REPO_PATH=\$base/work/$name"
fi
export BAND_HUB_URL=$(q "$BAND_HUB_URL")
export BAND_WORKER_ID=$(q "$BAND_WORKER_ID")
export BAND_BOOTSTRAP_TOKEN=$(q "$BAND_BOOTSTRAP_TOKEN")
export BAND_WORKER_LABELS=$(q "${BAND_LABELS:-}")
export BAND_WORKER_STATE_DIR="\$base/state"
export BAND_WORKER_ROOTS="\$base/work"
export BAND_WORKER_EPHEMERAL=1
export BAND_HOME="\$base/home/.band"
$idle
nohup $cmd >"\$base/worker.log" 2>&1 </dev/null &
pid=\$!
echo "\$pid" >"\$base/pid"
echo "BAND_MACHINE_HANDLE=\$pid"
echo "started worker \$BAND_WORKER_ID as pid \$pid on \$(hostname)"
REMOTE
