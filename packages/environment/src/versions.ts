/**
 * Version numbers and the small range grammar `requires` uses. It covers what a
 * toolchain constraint needs (`>=24`, `^3.12`, `~1.22.1`, `24.x`, `>=20 <23`,
 * `18 || >=20`), not the whole of npm's semver. Pre-release tags and build
 * metadata are ignored.
 */

export interface Version {
  major: number;
  minor: number;
  patch: number;
}

const VERSION_IN_TEXT = /(\d+)\.(\d+)(?:\.(\d+))?/;

/**
 * Pulls the first `x.y` or `x.y.z` out of a tool's `--version` output
 * ("go version go1.22.1 darwin/arm64" gives 1.22.1). `null` when there is none.
 */
export function extractVersion(output: string): string | null {
  const match = VERSION_IN_TEXT.exec(output);
  if (!match) return null;
  return `${match[1]}.${match[2]}.${match[3] ?? "0"}`;
}

export function parseVersion(text: string): Version | null {
  const match = /^v?(\d+)\.(\d+)(?:\.(\d+))?(?:[-+].*)?$/.exec(text.trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3] ?? 0) };
}

function compare(a: Version, b: Version): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/** A version with some parts left out, as written in a range (`24`, `3.12`, `1.x`). */
interface Partial {
  major: number;
  minor?: number;
  patch?: number;
}

function parsePartial(text: string): Partial | null {
  if (text === "*" || text === "x" || text === "X" || text === "") return { major: -1 };
  const match = /^v?(\d+)(?:\.(\d+|x|X|\*)(?:\.(\d+|x|X|\*))?)?$/.exec(text);
  if (!match) return null;
  const part = (s: string | undefined): number | undefined =>
    s === undefined || /^[xX*]$/.test(s) ? undefined : Number(s);
  const major = Number(match[1]);
  const minor = part(match[2]);
  const patch = minor === undefined ? undefined : part(match[3]);
  return { major, minor, patch };
}

const floor = (p: Partial): Version => ({
  major: p.major,
  minor: p.minor ?? 0,
  patch: p.patch ?? 0,
});

/** The first version above everything the partial covers (`24` gives 25.0.0). */
function ceiling(p: Partial): Version {
  if (p.minor === undefined) return { major: p.major + 1, minor: 0, patch: 0 };
  if (p.patch === undefined) return { major: p.major, minor: p.minor + 1, patch: 0 };
  return { major: p.major, minor: p.minor, patch: p.patch + 1 };
}

type Test = (v: Version) => boolean;

function comparator(op: string, p: Partial): Test {
  if (p.major === -1) return () => true;
  const lo = floor(p);
  const hi = ceiling(p);
  switch (op) {
    case ">=":
      return (v) => compare(v, lo) >= 0;
    case ">":
      return (v) => compare(v, hi) >= 0;
    case "<":
      return (v) => compare(v, lo) < 0;
    case "<=":
      return (v) => compare(v, hi) < 0;
    case "^": {
      const upper: Version =
        p.major > 0 || p.minor === undefined
          ? { major: p.major + 1, minor: 0, patch: 0 }
          : p.minor > 0 || p.patch === undefined
            ? { major: 0, minor: p.minor + 1, patch: 0 }
            : { major: 0, minor: 0, patch: (p.patch ?? 0) + 1 };
      return (v) => compare(v, lo) >= 0 && compare(v, upper) < 0;
    }
    case "~": {
      const upper: Version =
        p.minor === undefined
          ? { major: p.major + 1, minor: 0, patch: 0 }
          : { major: p.major, minor: p.minor + 1, patch: 0 };
      return (v) => compare(v, lo) >= 0 && compare(v, upper) < 0;
    }
    default:
      return (v) => compare(v, lo) >= 0 && compare(v, hi) < 0;
  }
}

const COMPARATOR = /^(>=|<=|>|<|=|\^|~)?\s*(.*)$/;

/** Compiles a range, or returns a message saying what is wrong with it. */
export function compileRange(range: string): Test | { error: string } {
  const alternatives = range.split("||").map((s) => s.trim());
  const compiled: Test[][] = [];
  for (const alternative of alternatives) {
    if (alternative === "") return { error: `"${range}" has an empty alternative` };
    // "> = 1" style gaps are not allowed, but "`>= 1.2`" is: glue an operator to its version.
    const tokens = alternative.replace(/(>=|<=|>|<|=|\^|~)\s+/g, "$1").split(/\s+/);
    const tests: Test[] = [];
    for (const token of tokens) {
      const match = COMPARATOR.exec(token);
      const partial = match ? parsePartial(match[2] ?? "") : null;
      if (!match || !partial) {
        return { error: `"${token}" is not a version range such as ">=24", "^3.12" or "1.22.x"` };
      }
      tests.push(comparator(match[1] ?? "=", partial));
    }
    compiled.push(tests);
  }
  return (v) => compiled.some((all) => all.every((t) => t(v)));
}

/** The reason `range` is not valid, or `null`. */
export function rangeError(range: string): string | null {
  const compiled = compileRange(range);
  return typeof compiled === "function" ? null : compiled.error;
}

/** True when `version` (as a tool printed it) is inside `range`. False for an unparsable version or range. */
export function satisfies(version: string, range: string): boolean {
  const parsed = parseVersion(version);
  const compiled = compileRange(range);
  return parsed !== null && typeof compiled === "function" && compiled(parsed);
}
