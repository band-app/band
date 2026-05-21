import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dispatchOpenFileEvent,
  type OpenFileDispatchHandlers,
} from "../src/lib/dispatch-open-file";
import { consumeExternalOpen } from "../src/lib/pending-external-open";

// ---------------------------------------------------------------------------
// dispatchOpenFileEvent — pure dispatcher for `band open` SSE events.
//
// Covers the routing matrix between the two rendering models:
//
//                  in-workspace            external
//   ───────────────┼─────────────────────┼─────────────────────────────
//   Desktop        │  onOpenFile         │  enqueue + onActivateFilesPanel
//   Mobile / web   │  navigateInWorkspace│  enqueue + navigateToWorkspaceCode
//
// The dispatcher is the contract between the SSE event boundary and the
// dockview/router; verifying it here means future regressions in
// __root.tsx's listener (which is now just a thin shim) can't silently
// break `band open` end-to-end. The CLI integration tests cover the
// server-side event shape; this file covers the renderer-side dispatch.
// ---------------------------------------------------------------------------

function makeHandlers(): OpenFileDispatchHandlers & {
  onOpenFile: ReturnType<typeof vi.fn>;
  onActivateFilesPanel: ReturnType<typeof vi.fn>;
  navigateInWorkspace: ReturnType<typeof vi.fn>;
  navigateToWorkspaceCode: ReturnType<typeof vi.fn>;
} {
  return {
    onOpenFile: vi.fn(),
    onActivateFilesPanel: vi.fn(),
    navigateInWorkspace: vi.fn(),
    navigateToWorkspaceCode: vi.fn(),
  };
}

function openFileEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "open-file",
    workspaceId: "my-project-feat-x",
    filePath: "src/foo.rs",
    external: false,
    focus: true,
    ...overrides,
  };
}

describe("dispatchOpenFileEvent", () => {
  // The pending-external-open store is module-level state; drain after
  // every test so cross-test pollution can't make an "external" assertion
  // pass spuriously because a previous test's entry was still around.
  afterEach(() => {
    consumeExternalOpen("my-project-feat-x");
    consumeExternalOpen("other-workspace");
  });

  // -------------------------------------------------------------------
  // Happy paths — one per quadrant of the dispatch matrix.
  // -------------------------------------------------------------------

  it("desktop + in-workspace → onOpenFile (writes per-workspace state + activates panel)", () => {
    const handlers = makeHandlers();
    const result = dispatchOpenFileEvent(openFileEvent({ filePath: "src/foo.rs:42:5" }), {
      isDockview: true,
      handlers,
    });

    expect(result).toEqual({ handled: true, kind: "dockview-in-workspace" });
    expect(handlers.onOpenFile).toHaveBeenCalledExactlyOnceWith(
      "my-project-feat-x",
      "src/foo.rs:42:5",
    );
    // The other three branches must not have fired.
    expect(handlers.onActivateFilesPanel).not.toHaveBeenCalled();
    expect(handlers.navigateInWorkspace).not.toHaveBeenCalled();
    expect(handlers.navigateToWorkspaceCode).not.toHaveBeenCalled();
    // External path is workspace-relative — no enqueue.
    expect(consumeExternalOpen("my-project-feat-x")).toBeUndefined();
  });

  it("desktop + external → enqueues + activates Files panel", () => {
    const handlers = makeHandlers();
    const result = dispatchOpenFileEvent(
      openFileEvent({ filePath: "/abs/path/foo.rs:7", external: true }),
      { isDockview: true, handlers },
    );

    expect(result).toEqual({ handled: true, kind: "dockview-external" });
    expect(handlers.onActivateFilesPanel).toHaveBeenCalledExactlyOnceWith("my-project-feat-x");
    expect(handlers.onOpenFile).not.toHaveBeenCalled();
    expect(handlers.navigateInWorkspace).not.toHaveBeenCalled();
    expect(handlers.navigateToWorkspaceCode).not.toHaveBeenCalled();
    // The CodeBrowserView in the (now-active) Files panel will drain
    // this on its next subscriber tick.
    expect(consumeExternalOpen("my-project-feat-x")).toEqual({
      filePath: "/abs/path/foo.rs:7",
    });
  });

  it("mobile + in-workspace → navigateInWorkspace", () => {
    const handlers = makeHandlers();
    const result = dispatchOpenFileEvent(openFileEvent({ filePath: "src/foo.rs:10-20" }), {
      isDockview: false,
      handlers,
    });

    expect(result).toEqual({ handled: true, kind: "mobile-in-workspace" });
    expect(handlers.navigateInWorkspace).toHaveBeenCalledExactlyOnceWith(
      "my-project-feat-x",
      "src/foo.rs:10-20",
    );
    expect(handlers.onOpenFile).not.toHaveBeenCalled();
    expect(handlers.onActivateFilesPanel).not.toHaveBeenCalled();
    expect(handlers.navigateToWorkspaceCode).not.toHaveBeenCalled();
    expect(consumeExternalOpen("my-project-feat-x")).toBeUndefined();
  });

  it("mobile + external → enqueues + navigates to workspace code index", () => {
    const handlers = makeHandlers();
    const result = dispatchOpenFileEvent(
      openFileEvent({ filePath: "/abs/path/foo.rs", external: true }),
      { isDockview: false, handlers },
    );

    expect(result).toEqual({ handled: true, kind: "mobile-external" });
    expect(handlers.navigateToWorkspaceCode).toHaveBeenCalledExactlyOnceWith("my-project-feat-x");
    expect(handlers.onOpenFile).not.toHaveBeenCalled();
    expect(handlers.onActivateFilesPanel).not.toHaveBeenCalled();
    expect(handlers.navigateInWorkspace).not.toHaveBeenCalled();
    expect(consumeExternalOpen("my-project-feat-x")).toEqual({
      filePath: "/abs/path/foo.rs",
    });
  });

  // -------------------------------------------------------------------
  // Reject paths — the dispatcher should silently no-op (not throw)
  // when the event is malformed or for an unrelated event kind. The
  // SSE stream is shared across all status events; the listener must
  // tolerate every event passing through.
  // -------------------------------------------------------------------

  it("ignores events that are not open-file", () => {
    const handlers = makeHandlers();
    const result = dispatchOpenFileEvent(
      { kind: "status-update", workspaceId: "my-project-feat-x" },
      { isDockview: true, handlers },
    );

    expect(result).toEqual({ handled: false, reason: "not-open-file" });
    expect(handlers.onOpenFile).not.toHaveBeenCalled();
    expect(handlers.onActivateFilesPanel).not.toHaveBeenCalled();
    expect(handlers.navigateInWorkspace).not.toHaveBeenCalled();
    expect(handlers.navigateToWorkspaceCode).not.toHaveBeenCalled();
  });

  it("ignores open-file events with no workspaceId", () => {
    const handlers = makeHandlers();
    const result = dispatchOpenFileEvent(
      { kind: "open-file", filePath: "src/foo.rs" },
      { isDockview: true, handlers },
    );

    expect(result).toEqual({ handled: false, reason: "missing-workspace-id" });
    expect(handlers.onOpenFile).not.toHaveBeenCalled();
  });

  it("ignores open-file events with no filePath", () => {
    const handlers = makeHandlers();
    const result = dispatchOpenFileEvent(
      { kind: "open-file", workspaceId: "my-project-feat-x" },
      { isDockview: true, handlers },
    );

    expect(result).toEqual({ handled: false, reason: "missing-file-path" });
    expect(handlers.onOpenFile).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------
  // Live-layout invariant — the dispatcher re-reads `isDockview` from
  // its options on every call, so changing layouts between events
  // routes the next event correctly. The production listener wraps
  // this with a ref so the SSE subscription survives viewport resize;
  // here we just verify the dispatcher itself doesn't cache.
  // -------------------------------------------------------------------

  it("respects per-call isDockview (no internal caching of layout)", () => {
    const handlers = makeHandlers();
    dispatchOpenFileEvent(openFileEvent(), { isDockview: true, handlers });
    dispatchOpenFileEvent(openFileEvent({ workspaceId: "other-workspace" }), {
      isDockview: false,
      handlers,
    });

    expect(handlers.onOpenFile).toHaveBeenCalledExactlyOnceWith("my-project-feat-x", "src/foo.rs");
    expect(handlers.navigateInWorkspace).toHaveBeenCalledExactlyOnceWith(
      "other-workspace",
      "src/foo.rs",
    );
  });
});

// ---------------------------------------------------------------------------
// Suffix preservation — the dispatcher does not parse the suffix; it
// forwards `filePath` to the handler verbatim. This is deliberate: the
// downstream consumer (CodeBrowserView via `openFilePath`, or the
// _splat route on mobile) does its own `parseFileLocation` and the
// dispatcher just decides where the payload goes. Document the
// invariant so a future "normalize here" refactor doesn't break the
// cursor-position contract.
// ---------------------------------------------------------------------------

describe("dispatchOpenFileEvent — suffix passthrough", () => {
  beforeEach(() => {
    // Defensive drain — the suite above already cleans up, but if these
    // run in a different order or in isolation the assertions below
    // must still see a fresh queue.
    consumeExternalOpen("my-project-feat-x");
  });

  it("forwards :line:col suffix verbatim on the in-workspace dockview path", () => {
    const handlers = makeHandlers();
    dispatchOpenFileEvent(openFileEvent({ filePath: "src/main.rs:42:5" }), {
      isDockview: true,
      handlers,
    });

    expect(handlers.onOpenFile).toHaveBeenCalledWith("my-project-feat-x", "src/main.rs:42:5");
  });

  it("forwards :line-end range suffix verbatim on the in-workspace mobile path", () => {
    const handlers = makeHandlers();
    dispatchOpenFileEvent(openFileEvent({ filePath: "src/main.rs:5-10" }), {
      isDockview: false,
      handlers,
    });

    expect(handlers.navigateInWorkspace).toHaveBeenCalledWith(
      "my-project-feat-x",
      "src/main.rs:5-10",
    );
  });

  it("preserves suffix in the queued external entry on dockview", () => {
    const handlers = makeHandlers();
    dispatchOpenFileEvent(openFileEvent({ filePath: "/abs/logs.txt:2:3", external: true }), {
      isDockview: true,
      handlers,
    });

    expect(consumeExternalOpen("my-project-feat-x")).toEqual({
      filePath: "/abs/logs.txt:2:3",
    });
  });
});
