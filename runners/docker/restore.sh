#!/bin/sh
# Runner hook "docker": restore. Starts a worker in a new container whose /work holds what snapshot.sh saved.
# It is spawn.sh in restore mode: the same flags, the same environment, no clone. Reads BAND_SNAPSHOT_ID.
set -eu

: "${BAND_SNAPSHOT_ID:?}"
BAND_DOCKER_RESTORE=1 exec "$(dirname "$0")/spawn.sh"
