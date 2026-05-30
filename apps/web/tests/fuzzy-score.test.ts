import { describe, expect, it } from "vitest";
import { fuzzyScore } from "../src/server/services/_utils/fuzzy-score";

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
  // The previous hand-rolled DP scorer weighted a `r` at the start of a
  // segment (e.g. `router` after `/`) above a consecutive `ts` run, so
  // `src/router.ts` outscored `src/errors.ts` for query `rts`. fzf-for-js
  // reverses that bias — its v2 algorithm rewards consecutive runs more
  // aggressively than word-start boundaries, so `src/errors.ts` (which
  // has `ts` consecutive at the end while `router.ts` does not — the
  // matched `t` in router falls inside `router` before the `.ts`) now
  // outscores `src/router.ts`. This matches the upstream fzf CLI's
  // behaviour, which is the de facto fuzzy-matching reference. Test
  // updated intentionally as part of issue #530 — see the file header
  // for context.
  it("consecutive runs are rewarded over word boundaries (fzf v2 weighting)", () => {
    const consecutive = fuzzyScore("rts", "src/errors.ts")!;
    const noConsecutive = fuzzyScore("rts", "src/router.ts")!;
    expect(consecutive).toBeGreaterThan(noConsecutive);
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
    const filename = fuzzyScore("git", "src/server/infra/git/git-client.ts")!;
    const directory = fuzzyScore("git", "git/src/services.ts")!;
    expect(filename).toBeGreaterThan(directory);
  });
});

// ---------------------------------------------------------------------------
// Real-world ranking scenarios
// ---------------------------------------------------------------------------
describe("fuzzyScore – real-world ranking", () => {
  const FILES = [
    "apps/web/src/server/services/fuzzy-score.ts",
    "apps/web/src/server/api/router.ts",
    "apps/web/src/server/infra/db/schema.ts",
    "apps/web/src/dashboard/components/QuickOpenDialog.tsx",
    "apps/web/src/server/services/state.ts",
    "apps/web/src/server/infra/git/git-client.ts",
    "apps/web/tests/trpc.test.ts",
    "apps/web/src/server/services/workspace.ts",
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
    expect(result[0]).toBe("apps/web/src/server/api/router.ts");
  });

  it("'qod' ranks QuickOpenDialog.tsx first", () => {
    const result = ranked("qod", FILES);
    expect(result[0]).toBe("apps/web/src/dashboard/components/QuickOpenDialog.tsx");
  });

  it("'git' ranks the git client first", () => {
    const result = ranked("git", FILES);
    expect(result[0]).toBe("apps/web/src/server/infra/git/git-client.ts");
  });

  it("'state' ranks state.ts first", () => {
    const result = ranked("state", FILES);
    expect(result[0]).toBe("apps/web/src/server/services/state.ts");
  });

  it("'fz' ranks fuzzy-score.ts first", () => {
    const result = ranked("fz", FILES);
    expect(result[0]).toBe("apps/web/src/server/services/fuzzy-score.ts");
  });
});

// ---------------------------------------------------------------------------
// Regression: substring matches beat scattered subsequence matches.
//
// Issue #530 reported the Cmd+P picker ranking files with the letters
// c-o-m-p-o-s-i-t-e scattered across them above files whose path
// contained `composite` as a literal substring. With the previous hand-
// rolled DP scorer combined with the 50-result cap, the wanted file
// (`flow-source-composite.ts`) could be pushed off the result list
// entirely. fzf v2's consecutive-run bonus makes the substring file the
// clear winner; this test pins the new behaviour so future scorer swaps
// can't regress it.
// ---------------------------------------------------------------------------
describe("fuzzyScore – substring beats scattered subsequence (issue #530)", () => {
  it("'composite' ranks flow-source-composite.ts above scattered matches", () => {
    const FILES = [
      // Substring match — `composite` appears as a literal consecutive run.
      "src/flow/flow-source-composite.ts",
      // Scattered matches — every char appears in order but spread across
      // a longer path. These are the kind of "noise" files that pushed
      // the wanted result off the bottom of the list in issue #530.
      "src/compose/option/site/setup.ts",
      "src/comparison/positive/site.ts",
      "src/components/positions/situational/test.ts",
    ];
    const result = ranked("composite", FILES);
    expect(result[0]).toBe("src/flow/flow-source-composite.ts");
  });
});
