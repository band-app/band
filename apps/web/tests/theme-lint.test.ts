import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

// The lint is a script CI runs, so the test runs the script on files in a temp dir.
const script = resolve(import.meta.dirname, "../../../scripts/check-theme-tokens.mjs");

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "theme-lint-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function run(source: string, name = "Fixture.tsx") {
  writeFileSync(join(dir, name), source);
  const result = spawnSync("node", [script, dir], { encoding: "utf8" });
  rmSync(join(dir, name));
  return { code: result.status, output: result.stderr };
}

describe("check-theme-tokens", () => {
  it("fails on a Tailwind palette class and points to the tokens", () => {
    const { code, output } = run('export const A = () => <div className="bg-blue-500 p-2" />;\n');
    expect(code).toBe(1);
    expect(output).toContain("bg-blue-500");
    expect(output).toContain("globals.css");
  });

  it("fails on a dark: variant of a palette class", () => {
    expect(run('const c = "text-red-600 dark:text-red-400";\n').code).toBe(1);
  });

  it("fails on hex and rgb literals", () => {
    expect(run('const c = "#ff0000";\n').code).toBe(1);
    expect(run('const c = { background: "rgba(0, 0, 0, 0.5)" };\n').code).toBe(1);
  });

  it("passes on token classes, variables and issue numbers", () => {
    const source = [
      'const a = "bg-selection text-git-added border-border bg-success-bg";',
      'const b = "var(--syntax-keyword)";',
      "// see issue #617 and bg-blue-500 in a comment",
      'const c = "fixes #539";',
    ].join("\n");
    expect(run(source).code).toBe(0);
  });

  it("honors the ignore markers", () => {
    expect(run('// theme-lint-ignore-file: brand colors\nconst c = "#ff0000";\n').code).toBe(0);
    expect(run('// theme-lint-ignore-line: QR code\nconst c = "bg-white";\n').code).toBe(0);
    expect(run('const c = "bg-white"; // theme-lint-ignore-line: QR code\n').code).toBe(0);
  });

  it("passes on the real tree", () => {
    const result = spawnSync("node", [script], { encoding: "utf8" });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });
});
