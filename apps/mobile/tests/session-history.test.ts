import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { relativeAge, sessionLabel, sessionRows } from "../src/lib/chat/session-history.ts";

const NOW = 1_000_000_000_000;

describe("session history rows", () => {
  it("orders newest first and marks the current session", () => {
    const rows = sessionRows(
      [
        { sessionId: "old-1", summary: "Older", lastModified: NOW - 3 * 3600_000 },
        { sessionId: "new-2", summary: "Newer", lastModified: NOW - 120_000 },
      ],
      "new-2",
      NOW,
    );
    assert.deepEqual(
      rows.map((r) => [r.sessionId, r.label, r.age, r.current]),
      [
        ["new-2", "Newer", "2m ago", true],
        ["old-1", "Older", "3h ago", false],
      ],
    );
  });

  it("falls back to a short id and leaves the age empty without a time", () => {
    assert.equal(sessionLabel({ sessionId: "abcdef123456", summary: "  " }), "abcdef12");
    const [row] = sessionRows(
      [{ sessionId: "abcdef123456", summary: "", lastModified: 0 }],
      undefined,
      NOW,
    );
    assert.equal(row?.age, "");
    assert.equal(row?.current, false);
  });

  it("does not reorder its input", () => {
    const input = [
      { sessionId: "a", summary: "a", lastModified: 1 },
      { sessionId: "b", summary: "b", lastModified: 2 },
    ];
    sessionRows(input, undefined, NOW);
    assert.equal(input[0]?.sessionId, "a");
  });

  it("steps through the age units", () => {
    assert.equal(relativeAge(NOW - 10_000, NOW), "just now");
    assert.equal(relativeAge(NOW - 2 * 86_400_000, NOW), "2d ago");
    assert.equal(relativeAge(NOW - 65 * 86_400_000, NOW), "2mo ago");
  });
});
