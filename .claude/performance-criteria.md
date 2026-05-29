# Performance Criteria

The source of truth for what a Band PR review checks on **performance concerns** — query patterns, hot-path loops, sync I/O in handlers, render-time work, pagination, large responses. Each criterion has a stable ID (`PERF-N`) — cite the ID when you flag a violation.

This file is loaded by:

- `.claude/agents/performance-reviewer.md` (the performance specialist that applies these rules)
- `.claude/skills/review-changes/SKILL.md` (the orchestrator that dispatches the performance-reviewer)
- `.github/workflows/claude-review.yml` (CI)

Output format and severity vocabulary are defined inline in `.claude/agents/performance-reviewer.md`.

## 1. Query patterns

- **PERF-1** *(blocker)* — **No N+1 queries.** A loop that issues one DB query per iteration over a user-controlled list (or any list of unbounded size) is a blocker. Use batch fetches (`WHERE id IN (...)`), joins, or a Drizzle-level eager-load.
- **PERF-2** *(nit)* — **List endpoints support pagination.** A new endpoint that returns a collection without `limit` / `cursor` / `offset` is a nit unless the collection is provably bounded (e.g. a per-user setting list with a hard cap defined in code).
- **PERF-3** *(suggestion)* — **Indexed columns for new query patterns.** A new query that filters or joins on a column without an index scales poorly. Either add the migration with the index in the same PR, or flag the missing index as a follow-up issue.

## 2. Hot-path loops

- **PERF-4** *(blocker)* — **No unbounded loops over user input.** Loops driven by request payloads (array length, recursion depth, pagination cursors) must enforce a hard cap. A single 10-MB JSON array in a request body should not pin a CPU for minutes.
- **PERF-5** *(nit)* — **Hot-path measurement guidance.** When flagging a perf concern in code that runs frequently, name the multiplier in the finding: "this runs per ingested event — at 10k events/sec the cost is N ms × 10k = X." Make the math visible to the author.

## 3. Synchronous I/O

- **PERF-6** *(blocker)* — **No large synchronous I/O in request handlers.** `readFileSync`, `statSync`, `execSync` on user-controlled paths inside an API/tRPC handler is a blocker — it parks the event loop for the duration of the I/O. Use the async equivalents.
- **PERF-7** *(nit)* — **No sync I/O in per-request middleware.** A middleware that reads a config file synchronously on every request (vs once at boot, cached) is a nit. Use a one-time read at module init.

## 4. Frontend render paths

- **PERF-8** *(nit)* — **No network calls from a React render function.** A `fetch` directly inside a component body (not in an effect, query hook, or event handler) re-fires every render. Move it to `useEffect` or a query hook.
- **PERF-9** *(suggestion)* — **Memoize derived values that drive re-renders.** `useMemo` / `useCallback` for derived values passed as props to children that depend on referential stability. Don't blanket-memoize; only when there's a measurable re-render cost.

## 5. Large responses

- **PERF-10** *(suggestion)* — **Stream large responses, don't buffer.** `JSON.stringify` on a large array in a response handler builds the whole string in memory before sending. For lists that can grow beyond ~1 MB, consider streaming JSON, paginating, or returning a downloadable artifact.
