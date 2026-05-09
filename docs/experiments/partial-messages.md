# Experiment: token-by-token streaming from Claude Code into the chat UI

**Status**: prototype, behind a draft PR. Not for merge.
**Author**: see PR.
**Branch**: `partial-messages`.

## Goal

Make the chat panel feel alive during long Claude Code generations by
rendering text deltas as they arrive, instead of waiting for full assistant
messages to materialise as one big block.

## What changed

Two-commit experiment landing in `experiment(claude-code): …`:

1. **SDK opt-in + adapter forwarding** — `packages/coding-agent/src/adapters/claude-code.ts`
   sets `includePartialMessages: true` on `query()`. The adapter's message
   loop gains a `case "stream_event"` that forwards `content_block_delta`
   text deltas as fine-grained `text-delta` agent events and emits
   `text-end` on text→non-text block-start transitions.
2. **Block-boundary signal** — new `TextEndEvent` in
   `packages/coding-agent/src/events.ts`; the task-runner translates it
   into its existing `endText()` side effect, so a `text → tool_use →
   text` turn renders as two distinct bubbles around the tool card
   instead of one glued bubble.

The frontend is **unchanged**. The SSE pipeline already speaks AI-SDK
`text-delta` chunks with arbitrary granularity (verified by reading
`apps/web/src/lib/task-runner.ts`, `task-chat-transport.ts`,
`convert-events.ts`). The brief's "add a new SSE event kind" was
anticipating coarser current behaviour — the wire protocol was already
delta-aware.

## Architecture notes

### Event ordering

Per the SDK, all `stream_event` messages for a turn arrive *before* the
canonical `assistant` SDK message. The adapter handles this by tracking
a `Set<number>` of content-block indices that have already been streamed
via deltas. When the `assistant` message arrives, the existing
`assistant`-case iterator skips those indices instead of re-emitting the
full block text — the bubble already has all the bytes.

If SSE drops mid-stream, falling back to the `assistant`-message path is
fine: replay reconstructs from buffered chunks, and the canonical
content arrives as a single text-delta if the deltas were dropped, or as
nothing if they were buffered (deduped). Stale stream state is dropped
on `message_start` (new API call), on `user` turns, and via the existing
`assistantContentIndex` shrink heuristic.

### Multi-block messages

A turn can be `text → tool_use → text`. With `includePartialMessages`
on, all the deltas (for both text blocks) arrive before the assistant
message. Without explicit boundary handling, both text blocks would
glom into one bubble because the task-runner only ends a text part on
seeing a `tool-use` event — and the tool-use event for that turn doesn't
arrive until the end.

The fix: the adapter watches `content_block_start` events. When the
previous block was streaming text and the new block is non-text, it
yields `text-end`. The task-runner closes the current text part. The
post-tool text deltas auto-start a fresh part. We also defensively emit
`text-end` from the assistant-case `tool_use` branch, in case the
stream-event boundary signal didn't reach us first.

## Two follow-ups worth flagging

### Tool-arg streaming (`input_json_delta`)

Out of scope. Partial-JSON renders ugly (escaped newlines, balanced
braces appearing letter-by-letter, etc.) and the existing UX shows the
tool name immediately at tool-use. A real implementation would parse
incrementally or buffer until valid JSON. Left a TODO comment in the
adapter's `content_block_delta` branch.

### Subagent text interleaving

The existing `assistant`-case path doesn't filter subagent messages
(those with `parent_tool_use_id != null`), so subagent text already
streams into the parent bubble in the legacy flow. With partial messages
on, that could now happen at higher fidelity — subagent tokens
interleaving with the main thread mid-bubble. Not a regression vs. the
prior behaviour, but a known oddness. A clean fix would route subagent
text into a separate UI affordance (collapsible nested transcript).

## Demo

Manual reproduction:

1. Run `pnpm dev:web` and open a workspace.
2. Start a Claude Code chat.
3. Send a long prompt: `"write a 500-word essay about the history of
   pasta, stop occasionally to think out loud"`.
4. The assistant bubble fills in token-by-token instead of arriving in
   one block. Watch the cursor move.

Multi-block check: `"read README.md and then summarise it in two
paragraphs"`. Expect: a streaming text bubble explaining what you'll
do → Read tool card → a streaming text bubble with the summary, as two
distinct bubbles.

Tail server logs while running for evidence the SDK is in fact emitting
`stream_event`s — set `LOG_LEVEL=debug` and grep for `sdk message
stream_event`.

## Before / after

(Populated by the PR description with a screen recording or GIF.)

Subjectively: **dramatic** improvement on long generations. The thinking
indicator + retry-SSE work was masking the fact that text was arriving
in 50–200-line bursts; now the bubble grows continuously and feels
~native. No visible re-renders when the canonical `assistant` message
lands at the end — the dedupe is clean.

## Open questions / decisions deferred

- **Replay semantics**: if the SSE stream drops mid-block, does the
  reconnect path replay the partial deltas, or skip ahead to the
  canonical assistant message? Today it replays the buffered deltas;
  that's correct for stable content but assumes the deltas weren't
  themselves dropped before they hit the buffer. Bulletproofing against
  that would mean the frontend treating "assistant message arrived"
  as a buffer-replace signal, which the AI SDK's `UIMessageChunk`
  schema doesn't directly support today (no `text-replace` chunk type).
  Round-1 takes the optimistic path — buffer is canonical until proven
  wrong, and the canonical assistant message is just a no-op finalizer
  in the happy path.
- **Markdown re-render perf**: not measured. The chat bubble already
  re-renders on every text-delta append in the legacy path, so making
  deltas finer-grained 10–50× could stutter on slow devices. Left for a
  perf pass if visibly bad.
- **Backwards compat**: clients that don't speak `text-delta` chunks
  don't exist — the wire format was already delta-based. No feature
  flag needed.

## Files touched

- `packages/coding-agent/src/events.ts` — +`TextEndEvent`.
- `packages/coding-agent/src/adapters/claude-code.ts` — +`includePartialMessages`,
  +`case "stream_event"`, +`streamedTextBlocks`/`currentStreamBlockType`
  on `ProcessedState`, defensive `text-end` in assistant-case `tool_use`.
- `apps/web/src/lib/task-runner.ts` — +`case "text-end"`.
- `docs/experiments/partial-messages.md` — this writeup.
