import { describe, expect, it, vi } from "vitest";
import {
  dispatchOpenFileEvent,
  type OpenFileDispatchHandlers,
} from "../src/lib/dispatch-open-file";

// ---------------------------------------------------------------------------
// dispatchOpenFileEvent — pure dispatcher for `band open` SSE events on
// the desktop layout.
//
//   in-worktree   →  onOpenFile
//   external       →  onOpenExternalFile
//
// Mobile is handled by the caller (`__root.tsx`) — the SSE listener
// short-circuits before reaching the dispatcher when `useDesktopLayout`
// is false. That guard lives in the production listener; this file
// covers the dispatcher's own contract.
//
// The dispatcher is the contract between the SSE event boundary and the
// layout; verifying it here means future regressions in `__root.tsx`'s
// listener (which is now just a thin shim) can't silently break
// `band open` end-to-end. The CLI integration tests cover the server-
// side event shape; this file covers the renderer-side dispatch.
// ---------------------------------------------------------------------------

function makeHandlers(): OpenFileDispatchHandlers & {
  onOpenFile: ReturnType<typeof vi.fn>;
  onOpenExternalFile: ReturnType<typeof vi.fn>;
} {
  return {
    onOpenFile: vi.fn(),
    onOpenExternalFile: vi.fn(),
  };
}

function openFileEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "open-file",
    worktreeId: "my-repo-feat-x",
    filePath: "src/foo.rs",
    external: false,
    focus: true,
    ...overrides,
  };
}

describe("dispatchOpenFileEvent", () => {
  // -------------------------------------------------------------------
  // Happy paths
  // -------------------------------------------------------------------

  it("in-worktree → onOpenFile (writes per-worktree state + activates panel)", () => {
    const handlers = makeHandlers();
    const result = dispatchOpenFileEvent(openFileEvent({ filePath: "src/foo.rs:42:5" }), handlers);

    expect(result).toEqual({ handled: true, kind: "in-worktree" });
    expect(handlers.onOpenFile).toHaveBeenCalledExactlyOnceWith(
      "my-repo-feat-x",
      "src/foo.rs:42:5",
    );
    expect(handlers.onOpenExternalFile).not.toHaveBeenCalled();
  });

  it("external → onOpenExternalFile", () => {
    const handlers = makeHandlers();
    const result = dispatchOpenFileEvent(
      openFileEvent({ filePath: "/abs/path/foo.rs:7", external: true }),
      handlers,
    );

    expect(result).toEqual({ handled: true, kind: "external" });
    expect(handlers.onOpenExternalFile).toHaveBeenCalledExactlyOnceWith(
      "my-repo-feat-x",
      "/abs/path/foo.rs:7",
    );
    expect(handlers.onOpenFile).not.toHaveBeenCalled();
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
      { kind: "status-update", worktreeId: "my-repo-feat-x" },
      handlers,
    );

    expect(result).toEqual({ handled: false, reason: "not-open-file" });
    expect(handlers.onOpenFile).not.toHaveBeenCalled();
    expect(handlers.onOpenExternalFile).not.toHaveBeenCalled();
  });

  it("ignores open-file events with no worktreeId", () => {
    const handlers = makeHandlers();
    const result = dispatchOpenFileEvent({ kind: "open-file", filePath: "src/foo.rs" }, handlers);

    expect(result).toEqual({ handled: false, reason: "missing-worktree-id" });
    expect(handlers.onOpenFile).not.toHaveBeenCalled();
  });

  it("ignores open-file events with no filePath", () => {
    const handlers = makeHandlers();
    const result = dispatchOpenFileEvent(
      { kind: "open-file", worktreeId: "my-repo-feat-x" },
      handlers,
    );

    expect(result).toEqual({ handled: false, reason: "missing-file-path" });
    expect(handlers.onOpenFile).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Suffix preservation — the dispatcher does not parse the suffix; it
// forwards `filePath` to the handler verbatim. This is deliberate: the
// downstream consumer (CodeBrowserView via `openFilePath`) does its own
// `parseFileLocation` and the dispatcher just decides where the payload
// goes. Document the invariant so a future "normalize here" refactor
// doesn't break the cursor-position contract.
// ---------------------------------------------------------------------------

describe("dispatchOpenFileEvent — suffix passthrough", () => {
  it("forwards :line:col suffix verbatim on the in-worktree path", () => {
    const handlers = makeHandlers();
    dispatchOpenFileEvent(openFileEvent({ filePath: "src/main.rs:42:5" }), handlers);

    expect(handlers.onOpenFile).toHaveBeenCalledWith("my-repo-feat-x", "src/main.rs:42:5");
  });

  it("forwards the suffix on the external path", () => {
    const handlers = makeHandlers();
    dispatchOpenFileEvent(
      openFileEvent({ filePath: "/abs/logs.txt:2:3", external: true }),
      handlers,
    );

    expect(handlers.onOpenExternalFile).toHaveBeenCalledWith("my-repo-feat-x", "/abs/logs.txt:2:3");
  });
});
