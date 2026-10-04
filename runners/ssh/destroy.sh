#!/bin/sh
# Runner hook "ssh": stops the worker spawn.sh started on the target and removes its directory.
set -eu

: "${BAND_SSH_TARGET:?}" "${BAND_WORKER_ID:?}"

q() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
dir="${BAND_SSH_DIR:-.band-runner}/$BAND_WORKER_ID"

# shellcheck disable=SC2086
ssh -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new ${BAND_SSH_OPTS:-} \
  -- "$BAND_SSH_TARGET" 'sh -s' <<REMOTE
base=$(q "$dir")
if [ -f "\$base/pid" ]; then kill "\$(cat "\$base/pid")" 2>/dev/null || true; fi
rm -rf "\$base"
echo "removed \$base"
REMOTE
