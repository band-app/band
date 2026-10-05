#!/bin/sh
# Runner hook "ssh": stops the worker spawn.sh started on the target and removes its directory.
# Called with BAND_WORKER_ID for a machine the hub knows, or with only BAND_MACHINE_HANDLE (the
# remote pid spawn.sh printed) for one it has lost track of. A handle is only trusted when one of
# the runner's directories on the target holds that pid.
set -eu

: "${BAND_SSH_TARGET:?}"
if [ -z "${BAND_WORKER_ID:-}" ] && [ -z "${BAND_MACHINE_HANDLE:-}" ]; then
  echo "BAND_WORKER_ID or BAND_MACHINE_HANDLE is required" >&2
  exit 1
fi

q() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
root="${BAND_SSH_DIR:-.band-runner}"

# shellcheck disable=SC2086
ssh -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new ${BAND_SSH_OPTS:-} \
  -- "$BAND_SSH_TARGET" 'sh -s' <<REMOTE
root=$(q "$root")
worker=$(q "${BAND_WORKER_ID:-}")
handle=$(q "${BAND_MACHINE_HANDLE:-}")
base=""
if [ -n "\$worker" ]; then
  base="\$root/\$worker"
else
  for dir in "\$root"/*/; do
    [ -f "\${dir}pid" ] || continue
    if [ "\$(cat "\${dir}pid")" = "\$handle" ]; then base="\${dir%/}"; break; fi
  done
  if [ -z "\$base" ]; then echo "no machine with handle \$handle"; exit 0; fi
fi
if [ -f "\$base/pid" ]; then
  pid="\$(cat "\$base/pid")"
  kill "\$pid" 2>/dev/null || true
  i=0
  while kill -0 "\$pid" 2>/dev/null; do
    i=\$((i + 1))
    if [ "\$i" -eq 50 ]; then kill -9 "\$pid" 2>/dev/null || true; fi
    if [ "\$i" -gt 100 ]; then break; fi
    sleep 0.1
  done
fi
rm -rf "\$base" || { sleep 1; rm -rf "\$base"; }
echo "removed \$base"
REMOTE
