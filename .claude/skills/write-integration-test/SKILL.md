---
name: write-integration-test
description: Implement a black-box integration test for a feature against the REAL application — the same binary you ship runs inside the test, external services are stubbed with Express servers on random ports (never MSW, never page.route on your own routes), and tests drive either via real HTTP (backend) or via Playwright + Page Object Model (frontend). Backend and frontend tests share the same server boot and fixtures. Use when asked to "write a test", "add integration test coverage", "add a regression test", "write a Playwright test", "test this endpoint end-to-end", or any time a new feature ships and needs the test that proves it.
allowed-tools: Bash, Read, Edit, Write, Glob, Grep
---

# Write Integration Tests

This skill is the operational playbook — *how* to write an integration test against the Band web app. It is NOT the rule list.

- **The reviewer-enforced rules** live in [`.claude/testing-criteria.md`](../../testing-criteria.md) as `TEST-1`…`TEST-35`. Open that file once before you write your first test on this repo. Both CI (`.github/workflows/claude-review.yml`) and the local `review-and-apply` skill apply it verbatim to your diff.
- **The narrative doctrine** — *why* we test this way — lives in [`docs/integration-testing.md`](../../../docs/integration-testing.md).

Throughout this playbook, prescriptions that correspond to a specific rule are cited inline as *(enforces TEST-N)*. If you intentionally deviate from one, fix it before pushing or cite the ID in your PR description with a justification — the reviewer will flag every unjustified deviation.

Integration tests are the **default proof of correctness** for any user-observable change *(enforces TEST-6)*. Unit tests stay useful for non-observable internals and combinatorial cases, but the integration test is what proves the feature works and what guards against the regression you came here to fix.

## Architecture — One Picture, Both Layers

Backend and frontend tests share the **same** server boot and the **same** fixture model. The only difference is whether the test drives the server through `fetch` or through a browser.

```
┌────────────────────────────────────────────────────────────────────┐
│                       Test Process                                 │
│                                                                    │
│  ┌─────────────┐                                                   │
│  │ Test body   │── fetch ──┐                                       │
│  └─────────────┘            ▼                                      │
│         │             ┌──────────────────────────────┐             │
│         │             │ Real App Server (production  │             │
│         │             │  binary, SSR, auth, tRPC,    │             │
│         │             │  migrations, the works)      │             │
│         │             └──────────────────────────────┘             │
│         │                       │ HTTP (env var override)          │
│         │                       ▼                                  │
│         │             ┌──────────────────────────────┐             │
│         │             │ Express stubs (one server    │             │
│         │             │  per external service, on    │             │
│         │             │  a random port)              │             │
│         │             └──────────────────────────────┘             │
│         │                                                          │
│ Frontend tests ONLY:                                               │
│  ┌─────────────────────┐         drives                            │
│  │ Playwright Browser  │ ◄────────────── Test body                 │
│  │ (Chromium, real)    │                                           │
│  └─────────────────────┘                                           │
│                                                                    │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │ Testcontainers / temp SQLite — real data layer, ephemeral    │  │
│  └──────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────┘
```

Concretely for Band:

- The real binary is `apps/web/dist/start-server.mjs`, spawned with `HOME` pointing at a fresh `mkdtempSync()` directory. It runs migrations against the SQLite DB inside that home automatically *(enforces TEST-3, TEST-34)*.
- External services Band calls out to (GitHub API, agent binaries' HTTP surfaces, etc.) get Express stubs on random ports. The server reads each upstream's URL from an env var at request time, which the fixture overrides *(enforces TEST-4, TEST-30)*.
- Frontend tests boot exactly the same server and additionally drive the rendered UI through Playwright + page objects.

## Decide Which Layer You're Testing

The layer-decision table is in `testing-criteria.md` §2 (rules `TEST-5`–`TEST-7`). Quick orientation:

| Change touches… | Write a… | Lives in… |
|---|---|---|
| HTTP / tRPC / WebSocket / SSE response shape, status, headers, side effects on disk or DB | **Backend API test** | `apps/web/tests/<feature>.test.ts` |
| What the user sees in the rendered DOM, what URL they land on, what's saved in `localStorage` by client code | **Frontend test** | `apps/web/e2e/<feature>.spec.ts` |
| Both | One of each. Don't conflate them. |

A feature that adds an endpoint *and* a UI button needs **two** tests *(enforces TEST-5)*. If the change is purely a CLI command, see the sibling `integration-tests` skill.

---

## Part A — Backend API Integration Test

### Where they live and what runs them

- Path: `apps/web/tests/<feature>.test.ts`.
- Runner: **vitest** (`describe` / `it` / `expect`) — `apps/web` is on vitest *(enforces TEST-8)*. Other packages use `node:test` per `CLAUDE.md` *(enforces TEST-9)*.
- Command: `pnpm --filter @band-app/server test` (from repo root) or `pnpm test` (from `apps/web/`).
- Server helper: `apps/web/tests/helpers/server-runtime.ts` — spawns the real production binary on a random port against a tmp home.

### Minimal shape

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "./helpers/server-runtime";
import { catalogStub } from "./fixtures/catalog";

const TOKEN = "test-token-getMaximizedState";

let server: { url: string; close: () => Promise<void> };
let tmpHome: string;
let catalog: ReturnType<typeof catalogStub>;

beforeAll(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), "band-test-"));
  // Express stubs for external services — START BEFORE the server,
  // so we can hand the server their URLs via env vars.
  catalog = await catalogStub.start();
  server = await startServer({
    home: tmpHome,
    settings: { tokenSecret: TOKEN },
    env: { CATALOG_SERVICE_URL: catalog.baseUrl },
  });
});

afterAll(async () => {
  await server.close();
  await catalog.stop();
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("workspace.getMaximizedState", () => {
  it("returns 401 without a token", async () => {
    const res = await fetch(`${server.url}/trpc/workspace.getMaximizedState`);
    expect(res.status).toBe(401);
  });

  it("returns null when no state has been saved", async () => {
    const url =
      `${server.url}/trpc/workspace.getMaximizedState?input=${
        encodeURIComponent(JSON.stringify({ workspaceId: "ws-1" }))
      }`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.data).toBeNull();
  });
});
```

### Real-server playbook

- **Port 0** *(enforces TEST-10)*. Bind to an OS-assigned port — never hardcode. Tests run in parallel and a hardcoded port collides on the second worker.
- **Temp `~/.band/`** *(enforces TEST-11)*. Override `HOME` to point at `mkdtempSync()`. The server runs migrations against its SQLite DB inside that home automatically.
- **Real HTTP** *(enforces TEST-12)*. `fetch` against `server.url`. No `supertest`, no in-process invocation of the route handler — those bypass the TCP layer and middleware.
- **Real auth** *(enforces TEST-13)*. Write `tokenSecret` into the seeded settings. Send it as `Authorization: Bearer <token>` or as the `band_token` cookie. **At least one negative test** asserts `401` without a token — error paths are part of the contract.
- **Tear down everything** *(enforces TEST-14)*. Server stops, Express stubs stop, child processes are killed, temp directory is removed. Leaked resources cause flakes and CI port exhaustion.

### Asserting

- Assert on **observable outputs only** *(enforces TEST-2, TEST-15)*: HTTP status, response body shape, headers, files on disk, rows in the DB, what arrived at an Express stub, SSE frames received.
- **Pin exact values** for anything the test seeded *(enforces TEST-16)*: `expect(body.email).toBe("test@example.com")` — not `expect.any(String)`.
- Use shape matchers only for genuinely non-deterministic values (UUIDs, system timestamps): `expect(body.id).toMatch(/^[a-f0-9-]{36}$/)`.
- Assert the **full body** when capturing what your server sent to an Express stub *(enforces TEST-17)*. Cherry-picking properties hides drift: `expect(captured).toEqual({ … entire body … })`.
- **Error paths.** Every endpoint test file includes at least one negative case *(enforces TEST-13)*: missing auth, malformed input, non-existent resource.

### Streaming endpoints (SSE / WebSocket)

Connect as a real client, read the stream, assert on the sequence *(enforces TEST-18)*.

```ts
const res = await fetch(`${server.url}/api/status/stream?token=${TOKEN}`);
const reader = res.body!.getReader();
const decoder = new TextDecoder();
let text = "";
const start = Date.now();
while (Date.now() - start < 2000) {
  const { value, done } = await reader.read();
  if (done) break;
  text += decoder.decode(value);
  if (text.includes("expected-marker")) break;
}
expect(text).toMatch(/expected-marker/);
```

Poll with a timeout. Never `setTimeout` to "wait for events to settle".

---

## Part B — Frontend Integration Test

### Where they live and what runs them

- Path: `apps/web/e2e/<feature>.spec.ts`.
- Runner: **Playwright** (`@playwright/test`).
- Command: `pnpm --filter @band-app/server test:e2e`.
- Config: `apps/web/playwright.config.ts` — pins viewport, locale, and timezone for deterministic snapshots.
- Server helper: `apps/web/e2e/helpers/server.ts` — `startServer()` boots the real production binary against a fresh tmp home *(enforces TEST-19)*. **Use it.**

### Critical: Run the real backend. No tRPC mocking.

Frontend tests boot the **same** server backend tests boot. The page they drive renders against real tRPC procedures hitting real handlers that read real state from a real (temp) SQLite DB. Do **not** mock tRPC. Do **not** use `page.route('**/trpc/**', …)`. Do **not** intercept any route your server serves *(enforces TEST-4, TEST-19)*.

If a feature's behaviour depends on an external service (GitHub API, agent process, etc.), stub **that external service** with an Express fixture on a random port, exactly the same way a backend test would. The server reads its URL from an env var at request time and the test fixture overrides the env var.

> **Legacy carve-out:** `apps/web/e2e/helpers/trpc-mock.ts` exists and the two `workspace-switch-*.spec.ts` files use it. Treat that as technical debt to be migrated, **not** as a pattern to copy.

### Minimal shape

```ts
import { rmSync } from "node:fs";
import { toWorkspaceId } from "@band-app/dashboard-core";
import { expect, test } from "@playwright/test";
import {
  createTmpHome,
  seedSettings,
  seedState,
  startServer,
  type ServerHandle,
} from "./helpers/server";
import { WorkspacePage } from "./pages/WorkspacePage";
import { catalogStub } from "./fixtures/catalog";

const TOKEN = "e2e-maximize-state-token";
const WORKSPACE_A = toWorkspaceId("alpha", "main");

// Wide viewport so useIsDesktop() reports true and the shared dockview renders.
test.use({ viewport: { width: 1280, height: 800 } });

let server: ServerHandle;
let tmpHome: string;
let catalog: Awaited<ReturnType<typeof catalogStub.start>>;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  seedState(tmpHome, { projects: [{ name: "alpha", path: "/tmp/fake/alpha",
    defaultBranch: "main", worktrees: [{ branch: "main", path: "/tmp/fake/alpha" }] }] });
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  catalog = await catalogStub.start();
  server = await startServer({
    tmpHome,
    env: { CATALOG_SERVICE_URL: catalog.baseUrl },
  });
});

test.afterAll(async () => {
  await server.close();
  await catalog.stop();
  rmSync(tmpHome, { recursive: true, force: true });
});

test.describe("Maximize state", () => {
  test("Maximizing a pane persists it across workspace switches", async ({ page }) => {
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);
    await workspacePage.goto(WORKSPACE_A);
    await workspacePage.maximizePanel();
    await expect(workspacePage.restoreButton).toBeVisible();
    // …drive the rest of the scenario via page-object methods…
  });
});
```

`createTmpHome`, `seedState`, `seedSettings` set up the home directory and DB state *(enforces TEST-20)*.

### Page Object Model

Tests **never** call `page.getByRole()` / `page.getByTestId()` / `page.goto()` directly in the test body *(enforces TEST-21)*. Everything goes through page objects (one per route/page) and component objects (one per section of a page).

```ts
// apps/web/e2e/pages/WorkspacePage.ts
import { type Locator, type Page, test } from "@playwright/test";

export class WorkspacePage {
  readonly maximizeButton: Locator;
  readonly restoreButton: Locator;

  constructor(
    private readonly page: Page,
    private readonly baseUrl: string,
    private readonly token: string,
  ) {
    this.maximizeButton = page.getByRole("button", { name: "Maximize" });
    this.restoreButton = page.getByRole("button", { name: "Restore" });
  }

  async goto(workspaceId: string) {
    const url = `${this.baseUrl}/workspace/${encodeURIComponent(workspaceId)}/code?token=${this.token}`;
    await test.step(`Navigate to ${url}`, async () => {
      await this.page.goto(url);
    });
  }

  async maximizePanel() {
    await test.step("Maximize active panel", async () => {
      await this.maximizeButton.click();
    });
  }

  async readMaximizedGroup(workspaceId: string): Promise<string | undefined> {
    return await this.page.evaluate(([id]) => {
      const raw = localStorage.getItem(`band:dockview-active:${id}`);
      if (!raw) return undefined;
      return JSON.parse(raw).maximizedGroup;
    }, [workspaceId]);
  }
}
```

A page object always *(enforces TEST-22)*:

- Takes `(page, baseURL, …)` in the constructor.
- Owns the locators as readonly fields.
- Has a `goto(opts)` method — the only place URLs are constructed.
- Has methods that match user-meaningful actions (`maximizePanel`, `addToCart`), not raw Playwright calls.

### Locator strategy

For elements your codebase owns, allowed in **decreasing preference** *(enforces TEST-23)*:

1. **`getByRole("button", { name: "Maximize" })`** — when the role + a system-controlled name (e.g. ARIA label set in code) is enough.
2. **`getByTestId("workspace__maximize-button")`** — default when role alone is ambiguous, or when name would be localised user copy. **BEM convention**: `page__element`.
3. **`getByText(value)`** — only for runtime data the test itself supplied.

Banned:

- CSS selectors (`.btn-primary`, `[class*="active"]`) for elements you own.
- Element IDs.
- `getByRole("link", { name: "Continue" })` when "Continue" is localisable product copy *(enforces TEST-26)*.

**Adding test hooks to production code.** `data-testid` attributes on JSX are the only production-code change tests are allowed to make *(enforces TEST-1)*. Use BEM: `workspace__maximize-button`, `cart-drawer__item-row`.

### Driving and asserting

- **Drive via the page object.** `await workspacePage.maximizePanel()`.
- **Assert via the page object.** `await expect(workspacePage.restoreButton).toBeVisible()`.
- **Wait properly** *(enforces TEST-24)*. `expect(locator).toBeVisible()` and friends auto-retry. Use `expect.poll(() => …)` for non-Playwright assertions (e.g. `localStorage`). Never `page.waitForTimeout(N)` for synchronisation.
- **Negative assertions need a positive anchor** *(enforces TEST-25)*. Prove the alternate state actually rendered before asserting the absence of the previous one.
- **Don't assert text equality on localised copy** *(enforces TEST-26)*. Assert on a `data-testid`, an ARIA attribute, or a `localStorage` value.

---

## Express Stubs — The One Pattern for All External Services

Every external service the app calls out to gets **exactly one** Express stub fixture and **exactly one** env var *(enforces TEST-27)*. If a feature touches three services, you write three fixtures.

### Why Express stubs, not MSW

We do **not** use MSW. Reasons, in order of weight:

1. **Subprocess safety.** Band's server spawns subprocesses (`codex`, `claude-code`, `git`, agent binaries). MSW only intercepts HTTP within the current Node process — anything those subprocesses call goes straight out to the real network and the test isn't sealed. An Express stub on a random port + an env var the subprocess inherits works regardless of which process the call comes from.
2. **Forces good production-code architecture.** Express stubs only work if the app reads upstream URLs from env vars **at request time** (not baked into an `axios.create({ baseURL })` at module load). That's the same property that makes the app configurable in any environment — the test fixture is the forcing function.
3. **One vocabulary.** Doctrine = Express stubs. No "MSW for these calls, Express for those" bookkeeping for reviewers to enforce.
4. **Captures the actual wire request.** No interception polyfill weirdness; you assert on the bytes that left the boundary.
5. **Negligible cost.** A new Express server per fixture takes <5 ms on modern hardware.

### Fixture pattern

```ts
// apps/web/tests/fixtures/catalog.ts  (works for backend OR frontend tests)
import express, { type Express, type Request, type Response } from "express";
import type { Server } from "node:http";

export type CatalogStub = {
  baseUrl: string;
  setGetProductResponse: (body: unknown, opts?: { onRequest?: (r: CapturedRequest) => void }) => void;
  stop: () => Promise<void>;
};

export const catalogStub = {
  async start(): Promise<CatalogStub> {
    const app = express();
    app.use(express.json());
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const port = (server.address() as { port: number }).port;

    return {
      baseUrl: `http://127.0.0.1:${port}`,
      setGetProductResponse(body, opts) {
        app.get("/api/v1/products/:id", (req: Request, res: Response) => {
          opts?.onRequest?.(captureRequest(req));
          res.status(200).json(body);
        });
      },
      stop: () => new Promise<void>((r) => server.close(() => r())),
    };
  },
};
```

Pattern rules, full statements in `testing-criteria.md` §6:

- `set*` methods register routes directly via `app.get(...)`; no mutable shared handler object *(enforces TEST-28)*.
- Test-scoped lifetime: `start()` in `beforeAll`, `stop()` in `afterAll` *(enforces TEST-29)*.
- No browser-level `page.route('**/api/external/*', ...)` interception, even for external services *(enforces TEST-31)*.

### Production-code constraint: read env vars at request time

For a test-scoped env var override to take effect, production code reads it at request time, **not** at module load *(enforces TEST-30)*.

```ts
// CORRECT
class CatalogClient {
  private getBaseUrl() { return process.env.CATALOG_SERVICE_URL!; }
  async fetchProduct(id: string) {
    return fetch(`${this.getBaseUrl()}/api/v1/products/${id}`);
  }
}

// WRONG — baseURL frozen at module load
class CatalogClient {
  private client = axios.create({ baseURL: process.env.CATALOG_SERVICE_URL });
}
```

If you encounter the second shape, refactoring it to the first is part of writing the fixture. That refactor is the *only* allowed production-code change (alongside `data-testid` attributes) — see TEST-1.

### Capturing requests for assertions

Use `onRequest` callbacks + an array. Assert the **full body** with `toEqual` *(enforces TEST-32)*.

```ts
const captured: CapturedRequest[] = [];
catalog.setGetProductResponse({ id: "p1", name: "Foo" }, {
  onRequest: r => captured.push(r),
});

await workspacePage.openProduct("p1");

await expect.poll(() => captured).toHaveLength(1);
expect(captured[0]).toEqual({
  method: "GET",
  path: "/api/v1/products/p1",
  headers: expect.objectContaining({ authorization: "Bearer real-token" }),
  body: null,
});
```

### Test data factories

Each fixture has a `test-data.ts` with builder functions returning realistic-but-obviously-fake response shapes *(enforces TEST-33)*. Use **obviously fake** defaults (`"product-id-value"`) so a reader can tell at a glance which fields the test cares about.

```ts
export function createProductResponse(overrides: Partial<ProductBody> = {}): ProductResponse {
  return { body: { id: "product-id-value", name: "product-name-value", priceCents: 0, ...overrides } };
}
```

---

## Databases & Stateful Stores

Band uses SQLite inside `~/.band/band.db`. Each test gets a fresh DB by virtue of the tmp home — no testcontainers needed *(enforces TEST-34)*. The server runs migrations against it during boot. Test isolation comes from each test owning its own home directory.

For projects with Postgres / Redis / MongoDB / S3-compatible storage, follow `docs/integration-testing.md` §11 *(enforces TEST-35)*: testcontainers per worker, tracked-cleanup for inserted records, never `TRUNCATE` / `FLUSHDB` (that would destroy data from concurrent tests on the same worker).

---

## BDD Scenarios (optional but encouraged)

`docs/integration-testing.md` §7 describes a scenario registry: every spec maps to a named `scenario(given, when, then)` entry, and `scenarioTest("name", fn)` annotates the Playwright test with the BDD text. Adopt it when the suite is past ~10 tests and the duplication starts to bite.

For now, plain `test("clear-name", fn)` with a name that *reads* as a scenario is acceptable. Bootstrap `scenarios/` and `pages/` as part of the feature PR that introduces them — never defer test infrastructure to a follow-up.

---

## Quick Decision Tree

```
Is the change user-observable in the rendered UI?
├── Yes → frontend test (Playwright, apps/web/e2e/)
│        ├── Boot the REAL server (startServer + tmp home)
│        ├── Stub external services with Express fixtures (no tRPC mock, no MSW)
│        ├── Drive via page objects
│        └── Assert on DOM, localStorage, URL, request capture
└── No (server-side only)
    ├── Backend test (vitest, apps/web/tests/)
    │   ├── fetch against the REAL server on port 0
    │   ├── Same Express fixtures as frontend tests
    │   └── Temp ~/.band/ + migrations
    └── CLI / binary spawning → see the `integration-tests` skill
```

---

## Before You Ship

Open [`.claude/testing-criteria.md`](../../testing-criteria.md). Scan `TEST-1`…`TEST-35` and confirm every rule that applies to your test is satisfied — the reviewer (CI + `review-and-apply`) will do exactly that. The criteria file's quick-reference table (§8) is the highest-yield place to start; it maps the disqualifying mistakes to their rule IDs.

If you find a rule you don't satisfy: fix it, or cite the ID in the PR description with a justification ("intentional deviation from TEST-X because …"). Silent deviations get flagged.

When you finish writing the test, **run it twice**: once on its own, once as part of the full suite. Both must pass. Then run it on the **previous** commit (the one with the bug, if it's a regression test) and confirm it *fails*. A test that passes on the broken code is not testing what you think it is.
