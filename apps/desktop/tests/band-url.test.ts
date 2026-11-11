/**
 * `parseBandUrl` turns `band://file/<path>[:line[:col]]` into a path and position. Any app can open
 * a band:// URL, so the parser must never yield anything but a path, and must report other routes
 * (such as the mobile app's `band://pair`) as unknown.
 */

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { parseBandUrl } from "../src/main/services/band-url.ts";

describe("parseBandUrl", () => {
  test("a plain path", () => {
    assert.deepEqual(parseBandUrl("band://file/Users/me/repo"), {
      kind: "file",
      path: "/Users/me/repo",
    });
  });

  test("line and column", () => {
    assert.deepEqual(parseBandUrl("band://file/Users/me/a.ts:12:3"), {
      kind: "file",
      path: "/Users/me/a.ts",
      line: 12,
      column: 3,
    });
    assert.deepEqual(parseBandUrl("band://file/Users/me/a.ts:7"), {
      kind: "file",
      path: "/Users/me/a.ts",
      line: 7,
    });
  });

  test("percent-decodes the path", () => {
    assert.deepEqual(parseBandUrl("band://file/Users/me/my%20repo/a%3Ab.ts:2"), {
      kind: "file",
      path: "/Users/me/my repo/a:b.ts",
      line: 2,
    });
  });

  test("drops a trailing slash and resolves dot segments", () => {
    assert.deepEqual(parseBandUrl("band://file/Users/me/repo/"), {
      kind: "file",
      path: "/Users/me/repo",
    });
    assert.deepEqual(parseBandUrl("band://file/Users/me/repo/../other"), {
      kind: "file",
      path: "/Users/me/other",
    });
  });

  test("other routes and bad input are unknown", () => {
    for (const url of [
      "band://pair?host=1.2.3.4&token=x",
      "band://worktree/a/chat/b",
      "https://file/Users/me",
      "not a url",
      "band://file/%E0%A4%A",
      "band://file",
    ]) {
      assert.equal(parseBandUrl(url).kind, "unknown", url);
    }
  });
});
