# syntax=docker/dockerfile:1

##############################################################################
# Band server — Linux test image (issue #594)
#
# Builds the standalone @band-app/server (web-only, no Electron) plus the
# Rust `band` CLI, then runs them on a stock Debian host that has NO zsh and
# NO Homebrew — exactly the environment the Linux-compatibility work targets.
# This is a test harness, not a production/publish image.
##############################################################################

# ---------------------------------------------------------------------------
# Stage 1 — build the Rust `band` CLI.
# Placing it on PATH in the runtime lets boot-time `band skills install`
# resolve a binary (findBandBinary checks /usr/local/bin/band first) and lets
# you exercise the CLI itself on Linux.
# ---------------------------------------------------------------------------
FROM rust:1-bookworm AS cli-builder
WORKDIR /src
COPY apps/cli ./apps/cli
RUN cargo build --release --manifest-path apps/cli/Cargo.toml

# ---------------------------------------------------------------------------
# Stage 2 — build the self-contained web bundle (apps/web/dist).
# Mirrors CI: node-pty 1.1.0 ships no linux-x64 prebuild, so it compiles via
# node-gyp during `pnpm install` (node-pty is allow-listed in
# pnpm-workspace.yaml's onlyBuiltDependencies) — the toolchain must be present.
# ---------------------------------------------------------------------------
FROM node:22-bookworm AS web-builder
# `--max-old-space-size` mirrors CI (.github/workflows/ci.yml): the SSR vite
# build otherwise hits the default ~2 GB V8 heap ceiling and aborts with
# "JavaScript heap out of memory". Ensure Docker's VM has >=8 GB RAM.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    HUSKY=0 \
    NODE_OPTIONS=--max-old-space-size=6144
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@10 node-gyp
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build:web

# ---------------------------------------------------------------------------
# Stage 3 — runtime: stock Debian slim, NO zsh, NO Homebrew.
# node-pty's Linux .node is compiled against bookworm + Node 22 in stage 2;
# keeping the runtime on the same base guarantees ABI/glibc compatibility.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
# git: workspaces / worktrees. ca-certificates: outbound HTTPS (gh, model
# APIs). Deliberately no zsh — defaultShell() must fall back to /bin/bash.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Install the CLI where the dashboard's checkCli() recognizes it as
# "Installed": a symlink at /usr/local/bin/band resolving to a path ending in
# "binaries/band" (the Electron-sidecar layout). A plain file at that path
# instead reports as "ConflictingBinary", which makes the dashboard show a
# spurious "Install band CLI / build it first" prompt. The symlink also keeps
# `band` on PATH and lets skills-install resolve the binary.
#
# WORKAROUND (band-app/band#596): this exploits checkCli()'s brittle
# `endsWith("binaries/band")` matcher because that detection is desktop-centric
# and doesn't recognize a standalone Linux install. Remove this contrived path
# once #596 makes CLI detection PATH/identity-aware — then a plain
# `/usr/local/bin/band` (or any `band` on PATH) will read as Installed.
COPY --from=cli-builder /src/apps/cli/target/release/band /opt/band/binaries/band
RUN ln -sf /opt/band/binaries/band /usr/local/bin/band

WORKDIR /app/apps/web
COPY --from=web-builder /app/apps/web/dist ./dist
COPY docker/entrypoint.sh /usr/local/bin/band-entrypoint.sh
RUN chmod +x /usr/local/bin/band-entrypoint.sh

# BAND_ACCESS_TOKEN is a convenience default for the ?token= access URL of
# this LOCAL test harness only — it is NOT a real credential and this image
# must never be published. In a real deployment the server generates a random
# tokenSecret via getOrCreateToken(); this default never reaches one.
ENV NODE_ENV=production \
    PORT=3456 \
    HOME=/data \
    BAND_ACCESS_TOKEN=band-local
EXPOSE 3456
ENTRYPOINT ["/usr/local/bin/band-entrypoint.sh"]
