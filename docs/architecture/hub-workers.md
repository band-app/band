# ADR: central hub with outbound workers

**Status:** Accepted · **Date:** 2026-10-03

This supersedes [docs/experiments/federation.md](../experiments/federation.md).

## Context

Today one Band server per machine owns everything: the database, the API, chat, scheduling and every git, file, process and terminal operation (`apps/hub/src/server/`). `federation.md` proposed connecting several of these servers as symmetric peers, each the authority for the worktrees on its machine.

Several planned features need a place that is always on and reachable from every device and every machine:

- a coordinator chat that outlives any one laptop
- subscriptions that react to GitHub webhooks and timers
- an OAuth credential vault and an MCP proxy
- runners that start machines on demand and dispose of them when idle

A laptop that sleeps cannot host these. A mesh of peers has no natural owner for them.

## Decision

1. **One hub, API only.** `apps/hub` owns the database, the API, the chat event log, scheduling and auth. Settings exist only on the hub. The UI stays in `apps/web` as a separate static SPA that connects to a hub URL. The hub, a static host or Electron can serve it.
2. **Workers own machines.** Every git, file, process, PTY, search, LSP and agent operation for a worktree runs on that worktree's host, through a `Host` interface. The hub never touches a worker's disk directly.
3. **Workers dial out.** Each worker keeps one outbound WebSocket to the hub and opens no inbound ports. This works behind NAT and tunnels without a VPN.
4. **Local mode is unchanged.** The hub runs a `LocalHost` in-process, so a single-machine user sees no difference.
5. **Chat stays on the hub, and only agent stdio is remote.** The hub keeps the ACP client and the event log. The worker spawns the agent and relays its stdio. Replay, queueing and subscriptions stay independent of where the agent runs.
6. **Runners only spawn.** A runner is a spawn hook script that receives env vars and starts `band-worker`. Ephemeral workers exit when idle, and attached workers (a laptop, a home server) stay connected.

## Consequences

Positive:

- The coordinator, subscriptions, vault and runners get one always-on home.
- One authoritative database and event log. No state exchange between peers, no settings replication, no conflict handling.
- Workers need no inbound networking, so Tailscale is no longer a requirement.
- The `Host` interface gives a clean boundary. A single contract test suite can run against `LocalHost` and a remote host.
- A phone or browser talks to one URL.

Negative:

- The hub is a single point of failure. When it is down, remote work stalls, though shells keep running in each worker's terminal daemon.
- A multi-machine user has to run a hub somewhere that stays up.
- Chatty operations (diffs, search, file trees) cross a network link and need batching, streaming and caching.
- Hub and worker versions can drift, so the handshake carries a protocol version and the hub rejects a mismatch.
- Every worker is a code-execution endpoint, so the tokens and the worker-side relay must be scoped tightly.
- A large refactor: the server code moves out of `apps/web`, and all git and file access goes through `Host`.

## Alternatives considered

**Peer mesh (`federation.md`).** Symmetric Band installs, each the authority for its own worktrees, joined over Tailscale. It was rejected because the mesh has no always-on place for the coordinator, subscriptions, the OAuth vault or the runners. Each would have to live on one chosen peer, which makes that peer a hub without the design saying so. The mesh would also need state exchange, proxying of tRPC calls to the owning peer, discovery and settings replication, all of which the hub avoids.

## What carries over from federation.md

Carried over:

- one authoritative machine per worktree
- a versioned protocol with a heartbeat
- handoff by git
- streamed PTY and file-change events
- cron bound to a host
- `ownerPeerId` becomes `hostId`

Dropped:

- the peer mesh, and Tailscale as a requirement
- exchanging "what I own" state between peers
- proxying tRPC to an owner peer
- mDNS discovery
- last-write-wins settings replication

## Phases

- **0.** This ADR.
- **1A.** Split the UI from the API: a static SPA, `apps/hub` created, cross-origin-safe auth, Electron loads the bundled UI.
- **1.** Host abstraction with no behavior change: `Host` interface, `LocalHost`, all consumers routed through it.
- **S.** Subscriptions: webhook and timer events delivered to chats. Independent of workers.
- **2.** Link, worker and remote host: the WebSocket protocol, attached workers, device and worker tokens, a headless hub deploy.
- **3.** Runners, environments and ephemeral workers: spawn hooks, `.band/environment.json`, placement, reaper.
- **4.** MCP proxy and credential vault.
- **5.** Context: hub-held git repos synced to workers.
- **6.** Missions: a coordinator chat with context, subscriptions and hub MCP tools.
- **7.** Desktop and browser: a desktop worker image and a remote viewer.
- **8.** Bunny convergence: its channels become subscription sources and its investigator becomes a mission.
