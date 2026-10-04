#!/bin/sh
# Runner hook "docker": removes the container spawn.sh started, with its /work volume.
# Succeeds when the container is already gone (`--rm` removes it when the worker exits).
set -eu

: "${BAND_WORKER_ID:?}"
name="band-$BAND_WORKER_ID"

if err="$(docker rm --force --volumes "$name" 2>&1)"; then
  echo "removed container $name"
elif printf '%s' "$err" | grep -qi "no such container"; then
  echo "container $name is already gone"
else
  # An unreachable daemon is not "gone": report it so the run log shows the leak.
  echo "$err" >&2
  exit 1
fi
