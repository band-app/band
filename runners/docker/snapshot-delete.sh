#!/bin/sh
# Runner hook "docker": snapshot-delete. Removes the image snapshot.sh made. Reads BAND_SNAPSHOT_ID.
# Succeeds when the image is already gone.
set -eu

: "${BAND_SNAPSHOT_ID:?}"

if err="$(docker rmi "$BAND_SNAPSHOT_ID" 2>&1)"; then
  echo "removed snapshot $BAND_SNAPSHOT_ID"
elif printf '%s' "$err" | grep -qi "no such image"; then
  echo "snapshot $BAND_SNAPSHOT_ID is already gone"
else
  echo "$err" >&2
  exit 1
fi
