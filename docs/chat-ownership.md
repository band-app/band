# Chat ownership

A chat runs where its owner is. For most worktrees the owner is the hub: it runs the ACP client, keeps the chat's event log and talks to the agent over the worker link. A worker started with `--own-chats` owns the chats of its own worktrees instead. It runs the agent session itself and copies every event to the hub in the background. The decision record is [architecture/chat-ownership.md](architecture/chat-ownership.md).

The desktop app's bundled worker (This Mac, in [install.md](install.md)) is installed with `--own-chats`. Then a chat on a Mac worktree does not depend on the network to the hub: the app reads and sends through the worker's local listener on `127.0.0.1`, and the agent runs on the Mac. The phone, a browser and `band chats watch` read the same chat from the hub.

## Who owns a chat

- A worker owns chats only when its hello lists the `chatOwnership` capability (`--own-chats`, or `BAND_WORKER_OWN_CHATS=1`). An ephemeral worker never does.
- The hub hands a chat to its worktree's worker at a clean point: no turn runs, nothing waits on the user, the agent runs no background work and the hub's queue for the chat is empty. That happens when the worker connects and when the next message arrives. The hub stops its own agent process for the chat first, so a chat never runs in two places.
- `chats.get` and `chats.list` return `ownerHostId` for an owned chat.
- A chat removed with its worktree, or moved by a restore or a move, leaves its worker. The worker finishes replicating, stops the agent and keeps its copy of the log until the chat is removed.

## What the worker does

The worker keeps `<state dir>/chats.db`, with the same `chat_events` table as the hub. Its rows have the same ids, kinds, payloads, revisions and turn starts.

- Ids. The hub leases the worker blocks of a million ids above every id it has used (`chat.idBlock`). The hub's own rows skip them. A worker that is offline keeps writing from its block.
- History. When it gets a chat, the worker copies the hub's rows for it (`chat.history`) before it runs a turn.
- Turns. One turn at a time, with a queue kept in `chats.db`. The agent starts with what the hub provides (`chat.launch`): the agent definition, a relay grant, MCP servers with a fresh token, the shared and upload directories. While the hub is unreachable the worker reuses the last launch.
- Replication. Every row goes to the hub in id order (`chat.replicate`). The hub inserts the rows it does not have and acks the batch. After a dropped link the worker resends from its last ack, so the hub ends up with every row once.

## What the hub does for an owned chat

- Stores the replicated rows in `chat_events` and passes them to its subscribers.
- Keeps task records, agent status, needs-attention and the chat's session and summary in step with the `prompt`, `turn-started`, `turn-ended` and `session-attached` rows. A finished turn triggers a checkpoint as it does for a hub-run chat.
- Forwards what other clients ask: messages (from another device, the message queue, cron jobs, subscription wake-ups, agent launches), stops, permission and form answers and queue edits. They go through the `chat_forwards` outbox. A message for an offline worker waits there, shows in the chat's queue, and runs once after the worker reconnects. Changing a session setting and listing past sessions need the worker online.

## The local path

The desktop app uses the worker's direct listener ([local direct path](local-direct-path.md), `apps/worker/src/direct.ts`) for an owned chat in a worktree on its own worker. The routes are in `apps/worker/src/chats/local-http.ts`, and the app reaches them through `apps/web/src/lib/direct-chat.ts`:

| Route | Like the hub's |
| --- | --- |
| `GET /api/chats/:chatId/events` | the chat event stream |
| `GET /api/chats/:chatId/history` | older turns |
| `POST /api/chats/:chatId/messages` | send a message |
| `POST /api/chats/:chatId/stop` | `tasks.abort` |
| `POST /api/chats/:chatId/permission`, `/elicitation` | `chat.answer`, `chat.answerElicitation` |

The token is the worktree's direct-path token, checked like the file and terminal calls (loopback `Host`, the desktop app's `Origin`, the worktree scope). A chat the worker does not own answers 404, and the app uses the hub for that chat for a minute. A refused token (401) makes the app ask the hub for a new one, and a connection failure or a 5xx sends the call to the hub while the direct path rests. An answer to a request that is gone is a 409, so it is never read as "not owned". Event ids are the same on both sides, so a stream moves between the worker and the hub without a reset. A chat created on the worker's worktree is owned from the start, so its first message can go direct.

## Restore

A worktree whose owning worker is offline restores on another worker as any other ([checkpoints](checkpoints.md)): the chat continues there from the hub's copy of the log and the agent session files of the last checkpoint. Events the worker logged after its last replication are not in the hub's copy yet. When that worker reconnects, the hub keeps those rows apart (`chat_event_holds`) and never mixes them into the restored chat.

## Limits

- The worker's chat runtime has no agent probe, one-shot calls, session catalog or learned Claude Code defaults. A chat with no session yet shows the hub's cached pickers.
- A worker whose platform has no `node:sqlite` cannot own chats.
- An existing desktop install picks up `--own-chats` when This Mac is added again or switched to the bundled worker.

## The agent of an owned chat

The worker starts the agent of an owned chat in its agent daemon ([agent daemon](architecture/agent-daemon.md)), marked `owned`. A worker restart (an app update, `launchctl kickstart -k`) leaves the agent running. The restarted worker rebuilds the chat's client from `chats.db` and reattaches to the agent (below). If the daemon no longer holds the agent, the next message starts a new one, and the daemon kills an unwatched agent once `BAND_AGENT_REATTACH_TIMEOUT_MS` plus 2 s pass. A cut hub link does not count as unwatched for an owned agent, because the chat works without the hub. When the worker's lease runs out the daemon kills the agent, as for any held agent. A daemon from before this change ignores the `owned` field and kills the agent after the hub link has been down that long.

The worker also stores what a rebuilt client would need, in the `chat_wire_state` table of `chats.db` (one row per chat). It holds the agent daemon's agent id, the session id, the `launchSpecHash` (never the launch spec), the stdout offset, the stderr offset, the next JSON-RPC request id, the open `session/prompt` id and the other open client requests, the open permission and form requests with the agent's JSON-RPC ids (beside the `requestId` the log has for them), the turn in progress, the background-work holds and the live session state. The queue stays in `queued_messages`. A tap on the JSON-RPC lines (`packages/chat-runtime/src/wire-tap.ts`) reads the agent's stdout line by line and tracks the offset after each line it hands to the SDK. The events those lines produce and the state commit in one SQLite transaction, opened when the first line of a batch arrives and committed in a `setImmediate` after the SDK handled it. Only then does the worker acknowledge the daemon, up to the committed offset. A kill at any point leaves the stored offset at the end of the last line whose events are in the log, and the daemon's ring holds every byte after it. The table is created when an older `chats.db` is opened.

## Rebuilding after a worker restart

`ChatOwner.start()` reads the stored state of each owned chat with a held agent and calls `ChatRuntime.rebuild`. The rebuild reattaches to the daemon from the stored stdout offset, and the daemon replays what the agent said since the last committed line, so each event is logged once. The client state also holds the agent's `initialize` answer and the stdin offset, so no second `initialize` is sent.

The wire tap is the JSON-RPC shim between the daemon stream and the SDK connection (`WireTap` with a `WireRestore`). The rebuilt connection's request ids are shifted above every stored id. The tap keeps back the one `session/prompt` the rebuilt connection re-issues and gives the agent's reply to the old prompt id to it, so the turn ends normally. The agent's output is held until that is in place. Answers to permission and form requests from before the restart go out with the agent's original ids (`WireTap.respond`), under the `requestId` the log already has. Replies to other old request ids are dropped.

If the daemon's stdin count is below the end of the stored prompt, the agent never received it. The turn is logged as failed and its message goes back to the head of the queue, which stays paused as after any failed turn. The state is written before each request reaches the daemon, so a restart finds it.

The rebuild needs no hub. Once the link is up (or at once, when it already is) the worker asks `chat.launch` for a fresh launch, hashes it the way a new start does (the resolved launch, the login variables and the unset names, not the chat's per-launch variables) and compares it with the stored hash. A different hash restarts the agent at the next clean point: no turn, request or background work, checked when a turn ends and before the next prompt.
