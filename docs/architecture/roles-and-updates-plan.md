# Plan: one setup for every machine, and updates that keep work running

This implements [roles-and-updates.md](roles-and-updates.md). Each step is one PR unless it says otherwise. Steps in one phase can run in parallel unless a step names another as its dependency. Sizes are rough: S is a day of agent work, M two or three, L more, and an L is split before it starts.

The phases are ordered by value. Phase 1 stops app updates from ending chats and is worth shipping on its own. Phase 4's hub updater only needs phase 1 for the "no lost turn" promise on workers, and can start in parallel with phases 2 and 3.

## Phase 1: a worker restart ends no chat

**1.1 Owned-chat agents in the agent daemon (M).** The worker's chat runtime (`apps/worker/src/chats/runtime.ts`) spawns through `AgentHolder` instead of as its own child, the way `acp.spawn` does in `methods-agents.ts`. `Worker.shutdown` detaches from held agents instead of killing them (`liveChildren` in `packages/host-local/src/agents/agent-spawn.ts` no longer covers them). The daemon marks each agent as owned, so an owned agent is not killed while the worker's hub link is down, only after no worker watched it for `BAND_AGENT_REATTACH_TIMEOUT_MS` plus 2 s. The fence still kills owned agents.

- Done when a real `band-worker` killed with SIGTERM leaves the owned chat's agent running with the same pid, and the daemon kills it once nothing reattaches within the timeout.
- Tests: `apps/worker/tests/agent-persistence.test.ts` (owned cases), the fence case in `fencing.test.ts`.

**1.2 Durable client state (M), after 1.1.** `chats.db` gets a table per chat with the stdout and stderr offsets, the open `session/prompt` id, the open permission and form request ids (they are already logged as `permission` and `elicitation` rows), the turn in progress, the queue and the background-work holds. Each batch of parsed events and its offset commit in one transaction, and the daemon is acknowledged after the commit. The schema change has a migration in `apps/worker/src/chats/store.ts`.

- Done when killing the worker at any point leaves a state whose offset matches the last committed event.
- Tests: worker tests that read `chats.db` after a kill.

**1.3 Rebuild and reattach (L, split into the shim and the rebuild), after 1.2.**

- The JSON-RPC shim sits between the daemon stream and the ACP SDK's connection. It starts the new connection's request ids above every stored id, routes a reply to the stored `session/prompt` id into the rebuilt turn, and sends answers to stored agent requests with the agent's original ids.
- The rebuild runs at worker start for each owned chat with a held agent: it reads the state, asks `chat.launch` for the launch spec again (secrets are never stored), compares `launchSpecHash` and schedules a restart at the next clean point when it changed, reattaches from the stored offsets, and replays what the daemon buffered. A prompt whose bytes did not reach the daemon (its stdin offset says so) is recorded as failed and the message stays queued.
- Done when the four scenarios pass with a real `band-worker` killed and restarted and the scripted ACP stub: in the middle of a stream, with a permission request waiting, with a message queued, with the hub unreachable during the restart. In each, the turn finishes, the answer reaches the agent, and no event appears twice.
- Tests: `apps/hub/tests/chat-ownership.test.ts` (new cases), `apps/worker/tests/agent-persistence.test.ts`. Adds an exception entry in CLAUDE.md if the shim is tested directly.

**1.4 Desktop update without lost turns (S), after 1.3.** The app update restarts the bundled worker as today. The update dialog stops listing owned chats as interrupted (`workers.interruptions` leaves held owned agents out, like held hub-run agents).

- Tests: `apps/web/e2e/update-agents.spec.ts`.

## Phase 2: one chat runtime, owned everywhere

**2.1 Port the hub-only chat features to the worker runtime (L, one PR per feature).** Background wake when an async task ends (#1050's `background-wake-service.ts`), stall detection and `lastActivityAt`, the learned Claude Code defaults, the session catalog (`listSessions` answered locally), and the agent probe and one-shot calls run on the worker that the hub asks over the link. Each PR moves one feature and its tests to run against an owned chat.

**2.2 Takeover on lease expiry and the diverged copy (M).** When an owning worker's lease runs out, `follow.offer` and `checkpoints.restore` may reassign its chats to the restored copy (`ChatService.reassignWorktree` and `ChatService.setOwner`). Events the old worker replicates afterwards stay in `chat_event_holds`. The offline worktree notice shows them as a diverged copy with "View" and "Discard", next to the file divergence that `follow.divergence` already shows. This finishes the second half of `chat-ownership.md`.

- Tests: `apps/hub/tests/follow-the-work.test.ts` with owned chats, `apps/web/e2e/follow-the-work.spec.ts`.

**2.3 Sleep and destroy without loss (S).** `lifecycle.idle` refuses to sleep while replication has unacknowledged events. On wake the hub seeds the log back to the worker (the hand-off seed in `chat-ownership-service.ts`). The reaper's hard-deadline destroy waits up to a grace for the acknowledgement and logs an error naming the chats when it gives up.

- Tests: `apps/hub/tests/ephemeral-lifecycle.test.ts`, `runner-reaper.test.ts`.

**2.4 Chat ownership on every worker (S), after 2.1 to 2.3.** Every worker reports `chatOwnership`. `--own-chats` and `BAND_WORKER_OWN_CHATS` become no-ops that log a deprecation line. The hub keeps hub-run chats for workers that do not report the capability.

- Tests: the whole chat suite runs owned; `chat-ownership.test.ts` keeps one old-worker case.

## Phase 3: the hub runs no worktrees

**3.1 Desktop hub as a launchd service (M).** "This computer is the hub" installs `app.band.hub` (a plist like the worker's, `ELECTRON_RUN_AS_NODE=1`, the bundled hub entry, BAND_HOME in `~/.band`), and the app connects to it like any hub. Quitting the app leaves it running. The app update restarts it first, then the worker (decision 9). Local mode no longer spawns the hub as a child.

- Tests: `apps/desktop/tests/` with a fake launchctl (`BAND_LAUNCHCTL_BIN`), `apps/web/e2e-desktop/` with an isolated profile.

**3.2 The three role questions (M), after 3.1.** First start asks: connect to an existing hub, make this computer the hub, use this computer as a worker. Settings gets a "This computer" page with the same three switches. Existing installs keep what they have: local mode means hub on, remote mode means hub off, and the existing "This computer as a worker" answer is the worker switch.

- Tests: `apps/web/e2e-desktop/` specs for each combination.

**3.3 Bundled worker for a local hub (M), after 3.2.** Turning on hub and worker on the same Mac installs the bundled worker against the local hub (the flow in `this-computer-worker.ts`, with the bootstrap token from the local hub). New worktrees go to that worker.

**3.4 Direct path with a local hub (S), after 3.3.** The CSP allows `127.0.0.1` for `app://local` too, `worker_local_id` answers for the local hub, and the web app takes the direct path for that worker. The behaviour no longer depends on where the hub runs (decision 7).

- Tests: `apps/web/e2e-desktop/desktop-direct-path.spec.ts` with a local hub.

**3.5 Move `local` worktrees onto a worker (L), after 3.3.** A boot migration, run when a worker on the hub's machine exists: for each `local` worktree, map its folder on the worker (`repos.map` from `repo-mappings.json` and `repos.path`), create the worktree row under the worker's id, and rekey everything keyed by the old id with `rekeyWorktreeRows` (chats, panel states, client state, cron jobs, subscriptions, origin links, groups, titles, browser history, usage). Shells in the hub's terminal daemon end, and their cold-restore checkpoints are copied to the worker's terminal history. Server hubs get a compose worker service, docs, and the provisioning command for the hub's own machine. A hub without a worker on its machine keeps `local` until one exists.

- Tests: a seeded-database migration test in the style of `worktree-host-ids-migration.test.ts`, then a real boot.

**3.6 Hub tests against a worker (L, several PRs by area).** Each hub test file moves to `helpers/test-host` so it runs against a worker, area by area (chat, terminals, files and git, repos, settings). The remote-loopback job becomes the default job.

**3.7 Remove `LocalHost` from the hub (M), after 3.5 and 3.6.** `BAND_LOCAL_WORKER` goes, `HostRegistry` holds only remote workers, the `HUB_HOST_ID` special cases go, and worktree ids always carry a worker. `toWorktreeId` still parses the old form for the migration. node-pty, ripgrep, the ACP adapters and the language server leave `apps/hub`'s dependencies, its build script and the Docker image. The machine-access exempt list in `biome.json` shrinks to hub state.

## Phase 4: every component updates itself, in order

**4.1 Built-in hub updater (L, split into the runner and the UI).** A service on the hub replaces `update.sh`: on the release check (`release-check-service.ts`), or a schedule in settings, it waits while turns run (the limits from `update.sh`: turns younger than 180 minutes, at most 6 hours), copies the SQLite database to `<BAND_HOME>/backups/<version>-<time>.db`, installs by `BAND_INSTALL_METHOD` (npm, compose, helm, k8s, docker, and desktop where the app does it), restarts, and checks `/api/health` and the version. When the new version does not come up healthy within a timeout, it restores the backup and the previous version. `hub-update.json` keeps the state across the restart, as `hub-update-service.ts` does now. Settings > Hub update shows the schedule, the last run and the log.

- After phase 2 a hub update ends no turn, so waiting becomes a courtesy limit instead of a requirement.
- Tests: `apps/hub/tests/hub-update.test.ts` with a fake installer that installs a version that fails its health check.

**4.2 Worker auto-update policy (M).** A worker behind the hub and idle updates itself, using `workers.update`. "Idle" means no turn running, nothing waiting on the user and no running terminal command, or, after phase 1, simply no update already in progress. The policy is a hub setting (on by default once phase 1 ships, off before) with a per-worker override in Settings > Workers.

- Tests: `apps/hub/tests/worker-versions.test.ts`, `apps/worker/tests/update.test.ts`.

**4.3 Update order (S), after 4.1 and 4.2.** Workers never update ahead of the hub: the policy only targets the hub's version, and a worker newer than its hub is accepted under the existing compatibility rule but gets no update. The desktop app, when it holds the hub and worker roles, updates the hub service first, waits for its health check, then the worker. `HubVersionNotice` stays for clients that are newer than a remote hub.

**4.4 The compatibility contract (M), before 1.0.** `docs/compatibility.md` writes down the rule per boundary from decision 10. CI gets an N-1 job: the previous release's worker and CLI against the new hub, and the new worker against the previous hub. A procedure or link method removed without the one-release wait fails the job.

## Phase 5: remove the old paths

**5.1 Minimum worker version (S).** Once every connected worker reports `chatOwnership` (shown in Settings > Workers), the hub refuses older workers with "update required" through the existing version check.

**5.2 Remove the hub's ACP client (M), after 5.1.** `agent-session-service.ts` and `task-service.ts` lose their ACP code, and `acp.spawn`, the held-agent reattach in `packages/host-remote/src/agent.ts` and `--own-chats` go. The hub keeps the replicated log, routing, the forward outbox, checkpoints and takeover.

## Decisions to make along the way

- Worker auto-update on by default (4.2): proposed on after phase 1, off before.
- Whether an owned chat keeps running while its worker is fenced (the open decision from #905). This ADR says no: a fenced worker stops its agents, which is what makes the takeover in 2.2 safe.
- When to set the minimum worker version (5.1).
- Whether a single-machine server install should get both roles from one command (the provisioning script can install the hub too).

## Rollout

A release publishes every component at once, but they update at different times: a hub on an update timer within the hour (and later than that while turns run), the desktop app and its bundled worker when the person restarts it, an npm worker when an admin updates it (or, after 4.2, when it is idle). So every step must work while the other side is one release behind.

- A worker change that needs new hub behaviour is offered behind a capability in the hello, and the new worker keeps working against a hub that lacks it. A hub change keeps answering workers one release behind.
- Phase 1 changes only the worker. The update that installs 1.1 still ends owned chats, because the old worker kills its children on the way out. The first update that ends no chat is the one that starts from a build with 1.1, 1.2 and 1.3 installed. Release 1.1 and 1.2 together, let people install them, then release 1.3: updating to 1.3 is the first lossless update. Shipping all three in one release works too, and then the update after it is the first lossless one.
- 2.4 takes effect on a worker only once both the hub and that worker run it. A hub-run chat moves to its worker at its next clean point.
- 4.1 replaces a hand-written update script and timer (the `update.sh` in `docs/updates.md`). The release that contains 4.1 is installed by the old timer, and the docs say to disable the timer after that, or the hub disables a timer it recognises. Anything the script did besides updating, such as refreshing a copy of the band CLI, moves into the updater or is no longer needed.
- 3.x changes nothing for a desktop that already connects to a remote hub and a hub with `BAND_LOCAL_WORKER=off`, except the new role screen, which shows their existing answers.
