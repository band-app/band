# Experiment: federation / remote machines

**Status:** Direction confirmed, no code yet · **Date:** 2026-05-27 · **Owner:** TBD

## Decisions

These shape everything below. Captured up front so the rest of the doc can
assume them.

1. **Band is an individual tool.** Not a team SaaS. Each user runs their own
   Band installs across their own machines. No central admin, no shared
   tenants, no multi-user dashboards.
2. **Federation, not control-plane + workers.** Peer mesh between full
   Band installs. Every peer is symmetric. See [Why federation fits
   Band](#why-federation-fits-band).
3. **Tailscale (or any mesh VPN) is assumed for networking.** Band does not
   solve NAT traversal, hole punching, or peer discovery. Tailscale gives us
   stable hostnames, mutual reachability, and identity. Users without
   Tailscale on a LAN can pair via direct hostname/IP; everything else is
   "use Tailscale."
4. **Workspace handoff is git, not migration.** A workspace stays on its
   home peer for its lifetime. To continue work on another machine: commit,
   push, pull on the other peer, create a workspace there. Band does not
   try to move a workspace's runtime state between peers.
5. **`band tunnel` stays.** Federation is for pairing your own machines.
   Tunnel is for exposing one peer's dashboard publicly (e.g. share a demo,
   reach your own server from a network without Tailscale). Different use
   cases, both still useful.
6. **Protocol is versioned from v1.** Explicit version handshake on every
   peer connection. Server refuses incompatible versions. Bumping the
   protocol is a deliberate, breaking-change decision.
7. **Browser panes federate later, via CDP.** v1 simply doesn't show a
   browser pane for remote workspaces. The eventual story is screencast /
   CDP streaming from the home peer, building on the existing
   [CDP screencast experiment](cdp-screencast.md).

## Motivation

Cursor shipped a remote-agent feature in April 2026: install Cursor on any
machine, run `agent worker start`, and that box becomes a registered worker
that you can drive from `cursor.com/agents` on any device. The agent runs on
the worker's CPU, with the worker's files and env vars; control flows from a
central dashboard. Anthropic shipped a narrower equivalent (Claude Code
Remote Control) in February 2026.

The use cases:

- **Beefy machine + thin client.** Worker on a desktop with a real GPU /
  RAM / dotfiles. Control from a MacBook Air or iPad. The work happens
  where the resources are; you babysit from wherever.
- **Overnight runs.** Kick off a long task before bed; review the diff on
  your phone over coffee.
- **Step-away continuity.** Mid-task, leave for a meeting. Approve
  checkpoints from your phone. Send follow-up prompts.
- **Multi-environment dispatch.** A project that needs Node 18 on macOS for
  one part and CUDA on Linux for another. One worker on each. Pick from
  the dropdown per task.

Band is currently 100% single-host. The question is what architecture
delivers these workflows in a way that fits Band's existing shape.

## Two architectures considered

### Option A: control plane + workers (Cursor's model)

One central dashboard (cloud-hosted or self-hosted). Workers are
stripped-down executor binaries that connect outbound to the dashboard via
WebSocket. The dashboard owns all durable state; workers own only live
process state (PTYs, agent subprocesses, file watchers). Workers stream
events up; the dashboard is the source of truth.

- **Pros:** clean separation, one canonical state store, natural fit for
  team / SaaS use, easy mobile (single always-on dashboard URL).
- **Cons:** requires extracting a worker binary out of `apps/web`,
  introducing a control-plane / data-plane split that doesn't exist today.
  Forces a SaaS-vs-self-hosting question. Either Band hosts the dashboard,
  or every user self-hosts a "main" server, or local servers expose
  themselves via `band tunnel`.

### Option B: peer mesh / federation (recommended)

Every Band install stays a full server, as it is today. Servers peer with
each other over a federation protocol. Each peer owns its own workspaces
on its own filesystem; peers exchange metadata so you can see all of them
from any dashboard. Execution data (PTY output, agent events, file
watcher events) streams between peers on demand.

There is no "main" peer. No central control plane. Each Band install is
symmetric.

- **Pros:** strict extension of current architecture. Local-first matches
  Band's positioning. Offline tolerance falls out for free — each peer is
  fully functional when alone. No SaaS dependency. No central server to
  host. Every node is its own dashboard.
- **Cons:** federation layer is new code. Phone needs at least one peer
  reachable. NAT traversal across the open internet is hard without a VPN
  (lean on Tailscale). Team / multi-user / central-audit use cases are
  awkward.

### The choice depends on product positioning

- **Personal / power-user / small-team running their own infra:** peer
  mesh is clearly better.
- **Team SaaS with central admin, audit, billing:** control plane + workers
  is clearly better.

You can't really do both well. Per Decision 1, Band is an individual tool,
so **peer mesh** is the direction.

## Why federation fits Band

Every Band install today is already a full server — SQLite, tRPC,
dashboard, agent pool, terminal manager, file watchers, browser host.
The workers model asks us to break that apart and create a stripped-down
executor binary. The peer model asks the opposite: leave every install
full-fat, and add a federation protocol so they can see each other.

That's strictly less invasive. No extraction of `agent-pool.ts` into a
separate process. No control-plane / data-plane split. The agent pool,
terminal manager, file watcher, diff endpoints, browser host — none of
these change. They keep operating on local workspaces only. A new
federation layer handles the remote case by **delegating to the peer
that owns the workspace**.

It also matches Band's positioning: local-first, no SaaS dependency, your
code never leaves machines you control. Peer mesh is what local-first
means in a multi-device world.

## The shape, concretely

Every Band install is symmetric. Each one:

- Owns its own workspaces — the ones whose worktrees live on its disk.
- Hosts a full dashboard on whichever port it's bound to.
- Knows about its peers and exchanges metadata with them.
- Streams execution data (PTY output, agent events, file watcher events,
  diffs, file contents) to any peer that's currently subscribed.

User-visible behavior:

| Scenario | What you see |
|---|---|
| At desk, both laptop & desktop online | Open desktop dashboard → see both. Open laptop dashboard → see both. |
| Laptop closed, on phone, hitting desktop | Desktop dashboard shows its own workspaces + "laptop offline (last seen 2h ago)" section. |
| Both off, on phone | Nothing reachable. Phone shows "no peers online." |
| Travelling with laptop only | Laptop dashboard shows its workspaces; desktop's appear as offline with last-known metadata. |

That's the natural behavior. No special offline-handling code — it falls
out of the federation model.

## Key simplifying insight: home-peer authority

The reason this is tractable, and not a distributed-systems nightmare,
is that **every workspace has exactly one home peer**: the machine whose
filesystem holds its worktree. That peer is the sole authority for the
workspace's state — chat transcripts, file watcher events, terminal
sessions, agent processes, all of it.

Other peers are **viewers**, not replicas. When the desktop's dashboard
shows a workspace that lives on the laptop, it's federating queries to
the laptop in real time. It doesn't keep its own copy of the chat history
or files. It only persistently caches the **metadata** needed to render
the workspace card while the laptop is offline: name, project, branch,
last activity, status.

This sidesteps the hardest problem in distributed state — conflict
resolution. There's nothing to conflict over because each workspace has
exactly one writer. Peers exchange state because they ask each other
"what do you have?", not because they're trying to maintain identical
replicas.

The same principle applies to **projects**. A project (logical entity:
name + git URL) is something peers agree about by URL identity. Each
peer reports "I have a clone of project X on my disk." Other peers learn
that fact but don't try to mirror the project.

## What syncs, what stays local

| Data | Where it lives |
|---|---|
| Workspace ownership (which peer owns each workspace) | Each peer owns its own list; peers exchange |
| Workspace metadata (name, branch, status, last activity) | Owned by home peer; cached on viewers for offline rendering |
| Workspace contents (files, diffs, chat transcripts, PTY scrollback) | Home peer only; viewers fetch on demand |
| Projects (logical: name + URL) | Each peer reports what it has; union shown in UI |
| Project clones (`.git`, files) | Each peer owns its own clones; never shared |
| User settings / preferences | Replicated across peers (the only thing that benefits from real sync) |
| Cronjobs | Owned by the peer they run on — a cron is bound to a machine |

The only state that genuinely needs **multi-writer sync** is user
preferences (theme, default agent type, etc.). For that, a tiny LWW
(last-writer-wins) registry per setting is sufficient. No CRDTs needed
for v1.

## Discovery and topology

Per Decision 3, Tailscale (or an equivalent mesh VPN) is assumed.
Discovery reduces to **the user typing or pasting a hostname**:

```
band peers add desktop https://amir-desktop.tailnet-name.ts.net:3456
```

That's it. Tailscale gives us:

- Stable hostnames (MagicDNS).
- Mutual reachability across networks without NAT punching.
- Per-device identity at the network layer (a sanity check on top of
  Band's own peer keypair auth — see [Authentication and identity](#authentication-and-identity)).

For users on the same LAN without Tailscale, the same command works with
a `.local` hostname or a raw IP. mDNS auto-discovery is **not** in scope
for v1 — the manual command is fast enough that auto-discovery is a
nice-to-have, and it's a clean addition later if we want it.

NAT traversal across the open internet without a VPN is **explicitly out
of scope**. If a user has two machines on two separate residential
networks with no VPN, the answer is "install Tailscale," not "Band
solves it for you."

A rendezvous / coordination server is also out of scope for v1. If we
ever offer a Band cloud product, that's where rendezvous would live.
Until then, the user's existing mesh VPN does the job.

## Phone access

Phones don't run Band. They're thin web clients to whichever peer they
can reach. That peer becomes a **bastion** for whatever federation
queries the phone makes:

- Phone → laptop dashboard
- Laptop renders its own UI
- For every "show me the desktop's workspaces" query, laptop proxies to
  desktop over the peer protocol
- For every "subscribe to chat X on desktop," laptop sets up a relay

This makes the bastion peer's network position important — it has to be
reachable from the phone *and* from the other peer it's federating
with. Tailscale solves both ends.

## Authentication and identity

Per-user keypair, generated on first run. Each peer has a public/private
pair. Pairing two peers = exchanging public keys (QR code on first pair,
copy-paste, or rendezvous-server-mediated).

After pairing, peers mutually authenticate every connection (mTLS, or a
Noise-protocol session like Tailscale uses). Revocation = remove the
peer's public key from your trusted list.

Token-based auth like the workers model doesn't fit here because there's
no central issuer.

For the **phone connects to laptop over HTTPS** path: standard web auth
(login + session cookie or device token). Phone isn't a peer; it's a
user agent.

## Execution flow

User opens desktop dashboard. Sees a workspace owned by laptop. Clicks it.

1. Desktop's UI fetches workspace detail from laptop over the peer protocol.
2. User opens a terminal pane. Desktop's UI calls
   `laptop.spawnTerminal(workspaceId, ...)`.
3. Laptop spawns the PTY locally — this is the existing
   `terminal-manager.ts` code path, totally unchanged.
4. Laptop streams PTY output back to desktop. Desktop forwards to the
   phone over WebSocket.
5. User starts an agent. Same shape: desktop tells laptop to spawn; laptop
   runs claude-code locally; events stream back.

The crucial property: **no code path on the laptop changes**. Spawning
an agent on the laptop is exactly what happens today when you spawn one
locally. The only new thing is that the *initiator* of the RPC is a
peer instead of the local dashboard.

## Protocol sketch

The peer protocol is mostly **state exchange** plus **on-demand RPC**:

```
peer → peer
─────────────────
hello                    // identity, capabilities, supported protocol versions
workspacesIOwn           // list with metadata (id, name, project, branch, status)
projectsIHaveCloned      // list with URLs + local paths
subscribeToWorkspace     // for live data when viewed
unsubscribeFromWorkspace
workspaceEventStream     // streamed only while subscribed:
                         //   - chatEvents
                         //   - ptyOutput
                         //   - fileChangeEvents
                         //   - agentEvents
heartbeat                // every 15s
settingsUpdate           // LWW replication of user prefs
```

The first three are state exchange; the rest are on-demand. Mostly
read-only across peers — the heavy state lives on each peer locally.

Transport: mutually-authenticated WebSocket over the Tailscale-routed
hostname. Outbound dial from either side — both peers are mutually
reachable at the network layer, so either can initiate.

## What changes in existing code

Strikingly little, compared to the workers split:

1. **Add a `peers` table** to SQLite:
   `id, name, publicKey, lastAddress, lastSeenAt, trusted`.
2. **Add a peer protocol** (separate from the existing tRPC; mTLS
   WebSocket between peers). Lives in something like
   `apps/web/src/lib/federation/`.
3. **Add a federation layer** in `apps/web` that, for any tRPC call
   referencing a workspace not owned by this peer, proxies to the owning
   peer.
4. **Workspace records gain `ownerPeerId`** (null = this peer; non-null
   = remote).
5. **Dashboard renders all workspaces uniformly**, with a "running on:
   laptop" badge for remote ones and an offline state.
6. **Workspace creation** asks "which peer should host this?" — defaults
   to local.

The agent pool, terminal manager, file watcher, browser host, diff
endpoints — none of these change. They keep operating on local
workspaces only.

## Trade-offs vs the control-plane alternative

| | Peer mesh | Workers (control plane + executors) |
|---|---|---|
| Conceptual match to current Band | Every install is already a server — extension, not refactor | Requires separating control plane from executor |
| Offline tolerance | Excellent — each peer is fully usable alone | Server can't reach worker → worker is dead to dashboard |
| Cloud dependency | None | Either user self-hosts a central server, or Band offers SaaS |
| Setup | Install Band + pair peers (~30s with QR / Tailscale) | Install worker daemon + token + server URL |
| Single dashboard for everything | Open any peer; it federates | One canonical dashboard |
| State complexity | Replicated metadata, owner-authoritative content | Single source of truth |
| Sync engineering | Real (peer protocol, identity, address book) | Easier — just RPC over an outbound socket |
| NAT story | Hard without a VPN — must lean on Tailscale | Easier — worker only needs outbound 443 |
| Multi-user / team | Awkward — peers are personal | Natural — central dashboard with multiple users |
| Cursor-shaped pitch (mobile control of dev) | Works, but requires one peer reachable | Works natively (central dashboard always reachable) |
| Resource needs per node | Higher — every node runs the full stack | Workers can be cheaper |

## Workspace handoff via git

Per Decision 4, Band does **not** try to migrate a workspace's runtime
state between peers. A workspace is bound to its home peer for its
lifetime — its worktree is on that machine's filesystem, its chat
history is in that machine's SQLite, its terminal scrollback is in that
machine's memory.

The handoff story is git, the way it would be without Band:

1. You're working on workspace `feature/login` on the laptop peer.
2. You commit and push from the laptop (via the agent, a terminal pane,
   or your normal shell).
3. On the desktop peer, you create a new workspace targeting the same
   project and branch. Desktop's Band clones / fetches / checks out.
4. You continue work on the desktop. The chat history from the laptop's
   workspace does **not** come with you — that's the cost of this
   model, and it's the same cost you'd pay if you switched IDEs or
   machines without Band. If you really need the old chat, the laptop
   peer still has it as long as the laptop is reachable.

This deliberately punts on the "follow me to the next machine" feature
Cursor's cloud agents implicitly offer. The trade-off: federation v1
ships in weeks instead of months, and we avoid the distributed-state
problem entirely. Future work could revisit handoff (e.g., serialize the
chat transcript over the peer protocol on hand-off), but it's not
in scope.

## Failure modes

| Scenario | Behavior |
|---|---|
| Peer network blip (<60s) | Peer reconnects, resumes subscriptions. No data loss. |
| Peer process restart, processes die | Open terminals / agents marked `dead` with full transcript preserved. User starts new ones. |
| Peer host offline for hours | Dashboard shows full metadata, all actions on that peer's workspaces disabled. Cronjobs on that peer simply don't run while it's off. |
| Peer host permanently gone | Workspaces remain in metadata-only state. No automatic migration in v1; user creates new workspaces elsewhere. |
| Network partition (laptop sees peer A, desktop sees peer B, but not each other) | Each side shows its own + whoever it can reach. Re-converges when the partition heals. |

## Remaining open questions

The big architectural questions are settled in [Decisions](#decisions)
at the top of this doc. What's left to decide before coding:

1. **Minimum useful demo.** Proposal: two Band installs paired over
   Tailscale, each shows the other's workspace list, you can click into
   a remote workspace and see its files. That's the milestone that
   validates the protocol end-to-end. Confirm this is the right v0
   target before starting work.
2. **Where does the federation code live?** Suggested:
   `apps/web/src/lib/federation/` with the peer protocol, identity, and
   address book. Open to alternative placement.
3. **Concrete protocol message format.** JSON over WebSocket is the
   easy default; protobuf or msgpack if we hit perf issues with PTY
   output. Start with JSON; revisit if benchmarks demand.
4. **How does the dashboard render "remote, currently offline"
   workspaces?** Need a UI design — grayed-out card, badge, last-seen
   timestamp, action affordances (probably all disabled). Out of scope
   for this doc; tracked separately when we get to step 2 of the PR
   sequence.

## Suggested PR sequencing

1. **`peers` table + pairing UI + tRPC CRUD.** No federation yet; just
   register / list / revoke. Pair via manual URL + public key exchange.
2. **Peer protocol scaffold:** mTLS WebSocket, handshake, heartbeat,
   `workspacesIOwn` exchange. After this PR, paired peers can see each
   other's workspace lists in the dashboard but can't click into them.
3. **Pick the smallest useful federated capability and wire it
   end-to-end.** Proposal: `listFiles` + `readFile` for a remote
   workspace. Validates the proxy plumbing without any long-lived
   subscriptions. After this PR you can browse a remote workspace's
   files from any peer's dashboard.
4. **Diff view federated.** Same plumbing as files; serves as a second
   datapoint for the proxy pattern.
5. **Chat / agent federated.** Subscribe to a remote workspace's chat,
   send messages, receive events. This is the headline feature.
6. **Terminal federated.** PTY output streamed over the peer protocol.
7. **File watcher federated.** Subscribe to `fileChanges` from a remote
   workspace.
8. **mDNS auto-discovery** for LAN pairing.
9. **Settings replication** (LWW).
10. **Cron jobs UI** — surface which peer runs each cron; allow target
    selection at creation time.

After step 3 you have a *demo-able* milestone, even though it's not yet
useful for real work. After step 5 it's useful end-to-end.

## What this defers cleanly

Things not being decided now, and which the v1 design doesn't paint us
into a corner on:

- Workspace migration between peers (today-on-laptop, tomorrow-on-desktop).
- Cloud workers (Band provisions a VM that runs a Band install and joins
  as a peer — works identically to a self-hosted peer).
- Browser pane federation.
- Multi-user / team on a single peer.
- Adoption flow for already-existing checkouts (worker discovers
  `~/code/my-app` and offers it as a workspace).
- CRDT-based settings sync (LWW is enough for now).
- NAT traversal without a VPN.

All slot in later without breaking the v1 protocol, **provided we version
the protocol from day one**.

## Background reading

- [Cursor Remote Agents: Control Dev From Any Device (2026)](https://www.buildfastwithai.com/blogs/cursor-remote-agents-any-device-2026)
- [Using Cursor Background Agents for Asynchronous Coding — Steve Kinney](https://stevekinney.com/courses/ai-development/cursor-background-agents)
- [Tailscale: How Tailscale works](https://tailscale.com/blog/how-tailscale-works)
- [docs/experiments/cdp-screencast.md](cdp-screencast.md) — closely related
  for the eventual browser-pane-federation story.
