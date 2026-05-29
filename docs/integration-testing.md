# Integration Testing — Portable Guide

A doctrine and structural template for integration testing of web applications. Boot the real server, mock only the things that are external to your process, drive HTTP directly (backend) or the rendered DOM via Playwright (frontend), and define every test as a named BDD scenario.

This guide covers both layers — **backend** integration tests that drive the real server via `fetch`, and **frontend** integration tests that drive the rendered UI through a real browser. They share the same server boot, the same external-service fixtures, and the same data layer. The only thing that differs is whether the test body talks to the server directly or via Playwright.

---

## Enforcement

The reviewer-checkable rule set distilled from this doc lives in [`.claude/testing-criteria.md`](../.claude/testing-criteria.md) as rules `TEST-1`…`TEST-35`. That file is the **source of truth** for what a PR review enforces — it is loaded verbatim by:

- `.github/workflows/claude-review.yml` (CI runs against every PR), and
- `.claude/skills/review-changes/SKILL.md` (the orchestrator that the local `review-and-apply` skill and CI both invoke; it dispatches `.claude/agents/testing-reviewer.md`).

The implementation playbook for actually *writing* tests against these rules lives in the [`write-integration-test` skill](../.claude/skills/write-integration-test/SKILL.md).

This document is the narrative — the *why*, the examples, the rationale. The criteria file is the rule. When the two disagree, **the criteria file wins** and this doc is stale. A PR that changes one without the other should be flagged.

---

## 1. Doctrine: Integration-Test-First

Integration tests are the **default proof of correctness** for any change that affects user-observable behaviour.

- A test exercises the application from its external surface (HTTP, rendered DOM, outbound traffic).
- A test boots the **real production server binary** — backend tests then drive it via `fetch`; frontend tests drive it via a real browser. No shallow renders, no in-memory React mounts, no in-process route-handler invocation that bypasses the HTTP/middleware layer.
- A test mocks **only** what is external to that server process: APIs, third-party SDKs, message queues, datastores you don't own.
- Unit tests remain useful for: non-externally-visible behaviour (internal helpers, log shaping), combinatorial explosion that's impractical to drive through the integration layer, and any case where the author judges a unit test adds value worth maintaining.

Every change that changes user-observable behaviour ships with the integration test that proves the new behaviour, including any test-infrastructure extensions the test needs (new fixtures, new page objects, new factory helpers). Test infrastructure is in scope for the feature work that needs it — never deferred to a follow-up.

---

## 2. Architecture

Backend and frontend tests share the **same** server boot and the **same** fixture model. The only thing that differs is whether the test body drives the server through `fetch` or through a browser.

```
┌────────────────────────────────────────────────────────────────────┐
│                       Test Process                                 │
│                                                                    │
│  ┌─────────────┐                                                   │
│  │ Test body   │── fetch ──┐                                       │
│  └─────────────┘            ▼                                      │
│         │             ┌──────────────────────────────┐             │
│         │             │ Real App Server (production  │             │
│         │             │  binary, SSR, auth, routing, │             │
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
│  │ Testcontainers / temp datastore — real data layer, ephemeral │  │
│  └──────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────┘
```

Key properties:

- **Real server.** The same Node/Express/Next/whatever process you ship runs inside the test. The SSR pipeline executes; React hydrates in a real browser; the same routing, middleware, auth, and content negotiation paths run.
- **External services stubbed via Express.** Each downstream service gets its own Express server on a random port. The app's env var pointing at that service (e.g. `SERVICE_CRM_URL`) is overridden to the fixture's `baseUrl` for the duration of one test.
- **Datastores real, via testcontainers.** Redis, Postgres, S3-compatible storage — anything stateful the app owns. The test container is started per worker (or per test for strict isolation), and the test cleans up the data it wrote.
- **Browser real (frontend layer only).** Playwright drives Chromium. The rendered DOM is the source of truth for UI assertions. Backend tests skip the browser entirely.

What you do NOT do:
- No `page.route()` interception of your own backend's routes. If the route is served by your server, it goes through your server.
- No mocking the SSR layer, the auth middleware, or the routing layer of the application under test.
- No in-process replacement of internal modules. If you have to monkey-patch your own code to test it, the design is wrong.
- No in-process route-handler invocation from backend tests (no `supertest`, no `import { handler }` then call it). Drive the real server over real HTTP.

---

## 3. Choose Your Layer — Backend or Frontend

Decide what you're testing before you write a line. The two layers test different surfaces and the wrong choice means an expensive test that proves the wrong thing.

| Change touches… | Write a… | Lives in… |
|---|---|---|
| HTTP / WebSocket / SSE response shape, status, headers, side effects on disk or DB | **Backend integration test** | `tests/integration/api/<feature>.test.ts` |
| What the user sees in the rendered DOM, what URL they land on, what's saved in `localStorage` by client code | **Frontend integration test** | `tests/integration/specs/<feature>.spec.ts` |
| Both | One of each. Don't conflate them — they're independent. |
| Pure CLI / binary behaviour | See the framework's CLI-testing guide | — |

A feature that adds an endpoint *and* a UI button needs **two** tests: one proves the endpoint, one proves the button drives the endpoint correctly. Don't try to assert the response body through the UI — the UI may swallow or reshape it.

Quick decision tree:

```
Is the change user-observable in the rendered UI?
├── Yes → frontend integration test (Playwright)
│        ├── Boot the REAL server
│        ├── Stub external services with Express fixtures
│        ├── Drive via Page Object Model
│        └── Assert on DOM, localStorage, URL, captured outbound requests
└── No (server-side only)
    └── Backend integration test (your test runner)
        ├── fetch against the REAL server on port 0
        ├── Same Express fixtures as frontend tests
        └── Real DB (testcontainer or temp datastore)
```

---

## 4. Backend Integration Tests

Backend integration tests boot the real server and drive it via `fetch`. They cover anything the user doesn't see in the rendered DOM — HTTP/tRPC/WebSocket/SSE response shapes, status codes, headers, side effects on disk, rows in the DB, and the requests your server sends to external services.

They share the same server boot, the same Express stubs (§10), the same data layer (§11), and the same auth fixture (§12) as the frontend tests covered in §5–§9.

### Where they live and what runs them

- Path: `tests/integration/api/<feature>.test.ts`.
- Runner: your project's chosen runner (vitest, mocha, `node:test`, jest). Whatever the codebase already uses; don't introduce a second runner for backend integration tests.
- Server helper: `tests/integration/fixtures/ServerFixture.ts` (or equivalent) that spawns the real production binary on a random port against an isolated state directory. The same helper that powers the frontend tests.

### Minimal shape

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "./helpers/server-runtime";
import { catalogStub } from "./fixtures/catalog";

const TOKEN = "test-token-getProduct";

let server: { url: string; close: () => Promise<void> };
let tmpHome: string;
let catalog: Awaited<ReturnType<typeof catalogStub.start>>;

beforeAll(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), "app-test-"));
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

describe("GET /api/v1/products/:id", () => {
  it("returns 401 without a token", async () => {
    const res = await fetch(`${server.url}/api/v1/products/p1`);
    expect(res.status).toBe(401);
  });

  it("returns the product when authenticated", async () => {
    catalog.setGetProductResponse({ id: "p1", name: "Foo", priceCents: 999 });
    const res = await fetch(`${server.url}/api/v1/products/p1`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ id: "p1", name: "Foo", priceCents: 999 });
  });
});
```

### Real-server checklist

- **Port 0.** Bind to an OS-assigned port — never hardcode. Tests run in parallel and a hardcoded port will collide on the second worker.
- **Temp state directory.** Override the env var that points the server at its state directory (e.g. `HOME` if the app stores under `~/.app/`) to a `mkdtempSync()` path. The server runs migrations against its DB inside that directory automatically.
- **Real HTTP.** `fetch` against `server.url`. No `supertest`, no in-process invocation of the route handler — those bypass the TCP layer, middleware, and content negotiation.
- **Real auth.** Seed credentials/tokens into the server's settings file. Requests send the real auth header or cookie. **At least one negative test** asserts the unauthenticated path — error paths are part of the contract.
- **Tear down everything.** Server stops, Express stubs stop, child processes are killed, temp directory is removed. Leaked resources cause flakes and CI port exhaustion.

### Asserting

- Assert on **observable outputs only**: HTTP status, response body shape, headers, files on disk, rows in the DB, what arrived at an Express stub, SSE frames received.
- **Pin exact values** for anything the test seeded. `expect(body.email).toBe("test@example.com")` — not `expect.any(String)`.
- Use shape matchers only for genuinely non-deterministic values (UUIDs, system timestamps): `expect(body.id).toMatch(/^[a-f0-9-]{36}$/)`.
- Assert the **full body** when capturing what your server sent to an Express stub. Cherry-picking properties hides drift: `expect(captured).toEqual({ … entire body … })`.
- **Error paths.** Every endpoint test file includes at least one negative case: missing auth, malformed input, non-existent resource.

### Streaming endpoints (SSE / WebSocket)

Connect as a real client, read the stream, assert on the sequence.

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

Poll with a timeout. Never `setTimeout(N)` to "wait for events to settle".

### Why no `supertest` / no in-process invocation

`supertest` (and any "import the handler, call it directly" pattern) skips the TCP socket and most of the middleware chain. Tests pass that wouldn't pass against the real binary: auth middleware that runs only on real requests, response negotiation, compression, rate limits, body-parser limits, header-canonicalisation differences. The whole point of an integration test is exercising the layers the unit test couldn't — a backend test that bypasses HTTP has become a unit test with extra ceremony.

---

## 5. Directory Structure

```
tests/integration/
├── scenarios/                       # BDD scenarios — the contract
│   ├── scenario-builder.ts          # scenario(given, when, then)
│   ├── scenario-test.ts             # scenarioTest(name, fn)
│   ├── scenario-tags.ts             # tag type definitions
│   ├── index.ts                     # registry of all scenarios
│   └── <feature>/<area>.scenarios.ts
├── specs/                           # Playwright test bodies
│   └── <feature>/<area>.spec.ts
├── pages/                           # Page-object model
│   ├── HomePage.ts
│   ├── <Feature>Page.ts
│   └── components/
│       ├── Header.ts
│       ├── SearchBar.ts
│       └── ...
├── fixtures/
│   ├── index.ts                     # mergeTests() of every fixture
│   ├── PageObjectFixture.ts         # exposes page objects to tests
│   ├── ServerFixture.ts             # boots the application server
│   ├── ApiFixture.ts                # for API-only tests (no browser)
│   ├── AuthSessionFixture.ts        # login helpers
│   ├── external-services/           # one folder per external service
│   │   ├── <service>/
│   │   │   ├── index.ts             # Playwright fixture
│   │   │   └── test-data.ts         # factories for request/response shapes
│   │   └── ...
│   └── utils/
│       ├── CapturedRequest.ts       # request capture for assertions
│       ├── ExpressServerManager.ts  # boots Express on a random port
│       └── matchers.ts              # UUID, ISO_TIMESTAMP, etc.
└── playwright.config.ts             # locale, timezone, workers pinned
```

---

## 6. Running the Application Under Test

The app server runs in-process or as a subprocess started by Playwright's `globalSetup`. The choice depends on whether the framework supports programmatic start.

**Recommended:** Boot the app server in `globalSetup`, expose its base URL via env var, and let `playwright.config.ts` consume it as `use.baseURL`.

```typescript
// playwright.config.ts
export default defineConfig({
    globalSetup: './tests/integration/global-setup.ts',
    use: {
        baseURL: process.env.TEST_APP_URL,
        locale: 'en-US',
        timezoneId: 'UTC',
    },
    workers: 4,
    fullyParallel: true,
});
```

```typescript
// global-setup.ts
export default async function globalSetup() {
    // start your real app, with SSR, on a free port
    const server = await startApp({ port: 0 });
    process.env.TEST_APP_URL = `http://localhost:${server.port}`;
    return async () => server.stop();
}
```

If the framework cannot be started in-process (e.g. Next.js dev mode), use Playwright's `webServer` option. Either way, the binary that runs is the production binary — no test-only build flags.

---

## 7. Writing Scenarios (BDD)

Every test is a named scenario. Scenarios live in `tests/integration/scenarios/` and are the contract — plain-English statements of what the system must do.

### The scenario builder

```typescript
// scenarios/scenario-builder.ts
export interface ScenarioDetails {
    given: string;
    when: string;
    then: string;
    tags: ScenarioTag[];
}

export function scenario(given: string, when: string, then: string) {
    return { given: trim(given), when: trim(when), then: trim(then) };
}

export function taggedScenarios<T extends string>(
    tags: ScenarioTag | ScenarioTag[],
    scenarios: Record<T, Omit<ScenarioDetails, 'tags'>>
): Record<T, ScenarioDetails> {
    const tagArray = Array.isArray(tags) ? tags : [tags];
    return Object.fromEntries(
        Object.entries(scenarios).map(([k, v]) => [k, { ...v, tags: tagArray }])
    ) as Record<T, ScenarioDetails>;
}
```

### Writing scenarios

```typescript
// scenarios/checkout/cart.scenarios.ts
export const cartScenarios = taggedScenarios(['success', 'checkout'], {
    'Adding a product to an empty cart updates the cart count': scenario(
        `Given the user is on the product page
         And the cart is empty`,
        `When the user clicks Add to Cart`,
        `Then the cart count shows 1
         And the product appears in the cart drawer`
    ),

    'Adding the same product twice increments the quantity': scenario(
        `Given the user has one unit of the product in the cart`,
        `When the user clicks Add to Cart on the product page`,
        `Then the cart shows the product with quantity 2`
    ),
});
```

### Scenario formatting rules

1. **Column alignment.** `Given`, `When`, `Then`, and `And` keywords start in the same column inside each template literal. The `A` of `And` sits directly under the `G` of `Given`.
2. **One clause per line.** Never wrap a clause across lines; never put two clauses on one line.
3. **No blank lines inside a clause group.**
4. **Then clauses describe direct consequences of When.** If the Then can be made true purely by configuring the mock response, it is circular — assert on the request the system sent, not the response the test fabricated.
5. **Avoid abstract verbs** ("activated", "triggered", "engaged"). Use concrete observables: "the API request is sent", "the modal is displayed", "the URL changes to X".
6. **Per-data-point scenarios stay distinct.** One scenario per enumerable data point (one per locale, country, plan tier) — not one abstract scenario that loops inside the test.

### Running a scenario as a test

`scenarioTest` looks the name up in the registry and attaches the BDD text as a Playwright annotation plus the tags as `@tag` annotations.

```typescript
// scenarios/scenario-test.ts
import { test } from '../fixtures';
import { allScenarios, ScenarioName } from './index';

export function scenarioTest<T extends ScenarioName>(name: T, fn: Parameters<typeof test>[2]) {
    const s = allScenarios[name];
    if (!s) throw new Error(`Scenario not found: ${name}`);
    const tags = s.tags.map(t => `@${t}`);
    const description = `\n${s.given}\n${s.when}\n${s.then}`;
    test(name, { tag: tags, annotation: { type: 'Scenario', description } }, fn);
}
```

This pattern gives:
- TypeScript-enforced consistency between spec name and a documented scenario.
- Tag-based filtering: `playwright test --grep @api-only`.
- The Playwright HTML report shows test name + BDD annotation + step labels as three abstraction levels.

---

## 8. Writing Specs

Specs implement scenarios. The Given/When/Then maps to fixture configuration, a user action, and assertions on observables.

```typescript
// specs/checkout/cart.spec.ts
import { expect, scenarioTest, test } from '../../fixtures';
import { createProductResponse } from '../../fixtures/external-services/catalog/test-data';

test.describe('Checkout', () => {
    test.describe('Cart', () => {
        scenarioTest(
            'Adding a product to an empty cart updates the cart count',
            async ({ catalog, productPage }) => {
                const productId = 'prod-123';
                const productName = 'Sample Product';

                // Given — fixture setup BEFORE the action
                catalog.setGetProductResponse(createProductResponse({ id: productId, name: productName }));

                await productPage.goto({ productId });

                // When — user action
                await productPage.addToCartButton.click();

                // Then — observable consequences
                await test.step('Verify cart count updates to 1', async () => {
                    await expect(productPage.header.cartCount).toHaveText('1');
                });

                await test.step('Verify product appears in the cart drawer', async () => {
                    await productPage.header.openCartDrawer();
                    await expect(productPage.cartDrawer.itemName(productId)).toHaveText(productName);
                });
            }
        );
    });
});
```

### Step labels

Use `test.step()` for trace-report grouping. Step labels are **short descriptions of what the test code does**, NOT a copy of the BDD clauses (the BDD lives in the scenario file). Examples: `Seed user with active subscription`, `Submit checkout form`, `Verify confirmation email request`.

### Parameterised cases

When N scenarios share the same spec body, use `cases.forEach`. The `name` field must match a scenario in the registry; non-varying values are inlined in the test body.

```typescript
test.describe('Recovery status', () => {
    const cases: { name: ScenarioName; statusCode: string; expectedHeading: string }[] = [
        { name: 'Recovery status shows in progress',
          statusCode: 'in_progress',
          expectedHeading: 'Your request is under review' },
        { name: 'Recovery status shows appeal in progress',
          statusCode: 'appeal_in_progress',
          expectedHeading: 'Your appeal is under review' },
    ];

    cases.forEach(({ name, statusCode, expectedHeading }) => {
        scenarioTest(name, async ({ recoveryService, profilePage }) => {
            recoveryService.setStatusResponse({ status: statusCode });
            await profilePage.goto();
            await expect(profilePage.recoveryBlock.statusHeading).toHaveText(expectedHeading);
        });
    });
});
```

Rules:
- Single-element case arrays are banned. Write the test directly.
- Case objects contain only fields that vary across cases. Constants live in the test body.
- Parameterised case arrays live in their own `test.describe` block — never interleaved with standalone tests.

---

## 9. Page Object Model

Tests never use raw `page.getByRole()`, `page.getByText()`, `page.getByTestId()`, or `page.goto()` in the test body. Everything goes through page objects (one per page) and component objects (one per section of a page).

### Page objects

```typescript
// pages/ProductPage.ts
import { expect, type Page, test } from '@playwright/test';
import { Header } from './components/Header';
import { CartDrawer } from './components/CartDrawer';

interface GotoOptions { productId: string; locale?: string; }

export class ProductPage {
    readonly header: Header;
    readonly cartDrawer: CartDrawer;
    readonly addToCartButton;

    constructor(private readonly page: Page, private readonly baseURL: string) {
        this.header = new Header(page);
        this.cartDrawer = new CartDrawer(page);
        this.addToCartButton = page.getByTestId('product__add-to-cart');
    }

    async goto({ productId, locale }: GotoOptions) {
        const localePart = locale ? `/${locale}` : '';
        const url = `${this.baseURL}${localePart}/products/${productId}`;
        await test.step(`Navigate to ${url}`, async () => {
            await this.page.goto(url);
        });
    }

    async expectActive() {
        await expect(this.page).toHaveURL(/\/products\//);
    }
}
```

A page object always has:
- A constructor that takes `(page: Page, baseURL: string)` and composes component objects.
- A `goto(options)` method — the only place URLs are constructed.
- `expectActive()` / `expectNotActive()` for routing assertions.
- No direct locators of its own (or very few); components own the locators.

### Component objects

```typescript
// pages/components/Header.ts
import { type Locator, type Page, test } from '@playwright/test';

export class Header {
    readonly container: Locator;
    readonly cartCount: Locator;
    readonly cartDrawerToggle: Locator;

    constructor(page: Page) {
        this.container = page.getByTestId('site__header');
        this.cartCount = this.container.getByTestId('site__cart-count');
        this.cartDrawerToggle = this.container.getByTestId('site__cart-toggle');
    }

    async openCartDrawer() {
        await test.step('Open cart drawer', async () => {
            await this.cartDrawerToggle.click();
        });
    }
}
```

A component takes either `Page` (top-level component) or `Locator` (scoped under a parent — supports reuse across pages).

### Locator strategy

For elements defined inside your codebase, use only:
- **`getByRole()`** — preferred when no `name` argument is needed (a single button inside a scoped container).
- **`getByTestId()`** — default when role alone is ambiguous, or when matching by role would require localised copy as the name. Use BEM-style naming: `page__element`.
- **`getByText()`** — only for dynamic content the test itself controls (e.g. a code the test typed).

Banned:
- CSS selectors (`.class`, `#id`, `[class*="…"]`).
- Element IDs.
- `getByRole('link', { name: 'Click here' })` — locating by localised product copy. Reword the copy and the test silently misses.

The only acceptable use of `getByRole({ name })` is when the name is runtime data the test itself supplied.

**For third-party widgets** (e.g. `react-select`) that expose no semantic hook, CSS selectors are acceptable with a comment explaining why.

### Adding inert test hooks to production code

`data-testid` attributes on JSX are the only production-code change tests are allowed to make. Use a BEM convention: `page__element` (`product__add-to-cart`, `checkout__submit`, `cart-drawer__item-row`).

### Page-object fixture

Page objects are handed to tests via a Playwright fixture.

```typescript
// fixtures/PageObjectFixture.ts
import { test as base } from '@playwright/test';
import { ProductPage } from '../pages/ProductPage';
import { CartPage } from '../pages/CartPage';

type PageObjectFixtures = {
    productPage: ProductPage;
    cartPage: CartPage;
};

export const test = base.extend<PageObjectFixtures>({
    productPage: async ({ page, baseURL }, use) => {
        await use(new ProductPage(page, baseURL!));
    },
    cartPage: async ({ page, baseURL }, use) => {
        await use(new CartPage(page, baseURL!));
    },
});
```

---

## 10. Fixtures for External Services

**Definition of "external service":** any service that is NOT running as part of the process producing the frontend application. APIs, third-party SDKs talking over the network, message queues, identity providers — all external. The app's own routes, middleware, SSR — not external.

### One fixture per external service (1:1)

Each external service maps to **exactly one fixture** and **exactly one env var**. If a feature touches three services, you write three fixtures, and the test destructures three fixtures.

### The fixture pattern

A fixture starts an Express server on a random port, overrides the app's env var pointing at that service, and exposes typed `set*Response` helpers that register Express route handlers when called.

```typescript
// fixtures/external-services/catalog/index.ts
import { test as base } from '@playwright/test';
import { Request, Response } from 'express';
import { captureRequest, OnRequestCallback } from '../../utils/CapturedRequest';
import { ExpressServerManager } from '../../utils/ExpressServerManager';
import type { ProductResponse } from './test-data';

type ResponseOptions = { onRequest?: OnRequestCallback };

export type CatalogFixture = {
    setGetProductResponse: (r: ProductResponse, opts?: ResponseOptions) => void;
    setSearchResponse: (r: SearchResponse, opts?: ResponseOptions) => void;
};

type TestFixtures = { catalog: CatalogFixture };

export const test = base.extend<TestFixtures>({
    catalog: [
        async ({}, use) => {
            const { fixture, serverManager } = await setup();
            await use(fixture);
            await teardown(serverManager);
        },
        { scope: 'test', auto: true },
    ],
});

async function setup() {
    const serverManager = await ExpressServerManager.create();
    const app = serverManager.app;

    process.env.CATALOG_SERVICE_URL = serverManager.baseUrl;

    const fixture: CatalogFixture = {
        setGetProductResponse: (response, options) => {
            app.get('/api/v1/products/:id', (req: Request, res: Response) => {
                options?.onRequest?.(captureRequest(req));
                res.status(response.status ?? 200).json(response.body);
            });
        },
        setSearchResponse: (response, options) => {
            app.post('/api/v1/products/search', (req: Request, res: Response) => {
                options?.onRequest?.(captureRequest(req));
                res.status(response.status ?? 200).json(response.body);
            });
        },
    };
    return { fixture, serverManager };
}

async function teardown(serverManager: ExpressServerManager) {
    await serverManager.teardown();
}
```

### Rules

1. **`set*` methods register routes directly** by calling `app.get()` / `app.post()`. Do not pre-register routes that read from a mutable shared object — that introduces hidden state.
2. **One fixture per env var.** Never bundle two services into one fixture by setting multiple env vars.
3. **Fixtures are test-scoped** (`{ scope: 'test', auto: true }`). Worker-scoped fixtures leak state across tests.
4. **No browser-level interception of your own backend routes.** `page.route('/api/*')` is banned. If your backend serves it, you test through your backend.

### Production-code constraint: read env vars at request time

For a test-scoped env var override to take effect, the production service code must read the env var **at request time**, not bake it into an axios client at startup.

```typescript
// CORRECT — reads env at request time
class CatalogClient {
    private getBaseUrl() { return process.env.CATALOG_SERVICE_URL!; }
    async fetchProduct(id: string) {
        return axios.get(`${this.getBaseUrl()}/api/v1/products/${id}`);
    }
}
```

```typescript
// WRONG — baseURL frozen at server boot; test-scoped overrides do not apply
class CatalogClient {
    private client = axios.create({ baseURL: process.env.CATALOG_SERVICE_URL });
}
```

If you find production code in the second shape, refactor it to the first as part of writing the fixture.

### Test data factories

Each fixture has a `test-data.ts` next to it with builder functions that return realistic-but-obviously-fake response shapes.

```typescript
// fixtures/external-services/catalog/test-data.ts
export type ProductResponse = { status?: number; body: ProductBody };
export type ProductBody = { id: string; name: string; priceCents: number };

export function createProductResponse(overrides: Partial<ProductBody> = {}): ProductResponse {
    return {
        body: { id: 'product-id-value', name: 'product-name-value', priceCents: 0, ...overrides },
    };
}
```

Defaults are **obviously fake** strings (`'product-id-value'`) so that a reader can tell at a glance which fields the test cares about.

### Capturing requests for assertions

The `onRequest` callback lets a test capture the request the app sent to a downstream service. Use an array, not a single variable:

```typescript
scenarioTest('checkout calls payment service with cart total', async ({ payment, checkoutPage }) => {
    const capturedPaymentRequests: CapturedRequest[] = [];
    payment.setChargeResponse(createChargeResponse(), {
        onRequest: req => capturedPaymentRequests.push(req),
    });

    // ... drive the checkout ...

    await expect.poll(() => capturedPaymentRequests).toHaveLength(1);
    expect(capturedPaymentRequests[0].body).toEqual({
        amountCents: 4999,
        currency: 'USD',
        cartId: 'cart-id-value',
    });
});
```

Assert on the **full request body** with `toEqual` — never cherry-pick properties. Use shared matchers (`UUID`, `ISO_TIMESTAMP`) for genuinely non-deterministic values; assert exact values for everything else.

---

## 11. Databases & Stateful Stores: Testcontainers

For datastores the application owns (Redis, Postgres, MySQL, MongoDB, S3-compatible storage, etc.), use **testcontainers** to start a real instance per test worker. The store runs the real binary, talks the real protocol, and is torn down at the end of the run.

### Worker-scoped startup

```typescript
// fixtures/external-services/postgres/index.ts
import { test as base } from '@playwright/test';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';

type PostgresFixture = {
    seedUser: (user: UserSeed) => Promise<void>;
};

type WorkerFixtures = { postgresContainer: StartedPostgreSqlContainer };
type TestFixtures = { postgres: PostgresFixture };

export const test = base.extend<TestFixtures, WorkerFixtures>({
    postgresContainer: [
        async ({}, use) => {
            const container = await new PostgreSqlContainer().start();
            process.env.DATABASE_URL = container.getConnectionUri();
            await use(container);
            await container.stop();
        },
        { scope: 'worker', auto: true },
    ],

    postgres: [
        async ({ postgresContainer }, use) => {
            const { fixture, createdIds } = await setup(postgresContainer);
            await use(fixture);
            await teardown(postgresContainer, createdIds);
        },
        { scope: 'test', auto: true },
    ],
});
```

### Test isolation through tracked cleanup

The container itself is shared across the worker. Test isolation comes from each test:
1. Using **unique identifiers** for any seeded data (UUIDs, not deterministic names).
2. **Tracking every record it writes** and deleting it in teardown.

Never use `TRUNCATE` or `FLUSHDB` to clean up — it destroys data from other concurrent tests on the same worker.

```typescript
async function setup(container: StartedPostgreSqlContainer) {
    const createdIds: string[] = [];
    const client = new Client({ connectionString: container.getConnectionUri() });
    await client.connect();

    const fixture: PostgresFixture = {
        seedUser: async (user) => {
            await client.query('INSERT INTO users (id, email) VALUES ($1, $2)', [user.id, user.email]);
            createdIds.push(user.id);
        },
    };
    return { fixture, createdIds };
}

async function teardown(container, createdIds: string[]) {
    if (createdIds.length === 0) return;
    const client = new Client({ connectionString: container.getConnectionUri() });
    await client.connect();
    await client.query('DELETE FROM users WHERE id = ANY($1)', [createdIds]);
    await client.end();
}
```

For databases with foreign keys, track inserted IDs per table and delete in reverse-dependency order.

### When the same store backs multiple test concerns

If, say, Postgres holds both users and orders, expose multiple seed methods on the same fixture (`seedUser`, `seedOrder`). The 1:1 rule is "one fixture per external service," not "one fixture per table." The database is one service.

### Migrations

Run schema migrations against the testcontainer once per worker, inside the `postgresContainer` setup. Use the same migration tool you ship to production.

---

## 12. Auth & Session

Sign-in is a frequent precondition. Create an `AuthSessionFixture` that exposes a `login(opts)` method, which either:
- Uses your identity provider's fixture (if you've stubbed it) to mint a token and write the auth cookie, or
- Calls your app's real `/auth/callback` route with a stubbed identity-provider response and lets the app set its own session cookie.

The latter exercises more of your real auth pipeline and is preferred.

```typescript
scenarioTest('signed-in user sees their name', async ({ authSession, profilePage }) => {
    await authSession.login({ accountId: 'user-1', displayName: 'Alice' });
    await profilePage.goto();
    await expect(profilePage.greeting).toHaveText('Hello, Alice');
});
```

---

## 13. Pre-flight: Tag-Based CI Sharding

Tags on scenarios let CI shard tests intelligently:

```bash
playwright test --grep @api-only          # API-only suite (no browser, fast)
playwright test --grep "@success|@error"  # All success and error paths
playwright test --grep-invert @slow       # Skip slow tests for PR checks
```

Conventional tags:
- `@success`, `@error`, `@validation`, `@authorization`, `@resilience`
- `@api-only` — tests driven through the BFF without a browser
- `@i18n` — locale-sensitive
- `@authenticated`, `@guest`
- `@mobile`, `@desktop`
- `@slow` — anything that requires real-time waits (countdowns, retries)

---

## 14. Key Rules (cheat sheet)

### Hard constraints — never violate

1. **No raw locators in test bodies.** Add to a page/component object.
2. **No CSS selectors or element IDs** for elements your codebase owns.
3. **No browser interception of your own backend's routes.** Stub the external service the backend calls.
4. **No production code modifications for tests** other than `data-testid` attributes.
5. **No conditionals in test bodies.** Variation goes in the case array.
6. **No timing hacks.** No `setTimeout(N)`, no extended `{ timeout }` overrides, no `document.querySelector` in test code.
7. **No `expect.any()` for deterministic values.** Pin the value; use shared matchers only for genuinely random values (UUIDs, timestamps generated by the system).
8. **No regex matchers for values the test seeded.** If the test controls the value, assert with `toBe`/`toEqual`.
9. **No `expect(getByText(...)).not.toBeVisible()`.** Locate by testid; assert the element's absence.
10. **No production-code imports from tests.** Duplicate the literal, or own it in test code.
11. **No skipping tests because the fixture doesn't support the scenario.** Extend the fixture.

### Soft conventions — strongly preferred

- One scenario file per area, one spec file per scenario file.
- One factory per external-service test-data file.
- Group fixture setup steps by the BFF endpoint that triggers them, with the triggering action in the label: `Configure services called when Continue is clicked (/appeal)`.
- Set Express-route fixtures **before** the action that triggers the request.
- Assert the **full** captured request body with `toEqual`, not cherry-picked properties.
- Every negative assertion (`not.toBeVisible`, `toHaveCount(0)`) needs a positive anchor inside the same component that proves the alt-state rendered, and the positive comes first.
- Pin `locale` and `timezoneId` in `playwright.config.ts` so date/number formatting is deterministic.

---

## 15. Why This Approach

- **Behaviour-first.** Tests assert what the user observes, not how the code is structured. Refactors that preserve behaviour leave the tests untouched.
- **Continuous deployment.** A green integration suite is sufficient evidence that an externally visible regression hasn't shipped. Manual regression goes away.
- **Real production paths.** SSR, middleware, auth, routing all execute under test. Bugs in the integration of your modules are caught by integration tests because the integration is what they test.
- **Repeatable.** All network is stubbed; the only real I/O is to local testcontainers. No flakes from external service drift, no rate limits, no shared test accounts.
- **Independent tests.** Two concurrent tests can stub the same downstream call with different responses without interfering — each test has its own Express stub on its own port.
- **One vocabulary.** Engineers, reviewers, agents, and product owners all use `integration test` with the same meaning. The scenario file is the contract; the spec file is the proof.

### Residual risk

Network is stubbed, so **data-contract drift with the real external services is not caught** by this layer. Address that separately with contract tests against the real services, run on a different cadence.

---

## 16. Adopting in a New Project — Order of Work

1. Stand up Playwright with `globalSetup` that boots your real server. Pin locale and timezone in the config.
2. Add `ExpressServerManager` and `CapturedRequest` utilities under `tests/integration/fixtures/utils/`.
3. Create `PageObjectFixture` and one page object for your most-changed page. Add a `data-testid` or two to make it locatable.
4. Add a fixture for your most-called external service. Override its env var in the fixture, refactor the production client to read env at request time.
5. Add testcontainers for any datastore you own. Track keys/IDs and clean up on teardown.
6. Add the scenario builder, scenario registry, and `scenarioTest`. Migrate two or three existing tests as exemplars.
7. Document the team's locator and assertion conventions in a `rules/` directory. Wire the PR-review agent (if you use one) to enforce them.
8. From there: every new feature ships with a scenario and a spec. Every bug fix ships with a regression scenario. Existing unit tests that overlap with integration coverage may be deleted at their author's discretion.

The doctrine works when it is the **default** for new behaviour. Treat the first ten scenarios as scaffolding; from the eleventh onward, the suite carries itself.
