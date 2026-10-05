#!/bin/sh
# Runner hook "ssh": prints the remote pid of every worker spawn.sh started on the target that is
# still running, one per line. The hub destroys the ones it has no record of.
# Settings are the same as for spawn.sh (BAND_SSH_TARGET, BAND_SSH_OPTS, BAND_SSH_DIR).
set -eu

: "${BAND_SSH_TARGET:?}"

q() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
root="${BAND_SSH_DIR:-.band-runner}"

# shellcheck disable=SC2086
ssh -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new ${BAND_SSH_OPTS:-} \
  -- "$BAND_SSH_TARGET" 'sh -s' <<REMOTE
root=$(q "$root")
for dir in "\$root"/*/; do
  [ -f "\${dir}pid" ] || continue
  pid="\$(cat "\${dir}pid")"
  if kill -0 "\$pid" 2>/dev/null; then echo "\$pid"; fi
done
REMOTE
