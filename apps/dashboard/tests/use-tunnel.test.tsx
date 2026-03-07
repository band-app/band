import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — Tauri APIs are third-party boundaries we don't own
// ---------------------------------------------------------------------------

const mockInvoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));

const eventHandlers = new Map<string, (event: { payload: unknown }) => void>();
const mockListen = vi.fn((eventName: string, handler: (event: { payload: unknown }) => void) => {
  eventHandlers.set(eventName, handler);
  return Promise.resolve(() => {
    eventHandlers.delete(eventName);
  });
});
vi.mock("@tauri-apps/api/event", () => ({ listen: mockListen }));

function emitEvent(name: string, payload?: unknown) {
  const handler = eventHandlers.get(name);
  if (handler) handler({ payload });
}

// ---------------------------------------------------------------------------
// Mock dashboard-core — useSettingsStore uses React Context internally,
// so we replace it with a controlled mock.
// isServiceHealthy is a pure function — we use the real logic.
// ---------------------------------------------------------------------------

let mockSettings = { tunnelSubdomain: "test-sub", autoStartTunnel: false };

vi.mock("@band/dashboard-core", () => ({
  isServiceHealthy: (
    health: { webserver: boolean; tunnel: boolean },
    subdomain?: string | null,
  ) => {
    if (!health.webserver) return false;
    if (subdomain) return health.tunnel;
    return true;
  },
  useSettingsStore: (selector: (state: { settings: typeof mockSettings }) => unknown) =>
    selector({ settings: mockSettings }),
}));

// ---------------------------------------------------------------------------
// Health response defaults
// ---------------------------------------------------------------------------

let healthResponse: {
  webserver: boolean;
  tunnel: boolean;
  tunnel_url: string | null;
  tunnel_remote_host: string | null;
};

function resetHealthResponse(overrides?: Partial<typeof healthResponse>) {
  healthResponse = {
    webserver: true,
    tunnel: true,
    tunnel_url: "https://test-sub.instatunnel.my",
    tunnel_remote_host: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Invoke mock implementation
// ---------------------------------------------------------------------------

function setupInvokeMock() {
  mockInvoke.mockImplementation(async (command: string) => {
    switch (command) {
      case "service_health_check":
        return { ...healthResponse };
      case "prereq_check":
        return { node: true, instatunnel: true };
      case "webserver_start":
        // After starting, the webserver becomes healthy
        healthResponse = { ...healthResponse, webserver: true };
        return;
      case "webserver_get_token":
        return "test-token";
      case "tunnel_start":
        return;
      default:
        throw new Error(`Unknown command: ${command}`);
    }
  });
}

// ---------------------------------------------------------------------------
// Minimal renderHook (no @testing-library/react needed)
// ---------------------------------------------------------------------------

interface HookResult<T> {
  result: { current: T };
  unmount: () => void;
}

function renderHook<T>(hookFn: () => T): HookResult<T> {
  const result = { current: undefined as unknown as T };
  function TestComponent() {
    result.current = hookFn();
    return null;
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => {
    root.render(createElement(TestComponent));
  });
  return {
    result,
    unmount: () => {
      act(() => root.unmount());
      document.body.removeChild(container);
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Flush pending promises and microtasks */
async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

/** Advance the 30s health poll interval and flush */
async function advancePoll() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000);
  });
}

function invokeCallsFor(command: string) {
  return mockInvoke.mock.calls.filter((args: unknown[]) => args[0] === command);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useTunnel", () => {
  let hook: HookResult<ReturnType<typeof import("../src/hooks/use-tunnel").useTunnel>>;

  beforeEach(() => {
    vi.useFakeTimers();
    resetHealthResponse();
    mockSettings = { tunnelSubdomain: "test-sub", autoStartTunnel: false };
    eventHandlers.clear();
    mockInvoke.mockReset();
    mockListen.mockClear();
    setupInvokeMock();
  });

  afterEach(() => {
    if (hook) hook.unmount();
    vi.useRealTimers();
  });

  async function mountHook() {
    const { useTunnel } = await import("../src/hooks/use-tunnel");
    hook = renderHook(() => useTunnel());
    await flush();
  }

  // -----------------------------------------------------------------------
  // Health poll — UI state updates
  // -----------------------------------------------------------------------

  it("poll sets webServerRunning=true when services are healthy", async () => {
    resetHealthResponse({ webserver: true, tunnel: true });
    await mountHook();

    expect(hook.result.current.webServerRunning).toBe(true);
  });

  it("poll sets webServerRunning=false when webserver is down", async () => {
    resetHealthResponse({ webserver: false, tunnel: false });
    await mountHook();

    expect(hook.result.current.webServerRunning).toBe(false);
  });

  it("poll preserves existing tunnelUrl (avoids overwriting token-bearing URL)", async () => {
    resetHealthResponse({ tunnel: true, tunnel_url: "https://test-sub.instatunnel.my" });
    await mountHook();

    // Simulate tunnel-url event with token-bearing URL
    act(() => emitEvent("tunnel-url", "https://test-sub.instatunnel.my?token=abc"));
    expect(hook.result.current.tunnelUrl).toBe("https://test-sub.instatunnel.my?token=abc");

    // Next poll should NOT overwrite the token-bearing URL
    await advancePoll();
    expect(hook.result.current.tunnelUrl).toBe("https://test-sub.instatunnel.my?token=abc");
  });

  it("poll clears tunnelUrl when tunnel is not running", async () => {
    resetHealthResponse({ tunnel: false, tunnel_url: null });
    await mountHook();

    expect(hook.result.current.tunnelUrl).toBeNull();
  });

  // -----------------------------------------------------------------------
  // tunnel-url event
  // -----------------------------------------------------------------------

  it("tunnel-url event updates tunnelUrl and marks services running", async () => {
    resetHealthResponse({ webserver: false, tunnel: false, tunnel_url: null });
    await mountHook();
    expect(hook.result.current.webServerRunning).toBe(false);

    act(() => emitEvent("tunnel-url", "https://test-sub.instatunnel.my?token=xyz"));

    expect(hook.result.current.tunnelUrl).toBe("https://test-sub.instatunnel.my?token=xyz");
    expect(hook.result.current.webServerRunning).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Recovery — shouldBeRunning behavior
  // -----------------------------------------------------------------------

  it("recovers downed services after tunnel-url confirms running", async () => {
    resetHealthResponse({ webserver: true, tunnel: true });
    await mountHook();

    // tunnel-url event sets shouldBeRunning=true
    act(() => emitEvent("tunnel-url", "https://test-sub.instatunnel.my?token=abc"));
    mockInvoke.mockClear();

    // Now services go down
    resetHealthResponse({ webserver: false, tunnel: false, tunnel_url: null });
    await advancePoll();

    // Recovery should have called webserver_start and tunnel_start
    expect(invokeCallsFor("webserver_start").length).toBeGreaterThanOrEqual(1);
    expect(invokeCallsFor("tunnel_start").length).toBeGreaterThanOrEqual(1);
  });

  it("recovers only the tunnel when webserver is still up", async () => {
    resetHealthResponse({ webserver: true, tunnel: true });
    await mountHook();

    act(() => emitEvent("tunnel-url", "https://test-sub.instatunnel.my?token=abc"));
    mockInvoke.mockClear();

    // Only tunnel goes down
    resetHealthResponse({ webserver: true, tunnel: false, tunnel_url: null });
    await advancePoll();

    expect(invokeCallsFor("webserver_start")).toHaveLength(0);
    expect(invokeCallsFor("tunnel_start").length).toBeGreaterThanOrEqual(1);
  });

  it("does NOT recover when shouldBeRunning is false (never started)", async () => {
    // Services are down but we never started them
    resetHealthResponse({ webserver: false, tunnel: false, tunnel_url: null });
    await mountHook();
    mockInvoke.mockClear();

    await advancePoll();

    expect(invokeCallsFor("webserver_start")).toHaveLength(0);
    expect(invokeCallsFor("tunnel_start")).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // handleStopped — disables recovery
  // -----------------------------------------------------------------------

  it("handleStopped disables recovery and clears state", async () => {
    resetHealthResponse({ webserver: true, tunnel: true });
    await mountHook();

    // Start services (tunnel-url sets shouldBeRunning=true)
    act(() => emitEvent("tunnel-url", "https://test-sub.instatunnel.my?token=abc"));
    expect(hook.result.current.webServerRunning).toBe(true);

    // User clicks stop
    act(() => hook.result.current.handleStopped());

    expect(hook.result.current.webServerRunning).toBe(false);
    expect(hook.result.current.tunnelUrl).toBeNull();
    expect(hook.result.current.tunnelRemoteHost).toBeNull();
    expect(hook.result.current.showDialog).toBe(false);

    // Services are down — recovery should NOT happen
    mockInvoke.mockClear();
    resetHealthResponse({ webserver: false, tunnel: false, tunnel_url: null });
    await advancePoll();

    expect(invokeCallsFor("webserver_start")).toHaveLength(0);
    expect(invokeCallsFor("tunnel_start")).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // tunnel-subdomain-taken — disables recovery, shows dialog
  // -----------------------------------------------------------------------

  it("tunnel-subdomain-taken disables recovery and shows dialog", async () => {
    resetHealthResponse({ webserver: true, tunnel: true });
    await mountHook();

    // Services were running
    act(() => emitEvent("tunnel-url", "https://test-sub.instatunnel.my?token=abc"));
    mockInvoke.mockClear();

    act(() => emitEvent("tunnel-subdomain-taken"));
    expect(hook.result.current.showDialog).toBe(true);

    // Recovery should be disabled
    resetHealthResponse({ webserver: false, tunnel: false, tunnel_url: null });
    await advancePoll();

    expect(invokeCallsFor("webserver_start")).toHaveLength(0);
    expect(invokeCallsFor("tunnel_start")).toHaveLength(0);
  });

  it("recovery resumes after subdomain-taken + new tunnel-url", async () => {
    resetHealthResponse({ webserver: true, tunnel: true });
    await mountHook();

    act(() => emitEvent("tunnel-url", "https://test-sub.instatunnel.my?token=abc"));
    act(() => emitEvent("tunnel-subdomain-taken"));

    // New tunnel URL (user picked a fallback subdomain)
    act(() => emitEvent("tunnel-url", "https://new-sub.instatunnel.my?token=xyz"));
    mockInvoke.mockClear();

    // Services go down — recovery should kick in again
    resetHealthResponse({ webserver: false, tunnel: false, tunnel_url: null });
    await advancePoll();

    expect(invokeCallsFor("webserver_start").length).toBeGreaterThanOrEqual(1);
  });

  // -----------------------------------------------------------------------
  // Auto-start
  // -----------------------------------------------------------------------

  it("auto-start sets shouldBeRunning when prereqs pass", async () => {
    mockSettings = { tunnelSubdomain: "test-sub", autoStartTunnel: true };
    resetHealthResponse({ webserver: false, tunnel: false, tunnel_url: null });
    await mountHook();

    // prereq_check should have been called
    expect(invokeCallsFor("prereq_check").length).toBeGreaterThanOrEqual(1);

    // shouldBeRunning is now true — next poll should trigger recovery
    mockInvoke.mockClear();
    await advancePoll();

    expect(invokeCallsFor("webserver_start").length).toBeGreaterThanOrEqual(1);
  });

  it("auto-start does not recover when prereqs fail", async () => {
    mockSettings = { tunnelSubdomain: "test-sub", autoStartTunnel: true };
    mockInvoke.mockImplementation(async (command: string) => {
      switch (command) {
        case "service_health_check":
          return { ...healthResponse };
        case "prereq_check":
          return { node: false, instatunnel: false };
        default:
          return;
      }
    });
    resetHealthResponse({ webserver: false, tunnel: false, tunnel_url: null });
    await mountHook();

    mockInvoke.mockClear();
    setupInvokeMock();
    resetHealthResponse({ webserver: false, tunnel: false, tunnel_url: null });
    await advancePoll();

    // shouldBeRunning was never set to true, so no recovery
    expect(invokeCallsFor("webserver_start")).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // openDialog
  // -----------------------------------------------------------------------

  it("openDialog enables recovery and refreshes health state", async () => {
    resetHealthResponse({ webserver: false, tunnel: false, tunnel_url: null });
    await mountHook();
    mockInvoke.mockClear();
    setupInvokeMock();

    // User clicks globe
    await act(async () => {
      await hook.result.current.openDialog();
    });

    expect(hook.result.current.showPrereq).toBe(true);

    // shouldBeRunning is now true — next poll should trigger recovery
    resetHealthResponse({ webserver: false, tunnel: false, tunnel_url: null });
    await advancePoll();

    expect(invokeCallsFor("webserver_start").length).toBeGreaterThanOrEqual(1);
  });

  // -----------------------------------------------------------------------
  // Event listeners setup
  // -----------------------------------------------------------------------

  it("registers all expected event listeners", async () => {
    await mountHook();

    const registeredEvents = mockListen.mock.calls.map((args) => args[0]);
    expect(registeredEvents).toContain("tunnel-url");
    expect(registeredEvents).toContain("tunnel-remote-host");
    expect(registeredEvents).toContain("tunnel-subdomain-taken");
  });

  it("does NOT register a tunnel-exited listener", async () => {
    await mountHook();

    const registeredEvents = mockListen.mock.calls.map((args) => args[0]);
    expect(registeredEvents).not.toContain("tunnel-exited");
  });

  // -----------------------------------------------------------------------
  // tunnel-remote-host event
  // -----------------------------------------------------------------------

  it("tunnel-remote-host event updates tunnelRemoteHost", async () => {
    await mountHook();

    act(() => emitEvent("tunnel-remote-host", "other-machine.local"));
    expect(hook.result.current.tunnelRemoteHost).toBe("other-machine.local");
  });
});
