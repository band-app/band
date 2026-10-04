#!/bin/sh
# Runner hook "docker": removes the container spawn.sh started, with its /work volume.
# Succeeds when the container is already gone (`--rm` removes it when the worker exits).
# Called with BAND_WORKER_ID for a machine the hub knows, or with only BAND_MACHINE_HANDLE (the
# container id spawn.sh printed) for one it lost track of. A handle is only removed when the
# container carries this runner's `band.runner` label.
set -eu

if [ -n "${BAND_WORKER_ID:-}" ]; then
  name="band-$BAND_WORKER_ID"
elif [ -n "${BAND_MACHINE_HANDLE:-}" ]; then
  name="$BAND_MACHINE_HANDLE"
  if owner="$(docker inspect --format '{{ index .Config.Labels "band.runner" }}' "$name" 2>&1)"; then
    if [ "$owner" != "${BAND_RUNNER_ID:-}" ]; then
      echo "container $name does not belong to runner ${BAND_RUNNER_ID:-}; leaving it" >&2
      exit 0
    fi
  elif printf '%s' "$owner" | grep -qi "no such"; then
    echo "container $name is already gone"
    exit 0
  else
    echo "$owner" >&2
    exit 1
  fi
else
  echo "BAND_WORKER_ID or BAND_MACHINE_HANDLE is required" >&2
  exit 1
fi

if err="$(docker rm --force --volumes "$name" 2>&1)"; then
  echo "removed container $name"
elif printf '%s' "$err" | grep -qi "no such container"; then
  echo "container $name is already gone"
else
  # An unreachable daemon is not "gone": report it so the run log shows the leak.
  echo "$err" >&2
  exit 1
fi
