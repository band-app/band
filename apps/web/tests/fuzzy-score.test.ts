import { describe, expect, it } from "vitest";
import { fuzzyScore } from "../src/lib/fuzzy-score";

// ---------------------------------------------------------------------------
// Helper: given a query and a list of file paths, return them sorted by score
// (highest first), filtering out non-matches.
// ---------------------------------------------------------------------------
function ranked(query: string, paths: string[]): string[] {
  const scored: { path: string; score: number }[] = [];
  for (const p of paths) {
    const s = fuzzyScore(query, p);
    if (s !== null) scored.push({ path: p, score: s });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((r) => r.path);
}

// ---------------------------------------------------------------------------
// Basic matching / rejection
// ---------------------------------------------------------------------------
describe("fuzzyScore – basic matching", () => {
  it("returns 0 for an empty query (matches everything)", () => {
    expect(fuzzyScore("", "src/index.ts")).toBe(0);
    expect(fuzzyScore("", "")).toBe(0);
  });

  it("returns null when the target is empty", () => {
    expect(fuzzyScore("a", "")).toBeNull();
  });

  it("returns null when query is longer than target", () => {
    expect(fuzzyScore("abcdef", "abc")).toBeNull();
  });

  it("returns null when characters are not present in order", () => {
    expect(fuzzyScore("xyz", "src/index.ts")).toBeNull();
    expect(fuzzyScore("ba", "abc")).toBeNull();
  });

  it("returns a positive score for a valid fuzzy match", () => {
    const score = fuzzyScore("idx", "src/index.ts");
    expect(score).not.toBeNull();
    expect(score!).toBeGreaterThan(0);
  });

  it("matches case-insensitively", () => {
    expect(fuzzyScore("ABC", "abc.txt")).not.toBeNull();
    expect(fuzzyScore("abc", "ABC.txt")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 1. Consecutive character matches score higher
// ---------------------------------------------------------------------------
describe("fuzzyScore – consecutive matches", () => {
  it("exact substring beats scattered characters", () => {
    const exact = fuzzyScore("schema", "schema.prisma")!;
    const scattered = fuzzyScore("schema", "src/cache/help_manager_app.ts")!;
    expect(exact).toBeGreaterThan(scattered);
  });

  it("longer consecutive run beats shorter runs", () => {
    // "index" as 5 consecutive chars vs matched across two segments
    const full = fuzzyScore("index", "src/index.ts")!;
    const split = fuzzyScore("index", "src/init_dex.ts")!;
    expect(full).toBeGreaterThan(split);
  });
});

// ---------------------------------------------------------------------------
// 2. Start-of-word / segment matches score higher
// ---------------------------------------------------------------------------
describe("fuzzyScore – word-start bonus", () => {
  it("match at word boundary beats match mid-word", () => {
    // 'r' at the start of 'router' (after /) vs 'r' buried inside 'error'
    const wordStart = fuzzyScore("rts", "src/router.ts")!;
    const midWord = fuzzyScore("rts", "src/errors.ts")!;
    expect(wordStart).toBeGreaterThan(midWord);
  });

  it("camelCase boundaries count as word starts", () => {
    const camel = fuzzyScore("QOD", "QuickOpenDialog.tsx")!;
    const noCamel = fuzzyScore("QOD", "quod_file.tsx")!;
    expect(camel).toBeGreaterThan(noCamel);
  });
});

// ---------------------------------------------------------------------------
// 3. Start-of-filename matches score highest
// ---------------------------------------------------------------------------
describe("fuzzyScore – filename-start bonus", () => {
  it("match at filename start beats match in directory", () => {
    const filenameStart = fuzzyScore("router", "src/trpc/router.ts")!;
    const dirMatch = fuzzyScore("router", "router/src/trpc.ts")!;
    expect(filenameStart).toBeGreaterThan(dirMatch);
  });
});

// ---------------------------------------------------------------------------
// 4. Compact matches score higher
// ---------------------------------------------------------------------------
describe("fuzzyScore – compactness", () => {
  it("adjacent matches beat distant matches", () => {
    const compact = fuzzyScore("ab", "ab_something.ts")!;
    const distant = fuzzyScore("ab", "a_long_path_before_b.ts")!;
    expect(compact).toBeGreaterThan(distant);
  });
});

// ---------------------------------------------------------------------------
// 5. Filename matches weighted more than directory path matches
// ---------------------------------------------------------------------------
describe("fuzzyScore – filename vs directory weight", () => {
  it("match in filename outscores same match in directory", () => {
    const inFilename = fuzzyScore("schema", "src/db/schema.ts")!;
    const inDirectory = fuzzyScore("schema", "schema/db/types.ts")!;
    expect(inFilename).toBeGreaterThan(inDirectory);
  });

  it("full filename match beats partial directory match even for short queries", () => {
    const filename = fuzzyScore("git", "src/lib/git.ts")!;
    const directory = fuzzyScore("git", "git/src/lib.ts")!;
    expect(filename).toBeGreaterThan(directory);
  });
});

// ---------------------------------------------------------------------------
// Real-world ranking scenarios
// ---------------------------------------------------------------------------
describe("fuzzyScore – real-world ranking", () => {
  const FILES = [
    "apps/web/src/lib/fuzzy-score.ts",
    "apps/web/src/trpc/router.ts",
    "apps/web/src/server/infra/db/schema.ts",
    "apps/web/src/dashboard/components/QuickOpenDialog.tsx",
    "apps/web/src/lib/state.ts",
    "apps/web/src/lib/git.ts",
    "apps/web/tests/trpc.test.ts",
    "apps/web/src/lib/workspace.ts",
    "schema.prisma",
    "src/old/scattered_chars_hema.ts",
  ];

  it("'schema' ranks schema.prisma first", () => {
    const result = ranked("schema", FILES);
    expect(result[0]).toBe("schema.prisma");
  });

  it("'schema' ranks db/schema.ts above scattered matches", () => {
    const result = ranked("schema", FILES);
    const schemaIdx = result.indexOf("apps/web/src/server/infra/db/schema.ts");
    const scatteredIdx = result.indexOf("src/old/scattered_chars_hema.ts");
    expect(schemaIdx).toBeLessThan(scatteredIdx);
  });

  it("'router' ranks router.ts first", () => {
    const result = ranked("router", FILES);
    expect(result[0]).toBe("apps/web/src/trpc/router.ts");
  });

  it("'qod' ranks QuickOpenDialog.tsx first", () => {
    const result = ranked("qod", FILES);
    expect(result[0]).toBe("apps/web/src/dashboard/components/QuickOpenDialog.tsx");
  });

  it("'git' ranks git.ts first", () => {
    const result = ranked("git", FILES);
    expect(result[0]).toBe("apps/web/src/lib/git.ts");
  });

  it("'state' ranks state.ts first", () => {
    const result = ranked("state", FILES);
    expect(result[0]).toBe("apps/web/src/lib/state.ts");
  });

  it("'fz' ranks fuzzy-score.ts first", () => {
    const result = ranked("fz", FILES);
    expect(result[0]).toBe("apps/web/src/lib/fuzzy-score.ts");
  });
});
