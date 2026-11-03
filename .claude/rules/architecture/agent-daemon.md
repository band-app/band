---
paths:
  - "**/WorkerUpdateButton.tsx"
  - "**/adapter-version.ts"
  - "**/agent-session-service.ts"
  - "**/credential-events.ts"
  - "**/dist/agent-daemon.mjs"
  - "**/holder.ts"
  - "**/start-server.ts"
  - "**/task-service.ts"
  - "apps/hub/tests/agent-daemon.test.ts"
  - "apps/hub/tests/chat-stalls.test.ts"
  - "apps/web/e2e/update-agents.spec.ts"
  - "apps/worker/src/agent-daemon.ts"
  - "apps/worker/src/agents.ts"
  - "apps/worker/src/methods-agents.ts"
  - "apps/worker/tests/agent-persistence.test.ts"
  - "docs/architecture/agent-daemon.md"
  - "packages/chat-runtime/src/acp-agent-process.ts"
  - "packages/host-local/src/agents/daemon/**"
  - "packages/host-remote/src/agent.ts"
---

# Architecture: agent daemon

A worker holds the ACP agent process of each hub-run chat in a second detached process, the agent daemon, so a worker update does not stop a running agent (ADR `docs/architecture/agent-daemon.md`). Chats a worker owns (`--own-chats`) and agents on the hub's own machine (the `local` worker) are not covered: their agents stay children of the process that starts them.

- Daemon (`packages/host-local/src/agents/daemon/`, entry `apps/worker/src/agent-daemon.ts` bundled to `dist/agent-daemon.mjs`, started by `apps/worker/src/agents.ts`): built on the daemon kit, run dir `<state dir>/run/agents/` (0700, socket 0600), its own `PROTOCOL_VERSION`, no node-pty. Requests `spawn | attach | ack | write | kill | list | forget`; events `out` (base64 with the byte offset) and `exit`. It keeps every stdout and stderr byte after the last acknowledged offset (`OutputRing`) and stops reading an agent past `BAND_AGENT_BUFFER_BYTES` (8 MiB, read on every chunk), so the agent blocks and nothing is dropped. An exited agent stays for `BAND_AGENT_EXIT_KEEP_MS` (10 minutes) until the hub `forget`s it. `BAND_AGENT_DAEMON=0` turns it off. `AgentHolder` (`holder.ts`) is the worker's connection, with the same build and supersede rules as the terminal backend, and `HeldAgentProcess` is the `AgentStdio` it hands out.
- Worker (`apps/worker/src/methods-agents.ts`): `acp.spawn` replies `held: true` and opens the two channels as before. A channel reset detaches and leaves the agent running. `acp.reattach {agentId, stdout, stderr}` opens fresh channels from the hub's offsets and answers with the daemon's stdin offset. `acp.ack` releases output, `acp.forget`, and `acp.reconcile {keep}` kills held agents the hub does not know that nobody is attached to. The fence, a `blockedPaths` folder (`LeaseGuard.onBlocked`) and a rejected hello (`Worker.killAgents`) kill held agents, `acp.spawn` is refused while fenced, and `uninstall-service` ends the daemon (`stopAgentDaemons`).
- Hub: `RemoteAgent` (`packages/host-remote/src/agent.ts`) wraps a held agent. When the link session is destroyed it detaches instead of exiting: its stdout and stderr iterables wait, stdin is kept, and `WorkerLinkService.onConnected` calls `RemoteHost.reattachAgents()`, which reattaches each agent and then reconciles. The hub acks what it received (250 ms debounce, at once above 1 MiB) and resends stdin past the offset the worker reports. `BAND_AGENT_REATTACH_TIMEOUT_MS` (2 minutes, read on every loss) gives up with exit signal `link-lost`, which is today's fallback (the next prompt starts a process and loads the session). Both 2 minutes and 8 MiB are estimates, not measurements.
- Restart at a clean point: `launchSpecHash` (`packages/chat-runtime/src/acp-agent-process.ts`) hashes command, args, adapter version (`adapter-version.ts`: package version, else file size and mtime), the ACP protocol version and client capabilities, unset names, and each env name with a hash of its value. The relay grant and chat ids are not in it. The hub stores it with the agent. After a reattach `Runtime.checkLaunch` is set, and the next prompt (`restartIfLaunchChanged` in `agent-session-service.ts`, never mid-turn) resolves the launch again and restarts the process when the hash differs.
- Kill at once: `credential-events.ts` carries "login removed, secret replaced or re-chosen" and "vault git credential changed" from the login and vault services to `agent-session-service.ts`, which stops the runtimes that hold the old login (`Runtime.loginId`) or a `GH_TOKEN` (`AgentStdio.ghToken`). Stop, chat removal and worktree removal already stop the runtime.
- When the hub stops, held agents stop too, because only the hub holds their ACP state. Shutdown calls `RemoteHost.stopAgents()` before the worker links close (`start-server.ts`), and the daemon kills an agent no worker watches for `BAND_AGENT_REATTACH_TIMEOUT_MS` plus 2 seconds (a worker restart or a worker with its hub link down, reported with the daemon request `hub`), so a hub crash cannot leave agents running. The daemon also enforces the lease (`lease {ttlMs}` on each renewal).
- Stalled turns (issue #1039). `AgentSessionService.prompt` runs a watchdog: a turn with no agent update for `BAND_TURN_STALL_MS` (5 minutes, read on every turn) while its process exited or its held agent has no link to the worker (`AgentStdio.detached`) ends as failed and closes the process, and `finishTask` then starts the next queued message. 5 minutes is longer than the 2 minute reattach window, so the watchdog only fires for a turn that path did not end, and a live agent in a quiet tool call is never cut off. `RemoteAgent` also asks for a reattach as soon as its output ends without an exit: `LinkSession.notify` drops a message while the socket is down, so an `acp.exit` sent during a cut is lost and no later connect would ask. `finishTask` drains the queue after a stopped or failed turn too, so a message sent while a Stop is still settling starts a turn. Messages queued before the Stop stay paused (`pausedQueues` in `task-service.ts`); only later ones start on their own. Test: `apps/hub/tests/chat-stalls.test.ts`.
- `workers.interruptions` (`AgentSessionService.liveAgents`) lists only agents the restart will end: held agents are left out. `WorkerUpdateButton.tsx` words the dialog accordingly, and "Update all" skips only workers with such agents.
- Not covered: a versioned copy of the adapter before spawn (npm replaces the files in place, #1008), worker-owned chats, the hub's own machine, Windows.
- Tests: `apps/worker/tests/agent-persistence.test.ts` (real `band-worker` killed and restarted, `cat` and shell agents, the cap, reconcile, fence, `blockedPaths`), `apps/hub/tests/agent-daemon.test.ts` (real hub and worker, the ACP stub: S1 to S6 and S8), `apps/web/e2e/update-agents.spec.ts` (stand-in workers that run the stub agent, `held` or not; the dialog and Update all).
