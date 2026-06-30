import { describe, expect, it } from "vitest";
import { findTerminalFileLinks } from "../src/lib/terminal-file-links";

// ---------------------------------------------------------------------------
// `findTerminalFileLinks` carves a line of terminal text into clickable file
// references. The combinatorial surface — which tokens become links and which
// are rejected as false positives — is exactly what these unit cases pin; the
// click-through-to-Quick-Open behaviour is covered by the Playwright spec in
// `e2e/terminal-file-links.spec.ts` (per TEST-6, the integration test is the
// proof of the user-observable behaviour; this guards the detection details).
// ---------------------------------------------------------------------------

/** Convenience: just the matched path strings for a line. */
function paths(line: string): string[] {
  return findTerminalFileLinks(line).map((m) => m.text);
}

describe("findTerminalFileLinks – paths that should link", () => {
  it("links a relative path with a line indicator", () => {
    expect(paths("see src/main.rs:42 for details")).toEqual(["src/main.rs:42"]);
  });

  it("links a path with a known extension and a slash, even without a line", () => {
    expect(paths("edited apps/web/src/foo.ts here")).toEqual(["apps/web/src/foo.ts"]);
  });

  it("preserves line:column and line-range suffixes", () => {
    expect(paths("components/Button.tsx:15:8")).toEqual(["components/Button.tsx:15:8"]);
    expect(paths("app.tsx:10-20")).toEqual(["app.tsx:10-20"]);
  });

  it("links ./ and ../ relative prefixes", () => {
    expect(paths("./src/utils.ts:5")).toEqual(["./src/utils.ts:5"]);
    expect(paths("../lib/index.js:100")).toEqual(["../lib/index.js:100"]);
  });

  it("links an absolute path", () => {
    expect(paths("/Users/me/project/src/main.rs:42")).toEqual(["/Users/me/project/src/main.rs:42"]);
  });

  it("links a well-known extensionless filename on its own", () => {
    expect(paths("Makefile")).toEqual(["Makefile"]);
  });

  it("finds multiple links on one line", () => {
    expect(paths("src/a.ts:1 and src/b.ts:2")).toEqual(["src/a.ts:1", "src/b.ts:2"]);
  });

  it("links a path wrapped in parentheses without grabbing the parens", () => {
    expect(paths("at (src/app.tsx:3)")).toEqual(["src/app.tsx:3"]);
  });
});

describe("findTerminalFileLinks – tokens that should NOT link", () => {
  it("rejects http/https URLs", () => {
    expect(paths("open http://localhost:5173/foo now")).toEqual([]);
    expect(paths("see https://example.com/path")).toEqual([]);
  });

  it("rejects host:port and dotted-number tokens", () => {
    expect(paths("listening on 127.0.0.1:5173")).toEqual([]);
    expect(paths("version 1.2.3 released")).toEqual([]);
  });

  it("rejects a bare filename with no slash and no line indicator", () => {
    expect(paths("ran utils.ts in the suite")).toEqual([]);
  });

  it("rejects unknown extensions", () => {
    expect(paths("touch notes.unknownext:10")).toEqual([]);
  });

  it("returns nothing for an empty or whitespace line", () => {
    expect(paths("")).toEqual([]);
    expect(paths("   ")).toEqual([]);
  });
});

describe("findTerminalFileLinks – match offsets", () => {
  it("reports the start/end indices of the matched path within the line", () => {
    const line = "see src/main.rs:42 here";
    const matches = findTerminalFileLinks(line);
    expect(matches).toHaveLength(1);
    const m = matches[0];
    expect(line.slice(m.startIndex, m.endIndex)).toBe("src/main.rs:42");
    expect(m.startIndex).toBe(4);
    expect(m.endIndex).toBe(4 + "src/main.rs:42".length);
  });
});
