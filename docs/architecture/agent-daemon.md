# Agent daemon: chat agents that survive a worker update

Status: accepted, phase 3 of the agent daemon work. Phases 1 (stable agent environment, #1027) and 2 (daemon kit, #1029) are in main.

## Problem

Every worker update stops every running chat agent, mid-turn. Between 2026-10-15 and 2026-10-29 ten releases changed no adapter version, spawn argument, `initialize` capability or stdio framing, and each one still killed the agents. Releases come about every 1.4 days and the update panel makes an update one click, so a person loses a turn often.

Terminals already survive a worker restart because they live in the terminal daemon. A chat agent is an ACP process that the worker spawns as its own child. The hub's ACP client talks to it through two link channels. When the worker exits, the process dies with it and the channels fail.

## Decision

A second detached process, the agent daemon, owns every ACP agent process a worker starts for a hub-run chat. The worker is a client of the daemon. After a restart the worker (and the hub behind it) reattaches to the same processes, and the hub's ACP connection keeps its state, because from the SDK's point of view the byte stream never ended.

### Why a separate daemon and not the terminal daemon

- Lossless output. A terminal daemon may drop or squash output (a headless mirror replays the screen). An ACP stream is newline-delimited JSON-RPC: a lost or duplicated byte corrupts the connection. The agent daemon keeps every byte from the last acknowledged offset.
- Independent restart. "Restart the terminal service" (Settings > Terminal) kills the terminal daemon and its shells. It must not kill agents, and killing an agent must not kill shells.
- No node-pty. The agent daemon needs no native module, so it never fails on a broken node-pty install and starts faster.
- Its own protocol version. The two protocols change for different reasons and a bump in one must not retire the other's sessions.

Both daemons use the daemon kit (`packages/host-local/src/daemon-kit/`): endpoint ownership, token hello, launch, supersede on upgrade, retired names.

## Layout

- Entry: `dist/agent-daemon.mjs` in the worker and desktop bundles (`apps/worker/src/agent-daemon.ts`).
- Run dir: `<state dir>/run/agents/` (0700), socket 0600, token hello. One daemon per worker state dir.
- Code: `packages/host-local/src/agents/daemon/` (`protocol.ts`, `daemon-server.ts`, `client.ts`, `launch.ts`, `holder.ts`, `main.ts`).
- Own `PROTOCOL_VERSION` (starts at 1) in every runtime file name.

## Protocol

Control connection (requests, answered) and stream connection (pushed events), like the terminal daemon.

- `spawn {env, unsetEnv, cwd, command, args, specHash}` returns `{agentId, pid, startedAt}`. `env` is the complete environment, built by the worker for this spawn. The daemon keeps it in memory only.
- `attach {agentId, stdout, stderr}` subscribes the stream connection to the agent's output from those byte offsets and replays what it holds. Answers with the agent record and, when the agent has already exited, its exit.
- `ack {agentId, stdout, stderr}` releases output up to those offsets. Answers with how many stdin bytes the daemon has written.
- `write {agentId, bytes}` writes stdin.
- `kill {agentId, signal}` signals the agent's process group.
- `list` returns each agent: id, pid, cwd, start time, `specHash`, adapter version, exit if any.
- `forget {agentId}` drops an exited agent the hub has seen exit.

Stream events: `out {agentId, stream, offset, data}` (base64) and `exit {agentId, code, signal}`.

### Output is lossless

The daemon keeps every stdout and stderr byte after the last acknowledged offset. Above a cap (8 MiB per agent and stream, `BAND_AGENT_BUFFER_BYTES`, read on every chunk) it stops reading the agent's stdout, so the agent blocks on a full pipe, and logs it once. The agent resumes when an acknowledgement frees space. Nothing is dropped.

Offsets are counted by the hub, which is the end that keeps the ACP connection. The hub acknowledges what it has received (a debounce of 250 ms, or at once above 1 MiB) with `acp.ack`, and the worker forwards it to the daemon. A reattach names the hub's offsets, so bytes the link lost in flight are sent again.

Stdin is made lossless the same way. The hub keeps the bytes it wrote since the last acknowledgement and, after a reattach, resends everything past the offset the daemon reports.

### Lifetime

The daemon exits when it holds no agents and has no connection, like the terminal daemon. An agent that exits while no server is attached stays in the daemon with its unread output until the hub sees the exit, or for 10 minutes (`BAND_AGENT_EXIT_KEEP_MS`). A newer build supersedes the endpoint and the old daemon keeps its agents until they end.

## Worker and link

- `acp.spawn` starts the process in the daemon and opens the same two channels as before. The reply gains `held: true`.
- A channel reset (the link is gone) detaches from the daemon and leaves the agent running. Only `acp.kill`, the kill paths below and the agent exiting end it.
- New `acp.reattach {agentId, stdout, stderr, stdin}` opens fresh stdio and stderr channels from those offsets. It answers with the agent's pid, the channels, the daemon's stdin offset and `exited` when the agent is already gone. An unknown agent is an error.
- New `acp.ack {agentId, stdout, stderr}` (see above) and `acp.reconcile {keep}`. After the hub has reattached what it wants, `reconcile` kills held agents it does not know and that have no live channels, so an agent whose chat is gone, or that outlived a hub restart, does not live forever.

## Hub

`RemoteHost` wraps a held agent in a `RemoteAgent` whose `stdout`, `stderr` and `stdin` outlive any one link session.

- When the session is destroyed (worker restart, resume window passed) the agent goes to `detached`. Nothing ends: the stdout iterable waits. The ACP connection, the chat's runtime, its relay grant, MCP proxy token and `GH_TOKEN` stay as they are.
- `worker-link-service` calls `reattachAgents()` after the worker says hello. Each detached agent calls `acp.reattach` and swaps its channels.
- If the worker does not come back within `BAND_AGENT_REATTACH_TIMEOUT_MS` (default 2 minutes, read on every loss), or the reattach fails, the agent exits with `link-lost`. That is today's behavior: the hub revokes its grants and the next prompt starts a process and runs `session/load` or `session/resume`.
- `kill()` on a detached agent is remembered and sent once the worker is back.

The two-minute timeout and the 8 MiB cap are estimates that cover an `npm i -g` plus a restart. They are settings, not measurements. Change the defaults only with a measurement.

## When an agent stops

At once, for correctness or security:

- The worker's lease runs out and it fences (#905): the worker kills held agents, and `acp.spawn` is refused until the next renewal. The worker also sends each lease renewal to the daemon (`lease {ttlMs}`), and the daemon kills every agent when the lease runs out with no renewal, so a worker that died cannot leave agents running past it.
- A worktree folder goes on `blockedPaths`: the worker kills held agents whose cwd is inside it.
- The worker is revoked or removed (the hub rejects its hello): the worker kills held agents before it exits. Uninstalling the service ends the agent daemon, which kills its agents.
- An agent login is removed, switched or its secret replaced, or a vault git credential the agent holds as `GH_TOKEN` is rotated: the hub stops the runtimes that hold it.
- A person stops the chat, removes it or removes the worktree.

At the next clean point (no turn, nothing pending), not mid-turn:

- The adapter version differs from the installed one.
- The resolved launch spec changed (command, arguments, login, per-worker agent command, environment Band sets).
- The client capabilities or ACP protocol version the hub depends on differ from what the held process was initialized with.

The hub computes one launch-spec hash and stores it with the agent at spawn: command, arguments, adapter version (the adapter's `package.json` version, or the file size and mtime for a bundled or stand-in script), the ACP protocol version, a fingerprint of the client capabilities, the names of the unset variables, and for each environment variable its name and a SHA-256 of its value. It never holds a value on disk. The relay grant (`BAND_TOKEN`, `BAND_SERVER_URL`) and chat ids are not in the hash, because they differ per launch by design. After a reattach the hub resolves the launch again and compares. A difference restarts the process before the next turn and the chat attaches with `session/load`.

This differs from "the worker compares" in the first sketch. The worker never sees the login or the chat environment, so the hub is the only side that can tell whether the launch changed.

### When the hub stops

The hub keeps the ACP client state of a hub-run chat in memory. Only a worker restart may keep a held agent. Once the hub is gone (shutdown, restart or crash), nothing can reattach, so:

- A hub shutdown ends the agents it runs. `start-server.ts` calls `RemoteHost.stopAgents()` for every remote worker before it closes the worker links. Each held agent is sent `acp.kill` and the hub waits, up to 3 seconds, for the worker to report its exit. Agents of the `local` worker are the hub's children and stop as before (`stopAllAgentProcesses`).
- A hub crash cannot run that code, so the daemon enforces it. An agent is orphaned when no worker watches it: no worker is subscribed, or the subscribed worker reports its hub link down (`hub {up:false}`, sent on the link's disconnect and connect events). After `BAND_AGENT_REATTACH_TIMEOUT_MS` plus 2 seconds (the same setting the hub's own give-up uses, read on every check by the daemon) the daemon kills it with SIGTERM, then SIGKILL after the grace period. A worker restart starts the same clock, so a reattach inside the timeout cancels it.
- `acp.reconcile` still ends held agents an arriving hub does not know.

Unavoidable, unchanged: reboot or shutdown, ephemeral sleep, the daemon crashing. When the daemon dies the hub's channels end, the agent is reported as exited, and the next prompt reattaches the session through `session/load`.

## Not covered

- Chats a worker owns (`--own-chats`) keep their agents as child processes of the worker.
- The hub's own machine (`local` worker): agents are the hub's children.
- TUI agents (already in the terminal daemon) and Windows.
- A versioned copy of the adapter. `npm i -g` replaces the adapter's files in place (#1008), so a held agent that loads a module for the first time after an update can read a file from the new version. Copying the adapter and its dependencies costs hundreds of megabytes per update. The restart rule above limits the exposure to one turn.

## Security

The daemon runs as the worker's user. Socket 0600 in a 0700 directory, token hello, endpoint ownership checks from the kit. The launch environment lives only in daemon memory. It is never written to disk, never logged, and `list` and the pid record carry the hash, not the values.
