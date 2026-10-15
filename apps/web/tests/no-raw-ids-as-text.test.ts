// A worktree id ends in `@<hostId>` off the hub's own host, so a component that renders an id as
// text shows `h-2e22f90bef5f` to the person reading it. Show `useWorktreeDisplay()` or
// `useHostDisplay()` output instead. Ids stay fine in attributes, keys, URLs and logs.
//
// Best-effort source scan: it flags JSX text children such as `{worktreeId}` or `{r.hostId}`.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const WEB_ROOT = join(import.meta.dirname, "..");
const ROOTS = [join(WEB_ROOT, "src"), join(WEB_ROOT, "..", "..", "plugins")];

/** Rendered as an id on purpose. Add a file here only with a reason. */
const ALLOWED = new Set([
  // A host request's id before a host is chosen: `<repo>-<branch>`, never host-qualified.
  "apps/web/src/dashboard/components/settings/RunnersSettings.tsx",
]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name === "dist") return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".tsx") ? [path] : [];
  });
}

const RAW_ID_CHILD =
  /(?:>\s*|^\s*)\{(?:[\w$?]+\.)*(?:worktreeId|newWorktreeId|hostId|workspaceId)\}\s*(?:<|$)/m;

/** The lines of JSX text children that print a raw id. */
function rawIdLines(source: string): number[] {
  return source
    .split("\n")
    .flatMap((line, i) => (RAW_ID_CHILD.test(line) && !line.includes("=") ? [i + 1] : []));
}

describe("raw ids as text", () => {
  it("flags a component that renders a worktreeId as text", () => {
    expect(rawIdLines(`<span>{worktreeId}</span>`)).toEqual([1]);
    expect(rawIdLines(`<li>\n  {r.hostId}\n</li>`)).toEqual([2]);
    expect(rawIdLines(`<Foo worktreeId={worktreeId} />`)).toEqual([]);
  });

  it("finds none in the UI sources", () => {
    const offenders = ROOTS.flatMap(sourceFiles).flatMap((file) => {
      const rel = relative(join(WEB_ROOT, "..", ".."), file);
      if (ALLOWED.has(rel)) return [];
      return rawIdLines(readFileSync(file, "utf8")).map((line) => `${rel}:${line}`);
    });
    expect(offenders).toEqual([]);
  });
});
