# Testing Criteria

The source of truth for what a Band PR review checks on **test changes** under `apps/hub/tests/**`, `apps/web/tests/**`, `apps/web/e2e/**`, and any `*.test.ts` / `*.spec.ts` in the repo. Each criterion has a stable ID (`TEST-N`) — cite the ID when you flag a violation.

This file is loaded by:

- `.claude/agents/testing-reviewer.md` (the testing specialist that applies these rules)
- `.claude/skills/review-changes/SKILL.md` (the orchestrator that dispatches the testing-reviewer)
- `.github/workflows/claude-review.yml` (CI)

`.claude/skills/write-integration-test/SKILL.md` and `docs/integration-testing.md` are the narrative explainers that show implementers *how* to write these tests. They are reference material — when this file and the narratives disagree, **this file wins** and the narratives are stale; flag them.

Output format and severity vocabulary are defined inline in `.claude/agents/testing-reviewer.md`. Don't restate them here.

## 1. Cardinal rules — any violation is a blocker

These four are non-negotiable.

- **TEST-1** *(blocker)* — **No production code modified to make a test pass.** No test-only flags. No `if (process.env.NODE_ENV === "test")` branches in business logic. No `export` of internals "so the test can import it". The **only** production-code changes a test is allowed to make are:
  1. Adding a `data-testid` attribute on a JSX element.
  2. Refactoring an outbound URL to be read from an env var **at request time** (not at module load) so the test can override it (see TEST-30).
  Any other production-code edit landing in the same diff as a new test is a blocker.
- **TEST-2** *(blocker)* — **Black-box only.** Tests drive the system through the same surface a real client uses: HTTP, the rendered DOM, files on disk, the CLI's stdout/stderr/exit code. A new test that `import`s an internal module from `apps/hub/src/server/services/**` or `apps/hub/src/server/infra/**` and calls it directly is a blocker. Asserting on internal state (private fields, module-level singletons, etc.) is also a blocker.
- **TEST-3** *(blocker)* — **The real binary runs inside the test.** Both backend and frontend tests boot the production server (`apps/hub/dist/start-server.mjs`) via `startServer()` against a fresh tmp home. No shallow renders, no `renderHook` from `@testing-library`, no in-memory React mounts, no test-only build flags. New tests that mount React in-process for behaviour that's user-observable in the rendered DOM are a blocker.
- **TEST-4** *(blocker)* — **Mock only what is external to the server process.** External = third-party APIs, identity providers, agent binaries' HTTP surfaces, GitHub, etc. **Use Express stubs on a random port + an env-var override read at request time.** All of the following are blockers in new code:
  - `msw` / `mswjs/data` of any kind.
  - `page.route('**/trpc/**', …)` or any `page.route()` on the app's own routes.
  - `createTrpcMock` from `apps/web/e2e/helpers/trpc-mock.ts` (legacy debt, not a pattern).
  - `vi.mock(…)` / `jest.mock(…)` / `nock` against your own code or your own HTTP surface.
  - `supertest` or any in-process route invocation that bypasses the TCP layer.

## 2. Layer — pick the right one

| Change touches… | Required test | Path |
|---|---|---|
| HTTP / tRPC / WebSocket / SSE response shape, status, headers, DB or filesystem side effects | Backend API test (vitest) | `apps/hub/tests/<feature>.test.ts` |
| What the user sees in the rendered DOM, the URL they land on, what's saved in `localStorage` by client code | Frontend test (Playwright) | `apps/web/e2e/<feature>.spec.ts` |
| Both | One of each. Don't conflate them. |
| CLI / binary spawning behaviour | Per the sibling `integration-tests` skill | — |

- **TEST-5** *(blocker)* — A diff that adds a new endpoint *and* a UI button needs two tests — one per layer. Missing either is a blocker for that layer.
- **TEST-6** *(blocker)* — A user-observable change ships without an integration test → blocker. Unit tests for non-observable internals are still allowed, but they do not replace the integration test.
- **TEST-7** *(blocker)* — A new test under `apps/web/e2e/` that does not boot the real server (no `startServer` from `e2e/helpers/server.ts`) is a blocker.

## 3. Test framework — match the package

- **TEST-8** *(nit)* — `apps/hub` and `apps/web` use **vitest** (`describe`/`it`/`expect`/`beforeAll`). New tests under `apps/hub/tests/`, `apps/web/tests/` or `apps/web/e2e/` must use vitest (or `@playwright/test` for `e2e/`). A new `node:test` + `node:assert/strict` test under `apps/web/` is a nit — call out the inconsistency.
- **TEST-9** *(blocker)* — All other packages use **`node:test` + `node:assert/strict`**. A new vitest/jest dependency in a package that doesn't already have one is a blocker.

## 4. Backend integration tests — the real-server checklist

For every new test at `apps/hub/tests/<feature>.test.ts`:

- **TEST-10** *(blocker)* — Boots the server via `startServer({ home, settings, env })` from `apps/hub/tests/helpers/server-runtime.ts`. Hardcoding a port (other than `0` for OS-assigned) is a blocker.
- **TEST-11** *(nit)* — Uses `mkdtempSync()` for `HOME`. The temp dir is removed in `afterAll`. Missing teardown is a nit (or a blocker if it leaks subprocesses — see TEST-14).
- **TEST-12** *(blocker)* — Drives the server via real `fetch` against `server.url`. No `supertest`, no direct route handler imports.
- **TEST-13** *(blocker)* — Real auth: a `tokenSecret` is seeded into settings; requests send `Authorization: Bearer <token>` or the `band_token` cookie. **At least one negative test** asserts `401` without a token — missing is a blocker.
- **TEST-14** *(blocker)* — Teardown is complete: server stops, Express stubs stop, child processes are killed, tmp dir is removed. A leaked resource is a blocker — it causes flakes and port exhaustion in CI.
- **TEST-15** *(nit)* — Assertions are on observable outputs only: HTTP status, response body, headers, files on disk, DB rows, request bodies captured at an Express stub, SSE frames. Asserting on internal state is escalated to a blocker under TEST-2.
- **TEST-16** *(blocker)* — Seeded values are pinned with `toBe` / `toEqual`. `expect.any(String)` / regex matchers are only used for genuinely non-deterministic values (UUIDs, system timestamps). Using `expect.any()` for a value the test itself seeded is a blocker.
- **TEST-17** *(nit)* — Captured outbound requests are asserted as full bodies (`expect(captured).toEqual({ … entire body … })`). Cherry-picking a subset of properties is a nit — drift hides bugs.
- **TEST-18** *(blocker)* — Streaming endpoints (SSE / WebSocket) are tested as streams: connect with `fetch`, read frames with a timeout-bounded loop, assert on the sequence. `setTimeout` for "let events settle" is a blocker.

## 5. Frontend integration tests — the Playwright checklist

For every new test at `apps/web/e2e/<feature>.spec.ts`:

- **TEST-19** *(blocker)* — Boots the real backend with `startServer` from `apps/web/e2e/helpers/server.ts`. A test that uses `createTrpcMock` for new behaviour is a blocker (legacy `workspace-switch-*.spec.ts` files are the only carve-out).
- **TEST-20** *(nit)* — Uses `createTmpHome`, `seedState`, and `seedSettings` to set up the home directory and DB state.
- **TEST-21** *(blocker)* — Drives the page through a **Page Object Model** under `apps/web/e2e/pages/`. The test body never calls `page.goto()`, `page.getByRole()`, or `page.getByTestId()` directly — only methods like `workspacePage.maximizePanel()`. Raw locators in the test body are a blocker.
- **TEST-22** *(nit)* — Page objects take `(page, baseUrl, …)` in the constructor, own locators as readonly fields, and have a `goto()` method that is the only place URLs are constructed.
- **TEST-23** *(blocker)* — Locator priority for elements the codebase owns, in decreasing preference:
  1. `getByRole(role, { name })` when the ARIA name is system-controlled.
  2. `getByTestId("page__element")` — BEM convention.
  3. `getByText(value)` — only for runtime data the test supplied.
  Using a CSS selector (`.btn-primary`, `[class*="active"]`), an element ID, or `getByText` for localisable copy is a blocker.
- **TEST-24** *(blocker)* — Synchronisation uses auto-retrying assertions (`expect(locator).toBeVisible()`, `expect.poll(() => …)`). Any `page.waitForTimeout(N)` in a new test is a blocker.
- **TEST-25** *(nit)* — Negative assertions have a positive anchor (prove the new state rendered before asserting the old state is gone). A bare `await expect(loc).not.toBeVisible()` with no positive companion is a nit.
- **TEST-26** *(blocker)* — Text equality assertions are not used on localisable product copy — assert on `data-testid`, an ARIA attribute, or `localStorage`. `expect(page.getByText('Saved')).toBeVisible()` for English UI copy is a blocker.

## 6. Express stubs — the one pattern for all external services

For every external service the change touches:

- **TEST-27** *(nit)* — One Express stub per external service, one env var per service. Bundling two services into one stub by exporting two env vars is a nit.
- **TEST-28** *(blocker)* — Stub lives under `apps/hub/tests/fixtures/` (or `apps/web/e2e/fixtures/`) and exports an object with `start()`, `stop()`, `baseUrl`, and `set*` methods. `set*` methods register routes directly via `app.get(...)` / `app.post(...)`. Sharing a mutable handler object across tests is a blocker — that pattern leaks state across tests.
- **TEST-29** *(nit)* — Lifetime is test-scoped: `start()` in `beforeAll`, `stop()` in `afterAll`. Sharing a single stub instance across spec files is a nit — call out the implicit coupling.
- **TEST-30** *(blocker)* — Production code reads the upstream URL **at request time**, not at module load. `axios.create({ baseURL: process.env.X })` at the top of a module is a blocker — refactor to a `getBaseUrl()` method called inside the fetch. (This refactor is one of the two allowed production-code changes a test may introduce — see TEST-1.)
- **TEST-31** *(blocker)* — No browser-level `page.route('**/api/external/*', ...)` interception, even for external services. The env-var override is the only mechanism.
- **TEST-32** *(nit)* — Captured-request assertions use `onRequest` callbacks pushed into an array, then asserted with `toEqual({ method, path, headers, body })` for the full request.
- **TEST-33** *(suggestion)* — Test-data factories live in a `test-data.ts` next to the fixture and return obviously-fake values (`"product-id-value"`) so a reader can see what the test cares about.

## 7. Databases & stateful stores

- **TEST-34** *(blocker)* — Band uses SQLite in `~/.band/band.db`. Tests get a fresh DB via the tmp `HOME` — the server runs migrations on boot. **No DB mocking.** Mocking the data layer is a blocker.
- **TEST-35** *(blocker)* — For services with Postgres / Redis / MongoDB / S3 (if introduced), follow the testcontainer doctrine: containers per worker, tracked cleanup of inserted records, **never** `TRUNCATE` / `FLUSHDB` (that destroys data from concurrent tests on the same worker).

## 8. Quick-reference — disqualifying mistakes

| Mistake | Rule | Severity |
|---|---|---|
| `page.route('**/trpc/**', ...)` in a frontend test | TEST-4 | blocker |
| Outbound HTTP stubbed with MSW | TEST-4 | blocker |
| `page.waitForTimeout(500)` after a click | TEST-24 | blocker |
| `page.goto(...)` directly in the test body | TEST-21 | blocker |
| `vi.mock('../db', …)` / `jest.mock('./fetch', …)` | TEST-4 | blocker |
| `expect(page.getByText('Saved')).toBeVisible()` for English copy | TEST-26 | blocker |
| `expect(body.id).toBe('abc-123')` when the server generates the id | TEST-16 | blocker |
| Importing the route handler from the test and calling it directly | TEST-12 | blocker |
| Skipping an error-path test "because the fixture doesn't support it" | TEST-13 | blocker |
| One Express stub shared across all tests via a mutable handler | TEST-28 | blocker |
