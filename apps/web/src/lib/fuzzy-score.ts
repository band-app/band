/**
 * Fuzzy file-path scoring algorithm, inspired by VS Code's Quick Open.
 *
 * Returns a numeric score (higher = better match) or null if the query
 * does not match the target at all.
 */

// ---------------------------------------------------------------------------
// Scoring constants
// ---------------------------------------------------------------------------

/** Base score awarded for every matched character. */
const SCORE_MATCH = 1;

/** Bonus when two matched characters are adjacent in the target. */
const BONUS_CONSECUTIVE = 8;

/** Bonus when a matched character sits at a word boundary (after / . - _ space). */
const BONUS_WORD_START = 7;

/** Bonus for a camelCase boundary (lowercase → uppercase transition). */
const BONUS_CAMEL_CASE = 6;

/** Bonus when the match starts at the very first character of the filename. */
const BONUS_FILENAME_START = 10;

/** Per-character bonus for every match that falls inside the filename portion. */
const BONUS_FILENAME_CHAR = 3;

/** Penalty applied when a match follows a gap (non-consecutive). */
const PENALTY_GAP_START = -3;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SEPARATOR_CODES: Set<number> = new Set([
  47, // '/'
  92, // '\\'
  46, // '.'
  45, // '-'
  95, // '_'
  32, // ' '
]);

function isSeparatorCode(code: number): boolean {
  return SEPARATOR_CODES.has(code);
}

/**
 * Compute the per-position bonus for matching at `target[j]`.
 *
 * Bonuses are awarded for:
 * - Being inside the filename portion of the path
 * - Immediately following a separator (word start)
 * - Being the very first character of the filename
 * - Sitting at a camelCase boundary
 */
function positionBonus(
  target: string,
  j: number,
  filenameStart: number,
): number {
  let bonus = 0;

  // Bonus for every match inside the filename
  if (j >= filenameStart) {
    bonus += BONUS_FILENAME_CHAR;
  }

  // Word-boundary / segment-start bonuses
  if (j === 0 || isSeparatorCode(target.charCodeAt(j - 1))) {
    bonus += j === filenameStart ? BONUS_FILENAME_START : BONUS_WORD_START;
  } else {
    // camelCase boundary: previous char is lowercase, current is uppercase
    const curr = target.charCodeAt(j);
    const prev = target.charCodeAt(j - 1);
    if (curr >= 65 && curr <= 90 && prev >= 97 && prev <= 122) {
      bonus += BONUS_CAMEL_CASE;
    }
  }

  return bonus;
}

// ---------------------------------------------------------------------------
// DP scorer
// ---------------------------------------------------------------------------

/**
 * Find the optimal subsequence-match of `queryLower` inside `target` and
 * return its score.  Uses a two-row DP:
 *
 *   M[j] = best score matching query[0..i] where query[i] IS matched at target[j]
 *   D[j] = best score matching query[0..i] with last match at-or-before target[j]
 *
 * Transition (for query char i, target position j where chars match):
 *   consecutive  = M_prev[j-1] + SCORE_MATCH + BONUS_CONSECUTIVE + posBonus
 *   afterGap     = D_prev[j-1] + SCORE_MATCH + posBonus + PENALTY_GAP_START
 *   M[j]         = max(consecutive, afterGap)
 *   D[j]         = max(D[j-1], M[j])
 */
function dpScore(
  queryLower: string,
  target: string,
  targetLower: string,
  filenameStart: number,
): number {
  const n = queryLower.length;
  const m = targetLower.length;

  let M = new Array<number>(m).fill(-Infinity);
  let D = new Array<number>(m).fill(-Infinity);

  // --- first query character (i = 0) ---
  for (let j = 0; j < m; j++) {
    if (targetLower[j] === queryLower[0]) {
      M[j] = SCORE_MATCH + positionBonus(target, j, filenameStart);
    }
    D[j] = j === 0 ? M[j] : Math.max(D[j - 1], M[j]);
  }

  // --- remaining query characters ---
  for (let i = 1; i < n; i++) {
    const prevM = M;
    const prevD = D;
    M = new Array<number>(m).fill(-Infinity);
    D = new Array<number>(m).fill(-Infinity);

    for (let j = i; j < m; j++) {
      if (targetLower[j] === queryLower[i]) {
        const bonus = positionBonus(target, j, filenameStart);

        // Continue a consecutive run (query[i-1] matched at target[j-1])
        const consecutive =
          prevM[j - 1] + SCORE_MATCH + BONUS_CONSECUTIVE + bonus;

        // Start a new run after a gap (penalised)
        const afterGap =
          prevD[j - 1] + SCORE_MATCH + bonus + PENALTY_GAP_START;

        M[j] = Math.max(consecutive, afterGap);
      }

      D[j] = j > 0 ? Math.max(D[j - 1], M[j]) : M[j];
    }
  }

  return D[m - 1];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute a fuzzy-match score for `query` against `filePath`.
 *
 * @returns A numeric score (higher = better) or `null` when the query does
 *          not match the path at all.  An empty query matches everything
 *          with score 0.
 */
export function fuzzyScore(query: string, filePath: string): number | null {
  if (!query) return 0;
  if (!filePath) return null;

  const queryLower = query.toLowerCase();
  const pathLower = filePath.toLowerCase();
  const n = queryLower.length;
  const m = pathLower.length;

  if (n > m) return null;

  // Quick rejection: verify all query chars exist in order
  let qi = 0;
  for (let i = 0; i < m && qi < n; i++) {
    if (pathLower[i] === queryLower[qi]) qi++;
  }
  if (qi < n) return null;

  const filenameStart = filePath.lastIndexOf("/") + 1;

  // Score against the full path
  let score = dpScore(queryLower, filePath, pathLower, filenameStart);

  // If all query chars can be found inside the filename alone, also score
  // against just the filename.  This effectively gives a large bonus to
  // filename-only matches because filenameStart becomes 0 and every char
  // gets BONUS_FILENAME_START / BONUS_FILENAME_CHAR.
  if (filenameStart > 0) {
    const filename = filePath.slice(filenameStart);
    const filenameLower = pathLower.slice(filenameStart);

    qi = 0;
    for (let i = 0; i < filenameLower.length && qi < n; i++) {
      if (filenameLower[i] === queryLower[qi]) qi++;
    }

    if (qi === n) {
      const fnScore = dpScore(queryLower, filename, filenameLower, 0);
      score = Math.max(score, fnScore);
    }
  }

  // Tiebreaker: among equally-scored files, prefer shorter paths (more
  // prominent / closer to the project root).  The factor is small enough
  // (max ~1.5 for a 150-char path) that it only affects ties.
  return score - filePath.length * 0.01;
}
