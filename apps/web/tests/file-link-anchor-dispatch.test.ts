// @vitest-environment jsdom
/**
 * Unit coverage for the dispatcher-side half of the issue #539 fix:
 * the click → `useContext(FileLinkWorkspaceContext)` → `dispatchOpenFile`
 * chain inside `FileLinkedAnchor`.
 *
 * The Playwright spec drives `band:open-file` events via
 * `window.dispatchEvent` from the page context, which validates the
 * LISTENER half (filter on `detail.workspaceId`) but bypasses the
 * dispatcher half entirely. Pinning the context-read here means a
 * regression where the provider stops supplying the workspaceId, or
 * where `FileLinkedAnchor` stops reading from context (e.g. someone
 * threads a prop through instead and forgets the context fallback)
 * will fail the unit suite before it ever reaches CI.
 *
 * Covers:
 *
 *   1. Anchor inside `FileLinkWorkspaceProvider` → dispatched event
 *      carries the provider's workspaceId in `detail.workspaceId`.
 *   2. Anchor OUTSIDE the provider (legacy / forward-compat call
 *      site) → dispatched event carries `workspaceId: undefined`,
 *      matching the backwards-compat contract the listener filters
 *      rely on (missing workspaceId falls through to the active
 *      workspace).
 *   3. Two providers in the same tree with DIFFERENT workspaceIds
 *      → clicks in each subtree dispatch their OWN workspace's id,
 *      not whichever one is "active" or last-rendered. This is the
 *      core LRU-cache invariant: workspace A's chat and workspace B's
 *      chat can both be mounted, and clicks route per subtree.
 *   4. The dispatch is the ONLY side effect — the anchor calls
 *      `e.preventDefault()` + `e.stopPropagation()` so the browser
 *      doesn't try to navigate to `band-file:…` as a URL.
 *
 * The `streamdown` Components `a` shape expects an `ExtraProps.node`
 * field that we don't have at the unit-test boundary; the test uses
 * `as never` to satisfy the type without importing streamdown's hast
 * types.
 */

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FileLinkWorkspaceProvider,
  fileLinkComponents,
} from "../src/components/ai-elements/file-link-components";

beforeAll(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
});

// ---------------------------------------------------------------------------
// Window-event capture — listen for `band:open-file` dispatches in the
// test (jsdom's `window` is the dispatch target). The captured detail
// is the full assertion surface.
// ---------------------------------------------------------------------------
interface CapturedDispatch {
  filename?: string;
  workspaceId?: string;
}

function captureDispatches(): {
  captured: CapturedDispatch[];
  cleanup: () => void;
} {
  const captured: CapturedDispatch[] = [];
  const handler = (e: Event) => {
    captured.push((e as CustomEvent<CapturedDispatch>).detail);
  };
  window.addEventListener("band:open-file", handler);
  return {
    captured,
    cleanup: () => window.removeEventListener("band:open-file", handler),
  };
}

let dispatch: ReturnType<typeof captureDispatches>;

beforeEach(() => {
  dispatch = captureDispatches();
});

afterEach(() => {
  dispatch.cleanup();
});

// ---------------------------------------------------------------------------
// Render helper — mounts a React tree, returns the container so the
// test can locate the anchor and synthesize a click.
// ---------------------------------------------------------------------------
function render(node: React.ReactElement): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(node);
  });
  return { container, root };
}

function unmount(root: Root, container: HTMLDivElement): void {
  act(() => {
    root.unmount();
  });
  container.remove();
}

/**
 * Build a `band-file:` anchor element through the streamdown
 * Components map's `a` override (which IS `FileLinkedAnchor`). The
 * test renders the anchor as a child of `FileLinkWorkspaceProvider`
 * (or not, for the no-provider case) and synthesizes a click.
 */
function makeAnchor(href: string, label = "open me"): React.ReactElement {
  const A = fileLinkComponents.a as unknown as React.ComponentType<{
    href: string;
    children: React.ReactNode;
    node: never;
  }>;
  return createElement(A, { href, node: undefined as never }, label);
}

function clickAnchor(container: HTMLElement, label = "open me"): void {
  const anchor = Array.from(container.querySelectorAll("a")).find((el) => el.textContent === label);
  if (!anchor) throw new Error(`anchor with label "${label}" not found`);
  act(() => {
    anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("FileLinkedAnchor — click → context → dispatch (issue #539)", () => {
  it("dispatches with the surrounding provider's workspaceId", () => {
    const tree = createElement(
      FileLinkWorkspaceProvider,
      { workspaceId: "ws-alpha" },
      makeAnchor("band-file:src/main.ts:42"),
    );
    const { container, root } = render(tree);
    clickAnchor(container);

    expect(dispatch.captured).toEqual([{ filename: "src/main.ts:42", workspaceId: "ws-alpha" }]);

    unmount(root, container);
  });

  it("dispatches with workspaceId: undefined when rendered OUTSIDE a provider (backwards-compat hatch)", () => {
    // Forward-compat: the listener filter treats `undefined` as
    // "fall through to the active workspace" so a legacy non-chat
    // caller that calls `dispatchOpenFile` outside a chat tree keeps
    // working. The anchor itself doesn't crash on missing context —
    // `useContext` returns the default value (undefined).
    const { container, root } = render(makeAnchor("band-file:legacy.ts:1"));
    clickAnchor(container);

    expect(dispatch.captured).toEqual([{ filename: "legacy.ts:1", workspaceId: undefined }]);

    unmount(root, container);
  });

  it("two providers in the same tree route clicks to their OWN workspaceId (LRU-cache invariant)", () => {
    // The MultiWorkspacePanelHost cache mounts up to
    // `maxCachedWorkspaces` chat trees simultaneously — each wrapped
    // in its own `FileLinkWorkspaceProvider`. Clicks in subtree A
    // must dispatch ws-A; clicks in subtree B must dispatch ws-B,
    // regardless of mount order or which subtree is visually
    // focused. This is the core invariant the per-chat workspace
    // routing exists to maintain.
    const tree = createElement(
      "div",
      null,
      createElement(
        FileLinkWorkspaceProvider,
        { workspaceId: "ws-A" },
        makeAnchor("band-file:a.ts", "click-A"),
      ),
      createElement(
        FileLinkWorkspaceProvider,
        { workspaceId: "ws-B" },
        makeAnchor("band-file:b.ts", "click-B"),
      ),
    );
    const { container, root } = render(tree);

    clickAnchor(container, "click-A");
    clickAnchor(container, "click-B");
    clickAnchor(container, "click-A"); // second click in A — same routing

    expect(dispatch.captured).toEqual([
      { filename: "a.ts", workspaceId: "ws-A" },
      { filename: "b.ts", workspaceId: "ws-B" },
      { filename: "a.ts", workspaceId: "ws-A" },
    ]);

    unmount(root, container);
  });

  it("calls preventDefault / stopPropagation — the browser must NOT navigate to band-file: as a URL", () => {
    // Without `preventDefault`, the browser would try to navigate to
    // `band-file:src/main.ts` which is gibberish. Without
    // `stopPropagation`, an outer click handler (e.g. the chat
    // bubble's own click → expand / fold) would also fire on the
    // anchor click.
    const tree = createElement(
      FileLinkWorkspaceProvider,
      { workspaceId: "ws-default" },
      makeAnchor("band-file:src/main.ts"),
    );
    const { container, root } = render(tree);

    // Listener is attached to `document.body` — an ANCESTOR of
    // the React root container. `stopPropagation` only prevents
    // bubbling past the same node, not same-node listeners, so the
    // assertion has to be on an ancestor to actually exercise the
    // stop-bubbling claim.
    const outerSpy = vi.fn();
    document.body.addEventListener("click", outerSpy);

    const anchor = container.querySelector("a") as HTMLAnchorElement;
    const evt = new MouseEvent("click", { bubbles: true, cancelable: true });
    act(() => {
      anchor.dispatchEvent(evt);
    });

    expect(evt.defaultPrevented).toBe(true);
    expect(outerSpy).not.toHaveBeenCalled();

    document.body.removeEventListener("click", outerSpy);
    unmount(root, container);
  });
});
