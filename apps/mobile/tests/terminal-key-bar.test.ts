import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyCtrl,
  BAR_KEYS,
  type BarKey,
  barKeyBytes,
  scanCursorMode,
  trackCursorMode,
} from "../src/lib/terminal/key-bar.ts";

describe("key bar bytes", () => {
  it("sends Esc and Tab", () => {
    assert.equal(barKeyBytes("esc", false), "\u001b");
    assert.equal(barKeyBytes("tab", false), "\t");
  });

  it("sends arrows in normal or application cursor mode", () => {
    assert.equal(barKeyBytes("up", false), "\u001b[A");
    assert.equal(barKeyBytes("down", false), "\u001b[B");
    assert.equal(barKeyBytes("right", false), "\u001b[C");
    assert.equal(barKeyBytes("left", false), "\u001b[D");
    assert.equal(barKeyBytes("up", true), "\u001bOA");
    assert.equal(barKeyBytes("left", true), "\u001bOD");
  });

  it("sends the punctuation the iOS keyboard hides", () => {
    assert.equal(barKeyBytes("pipe", false), "|");
    assert.equal(barKeyBytes("tilde", false), "~");
    assert.equal(barKeyBytes("slash", false), "/");
  });

  it("has a key for each BarKey, once", () => {
    const all: BarKey[] = ["esc", "tab", "up", "down", "left", "right", "pipe", "tilde", "slash"];
    const keys = BAR_KEYS.map((k) => k.key);
    assert.equal(new Set(keys).size, keys.length);
    assert.deepEqual([...keys].sort(), [...all].sort());
    for (const k of keys) assert.notEqual(barKeyBytes(k, false), "");
  });
});

describe("applyCtrl", () => {
  it("turns letters into control codes", () => {
    assert.deepEqual(applyCtrl("c"), { data: "\u0003", applied: true });
    assert.deepEqual(applyCtrl("C"), { data: "\u0003", applied: true });
    assert.deepEqual(applyCtrl("d"), { data: "\u0004", applied: true });
    assert.deepEqual(applyCtrl("z"), { data: "\u001a", applied: true });
    assert.deepEqual(applyCtrl("a"), { data: "\u0001", applied: true });
  });

  it("maps the punctuation controls", () => {
    assert.equal(applyCtrl("[").data, "\u001b");
    assert.equal(applyCtrl("\\").data, "\u001c");
    assert.equal(applyCtrl(" ").data, "\u0000");
    assert.equal(applyCtrl("?").data, "\u007f");
  });

  it("leaves everything else alone", () => {
    assert.deepEqual(applyCtrl("1"), { data: "1", applied: false });
    assert.deepEqual(applyCtrl("ls"), { data: "ls", applied: false });
    assert.deepEqual(applyCtrl("\u001b[A"), { data: "\u001b[A", applied: false });
    assert.deepEqual(applyCtrl("é"), { data: "é", applied: false });
  });
});

describe("trackCursorMode", () => {
  it("follows the last set or reset in a chunk", () => {
    assert.equal(trackCursorMode(false, "\u001b[?1h"), true);
    assert.equal(trackCursorMode(true, "\u001b[?1l"), false);
    assert.equal(trackCursorMode(false, "\u001b[?1h text \u001b[?1l"), false);
    assert.equal(trackCursorMode(false, "\u001b[?1l\u001b[?1h"), true);
  });

  it("keeps the mode when the chunk does not change it", () => {
    assert.equal(trackCursorMode(true, "plain output \u001b[?25h \u001b[?1049h"), true);
    assert.equal(trackCursorMode(false, ""), false);
  });
});

describe("scanCursorMode", () => {
  const bytes = (text: string) => new TextEncoder().encode(text);
  const none = new Uint8Array(0);

  it("matches trackCursorMode on whole chunks", () => {
    const chunks = [
      "\u001b[?1h",
      "\u001b[?1h x \u001b[?1l",
      "\u001b[?1l\u001b[?1h",
      "plain \u001b[?25h",
    ];
    for (const start of [false, true]) {
      for (const chunk of chunks) {
        assert.equal(
          scanCursorMode(start, bytes(chunk), none).mode,
          trackCursorMode(start, chunk),
          chunk,
        );
      }
    }
  });

  it("finds a sequence split across frames at every position", () => {
    const seq = bytes("\u001b[?1h");
    for (let cut = 1; cut < seq.length; cut++) {
      const a = scanCursorMode(false, seq.subarray(0, cut), none);
      assert.equal(a.mode, false);
      const b = scanCursorMode(a.mode, seq.subarray(cut), a.tail);
      assert.equal(b.mode, true, `cut at ${cut}`);
    }
  });

  it("does not count a sequence twice or keep more than four bytes", () => {
    const a = scanCursorMode(false, bytes("\u001b[?1h"), none);
    assert.equal(a.tail.length, 4);
    const b = scanCursorMode(true, bytes("\u001b[?1l"), a.tail);
    assert.equal(b.mode, false);
    const c = scanCursorMode(b.mode, bytes("x"), b.tail);
    assert.equal(c.mode, false);
  });
});
