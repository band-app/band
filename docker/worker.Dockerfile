# syntax=docker/dockerfile:1

##############################################################################
# band-worker image (plan step 2.6)
#
# A machine for a Band hub to run workspaces on. It dials the hub, so it needs
# no inbound port. Run it with the hub URL and a bootstrap token:
#
#   docker build -f docker/worker.Dockerfile -t band-worker .
#   docker run -d -v band-work:/work \
#     -e BAND_HUB_URL=https://hub.example.com \
#     -e BAND_WORKER_TOKEN=bwb_... band-worker
#
# The worker accepts plain http only for a loopback hub, so a hub on the same
# host is reached with `--network host` and http://127.0.0.1:<port>.
##############################################################################

# ---------------------------------------------------------------------------
# Stage 1: pack the worker the way npm would publish it, then install the
# tarball. node-pty 1.1.0 ships no linux-x64 prebuild and compiles during the
# install, so the toolchain is here and not in the runtime stage.
# ---------------------------------------------------------------------------
FROM node:22-bookworm AS builder
ENV HUSKY=0 \
    ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@10
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --filter "@band-app/worker..." \
 && pnpm --filter @band-app/worker pack --pack-destination /out \
 && mkdir /opt/band-worker \
 && cd /opt/band-worker \
 && npm init -y >/dev/null \
 && npm install --omit=dev --no-audit --no-fund /out/band-app-worker-*.tgz

# ---------------------------------------------------------------------------
# Stage 2: runtime. Same Debian base as the builder, so node-pty's binary
# matches. git is what workspaces are made of. The rest is what an agent
# usually reaches for.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git ca-certificates openssh-client curl bash procps less jq \
 && rm -rf /var/lib/apt/lists/*

COPY --from=builder /opt/band-worker /opt/band-worker
RUN ln -s /opt/band-worker/node_modules/.bin/band-worker /usr/local/bin/band-worker

# A fixed non-root uid, so a bind-mounted /work can be chowned to match.
RUN useradd --uid 10001 --create-home --shell /bin/bash worker \
 && mkdir -p /work /home/worker/.band/worker \
 && chown -R worker:worker /work /home/worker
# /work is writable by any uid. The docker runner hook (runners/docker) runs the image as uid 65532
# with a fresh /work volume, which takes its ownership and mode from this directory.
RUN chmod 1777 /work
USER worker
WORKDIR /work

# git needs an identity for commits and must trust a bind-mounted repo owned by
# another uid.
RUN git config --global user.email "band-worker@localhost" \
 && git config --global user.name "Band worker" \
 && git config --global init.defaultBranch main \
 && git config --global --add safe.directory '*'

# /work holds the workspaces the worker serves. The worker state (its id and
# session token) lives in the second volume, so a recreated container is still
# the same host.
ENV HOME=/home/worker \
    BAND_WORKER_ROOTS=/work \
    BAND_WORKER_STATE_DIR=/home/worker/.band/worker
VOLUME ["/work", "/home/worker/.band/worker"]

ENTRYPOINT ["band-worker"]
