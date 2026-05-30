/**
 * Unit coverage for `shouldDropPersistedTab` — the four-branch
 * predicate at the heart of the persisted-tab self-heal added for
 * issue #539 (fix layer 3).
 *
 * The predicate is the only piece of logic between a FileViewer load
 * rejection and `handleTabClose`. Pinning its truth table here gives
 * us the counter-anchor that the integration spec's "ENOENT
 * self-heals" test can't (the spec can prove the POSITIVE branch
 * — stale tab gets closed — but driving the three negative branches
 * end-to-end requires user-initiated tab navigation that the
 * dockview layout doesn't expose a stable locator for).
 *
 * The truth table:
 *
 *   | restoredTabPath | failedPath  | error contains ENOENT | drop? |
 *   |-----------------|-------------|-----------------------|-------|
 *   | null            | anything    | yes                   | no    |
 *   | "a.ts"          | "b.ts"      | yes                   | no    |
 *   | "a.ts"          | "a.ts"      | no                    | no    |
 *   | "a.ts"          | "a.ts"      | yes                   | YES   |
 *
 * Plus error-message lexical variants (literal `ENOENT` vs the
 * "no such file or directory" prose, with case-insensitive matching)
 * so a future adapter that wraps the rejection doesn't accidentally
 * bypass the self-heal.
 */

import { describe, expect, it } from "vitest";
import { shouldDropPersistedTab } from "../src/lib/persisted-tab-self-heal";

describe("shouldDropPersistedTab — four-branch contract (issue #539)", () => {
  // ---------------------------------------------------------------------
  // Branch 1 — no restored tab on mount → never drop
  // ---------------------------------------------------------------------
  it("returns false when restoredTabPath is null (no persisted tab to restore)", () => {
    expect(
      shouldDropPersistedTab(
        "src/main.ts",
        null,
        "ENOENT: no such file or directory, stat '/foo/src/main.ts'",
      ),
    ).toBe(false);
  });

  it("returns false when restoredTabPath is null even for non-ENOENT errors", () => {
    expect(shouldDropPersistedTab("src/main.ts", null, "Network error")).toBe(false);
  });

  // ---------------------------------------------------------------------
  // Branch 2 — restored tab exists but a DIFFERENT tab failed → never drop
  // ---------------------------------------------------------------------
  it("returns false when the failing path is not the restored tab (path mismatch)", () => {
    // The user-driven counter-anchor: workspace mounted with a real
    // persisted tab, the user navigated to a second tab, the second
    // tab failed with ENOENT. The second tab is NOT the
    // initial-restored one, so the self-heal must not fire — that
    // tab is the user's responsibility to keep or close.
    expect(
      shouldDropPersistedTab(
        "src/different.ts",
        "src/active.ts",
        "ENOENT: no such file or directory",
      ),
    ).toBe(false);
  });

  it("returns false when a sibling tab fails (prefix-safety)", () => {
    // Defence against a future regression that switched the equality
    // check to a startsWith / prefix match. `src/main.ts.bak` would
    // share the `src/main.ts` prefix but is a different file.
    expect(
      shouldDropPersistedTab("src/main.ts.bak", "src/main.ts", "ENOENT: no such file or directory"),
    ).toBe(false);
  });

  // ---------------------------------------------------------------------
  // Branch 3 — same tab but non-ENOENT error → never drop (transient)
  // ---------------------------------------------------------------------
  it("returns false when the error is a generic / transient rejection", () => {
    // Network blip — the file may still exist; a retry could succeed.
    // Dropping the tab here would silently make the user's work
    // disappear on a single failed read.
    expect(shouldDropPersistedTab("src/main.ts", "src/main.ts", "Network error")).toBe(false);
  });

  it("returns false on permission errors (EACCES / EPERM)", () => {
    expect(
      shouldDropPersistedTab(
        "src/main.ts",
        "src/main.ts",
        "EACCES: permission denied, stat '/foo/src/main.ts'",
      ),
    ).toBe(false);
    expect(
      shouldDropPersistedTab(
        "src/main.ts",
        "src/main.ts",
        "EPERM: operation not permitted, stat '/foo/src/main.ts'",
      ),
    ).toBe(false);
  });

  it("returns false on the unhelpful fallback message", () => {
    // FileViewer's catch branch defaults to "Failed to read file" when
    // the rejection isn't an Error instance. That's not ENOENT, so we
    // mustn't act on it.
    expect(shouldDropPersistedTab("src/main.ts", "src/main.ts", "Failed to read file")).toBe(false);
  });

  // ---------------------------------------------------------------------
  // Branch 4 — same tab AND ENOENT-style error → drop
  // ---------------------------------------------------------------------
  it("returns true when the path matches and the error contains the literal ENOENT", () => {
    // The `fs.stat` rejection shape from `editor-service`.
    expect(
      shouldDropPersistedTab(
        "src/main.ts",
        "src/main.ts",
        "ENOENT: no such file or directory, stat '/foo/src/main.ts'",
      ),
    ).toBe(true);
  });

  it("returns true when the path matches and the error contains the prose form only", () => {
    // Some adapters wrap the rejection before forwarding — the
    // literal `ENOENT` substring may be stripped, leaving only the
    // human-readable suffix. The helper accepts either form.
    expect(shouldDropPersistedTab("src/main.ts", "src/main.ts", "no such file or directory")).toBe(
      true,
    );
  });

  it("matches the ENOENT marker case-insensitively (defensive)", () => {
    // The regex uses the `i` flag. A future logger that lower-cases
    // its messages, or a different OS / locale, must still trip the
    // self-heal.
    expect(shouldDropPersistedTab("src/main.ts", "src/main.ts", "enoent: file gone")).toBe(true);
    expect(shouldDropPersistedTab("src/main.ts", "src/main.ts", "NO SUCH FILE OR DIRECTORY")).toBe(
      true,
    );
  });

  // ---------------------------------------------------------------------
  // Edge: empty strings
  // ---------------------------------------------------------------------
  it("returns false for an empty failedPath even when the ref is also empty", () => {
    // `""` is the sentinel CodeBrowserView uses for "no file selected"
    // (`viewFilePath = fileTabs.activeTabPath ?? ""`). The empty-state
    // FileViewer doesn't actually load anything, so it should never
    // reach `handleFileLoadError`, but guard anyway: an empty ref
    // matching an empty failedPath shouldn't accidentally trip the
    // self-heal on a non-ENOENT diagnostic.
    expect(shouldDropPersistedTab("", null, "anything")).toBe(false);
    expect(shouldDropPersistedTab("", "", "no error context")).toBe(false);
  });
});
