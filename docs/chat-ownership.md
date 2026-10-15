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

A worktree whose owning worker is offline restores on another host as any other ([checkpoints](checkpoints.md)): the chat continues there from the hub's copy of the log and the agent session files of the last checkpoint. Events the worker logged after its last replication are not in the hub's copy yet. When that worker reconnects, the hub keeps those rows apart (`chat_event_holds`) and never mixes them into the restored chat.

## Limits

- The worker's chat runtime has no agent probe, one-shot calls, session catalog or learned Claude Code defaults. A chat with no session yet shows the hub's cached pickers.
- A worker whose platform has no `node:sqlite` cannot own chats.
- An existing desktop install picks up `--own-chats` when This Mac is added again or switched to the bundled worker.
