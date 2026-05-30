/**
 * Fuzzy file-path scoring — thin wrapper around `fzf-for-js` (npm `fzf`),
 * a faithful TypeScript port of fzf v2's algorithm.
 *
 * Why fzf and not the previous hand-rolled DP scorer:
 *   The old scorer (see git history for the `fuzzy-score.ts` it replaced)
 *   used a two-row dynamic-programming approach that occasionally ranked
 *   scattered subsequence matches above literal substring matches — the
 *   real-world example from issue #530 was the query `composite` matching
 *   `flow-source-composite.ts` (a substring run) being out-scored by
 *   files where the letters c-o-m-p-o-s-i-t-e happened to appear strewn
 *   across a longer path. With Quick Open's result cap the wanted file
 *   could be pushed off the list entirely.
 *
 *   fzf's v2 algorithm rewards consecutive runs, word boundaries, and
 *   camel-case boundaries — and it's the upstream-maintained matcher
 *   junegunn/fzf ships, so we get correct substring-beats-scattered
 *   behaviour for free without owning the algorithm ourselves.
 *
 * Public API preserved verbatim from the previous implementation so the
 * `SearchService.searchFiles` call site (and any direct consumers in the
 * test suite) keep working unchanged:
 *
 *     fuzzyScore(query, filePath) → number | null
 *
 *   - `null`   — no fuzzy match (any query char missing in order)
 *   - `number` — relative score; higher is a better match. Empty query
 *                returns 0 (matches everything) for parity with the old
 *                contract.
 *
 * On top of fzf we add two adjustments that mirror the old DP scorer:
 *
 *   1. Per-character filename bonus. fzf doesn't know about path
 *      structure, so `router` in `src/trpc/router.ts` and
 *      `router/src/trpc.ts` score identically — both are a clean
 *      consecutive run at a `/` boundary. We boost positions that fall
 *      inside the filename portion (after the last `/`) so Quick Open
 *      users see file-name matches above directory matches, which is
 *      the implicit expectation every Quick Open implementation
 *      validates (VS Code, Sublime, etc.).
 *
 *   2. Short-path tiebreaker. Among equally-scored paths, prefer the
 *      shorter one (closer to the project root). Small enough that it
 *      never overturns a real score difference.
 */

import { Fzf, type FzfResultItem } from "fzf";

/**
 * Per-character bonus for every matched position that falls inside the
 * filename portion of the path. Mirrors `BONUS_FILENAME_CHAR = 3` in
 * the old DP scorer — same value, same semantics.
 */
const BONUS_FILENAME_CHAR = 3;

/**
 * Length tiebreaker — among equally-scored results, prefer shorter
 * paths (closer to the project root). The factor is small enough that
 * it never overturns a real score difference; for a 150-char path it
 * shifts the score by at most ~1.5. Mirrors the constant in the
 * previous DP implementation exactly.
 */
const SHORT_PATH_TIEBREAKER_WEIGHT = 0.01;

/**
 * fzf options reused on every call. We construct a fresh `Fzf` per
 * call because the wrapper API takes one (query, path) pair at a time;
 * this is hot but well-bounded (Quick Open corpora are typically <10k
 * paths) and the per-call cost is dominated by fzf's matcher itself.
 *
 * `casing: "case-insensitive"` preserves the old contract: the
 * previous DP scorer always lower-cased both operands, so `QOD` matched
 * `quod_file.tsx`. fzf's default `smart-case` would reject that.
 *
 * `forward: false` matches from the end of the string. fzf documents
 * this exact case in its own JSDoc: "useful if one needs to match a
 * file path and they prefer querying for the file name over directory
 * names present in the path." Without it, `git` in
 * `src/server/infra/git/git-client.ts` matches the `infra/git/`
 * directory rather than the `git-client.ts` filename — both score
 * identically in fzf, and forward:true picks the first occurrence.
 * forward:false picks the last one, which combined with the per-char
 * filename bonus below gives Quick Open the right ranking.
 */
const FZF_OPTIONS = { casing: "case-insensitive", forward: false } as const;

export function fuzzyScore(query: string, filePath: string): number | null {
  // Preserve the legacy contract for the empty-string edge cases. fzf
  // returns an empty result list for an empty query (treats it as "no
  // pattern"), but callers expect 0 (matches everything with neutral
  // score) so they can sort files by path-length alone in that mode.
  if (!query) return 0;
  if (!filePath) return null;

  const result: FzfResultItem<string> | undefined = new Fzf([filePath], FZF_OPTIONS).find(query)[0];
  if (!result) return null;

  // Add a per-character bonus for every matched position that falls in
  // the filename portion of the path. fzf returns positions as a
  // `Set<number>` — iterate once and count how many are at-or-after the
  // filename start. We deliberately do NOT take a max(full, filename)
  // here because fzf gives the same raw score for matching `router`
  // against the full path vs against just the filename — the
  // per-position bonus is what differentiates them.
  const filenameStart = filePath.lastIndexOf("/") + 1;
  let filenameBonus = 0;
  if (filenameStart > 0) {
    for (const pos of result.positions) {
      if (pos >= filenameStart) filenameBonus += BONUS_FILENAME_CHAR;
    }
  } else {
    // No `/` in the path means the whole thing is the filename; every
    // matched position counts. Iterate `result.positions` instead of
    // multiplying by query length because fzf positions may include
    // bonus characters in non-fuzzy modes (defensive, even though our
    // mode is plain v2 fuzzy).
    filenameBonus = result.positions.size * BONUS_FILENAME_CHAR;
  }

  return result.score + filenameBonus - filePath.length * SHORT_PATH_TIEBREAKER_WEIGHT;
}
