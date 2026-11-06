# ADR: one setup for every machine, and updates that keep work running

**Status:** Proposed · **Date:** 2026-11-06

This amends [hub-workers.md](hub-workers.md) decision 4 ("the hub runs a `LocalHost` in-process") and replaces the per-host choice in [chat-ownership.md](chat-ownership.md) decision 1. The implementation plan is [roles-and-updates-plan.md](roles-and-updates-plan.md).

## Context

Band has three components: the hub, workers and clients (the desktop app, the web UI and the mobile app). How they behave depends on how a person installed them:

- **The hub's machine is special.** A hub has a built-in worker, `local`, which is `LocalHost` code inside the hub process. Its worktrees have ids without a worker suffix (`<repo>-<branch>`), and its agents and terminals are children of the hub. Owned chats, the agent daemon, checkpoints, follow-the-work and the worker lease all exclude it. In the hub's source, 34 files mention it about 100 times (`HUB_HOST_ID`, `"local"` checks, `BAND_LOCAL_WORKER`). A hub that runs with `BAND_LOCAL_WORKER=off` and a separate `band-worker` beside it already works without any of this.
- **Chats run in one of two places.** A worker started with `--own-chats` runs the ACP client and the event log for its worktrees' chats, and the hub keeps a replicated copy. Every other worker relays agent stdio to the hub, which runs the client. The two runtimes (`apps/worker/src/chats/` and the hub's `agent-session-service.ts` and `task-service.ts`) differ: background wake, stall detection, the agent probe, one-shot calls, the session catalog and the learned Claude Code defaults exist only on the hub. A turn-handling fix has to be made twice.
- **Updates kill work.** Whichever process runs a chat's ACP client loses the conversation when it restarts. The client's position in the agent's output, its open `session/prompt` request and the permission requests waiting for an answer exist only in memory. The agent daemon keeps agent processes alive, but only for hub-run chats, and only while the hub stays up. A desktop app update restarts the bundled worker and ends every owned chat. A hub update ends every hub-run chat (`RemoteHost.stopAgents()` at shutdown, because nothing could pick the agents up afterwards).
- **The desktop app couples roles.** In local mode Electron starts the hub as its own child process, so quitting the app stops the hub for every device. "This computer is the hub" also means "this computer is a worker", through `local`.
- **The direct path depends on the setup.** The desktop UI talks to its own machine's worker on `127.0.0.1` only when the hub is remote. With the hub on the same Mac the CSP does not allow it (`app://local` gets no `127.0.0.1` in `connect-src`), and worktrees on `local` have no worker to talk to anyway.
- **The hub has no updater.** Clients update themselves (electron-updater on desktop, TestFlight and EAS on mobile, the web UI ships with the hub). Workers update with one click or "Update all" (`workers.update`, `workers.updateAll`), and the bundled worker with the desktop app. The hub only runs a command an admin configured (`settings.hubUpdate.command`), and the scheduling, deferral while turns run and restart live in a script the admin writes (`update.sh` and a systemd timer in `docs/updates.md`).

## Decision

1. **Three roles, installed independently.** A machine runs any combination of the hub, a worker and a client. The desktop app bundles all three. On first start, and later in Settings, it asks three questions: connect to an existing hub, make this computer the hub, use this computer as a worker. Each role on the desktop is a launchd service of its own (the worker already is: `app.band.worker`), so closing the app window stops neither the hub nor the worker. A server installs the hub and the worker as npm packages or images, with the same three roles.
2. **The hub runs no worktrees.** The hub keeps data, routing and scheduling, and touches no machine. Every worktree is on a worker, including on the hub's machine, where the person installs the worker role beside the hub. `LocalHost`, the `local` worker id and the worker-less worktree id format are removed after a migration moves existing `local` worktrees onto a real worker.
3. **The worker owns every chat.** The worker that holds a worktree runs its chats' ACP client and event log, everywhere. The hub keeps the replicated log and is the read source for every other client, routes messages that come from elsewhere (the phone, cron jobs, subscriptions) through the forward outbox, takes checkpoints and decides takeovers. There is one chat runtime, the worker's, which gains the features only the hub has today. The hub's ACP client and the `--own-chats` flag are removed. A worker that does not report `chatOwnership` keeps hub-run chats until the minimum worker version drops it.
4. **The chat client is restartable.** Everything the ACP client knows is stored with the event log in the same transaction: the stdout offset it has read up to, the id of its open `session/prompt`, the open permission and form requests, the turn in progress, the queue and the background-work holds. The worker acknowledges output to the agent daemon only after that commit. Agents of every chat are held by the agent daemon, and a worker shutdown detaches from them. After a restart the worker rebuilds each client from its log and reattaches from the stored offset. A reply to a request id from before the restart is routed to the rebuilt turn, so the turn finishes. The agent daemon's protocol stays version 1 and holds no chat logic, so chat fixes ship with every update without touching running agents.
5. **The hub takes over when a lease expires.** When a worker's lease runs out it fences: it stops its agents and starts none (`LeaseGuard`). Only then may the hub reassign the worker's chats to a copy restored on another worker. Events the old worker logged after the cut stay in `chat_event_holds` and are shown as a diverged copy, never merged by themselves.
6. **Nothing is lost on sleep or destroy.** An ephemeral worker sleeps only after the hub has acknowledged every event it logged. On wake the hub sends the log back, so no `chats.db` goes into snapshots. The reaper's hard-deadline destroy waits for that acknowledgement and logs an error naming the chats when it cannot.
7. **Same behaviour in every setup.** A client that runs on the same machine as a worktree's worker talks to that worker directly (files, terminals, LSP, watch, chats), whether the hub is on that machine or elsewhere, and falls back to the hub when the direct path fails. No feature depends on where the hub runs.
8. **Every component updates itself.** The desktop app updates with electron-updater and brings its bundled hub and worker with it. The hub gets a built-in updater: it checks for a release, waits while turns run (up to a limit, as `update.sh` does today), backs up its database, installs by its install method, restarts, checks its health, and restores the backup and the previous version when the new one does not come up. A worker updates itself when it is behind the hub and idle, unless the admin turns the policy off. Because of decision 4, an update interrupts no turn.
9. **Updates go in a fixed order.** The hub first, then workers, then clients. The hub accepts workers and clients one minor version behind it. A worker or client that is newer than its hub is told so (`HubVersionNotice` already does this for the web UI) and waits for the hub. A desktop app that bundles the hub and the worker updates all three of its own roles in that order on its own machine. Its client still respects a remote hub's version.
10. **Breaking changes follow a contract once Band is stable.** Before 1.0, `compatibilityProblem` keeps the current rule (same major, middle number within 1) and any boundary may break with a version gate. From 1.0, each boundary has one written rule:
    - client and hub (tRPC): additive changes only. A removed or changed procedure keeps its old shape for one minor release.
    - hub and worker (link): `PROTOCOL_VERSION` plus capability flags in the hello. A new behaviour is offered behind a capability and the old one is removed one minor release after the hub stops needing it.
    - client and worker (direct path): the same rule as tRPC, with `DIRECT_PROCEDURES` as the list.
    - worker and its daemons: daemon protocols are read by the next build without a bump. A bump supersedes the old daemon and leaves its sessions running under retired names, as today.
    - hub database: forward-only migrations, a backup before each migration, and no migration that a version one minor behind cannot read when the update fails and the hub rolls back.

## Consequences

Positive:

- One code path for every setup. Removing `local` and the hub's ACP client deletes the special cases in the hub, and features that excluded the hub's machine (owned chats, the agent daemon, checkpoints, follow-the-work, the lease) apply everywhere.
- A hub restart ends no work. Agents and their clients live on workers, so a hub update pauses replication and routing until the hub is back.
- A worker restart ends no work, with decision 4.
- The hub carries no machine tooling. node-pty, ripgrep, the ACP adapters and the language server leave the hub's build and its Docker image.
- Updates can be automatic, because they no longer cost a turn.

Negative:

- Other clients see a replica. The phone, status, needs-attention and checkpoint triggers lag the worker by the replication delay. On the desktop with a remote hub this is the case today.
- A single-machine install runs two services, the hub and the worker, and the setup has to start both and report a worker that fails to start.
- Existing `local` worktrees move to a new worker id. Chats, panel states, client state, cron jobs, subscriptions, layouts and history are rekeyed (`rekeyWorktreeRows`). Shells in the hub's terminal daemon do not move. Cold restore brings their scrollback back.
- The hub test suite has to start a worker. 236 hub test files exist, and 62 already run against a worker through `helpers/test-host`. The rest assume the in-process `local` worker and get slower.
- The worker's chat runtime grows to the hub's feature set before the hub's client can go.
- Rolling the hub back after a migration needs the database backup. A failed update costs the time to restore it.

## Alternatives considered

**The hub owns every chat.** One runtime, the hub's, and no replication. It loses local speed on the desktop and working while the hub is unreachable, and every hub update still ends every chat until the hub's client is made restartable as well.

**Keep the per-worker choice and make both clients restartable.** It fixes updates without a migration, but keeps two runtimes, the `local` special cases and setup-dependent behaviour.

**Run the chat runtime in a daemon.** It would survive worker restarts without storing client state. Chat logic changes often (#1041, #1050 and #1073 landed within four days), and every change would mean replacing the daemon that holds the agents, which is the restart this ADR exists to avoid.

**Keep `local` as an option.** It saves a process on single-machine installs, but keeps the in-process worker, its id format and every exclusion listed above.
