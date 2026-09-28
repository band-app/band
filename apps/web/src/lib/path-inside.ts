/**
 * Segment-aware containment check for POSIX-style paths.
 *
 * Returns the path of `child` relative to `parent` when `child` is
 * inside `parent`, or `null` when it isn't. Workspace paths in Band
 * are always POSIX-style (forward slashes), so we operate on raw
 * string segments rather than pulling in `node:path` — this helper is
 * imported by browser-running components where `path` isn't available
 * natively, and a Vite polyfill would be overkill for one comparison.
 *
 * Implemented as a segment-aware prefix check rather than a raw
 * `startsWith`:
 *
 *   pathInside("/a/band",      "/a/band/src/x.ts")    → "src/x.ts"
 *   pathInside("/a/band",      "/a/band")             → ""
 *   pathInside("/a/band",      "/a/band-fork/src/x")  → null   ← prefix-safe
 *   pathInside("/a/band/",     "/a/band/src/x.ts")    → "src/x.ts"
 *   pathInside("/a/band",      "/elsewhere/x.ts")     → null
 *
 * The prefix-collision case is the security-adjacent invariant: a
 * naive `chosen.startsWith(root)` would treat `/a/band-fork/...` as
 * inside `/a/band`. We strip trailing slashes from `parent` first,
 * then require either an exact match or a `${parent}/` prefix — the
 * required `/` separator after the parent is what blocks the
 * collision.
 *
 * Backs the untitled save flow's "did the user pick a path inside
 * the workspace?" decision in `CodeBrowserView.handleSaveUntitled`.
 * Pure function, no I/O — easy to unit-test.
 */
export function pathInside(parent: string, child: string): string | null {
  if (!parent) return null;
  const root = parent.replace(/\/+$/, "");
  if (!root) return null;
  if (child === root) return "";
  const prefix = `${root}/`;
  if (!child.startsWith(prefix)) return null;
  return child.slice(prefix.length);
}
