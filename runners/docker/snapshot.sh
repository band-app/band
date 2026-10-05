#!/bin/sh
# Runner hook "docker": snapshot. Saves the /work volume of the worker's container as an image and prints
# BAND_SNAPSHOT_ID=<image tag>. Contract: docs/runner-hooks.md.
#
# `docker commit` leaves volumes out, and /work is a volume, so the snapshot is built in two steps: a helper
# container from the same image gets the contents of /work copied into /snapshot (a plain directory), and
# `docker commit` of the helper makes the image. The image records its base image ID in the label
# band.snapshot.base, so restore.sh starts the same image the worker ran from. The container keeps running,
# so the copy is crash-consistent, not a quiesced one. Memory, processes and /tmp are not part of it.
#
# The image is stored on the docker daemon (DOCKER_HOST) the container runs on. Remove it with snapshot-delete.sh.
set -eu

: "${BAND_WORKER_ID:?}"
name="band-$BAND_WORKER_ID"

if ! docker inspect --format '{{.Id}}' "$name" >/dev/null 2>&1; then
  echo "container $name does not exist" >&2
  exit 1
fi

base="$(docker inspect --format '{{.Image}}' "$name")"
user="$(docker image inspect --format '{{.Config.User}}' "$base")"
safe="$(printf '%s' "$BAND_WORKER_ID" | tr 'A-Z' 'a-z' | tr -c 'a-z0-9_.\n-' '_')"
tag="band-snapshot:$safe-$(date +%s)"
helper="band-snapshot-$safe-$$"
trap 'docker rm --force --volumes "$helper" >/dev/null 2>&1 || true' EXIT

# --user root: the image's own user cannot create /snapshot. The commit puts the image's user back.
docker run --name "$helper" --user root --entrypoint /bin/sh "$base" -c 'mkdir -p /snapshot' >/dev/null
docker cp "$name:/work/." - | docker cp - "$helper:/snapshot/"

set -- --change "LABEL band.snapshot.base=$base" --change "LABEL band.worker=$BAND_WORKER_ID"
if [ -n "${BAND_RUNNER_ID:-}" ]; then set -- "$@" --change "LABEL band.runner=$BAND_RUNNER_ID"; fi
if [ -n "$user" ]; then set -- "$@" --change "USER $user"; fi
docker commit "$@" "$helper" "$tag" >/dev/null

echo "BAND_SNAPSHOT_ID=$tag"
echo "BAND_SNAPSHOT_SIZE=$(docker image inspect --format '{{.Size}}' "$tag")"
echo "snapshotted /work of container $name as $tag"
