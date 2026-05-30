/**
 * Unit coverage for `shouldBailAutoOpen` — the pure predicate that
 * gates the QuickOpenDialog's autoOpen → silent-close bail (issue
 * #539, fix layer 2).
 *
 * Mirrors the shape of the `shouldDropPersistedTab` unit suite for
 * the persisted-tab self-heal: pure-function, three branches with
 * explicit cases for each, no React rendering, no mocked adapter.
 *
 * The ref-isolation correctness (the open-capture effect must
 * depend ONLY on `open`, not on `workspaceId` — the regression CI
 * Claude reviewer caught on round 1) is documented inline in
 * `QuickOpenDialog.tsx`. The integration spec
 * `chat-file-link-workspace.spec.ts` covers the listener-filter
 * half of the leak end-to-end (the cross-workspace tab-leak test).
 * This unit test pins the bail's decision logic.
 */

import { describe, expect, it } from "vitest";
import { shouldBailAutoOpen } from "../src/dashboard/lib/quick-open-bail";

describe("shouldBailAutoOpen — three-branch contract (issue #539)", () => {
  it("returns false when the dialog hasn't captured a workspace yet (open-effect hasn't fired)", () => {
    // `null` is the initial ref state before the first `open: true`
    // transition fires the capture effect. The dialog has no
    // committed workspace to bail against — defer to whatever the
    // autoOpen effect does next.
    expect(shouldBailAutoOpen(null, "ws-A")).toBe(false);
    expect(shouldBailAutoOpen(null, "ws-B")).toBe(false);
    expect(shouldBailAutoOpen(null, "")).toBe(false);
  });

  it("returns false when the captured workspace matches the current workspace (happy path)", () => {
    // No flip happened between open-time and search-resolve-time;
    // the autoOpen shortcut should proceed normally.
    expect(shouldBailAutoOpen("ws-A", "ws-A")).toBe(false);
    expect(shouldBailAutoOpen("ws-B", "ws-B")).toBe(false);
    // Defensive: empty string match is still "match", not bail.
    expect(shouldBailAutoOpen("", "")).toBe(false);
  });

  it("returns true when the captured workspace differs from the current workspace (bail path)", () => {
    // The race the bail exists to handle: dialog opened against A,
    // workspace flipped to B before search resolved, `onOpenFile`
    // is bound to the parent's CURRENT workspace (B), so firing it
    // would leak the file into B's tab list. Abandon silently.
    expect(shouldBailAutoOpen("ws-A", "ws-B")).toBe(true);
    expect(shouldBailAutoOpen("ws-A", "ws-other")).toBe(true);
    expect(shouldBailAutoOpen("project-X/main", "project-Y/main")).toBe(true);
  });

  it("distinguishes null from empty string (prefix-safety against type widening)", () => {
    // A future refactor that widened the captured-id type might
    // round-trip `null` through some coercion that produced `""`.
    // The bail's `!== null` check is strict — `""` is NOT null and
    // a mismatched empty captured against a non-empty current
    // SHOULD bail (defensive: never silently treat the
    // empty-string state as "no capture").
    expect(shouldBailAutoOpen("", "ws-A")).toBe(true);
    // Symmetric: captured "ws-A" + current "" mismatches.
    expect(shouldBailAutoOpen("ws-A", "")).toBe(true);
  });
});
