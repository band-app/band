---
name: integration-tests
description: Writes black-box integration tests that exercise the real system through public interfaces. Covers HTTP APIs, CLIs, streaming endpoints, and file-based services using real infrastructure (test containers, real servers on random ports, temp filesystems) and MSW for external boundaries. Use when asked to write tests, add test coverage, create integration tests, add specs, or test an endpoint. Does NOT write unit tests with mocks or E2E browser tests.
---

# Integration Tests

You are writing integration tests. Follow every rule below. No exceptions.

## When to Use

Use this skill when asked to write, add, fix, or review integration tests. This applies to any system: HTTP APIs, CLIs, streaming endpoints, file-based services, or anything with a public interface.

## The Cardinal Rule

**NEVER modify production code to make a test pass.** No test-only flags. No `if (process.env.NODE_ENV === 'test')`. No exporting internals for test access. If you can't test it without changing the source, you're testing wrong. Rethink the approach.

## What You Test

**Black-box only.** Test the system the way a client or user interacts with it — through its public interface.

- For HTTP APIs: make real HTTP requests with `fetch` to a real running server
- For CLIs: spawn the actual binary with `child_process` and assert on stdout, stderr, exit code
- For file-based systems: write to / read from the real filesystem (in temp directories)
- For streaming endpoints (SSE, WebSocket): connect as a real client, consume the full stream

**Never** import internal modules, call private functions, or assert on internal state.

## Infrastructure Rules

### Servers

Start the real server on **port 0** (OS-assigned random port). Make real HTTP requests over the network. Don't use supertest or libraries that bypass the TCP stack.

```js
// GOOD
const server = createServer(handler);
server.listen(0);
const port = server.address().port;
const res = await fetch(`http://localhost:${port}/api/foo`);

// BAD
const res = await supertest(app).get('/api/foo');
```

### Databases

**Never mock the database.** Use test containers to spin up a real database instance. Run real migrations, seed with test data, run the tests, tear down.

```js
// GOOD - real postgres via testcontainers
const container = await new PostgreSqlContainer().start();
const db = connect(container.getConnectionUri());
await migrate(db);
await seed(db, testData);

// BAD
jest.mock('../db', () => ({ query: jest.fn() }));
```

### External Network Services

Use **MSW (Mock Service Worker)** in Node.js to intercept at the network layer. This tests your real HTTP client code, serialization, and error handling.

```js
// GOOD - intercept at network boundary
const server = setupServer(
  http.post('https://api.external.com/v1/chat', () => {
    return HttpResponse.json({ result: 'ok' });
  })
);
server.listen();

// BAD - replace the module
jest.mock('node-fetch', () => jest.fn());
```

### File-Based State

Use **temporary directories** per test or test suite. Point the system at the temp dir. Clean up after.

```js
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-'));
// Set env/config to use tmpDir instead of ~/.band/
// ...run tests...
// Cleanup in afterEach/after
fs.rmSync(tmpDir, { recursive: true, force: true });
```

### CLIs

Invoke the **actual binary** on a real (temporary) filesystem. Assert on stdout, stderr, and exit codes.

```js
const result = spawnSync('node', ['cli.js', 'add', '--path', tmpDir], {
  env: { ...process.env, HOME: tmpDir },
});
assert.strictEqual(result.status, 0);
assert.match(result.stdout.toString(), /Project added/);
```

### Git Operations

Create **real temporary git repos**. Use `git init`, make real commits, create real branches. Don't mock git.

```js
execSync('git init', { cwd: tmpDir });
execSync('git commit --allow-empty -m "init"', { cwd: tmpDir });
```

### Authentication

Generate test-specific secrets and tokens in setup hooks. Make real requests with valid tokens, invalid tokens, expired tokens, and no tokens. Use `crypto` to create them the same way the production system expects.

## Isolation & Determinism

### Test Independence

Each test must be fully independent. No shared mutable state. No dependency on execution order. A test that fails alone but passes in a suite is broken.

### Setup and Teardown

- Create fresh state in `beforeEach` or at the start of each test
- Kill servers, remove temp directories, restore env vars in `afterEach`/`after`
- Leaked resources cause flaky tests and port conflicts

### Never Sleep

**Never use `setTimeout` or `sleep` for synchronization.** If you're waiting for something:

- Poll with a short interval and a timeout
- Wait for an event (SSE message, file change, process exit)
- Use a condition-based wait helper

```js
// GOOD
async function waitFor(fn, { timeout = 5000, interval = 50 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { if (await fn()) return; } catch {}
    await new Promise(r => setTimeout(r, interval));
  }
  throw new Error('Timed out');
}

// BAD
await new Promise(r => setTimeout(r, 2000));
```

### Non-Determinism

Don't assert on exact values for timestamps, random IDs, or UUIDs. Use matchers:

```js
// GOOD
assert.match(body.id, /^[a-z0-9-]+$/);
assert.ok(typeof body.createdAt === 'string');

// BAD
assert.strictEqual(body.id, 'abc-123');
```

## What to Assert

### Observable Outputs Only

Assert on things a client/user would see:

- HTTP status codes, response bodies, response headers
- File contents written to disk
- CLI stdout, stderr, exit codes
- SSE events received by a connected client
- Cookies set in responses

**Don't** assert on logs, internal counters, implementation details, or JSON key ordering.

### Test the Contract, Not the Implementation

Assert on the structure and meaningful content. Don't assert on things that could change without breaking the contract.

```js
// GOOD - tests the contract
assert.strictEqual(res.status, 200);
assert.ok(Array.isArray(body.projects));
assert.ok(body.projects.length > 0);
assert.ok(body.projects[0].name);

// BAD - tests implementation details
assert.strictEqual(JSON.stringify(body), '{"projects":[...exact...]}');
```

### Error Paths Are Part of the Contract

Test unauthorized requests, malformed input, missing resources, invalid methods. The error behavior is the contract.

```js
// Must test these
const noAuth = await fetch(`${url}/api/projects`); // no token
assert.strictEqual(noAuth.status, 401);

const badInput = await fetch(`${url}/api/projects/add`, {
  method: 'POST',
  body: JSON.stringify({}), // missing required fields
});
assert.strictEqual(badInput.status, 400);
```

### Streaming Endpoints

For SSE/streaming: connect as a real client, collect all events, assert on the sequence.

```js
const res = await fetch(`${url}/api/status/stream`);
const reader = res.body.getReader();
const decoder = new TextDecoder();
const events = [];

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  events.push(decoder.decode(value));
}
```

## Test Organization

### Naming

Name tests as behavior specifications. The name should tell you what broke.

```js
// GOOD
it('returns 401 when auth token is missing', ...);
it('creates a project and returns it in the project list', ...);
it('streams status events for the active workspace', ...);

// BAD
it('test auth', ...);
it('projects endpoint', ...);
it('test streaming', ...);
```

### One Behavior Per Test

Each test verifies one scenario. If the name needs "and", split it.

### Grouping

Group tests by feature or endpoint, not by type. All tests for `/api/projects` go together.

```js
describe('/api/projects', () => {
  it('returns empty list when no projects registered', ...);
  it('returns 401 when not authenticated', ...);
  it('lists projects after adding one', ...);
});
```

### Helpers

Keep helpers minimal and obvious. A `startServer()` that returns `{ url, close }` is fine. A 200-line test framework is not. Tests should be readable without jumping through abstractions.

## Tauri / Desktop Apps

### Test Rust Commands Directly

Tauri `#[tauri::command]` functions are regular Rust functions that take state and return `Result`. Write integration tests in the `tests/` directory that call these functions with real file-based state in temp directories. No Tauri runtime needed for most commands.

```rust
// tests/project_test.rs
use tempfile::tempdir;

#[test]
fn project_init_creates_state_file() {
    let tmp = tempdir().unwrap();
    let band_home = tmp.path().join(".band");
    // Call the same function the command invokes, pointed at tmp
    // Assert on files created, state written
}
```

### Commands That Spawn Processes

For commands that spawn child processes (web server, tunnel, git, gh), let them spawn real processes against temp directories. Assert on side effects: files created, process exit codes, stdout parsed correctly.

### macOS-Specific APIs

Commands using Accessibility framework, libproc, or AppleScript need a real macOS desktop session. Gate these tests with `#[cfg(target_os = "macos")]` and skip in headless CI. Document them as manual-test-only — they cannot run in containers or Linux CI.

### File Watchers

For `notify`-based watchers, write a real file to the watched temp directory and assert the event fires. Don't mock the watcher — exercise the real `notify` crate against the real filesystem. Use a polling wait for the event with a timeout.

```rust
// Write a status file to the watched directory
fs::write(watched_dir.join("workspace-1.json"), r#"{"status":"active"}"#).unwrap();
// Wait for the event to be emitted (poll, don't sleep)
```

### IPC Layer

Don't test through Tauri's IPC bridge. The IPC serialization is Tauri's concern. Test the Rust command functions directly and test the frontend adapter separately against the web API.

## Rust-Specific Rules

### Test Runner

Use `cargo test` with the built-in `#[test]` attribute. Integration tests live in the `tests/` directory at the crate root. Don't add test framework crates unless there's a clear need.

### Temp Directories

Use `tempfile::tempdir()` which auto-cleans on drop. Point all state paths at it. No manual cleanup needed.

```rust
use tempfile::tempdir;

#[test]
fn loads_settings_from_band_home() {
    let tmp = tempdir().unwrap();
    let settings_path = tmp.path().join("settings.json");
    fs::write(&settings_path, r#"{"theme":"dark"}"#).unwrap();
    // Call the function under test pointed at tmp.path()
}
```

### Async Commands

For tokio-based async functions, use `#[tokio::test]` and exercise the real async behavior. Don't block on futures manually.

```rust
#[tokio::test]
async fn webserver_wait_ready_detects_listening_port() {
    // Start a real TCP listener on port 0
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    // Call the wait_ready function, assert it returns Ok
}
```

### Process Management

Tests for process spawning and killing (SIGTERM, process tree kill) should spawn a real child process, kill it, and verify it's gone. Use a simple `sleep` binary as the target.

```rust
use std::process::Command;

#[test]
fn kills_child_process_tree() {
    let child = Command::new("sleep").arg("60").spawn().unwrap();
    let pid = child.id();
    // Call your kill function
    // Assert process no longer exists
}
```

### Platform-Conditional Tests

Use `#[cfg(target_os = "macos")]` for macOS-only tests. Don't use runtime detection — let the compiler exclude them entirely on other platforms.

```rust
#[cfg(target_os = "macos")]
#[test]
fn detect_active_workspace_returns_none_when_no_vscode() {
    // Only compiles and runs on macOS
}
```

## Node.js Test Runner

Use **Node.js built-in test runner** (`node:test`) with `node:assert/strict` unless the project already uses a different test runner. Don't add test framework dependencies when the built-in runner suffices.

## Safety

- **Never run tests against the user's real home directory or real repositories.** Always redirect state paths to isolated temp directories.
- **Never hardcode real secrets, tokens, or API keys.** Generate test-specific ones.
- **Never make real requests to external services.** Use MSW to intercept everything that crosses the network boundary you don't own.

## Checklist Before You're Done

- [ ] No production code was modified
- [ ] All tests pass when run individually
- [ ] All tests pass when run together
- [ ] No temp files or processes are leaked
- [ ] No real user data, home directory, or repos are touched
- [ ] No `setTimeout`/`sleep` used for synchronization
- [ ] Error paths are tested, not just happy paths
- [ ] Test names describe the behavior being verified
- [ ] macOS-specific tests are gated with `#[cfg(target_os = "macos")]`
- [ ] Rust tests use `tempfile::tempdir()` (not manual temp paths)
- [ ] Async Rust tests use `#[tokio::test]`, not manual runtime construction
