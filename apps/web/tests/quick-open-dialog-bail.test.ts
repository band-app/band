// @vitest-environment jsdom
/**
 * Unit coverage for `QuickOpenDialog`'s `openedWorkspaceIdRef` bail —
 * the in-flight workspace-switch guard added for issue #539 (fix
 * layer 2).
 *
 * The bail's exercise path resists black-box integration testing
 * because the race window (workspace flips between the dialog's open
 * and the search resolving) is faster than Playwright's await
 * granularity on a tiny test fixture. This unit test instead
 * controls the `searchWorkspaceFiles` adapter directly via a
 * pending-promise pattern, so the test code chooses precisely when
 * the search resolves relative to the workspaceId prop flip.
 *
 * Covers four scenarios:
 *
 *   1. Happy path — workspace stays put → `onOpenFile` fires for the
 *      captured workspace.
 *   2. Bail path — workspace flips between dialog open and search
 *      resolve → `onOpenFile` does NOT fire; dialog closes silently.
 *   3. Ref-isolation regression — the open-capture effect must NOT
 *      have `workspaceId` in its dep array. We simulate the broken
 *      shape by flipping the prop BEFORE the search resolves and
 *      asserting the bail still fires; if the ref were re-captured
 *      on every prop change, the bail's comparison would no-op and
 *      `onOpenFile` would wrongly fire against the new workspace.
 *   4. No-autoOpen path — the bail is gated on `autoOpen=true`; if
 *      `autoOpen` is false, the dialog just becomes visible and the
 *      user picks manually. `onOpenFile` MUST NOT fire automatically.
 *
 * Avoids `@testing-library/react` — uses the same minimal
 * `createRoot` + `act` pattern as `useFileTabs.test.ts` and
 * `editor-history.test.ts`. The dashboard context is supplied
 * directly by rendering `<DashboardProvider>` around the dialog so
 * `useAdapter()` / `useCapabilities()` resolve.
 */

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { DashboardProvider, type PlatformCapabilities, QuickOpenDialog } from "../src/dashboard";
import type { DashboardAdapter } from "../src/dashboard/adapter";

beforeAll(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  // jsdom is missing a handful of DOM APIs that radix-ui / cmdk
  // touch unconditionally during mount. Stub them with no-op
  // implementations so the dialog renders without crashing.
  if (typeof window.matchMedia !== "function") {
    (window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = () =>
      ({
        matches: false,
        media: "",
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList;
  }
  if (typeof (globalThis as Record<string, unknown>).ResizeObserver !== "function") {
    (globalThis as Record<string, unknown>).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

// ---------------------------------------------------------------------------
// Controlled adapter — `searchWorkspaceFiles` returns a promise whose
// resolution is gated by `resolveLatest()`. Lets the test choose
// when the autoOpen effect's "search has completed" branch fires.
// ---------------------------------------------------------------------------
interface PendingSearch {
  workspaceId: string;
  query: string;
  resolve: (files: string[]) => void;
}

function makePendingAdapter(): {
  adapter: DashboardAdapter;
  pending: PendingSearch[];
  resolveLatest: (files: string[]) => void;
} {
  const pending: PendingSearch[] = [];

  const searchWorkspaceFiles = (
    workspaceId: string,
    query: string,
  ): Promise<{ files: string[] }> => {
    return new Promise((resolve) => {
      pending.push({
        workspaceId,
        query,
        resolve: (files) => resolve({ files }),
      });
    });
  };

  // Minimal adapter — only the field QuickOpenDialog reads is set.
  // Everything else is intentionally `undefined` so a regression that
  // started reading a different method would crash loudly here rather
  // than silently returning empty data.
  const adapter = { searchWorkspaceFiles } as unknown as DashboardAdapter;
  return {
    adapter,
    pending,
    resolveLatest: (files: string[]) => {
      const next = pending.shift();
      if (!next) throw new Error("resolveLatest: no pending search");
      next.resolve(files);
    },
  };
}

const capabilities: PlatformCapabilities = {} as PlatformCapabilities;

// ---------------------------------------------------------------------------
// Render harness — mounts QuickOpenDialog with controllable props and
// captures the `onOpenFile` / `onOpenChange` callbacks for assertions.
// ---------------------------------------------------------------------------
interface RenderHandle {
  rerender: (props: Partial<RenderProps>) => Promise<void>;
  unmount: () => void;
  onOpenFile: ReturnType<typeof vi.fn>;
  onOpenChange: ReturnType<typeof vi.fn>;
}

interface RenderProps {
  workspaceId: string;
  open: boolean;
  initialQuery?: string;
  autoOpen?: boolean;
}

function renderDialog(initial: RenderProps, adapter: DashboardAdapter): RenderHandle {
  const onOpenFile = vi.fn();
  const onOpenChange = vi.fn();
  let currentProps = initial;
  let root: Root;

  const container = document.createElement("div");
  document.body.appendChild(container);

  function syncRender() {
    act(() => {
      root.render(
        createElement(
          DashboardProvider,
          { adapter, capabilities },
          createElement(QuickOpenDialog, {
            ...currentProps,
            onOpenChange,
            onOpenFile,
          }),
        ),
      );
    });
  }

  act(() => {
    root = createRoot(container);
  });
  syncRender();

  return {
    rerender: async (next) => {
      currentProps = { ...currentProps, ...next };
      syncRender();
    },
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
    onOpenFile,
    onOpenChange,
  };
}

// ---------------------------------------------------------------------------
// Helper — sleep long enough for the dialog's 150 ms search debounce
// to elapse + microtask drainage. Uses real time (no fake timers) —
// fake-timers interleaves badly with React's concurrent effect
// flush, so we wait the real 250 ms and rely on `act` to drain
// effects after.
// ---------------------------------------------------------------------------
async function flushDialog(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
  });
}

/**
 * Drain microtasks inside `act` so the controlled adapter's Promise
 * resolution propagates through `.then` → `setFiles` → React batch
 * commit → autoOpen effect re-run.
 *
 * `await act(async () => { resolveLatest(...); await microtask })`
 * is the shape — without the bare-microtask drain inside act, React
 * 18's automatic-batching of Promise-driven setState lands the
 * commit one tick after act returns, and any post-act assertion
 * fires before the autoOpen effect actually runs.
 */
async function resolveAndFlush(
  resolveLatest: (files: string[]) => void,
  files: string[],
): Promise<void> {
  await act(async () => {
    resolveLatest(files);
    // One-tick yield drains the Promise's `.then` / `.finally`
    // microtasks and forces React to commit the queued setFiles
    // batch before act returns.
    await new Promise((r) => setTimeout(r, 0));
  });
  await flushDialog();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("QuickOpenDialog — openedWorkspaceIdRef bail (issue #539)", () => {
  it("happy path: workspace stays put, single-match search → onOpenFile fires for the captured workspace", async () => {
    const { adapter, pending, resolveLatest } = makePendingAdapter();
    const harness = renderDialog(
      { workspaceId: "ws-A", open: true, initialQuery: "src/main.ts", autoOpen: true },
      adapter,
    );

    await flushDialog();
    // The dialog's open-effect runs setQuery(initialQuery), then the
    // search effect's cleanup cancels the empty-query 0-delay timer
    // and schedules a new 150 ms debounce against "src/main.ts" in
    // ws-A. After flushDialog, that adapter call is pending.
    expect(pending.length).toBeGreaterThan(0);
    expect(pending[pending.length - 1].workspaceId).toBe("ws-A");
    expect(pending[pending.length - 1].query).toBe("src/main.ts");

    await resolveAndFlush(resolveLatest, ["src/main.ts"]);

    expect(harness.onOpenFile).toHaveBeenCalledTimes(1);
    expect(harness.onOpenFile).toHaveBeenCalledWith("src/main.ts");
    expect(harness.onOpenChange).toHaveBeenLastCalledWith(false);

    harness.unmount();
  });

  it("bail path: workspaceId flips between open and search resolve → onOpenFile does NOT fire", async () => {
    const { adapter, pending, resolveLatest } = makePendingAdapter();
    const harness = renderDialog(
      { workspaceId: "ws-A", open: true, initialQuery: "shared.ts", autoOpen: true },
      adapter,
    );

    await flushDialog();
    // First debounced search is queued against ws-A.
    expect(pending.length).toBeGreaterThan(0);

    // Flip the workspace prop BEFORE resolving — this is the race the
    // bail exists to handle. The ref captured `ws-A` on the
    // false → true `open` transition; this prop flip MUST NOT
    // overwrite that captured value.
    await harness.rerender({ workspaceId: "ws-B" });
    await flushDialog();

    // Drain the cancelled ws-A call first — its setFiles/finally
    // closures already have `cancelled=true` from the cleanup, so
    // resolving doesn't affect dialog state, but emptying the queue
    // confirms the cancellation guard works.
    while (pending.length > 1) {
      const old = pending.shift();
      old?.resolve(["ws-A-leak-shared.ts"]);
    }
    const latest = pending[pending.length - 1];
    expect(latest.workspaceId).toBe("ws-B");

    await resolveAndFlush(resolveLatest, ["shared.ts"]);

    // With the bail in place: openedWorkspaceIdRef (ws-A) !==
    // current workspaceId (ws-B) → onOpenChange(false), no
    // onOpenFile call.
    expect(harness.onOpenFile).not.toHaveBeenCalled();
    expect(harness.onOpenChange).toHaveBeenLastCalledWith(false);

    harness.unmount();
  });

  it("ref-isolation regression: the captured workspace must survive multiple workspaceId flips while open", async () => {
    // Direct guard against the round-1 bug CI Claude reviewer caught:
    // the open-capture effect originally had `workspaceId` in its
    // deps, so EVERY workspace flip while the dialog was open
    // overwrote the ref with the current workspaceId. This test
    // proves the ref captures only the open-transition value.
    const { adapter, pending, resolveLatest } = makePendingAdapter();
    const harness = renderDialog(
      { workspaceId: "ws-A", open: true, initialQuery: "shared.ts", autoOpen: true },
      adapter,
    );

    await flushDialog();

    // Flip THREE times through ws-B, ws-C, then settle on ws-D — if
    // the ref re-captured on each prop change it'd now hold ws-D.
    await harness.rerender({ workspaceId: "ws-B" });
    await harness.rerender({ workspaceId: "ws-C" });
    await harness.rerender({ workspaceId: "ws-D" });
    await flushDialog();

    // Drain everything older than the freshest pending call.
    while (pending.length > 1) {
      pending.shift()?.resolve(["leak"]);
    }
    await resolveAndFlush(resolveLatest, ["shared.ts"]);

    // Bail fires because the ref still holds ws-A — onOpenFile is
    // not called against ws-D. A regression that re-included
    // workspaceId in the capture effect's deps would have made the
    // ref equal to ws-D at this point, and onOpenFile would have
    // wrongly fired.
    expect(harness.onOpenFile).not.toHaveBeenCalled();
    expect(harness.onOpenChange).toHaveBeenLastCalledWith(false);

    harness.unmount();
  });

  it("no-autoOpen path: visible dialog, single-match search → onOpenFile is NOT auto-called (user must select)", async () => {
    // The bail is gated on `autoOpen=true`. When the user opens the
    // dialog manually (Cmd+P, no preset query), the dialog is just a
    // picker — the search runs, results render, the user clicks one,
    // and onOpenFile fires from `handleSelect` (not from the
    // autoOpen effect). Verify the autoOpen-effect-driven
    // onOpenFile call doesn't happen even when search resolves
    // single-match.
    const { adapter, pending, resolveLatest } = makePendingAdapter();
    const harness = renderDialog(
      { workspaceId: "ws-A", open: true, initialQuery: "src/main.ts", autoOpen: false },
      adapter,
    );

    await flushDialog();
    expect(pending.length).toBeGreaterThan(0);

    await resolveAndFlush(resolveLatest, ["src/main.ts"]);

    // No autoOpen → no onOpenFile from the effect, even on single
    // match. The user has to click to pick.
    expect(harness.onOpenFile).not.toHaveBeenCalled();

    harness.unmount();
  });
});
