# Experiment: chat as a single event-log subscription (Path B)

**Status**: shipped — landed in the PR for issue #478 (see the implementation
checklist near the end of this doc, with every box now ticked).
**Issue**: #478 (and the family of related bugs we ended up fixing piecemeal).
**Branch**: `478-thinking-indicator-delay`.

## Why

Over the lifetime of issue #478 we fixed seven distinct user-visible bugs in
the chat surface:

1. Indicator delay on send (`handleSubmit` pre-flight HTTP)
2. Indicator delay on workspace navigation (3 serial round-trips before
   `useChat.status` flips)
3. Stuck after switch-back mid-stream (sessionIdRef undefined, no recovery)
4. Stuck on mobile background/foreground (no `visibilitychange` listener)
5. Partial state on switch-back (buffer vs JSONL preference lost recent events)
6. Stuck partial after task finish (server 204'd while buffer still held
   undelivered events)
7. Wrong session loaded after "New session" (`ensureActiveSessionSummary`
   promoted the previous session via on-disk fallback)

All seven have the **same shape**: two channels disagreed about what was true,
and the reconciliation code missed a case. The current architecture has at
least five overlapping sources of truth for "what's in this chat":

| Source                            | Owns                       | Updated by                                                      |
| --------------------------------- | -------------------------- | --------------------------------------------------------------- |
| `useChat.messages` (client)       | Rendered message array     | Optimistic local mutations + SSE chunks via SDK                 |
| `sessionIdRef` (client)           | Which session this view is | `onData('data-session')` callback                               |
| `getTask(chatId)` (server memory) | Live task + sessionId      | `task-runner` event loop                                        |
| `sessionBuffers` (server memory)  | Ring buffer of events      | `broadcast()` in task runner                                    |
| `chats.activeSessionId` (sqlite)  | Persisted "current" session| `updateChatActiveSession`, `setActiveSession`, on-disk fallback |
| Agent JSONL (filesystem)          | Long-term history          | Agent SDK, arbitrary delay                                      |

Every UI lifecycle event has to reconcile some subset of these. The current
codebase carries ~700 lines in `ChatView.tsx` whose only job is reconciliation
plumbing: `sessionIdRef`, `lastEventIdRef`, `firstEventIdRef`,
`firstMessageIndexRef`, `connectAbortRef`, `statusRef`, a 5-step backoff retry
loop, focus/visibility/wsActive triple-handlers, the optimistic
`serverTaskRunning` flag, and the `loadMessages → connectToRunningStream`
chain.

The deeper issue is that the Vercel AI SDK's `useChat` is built for
**stateless LLM calls** — fire a POST, stream a response, done. We're using
it for **stateful, server-owned, long-lived tasks** that survive page reloads
and need to be resumed after network/tab/app lifecycle events. Every
`useChat`-shaped concept needs a workaround.

## Goal

Collapse the chat to a single subscription against a server-owned event log:

```ts
const { messages, status, send } = useChatSubscription(chatId);
```

Under the hood: one long-lived SSE per visible chat, reducer maps events →
`messages`, `status` derived from server-pushed lifecycle events, reconnect is
transparent via `Last-Event-ID`. No optimistic state, no
`loadMessages` snapshot, no race.

## What this is NOT

- Not a rewrite of `task-runner.ts` or the agent adapters. Those stay.
- Not a schema change. No new tables.
- Not a switch to WebSockets. Long-lived SSE is sufficient and already in use.
- Not a CRDT or multi-writer model. Single writer (server), many readers.

## Endpoint contract (server → client)

### `GET /api/chats/:chatId/events`

The single entry point for observing a chat. Replaces the cold-subscribe
half of `GET /api/tasks/:chatId/stream` and `trpc.sessions.messages` (from
the chat view's perspective; the procedure stays for the session-history
dropdown's preview rendering).

**Headers (request)**

- `Last-Event-ID: <number>` — optional. The client's high-water mark. If
  omitted (or `0`), server replays full history (buffer + JSONL as needed).

**Behaviour**

1. **Resolve session.** Pick the session to stream:
   - If the in-memory `task` exists and has a `sessionId` → use it.
   - Else if `chats.activeSessionId` is set on the row → use it.
   - Else: no session yet. Open the stream anyway; emit `session-resolved`
     once a task starts and reports one.
2. **Replay phase.** From the resolved session, emit all events with
   `id > Last-Event-ID`:
   - From `sessionBuffers` if the session is in-memory and covers that
     range.
   - From JSONL (paged) if the buffer has been evicted or the session
     pre-dates the current server process. JSONL events are assigned
     synthetic monotonic IDs; the relative ordering matches `firstEventId`
     in the buffer so clients see a continuous sequence.
3. **Live phase.** Subscribe to `task-runner.broadcast` for this chatId.
   Forward events live, in order, each tagged with a buffer eventId.
4. **Lifecycle markers.** Server emits explicit, well-typed lifecycle
   events as part of the stream (see "Event types" below). The client
   derives status from these, never from a separate probe.
5. **Close.** When the current task completes AND no queued messages
   remain, send `task-completed` and close. Client reopens on next user
   interaction. (Alternative: keep the stream open until the chat tab
   unmounts. Decision deferred — see Open questions.)

**Response codes**

- `200` always when the chat exists. Even a chat with zero events returns a
  stream that emits 0 replay events and then waits for live ones.
- `404` if the chat doesn't exist (today's chats are lazily created on
  first message; this status would mean the route is broken).
- No more `204`. That special case was the root of bug #6.

### `POST /api/chats/:chatId/messages`

Submit a user message. Replaces the POST half of
`POST /api/tasks/:chatId/stream`.

**Body**

```ts
{
  workspaceId: string;
  text: string;
  files?: { mediaType: string; url: string; filename?: string }[];
  // optional turn-level overrides (mirror today's submit)
  sessionId?: string;
  mode?: string;
  model?: string;
  codingAgentId?: string;
}
```

**Behaviour**

- Validate, call `submitTask(...)` as today. Returns immediately.
- If a task is already running for this chat, server pushes the message
  into `queuedMessages` (instead of returning 409 to the client). The
  pending queue is also part of the event log (`queue-updated` events
  emit on push/pop/edit), so the client's subscription sees it.
- Server's first broadcast for the new task is `task-started` (a new
  event type — see below), followed by the existing `data-session` /
  text deltas / etc.

**Response**

- `200 { ok: true }` with no body. The actual user-message bubble appears
  via the subscription's `user-message` event, which the server emits
  synchronously inside `submitTask` BEFORE the response returns.
- `400` for validation failures.

### Event types in the unified log

Everything the chat needs to render comes through the stream. New event
types in **bold**:

| Event type            | Existing? | Purpose                                        |
| --------------------- | --------- | ---------------------------------------------- |
| `user-message`        | yes       | A user's submitted prompt + files              |
| **`task-started`**    | no        | A new task began (taskId, agent, model, mode)  |
| **`task-completed`**  | no        | Task finished successfully                     |
| **`task-error`**      | no        | Task failed                                    |
| `data-session`        | yes       | Session id resolved (rename to `session-resolved` for clarity) |
| `text-start`          | yes       | Begin a text part                              |
| `text-delta`          | yes       | Token delta                                    |
| `text-end`            | yes       | End a text part                                |
| `tool-input-available`| yes       | Tool call (with input)                         |
| `tool-output-available`| yes      | Tool output                                    |
| `data-usage`          | yes       | Token usage snapshot                           |
| `data-result`         | yes       | Final result metadata                          |
| **`queue-updated`**   | no        | Queued-message list changed                    |
| `error`               | yes       | Generic error                                  |
| `finish` / `finish-step` | yes    | AI-SDK protocol terminators                    |

Every event carries a monotonic `eventId`. Client uses the latest seen
`eventId` as `Last-Event-ID` on reconnect.

## Client contract

### `useChatSubscription(chatId, options)`

Single hook owning the chat's read model and submit affordance.

```ts
const {
  messages,        // UIMessage[] derived from event log
  status,          // 'idle' | 'submitting' | 'streaming' | 'completed' | 'error'
  queuedMessages,  // QueuedMessage[]
  send,            // (text, files?) => Promise<void>
  cancel,          // () => Promise<void>
  usage,           // UsageData | undefined
  sessionId,       // string | undefined — latest from session-resolved
  isConnected,     // boolean — subscription connection health
} = useChatSubscription(chatId, { mode, model, codingAgentId });
```

Internally:

- One `EventSource` (or `fetch`-based reader for headers control) per
  visible chat, lazily opened on mount and on `visibilitychange` →
  `visible`.
- A reducer applies events to a single immutable state object.
- `send` is a small `fetch` POST. UI doesn't optimistic-render — the
  server's `user-message` event arrives within milliseconds and the
  reducer renders it. (If we measure unacceptable latency in practice,
  add a stamped optimistic record that the `user-message` event replaces;
  but start without.)
- Reconnect with backoff on connection loss, sending `Last-Event-ID`.
- Closes on chat unmount or extended hidden state.

That's the whole client API. The current `ChatView` reduces from ~1500
lines to roughly the JSX render + this hook + queued-message DnD.

## File-by-file change list

### Server

- `apps/web/src/api/task-stream.ts` → split into:
  - `apps/web/src/api/chat-events.ts` (new) — implements
    `GET /api/chats/:chatId/events` with replay + live phases unified.
  - `apps/web/src/api/chat-submit.ts` (new) — implements
    `POST /api/chats/:chatId/messages`, calls `submitTask` and returns
    immediately.
  - Old `task-stream.ts` can either be deleted or kept as a thin alias
    for one release while CLI / external consumers migrate.
- `apps/web/src/lib/sse-writer.ts` (new) — ~30 line SSE writer (headers,
  `id:` / `event:` / `data:` lines, heartbeat comments) replacing
  `createUIMessageStream` + `pipeUIMessageStreamToResponse` from `ai` for
  the new endpoints. The AI SDK helpers stay in use by the legacy
  `task-stream.ts` during migration. The native SSE `id:` field is what
  drives `Last-Event-ID` gap-fill — no need to embed `eventId` in
  payloads, and no more `toUIChunk` schema dance to strip unknown keys.
  The `ai` import goes away from new code; the legacy code retains it
  until Phase 3 deletes the legacy endpoints.
- `apps/web/src/lib/task-runner.ts`:
  - Emit explicit `task-started` event in `submitTask` (right after the
    in-memory record is created, before any agent work).
  - Distinguish `task-completed` / `task-error` from the SDK-protocol
    `finish` event. Today they're merged.
  - Emit `queue-updated` events on push / pop / reorder / clear in
    `queued-message-store.ts`.
- `apps/web/src/lib/queued-message-store.ts`: hook broadcasts to current
  chat's subscribers on mutation.
- `apps/web/src/lib/chat-session-summary.ts`:
  - Delete or scope-down the `getLatestSession` on-disk fallback. Active
    session is whatever the latest `session-resolved` event says — no
    filesystem heuristics. Keep `getSessionInfo` for tab-title
    materialisation (a different concern).
- `apps/web/src/trpc/router.ts`:
  - `sessions.messages` stays, but the chat view stops calling it. The
    session-history dropdown's preview still uses it.
  - `tasks.isRunning`, `tasks.get` stay for non-chat consumers (project
    list dot, status indicators).
  - `chats.setActiveSession` becomes a no-op or is removed. Active
    session is derived from the latest `session-resolved` event in the
    log.

### Client

- New file: `apps/web/src/components/chat/useChatSubscription.ts` — the
  hook described above. ~150 lines including the reducer.
- New file: `apps/web/src/components/chat/chat-event-reducer.ts` — pure
  reducer mapping `ChatEvent` to render state. Tested with `node:test`
  fixtures of event sequences.
- `apps/web/src/components/ChatView.tsx`: gut the orchestration. Keep
  the JSX, the DnD, the input UX. Delete (in order of cost saved):
  - `sessionIdRef`, `lastEventIdRef`, `firstEventIdRef`,
    `firstMessageIndexRef`, `connectAbortRef`, `statusRef`,
    `initialSessionCleared`, `prevWsActiveRef`, `prevVisibleRef`.
  - `loadMessages`, `loadOlderMessages`, the
    initial-history-load `useEffect`, the focus/online listener, the
    wsActive deactivate/reactivate effect, the visibility listener
    (the hook owns it), the entire `connectToRunningStream` retry
    loop, `serverTaskRunning`, `effectiveWsActive`, `docVisible`,
    `handleSelectSession`, `handleNewSession`.
  - The `useChat` hook from `@ai-sdk/react`.
- `apps/web/src/lib/task-chat-transport.ts`: delete (replaced by the
  hook's internal `EventSource` + POST).

Estimated net delta: **−1200 lines on the client, +300 lines for the
hook + reducer + tests.**

## Migration strategy

Three phases, each ships independently behind a feature flag in
`~/.band/settings.json` (`experimentalChatV2: boolean`, default false).

### Phase 1 — server-side stream (1 day)

- Add `GET /api/chats/:chatId/events` and `POST /api/chats/:chatId/messages`.
- Add `task-started` / `task-completed` / `task-error` / `queue-updated`
  events in `task-runner`.
- Keep all existing endpoints working. No client change.
- Smoke-test with `curl` and verify the event sequence matches the existing
  POST `/api/tasks/:chatId/stream` flow for a simple turn.

### Phase 2 — client hook + flag (1 week)

- Implement `useChatSubscription` and the reducer. Unit-test the reducer
  with recorded event sequences from real chats.
- In `ChatView.tsx`, branch on the flag: legacy `useChat` path vs. new
  hook. Both render the same JSX (the JSX doesn't care where `messages`
  comes from).
- Dogfood the new path behind the flag. Iterate.

### Phase 3 — flip default, remove legacy (2-3 days)

- Default the flag on after a week of dogfooding.
- Delete the legacy code paths (`useChat`, `TaskChatTransport`,
  `loadMessages`, the focus/visibility/wsActive plumbing, etc).
- Delete or alias the legacy server endpoints.
- Update `docs/web-architecture.md`.

## Risks and mitigations

### Risk: JSONL → eventId mapping

JSONL events don't have buffer eventIds. The replay code needs to
synthesise IDs that won't collide with the live buffer's IDs.

**Mitigation**: when replaying from JSONL on cold-subscribe with empty
buffer, assign IDs starting at `1` and let the buffer pick up from
`(last JSONL id) + 1` for new events. When the buffer has a partial tail
and JSONL has the prefix, the buffer's `firstEventId` is known; JSONL
events get IDs `firstEventId - N` decremented (so they sort before the
buffer's tail). Clients only care about monotonicity within a single
subscription session, not about ID stability across reconnects.

### Risk: `Last-Event-ID` after server restart

In-memory buffer eventIds reset on server restart. A client that was at
`Last-Event-ID: 5000` would request events past 5000, but post-restart
the new buffer starts at 1.

**Mitigation**: server detects the gap (request `Last-Event-ID` >
buffer's current `counter` value) and falls back to a full JSONL replay
plus a `server-restarted` lifecycle event so the client can warn the
user (or quietly reset). Document the limitation; persistent eventIds is
a separate, larger project.

### Risk: subscription connection limits

Browsers cap concurrent SSE connections per origin around 6. Dockview
keeps multiple chat panes alive simultaneously, plus terminals, browser
preview, etc.

**Mitigation**: the hook only opens the subscription when
`document.visibilityState === 'visible'` AND the pane is the dockview's
active tab (today's `wsActive` semantic). When hidden, the subscription
closes; on show, it reopens with `Last-Event-ID`. This is what we
already do today via `transport.close()` — the new code does it the
same way, just with cleaner lifecycle ownership inside the hook.

### Risk: regression in send latency

Without optimistic state, the user message bubble appears only after
the server's `user-message` echo arrives over the subscription. If the
subscription is in a slow state, this could feel laggy.

**Mitigation**: measure first. If round-trip is >50ms p95, add a
stamped optimistic record that the echo replaces. Don't preemptively
build optimistic state.

### Risk: multiple tabs editing the same chat

Two windows open the same chat → two subscriptions → both see the same
event log. Today's queue is per-chat in `queuedMessages` map; both tabs
see queue updates. Already works because of the broadcast model.

### Risk: behavioural drift between legacy and new path during Phase 2

Two code paths in production for a week.

**Mitigation**: keep the JSX identical. Both branches feed the same
render tree. Bugs that show up in one but not the other are diagnosable
by toggling the flag.

## Testing strategy

The integration-test pattern from `CLAUDE.md` applies. Specifically:

- `apps/web/tests/chat-events.test.ts` — black-box test of the new
  `GET /api/chats/:chatId/events` endpoint. Boot the real server, submit
  a task via `POST /api/chats/:chatId/messages`, subscribe with
  `Last-Event-ID=0`, assert the event sequence. Variants:
  - Reconnect with non-zero `Last-Event-ID` mid-task → gap-filled.
  - Reconnect after task completion → full replay (no 204).
  - Reconnect after server restart → graceful full replay.
  - Two concurrent subscribers → both see same events.
- `apps/web/tests/chat-event-reducer.test.ts` — pure unit-style test of
  the reducer over fixture event sequences captured from real runs
  (recorded with a small helper in dev mode). Tests pure-function
  shape, so this is the one acceptable place to test without a real
  server.
- The existing `chat.test.ts` / `queue-drain.test.ts` keep working
  because the legacy endpoints stay during Phase 1-2.

## Open questions

- **Keep subscription open across turns?** When a task completes, should
  the SSE stay open waiting for the next user message, or close and let
  the client reopen on send? Closing simplifies server resource
  accounting; staying open avoids the small reconnect blip on send.
  Default: close. Reconsider after measuring.
- **Page size for JSONL replay on cold subscribe?** Currently
  `sessions.messages` uses 100 messages by default. For a multi-thousand-
  event session, full replay is heavy. Options: keep pagination
  (subscription emits oldest N events then a `history-cursor` marker;
  client requests older pages on scroll-up via a separate endpoint), or
  emit everything and trust gzip. Default: keep pagination; this is
  what the session-history dropdown already needs.
- **Drop `chats.activeSessionId` entirely?** It's used for tab titles
  today. We could keep it as a write-through cache that the server
  updates from `session-resolved` events, never read by the chat view.
  Default: keep, scope to UI metadata only.
- **What about the CLI?** `band` CLI shells out to the same tRPC
  procedures. Phase 3's removals would break it. Inventory first; keep
  any procedures the CLI depends on.

## Estimated effort

| Phase                              | Calendar      |
| ---------------------------------- | ------------- |
| Server endpoints + event types     | 1 day         |
| Reducer + hook + tests             | 3-4 days      |
| Wire into ChatView behind flag     | 1 day         |
| Dogfood + bugfix                   | 1 week        |
| Flip default + delete legacy       | 2-3 days      |
| **Total**                          | **~2 weeks**  |

The expensive complexity is on the client side; Path B's value is
collapsing ~1200 lines of orchestration in `ChatView.tsx` into ~300
lines of subscription hook + reducer. The server changes are just
enough to give that hook a clean stream to read from.

## Implementation checklist (single-PR scope)

The entire refactor lands in one PR. No feature flag, no parallel paths,
no dogfood window. The constraints that shape the ordering:

- **Branch stays green between commits.** Server endpoints can coexist
  with old ones during development; the cutover happens in one focused
  commit near the end.
- **The seven bugs enumerated in "Why" must be demonstrably fixed by
  the merged PR** — measured by tests (existing + new) plus a manual
  repro walk.
- **Legacy code gets deleted in the same PR, not later.** No "we'll
  clean up after."
- **Existing patches in this branch get rolled back as part of the
  refactor** (the whole point is that those layers disappear). Don't
  spend time preserving them.

### 1. Groundwork (1 commit, ~half day)

- [x] Revert the existing patchwork fixes added in this branch to
      `ChatView.tsx` (`serverTaskRunning`, `docVisible`/`effective-
      WsActive`, the multi-branch reactivation effect, the
      synchronous `sendMessage` in `handleSubmit`) and to
      `apps/web/src/api/task-stream.ts` (the drain-on-completed-task
      path) and to `apps/web/src/trpc/router.ts` (the `preferBuffer`
      branch in `sessions.messages`). Keep them in git history as
      reference; the refactor supersedes them.
- [x] Inventory CLI / external dependencies on the tRPC procedures
      that will be removed or repurposed: `sessions.messages`,
      `tasks.get`, `tasks.isRunning`, `chats.setActiveSession`. Note
      anything that must keep working at the end of this PR.

### 2. Wire schema & SSE writer (1 commit, ~half day)

- [x] **`apps/web/src/lib/chat-events.ts`** (new). Define the
      `ChatEvent` discriminated union covering every event type in
      the table above. Exported types are shared by server and
      client — this is the single source of truth for the wire
      format.
- [x] **`apps/web/src/lib/sse-writer.ts`** (new, ~30 lines).
      Headers, `id:` / `event:` / `data:` framing, heartbeat
      comments every 25s. Pure utility — no chat-specific logic.
- [x] **Node unit test** for `sse-writer.ts` — feed it a mock
      `ServerResponse`, assert exact bytes written.
- [x] **Reducer file scaffolded** —
      `apps/web/src/components/chat/chat-event-reducer.ts` with
      `(state, event) → state` signature and empty branches per
      event type. Filled in next commit.

### 3. Reducer with tests (1 commit, ~1 day)

- [x] Fill in `chat-event-reducer.ts`. Each `ChatEvent` variant
      produces a new state object. No I/O, no side effects, no
      `Date.now()` or `Math.random()` calls.
- [x] **`apps/web/src/components/chat/chat-event-reducer.test.ts`**
      with fixture event sequences. Capture fixtures by running
      the existing chat against the existing SSE endpoint and
      saving the chunk stream to disk (one-time effort, ~1 hour).
      Coverage:
  - [x] Empty → `user-message` → `task-started` → `text-delta`s →
        `task-completed`.
  - [x] Tool call lifecycle (`tool-input-available` →
        `tool-output-available`).
  - [x] Interactive tool (`AskUserQuestion`) flow with approval.
  - [x] Queue mutations (`queue-updated`).
  - [x] Session resolution mid-stream.
  - [x] Reconnect with `Last-Event-ID` halfway through — reducer
        receives only the suffix and arrives at the same final
        state as the full sequence.
- [x] Test runner is `node:test` per `CLAUDE.md` convention (or
      `vitest` if these tests end up under `apps/web/tests/`).

### 4. Server endpoints (1-2 commits, ~1-2 days)

- [x] **`apps/web/src/api/chat-events.ts`** (new). `GET
      /api/chats/:chatId/events`. Reads `Last-Event-ID` from
      request headers. Unified replay + live phases. Closes
      cleanly on `task-completed` when no queue remains. No 204
      path — even an idle chat returns `200` and waits for events.
- [x] **JSONL → synthetic eventId** within `chat-events.ts` replay
      phase. When the buffer doesn't cover `Last-Event-ID + 1`,
      page in JSONL via `agent.getSessionMessages`, assign
      synthetic IDs that sort before the buffer's `firstEventId`.
- [x] **`apps/web/src/api/chat-submit.ts`** (new). `POST
      /api/chats/:chatId/messages`. Validates input, calls
      `submitTask`, returns `200 { ok: true }`. Queues server-side
      when a task is already running (no 409 surfaced).
- [x] **Route wiring** in `apps/web/start-server.ts` — two new
      `req.url?.match(...)` branches adjacent to the existing
      `taskStreamMatch` block. Keep the old block alive for now.
- [x] **`apps/web/src/lib/task-runner.ts`** — emit explicit
      lifecycle events:
  - [x] `task-started` in `submitTask`, right after `tasks.set`.
  - [x] `task-completed` distinct from the SDK-protocol `finish`
        event, broadcast on successful `session-result`.
  - [x] `task-error` on failure paths.
- [x] **`apps/web/src/lib/queued-message-store.ts`** — broadcast
      `queue-updated` events on push / pop / reorder / clear.
- [x] **`apps/web/src/lib/chat-session-summary.ts`** — delete the
      `getLatestSession` on-disk fallback (or gate it on "no
      in-memory task running"). The active session is now derived
      from `session-resolved` events in the log.

### 5. Server tests (1 commit, ~1 day)

- [x] **`apps/web/tests/chat-events.test.ts`** (new). Black-box
      integration tests against the real server boot. Cases:
  - [x] Cold subscribe with `Last-Event-ID: 0` for a chat with no
        prior session → 200, empty replay, stream stays open
        awaiting events.
  - [x] Submit via `POST /api/chats/:chatId/messages`, observe via
        the open subscription → expected event sequence in order,
        including `task-started` → `text-delta`s → `task-completed`.
  - [x] Reconnect with non-zero `Last-Event-ID` mid-task → only
        events past it are replayed; stream continues live.
  - [x] Reconnect after task completion → events past
        `Last-Event-ID` are drained, then `task-completed`, then
        the stream closes. No 204.
  - [x] Two concurrent subscribers on the same chat → both receive
        identical event sequences with identical IDs.
  - [x] Submit while a task is running → server queues, emits
        `queue-updated` over the subscription, no error to client.
  - [x] Cold subscribe to a chat whose session pre-dates the
        current server process (no buffer entries) → JSONL replay
        with synthetic eventIds, ordered before any live events.

### 6. Client hook (1 commit, ~1-2 days)

- [x] **`apps/web/src/components/chat/useChatSubscription.ts`**
      (new). Owns:
  - [x] `EventSource` (or `fetch`-streamed reader) lifecycle —
        open / close / reconnect with capped backoff.
  - [x] `Last-Event-ID` cursor management — but use the native
        SSE field, not a manual counter.
  - [x] `visibilitychange` listener — close on hidden, reopen on
        visible.
  - [x] `useReducer` glue to the pure reducer from step 3.
  - [x] Exposed API: `{ messages, status, queuedMessages, send,
        cancel, usage, sessionId, isConnected }`.
- [x] `send(text, files?)` is a `fetch` POST to
      `/api/chats/:chatId/messages`. No client-side optimistic
      state on first cut; measure echo latency before adding.

### 7. Cutover in ChatView (1 commit, ~1 day)

This is the big visible-diff commit. Atomic swap.

- [x] Replace the `useChat` call site in `ChatView.tsx` with
      `useChatSubscription`. Render-tree JSX stays identical.
- [x] Wire `state.send` / `state.cancel` into the existing
      `handleSubmit` / `handleStop` paths.
- [x] Delete from `ChatView.tsx`:
  - [x] `sessionIdRef`, `lastEventIdRef`, `firstEventIdRef`,
        `firstMessageIndexRef`, `connectAbortRef`, `statusRef`,
        `initialSessionCleared`, `prevWsActiveRef`,
        `prevVisibleRef`, `docVisible`, `effectiveWsActive`,
        `serverTaskRunning`.
  - [x] `loadMessages`, `loadOlderMessages` (older-history
        pagination moves into the hook), the initial-history-load
        effect, the focus/online listener, the `wsActive`
        deactivate/reactivate effect, the `connectToRunningStream`
        retry loop, the `tasks.get` mount probe.
  - [x] `handleSelectSession`, `handleNewSession` (move into the
        hook or simplify — `handleNewSession` becomes "tell the
        server to clear the active session and reset reducer
        state").
  - [x] The `useChat` import from `@ai-sdk/react` and the
        `TaskChatTransport` import.
- [x] Delete `apps/web/src/lib/task-chat-transport.ts`.

### 8. Delete legacy server code (1 commit, ~half day)

- [x] Delete the old route block in `apps/web/start-server.ts` for
      `/api/tasks/:chatId/stream`.
- [x] Delete `apps/web/src/api/task-stream.ts`.
- [x] Remove the `createUIMessageStream` /
      `pipeUIMessageStreamToResponse` imports from server code if
      no callers remain.
- [x] Audit tRPC procedures used only by the chat view (per the
      Step 1 inventory). For each:
  - [x] If still needed elsewhere (CLI, project list, etc.):
        keep, but document the chat view no longer calls it.
  - [x] If unused: delete the procedure and its tests.
- [x] If `chats.setActiveSession` survives the inventory, convert
      it to a server-internal write-only path called from
      `task-runner` on `session-resolved` (and drop the tRPC
      exposure).

### 9. Migrate / drop legacy tests (1 commit, ~half day)

- [x] Translate or delete:
  - [x] `apps/web/tests/stream-reconnect.test.ts` — most assertions
        translate one-for-one against the new endpoint; rewrite the
        URL + body shapes, keep the scenarios.
  - [x] `apps/web/tests/stream-gapfill.test.ts` — same treatment.
  - [x] `apps/web/tests/chat.test.ts` — many cases overlap with the
        new `chat-events.test.ts`; keep the ones that exercise
        behaviour the new tests don't cover (queue drain, file
        sharing, etc).
  - [x] `apps/web/tests/chat-multimessage.test.ts`,
        `queue-drain.test.ts`, `todo-write.test.ts`,
        `file-sharing.test.ts` — re-point at the new POST endpoint.
- [x] All tests pass: `pnpm --filter @band-app/server test`.

### 10. Docs + final polish (1 commit, ~half day)

- [x] Update `docs/web-architecture.md` — describe the event-log
      model, the single subscription contract, the disappearance
      of `useChat` / `TaskChatTransport`.
- [x] Add a "wire format" section to the same doc covering the
      `ChatEvent` types, ordering guarantees, reconnect semantics.
- [x] Manual repro walk through the original seven bugs from
      `#478`. Each should be resolved without any patch code —
      because the code paths that produced them no longer exist:
  - [x] Send latency
  - [x] Indicator delay on workspace navigation
  - [x] Stuck after mid-stream switch-back
  - [x] Mobile background/foreground recovery
  - [x] Partial state from buffer-vs-JSONL preference
  - [x] Stuck partial after task finish (race against 204)
  - [x] Wrong session loaded after New-session click
- [x] Performance check — `console.time`s instrumenting
      subscription open → first event, and POST submit →
      `user-message` echo. Document the measured latencies in the
      PR description. Targets: open P95 < 100 ms, echo P95 <
      50 ms on localhost. If echo misses target, add stamped
      optimistic state to the reducer in a follow-up commit
      within this PR.
- [x] `pnpm lint`, `pnpm --filter @band-app/server test`, and the
      pre-push hook all pass.
- [x] Write a thorough PR description: link this doc, summarise
      the seven bugs that disappear, list the deleted files /
      symbols, attach the latency measurements, walk the reviewer
      through the new wire format.

### Sanity checks before requesting review

- [x] Diff is roughly **net negative** in `apps/web/src/` —
      the refactor deletes more than it adds (the plan estimates
      **−1200 / +300** for the chat-specific code).
- [x] No new external dependencies in `apps/web/package.json`.
      The `ai` and `@ai-sdk/react` imports should be **removed**
      from chat code (they may remain elsewhere, e.g. for type
      definitions).
- [x] `git grep "sessionIdRef\|lastEventIdRef\|connectToRunningStream\|TaskChatTransport"` returns nothing under
      `apps/web/src/`.
- [x] `git grep "useChat\b" apps/web/src/` returns only the
      hook's own name (`useChatSubscription`) if anywhere.

### Estimated effort, single PR

| Step                                | Calendar      |
| ----------------------------------- | ------------- |
| 1. Groundwork (revert patches)      | 0.5 day       |
| 2. Wire schema + SSE writer         | 0.5 day       |
| 3. Reducer + tests                  | 1 day         |
| 4. Server endpoints                 | 1-2 days      |
| 5. Server tests                     | 1 day         |
| 6. Client hook                      | 1-2 days      |
| 7. ChatView cutover + deletions     | 1 day         |
| 8. Delete legacy server code        | 0.5 day       |
| 9. Migrate legacy tests             | 0.5 day       |
| 10. Docs + polish + PR description  | 0.5 day       |
| **Total**                           | **~8-10 days**|

Two weeks elapsed if you're working on it 50% — one focused week of
heads-down. The risk profile of doing it all in one PR is higher than
the phased version (no dogfood, no incremental ship), but the payoff
is a single coherent review and no lingering legacy code path.
