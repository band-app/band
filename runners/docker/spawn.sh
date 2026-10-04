#!/bin/sh
# Runner hook "docker": starts a band-worker in a hardened container with `docker run --rm`.
# Contract: docs/runner-hooks.md.
#
# The flags follow Bunny's docker runtime (bunny packages/runner/src/runtime/dockerRuntimeAdapter.ts
# and docker/client.ts): uid 65532, CapDrop ALL, AutoRemove, a pids and memory limit, ownership labels.
# Beyond Bunny it adds no-new-privileges and a read-only root file system. Nothing from the host is
# mounted and the docker socket is never passed in.
#
# Settings (the runner's "env"):
#   BAND_DOCKER_IMAGE       the worker base image, run when the project has no ready environment image
#                           (default: band-worker, built from docker/worker.Dockerfile).
#   BAND_PROJECT_IMAGE      set by the hub: the project's current image from `band env build` (plan
#                           step 3.2). It wins over BAND_DOCKER_IMAGE when this docker daemon has it or
#                           can pull it, else the base image runs. It needs git for the clone.
#   BAND_DOCKER_NETWORK     docker network (default: bridge). A worker accepts plain http only for a
#                           loopback hub, so a hub on this machine needs "host" and http://127.0.0.1:<port>,
#                           or an https BAND_HUB_URL.
#   BAND_DOCKER_PIDS_LIMIT  --pids-limit (default: 512)
#   BAND_DOCKER_MEMORY      --memory when the environment sets no resources.memory (default: none)
#   BAND_DOCKER_CPUS        --cpus when the environment sets no resources.cpu (default: none)
#   BAND_DOCKER_TMP_SIZE    size of the /tmp tmpfs (default: 512m)
#   BAND_IDLE_EXIT          idle time before the ephemeral worker exits, like 90s
#   DOCKER_HOST             a remote docker host, like ssh://user@host. Volumes then live on that host.
set -eu

: "${BAND_HUB_URL:?}" "${BAND_WORKER_ID:?}" "${BAND_BOOTSTRAP_TOKEN:?}"

node="${BAND_NODE:-node}"
image="${BAND_DOCKER_IMAGE:-band-worker}"
name="band-$BAND_WORKER_ID"

# resources.cpu and resources.memory from the request's environment (docs/agent-environments.md).
env_field() {
  printf '%s' "${BAND_ENVIRONMENT:-}" | "$node" -e '
    let s = "";
    process.stdin.on("data", (c) => (s += c)).on("end", () => {
      const e = JSON.parse(s || "{}");
      const v = { cpu: e.resources?.cpu, memory: e.resources?.memory }[process.argv[1]];
      if (v !== undefined) process.stdout.write(String(v));
    });' "$1"
}

# "8Gi" -> "8g", "512Mi" -> "512m": docker takes b, k, m or g.
docker_size() {
  printf '%s' "$1" | sed -E 's/^([0-9.]+) ?(Ki|K|KB)$/\1k/; s/^([0-9.]+) ?(Mi|M|MB)$/\1m/; s/^([0-9.]+) ?(Gi|G|GB)$/\1g/; s/^([0-9.]+) ?(Ti|T|TB)$/\1024g/'
}

# The project's own image holds its toolchain and installed dependencies, and the worker (layer 1 of
# docs/agent-environments.md). When this daemon cannot get it (a build on another host without a
# registry), the worker base image runs instead.
if [ -n "${BAND_PROJECT_IMAGE:-}" ]; then
  if docker image inspect "$BAND_PROJECT_IMAGE" >/dev/null 2>&1 || docker pull --quiet "$BAND_PROJECT_IMAGE" >/dev/null 2>&1; then
    image="$BAND_PROJECT_IMAGE"
  else
    echo "project image $BAND_PROJECT_IMAGE is not available on this docker host; using $image" >&2
  fi
fi

cpus="$(env_field cpu)"
cpus="${cpus:-${BAND_DOCKER_CPUS:-}}"
memory="$(env_field memory)"
if [ -n "$memory" ]; then memory="$(docker_size "$memory")"; else memory="${BAND_DOCKER_MEMORY:-}"; fi

# The repository is cloned inside the container, under /work, before the worker starts. The hub learns
# the path from the line printed below, and only uses it once the worker has said hello.
repo=""
repo_name=""
if [ -n "${BAND_REPO_URLS:-}" ]; then
  repo="${BAND_REPO_URLS%%,*}"
  case "$repo" in
    /*) echo "the project has no origin URL a container can clone (got $repo)" >&2; exit 1 ;;
  esac
  repo_name="$(printf '%s' "${BAND_PROJECT:-repo}" | tr -c 'A-Za-z0-9_.-' '_')"
  case "$repo_name" in "" | . | ..) repo_name=repo ;; esac
  echo "BAND_HOST_PROJECT_PATH=/work/$repo_name"
fi

# -e NAME without a value copies it from this script's environment, so the token never shows in `ps`
# or in the docker command line.
set -- \
  --detach --rm --name "$name" \
  --label "band.runner=${BAND_RUNNER_ID:-}" \
  --label "band.request=${BAND_REQUEST_ID:-}" \
  --label "band.worker=$BAND_WORKER_ID" \
  --user 65532:65532 \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --read-only \
  --tmpfs "/tmp:rw,nosuid,size=${BAND_DOCKER_TMP_SIZE:-512m},mode=1777" \
  --volume /work \
  --pids-limit "${BAND_DOCKER_PIDS_LIMIT:-512}" \
  --network "${BAND_DOCKER_NETWORK:-bridge}"
if [ -n "$memory" ]; then set -- "$@" --memory "$memory"; fi
if [ -n "$cpus" ]; then set -- "$@" --cpus "$cpus"; fi

# HOME and the worker state live on the /work volume, the only writable place besides /tmp. The image's
# global git config (identity, safe.directory) is read from where it was written, as HOME moves.
# The volume is anonymous, so `--rm` removes it with the container.
set -- "$@" \
  -e BAND_HUB_URL -e BAND_WORKER_ID -e BAND_BOOTSTRAP_TOKEN \
  -e "BAND_WORKER_LABELS=${BAND_LABELS:-}" \
  -e BAND_WORKER_EPHEMERAL=1 \
  -e HOME=/work/home \
  -e BAND_WORKER_ROOTS=/work \
  -e BAND_WORKER_STATE_DIR=/work/.band-worker \
  -e "BAND_CLONE_URL=$repo" -e "BAND_CLONE_NAME=$repo_name"
if [ -n "${BAND_IDLE_EXIT:-}" ]; then set -- "$@" -e "BAND_WORKER_IDLE_EXIT=$BAND_IDLE_EXIT"; fi

start='set -e
# The worker image keeps its git identity and safe.directory in /home/worker, which HOME no longer is.
if [ -f /home/worker/.gitconfig ]; then export GIT_CONFIG_GLOBAL=/home/worker/.gitconfig; fi
mkdir -p "$HOME" "$BAND_WORKER_STATE_DIR"
if [ -n "$BAND_CLONE_URL" ]; then env -u BAND_BOOTSTRAP_TOKEN GIT_ALLOW_PROTOCOL=https:ssh:git git clone --quiet -- "$BAND_CLONE_URL" "/work/$BAND_CLONE_NAME"; fi
exec band-worker'

id="$(docker run "$@" --entrypoint /bin/sh "$image" -c "$start")"
echo "started container $name (${id%"${id#????????????}"}) from $image"
