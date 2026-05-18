import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FormatterError, formatFile } from "../src/lib/formatter";

// Black-box tests for the Prettier-backed formatter. The dispatcher is a
// pure function — content in, formatted content out — so almost every test
// here can run without touching the filesystem. We do drop a real
// `.prettierrc` next to the file in the project-config test, since that
// codepath exercises Prettier's filesystem walk-up resolver.

describe("formatFile (Prettier dispatcher)", () => {
  let worktree: string;

  beforeEach(() => {
    worktree = realpathSync(mkdtempSync(join(tmpdir(), "band-formatter-")));
  });
  afterEach(() => {
    rmSync(worktree, { recursive: true, force: true });
  });

  it("formats a poorly-indented .js source string", async () => {
    const file = join(worktree, "ugly.js");
    const result = await formatFile(worktree, file, "const   foo={bar:1,baz:2}\n", {
      configOverride: null,
    });
    expect(result.skipped).toBe(false);
    if (result.skipped) throw new Error("unreachable");

    expect(result.parser).toBe("babel");
    expect(result.changed).toBe(true);
    expect(result.formatted).toContain("const foo = { bar: 1, baz: 2 };");
  });

  it("formats .ts using the typescript parser", async () => {
    const file = join(worktree, "x.ts");
    const result = await formatFile(worktree, file, "const x:number=1\n", {
      configOverride: null,
    });
    expect(result.skipped).toBe(false);
    if (result.skipped) throw new Error("unreachable");
    expect(result.parser).toBe("typescript");
    expect(result.changed).toBe(true);
    expect(result.formatted).toContain("const x: number = 1;");
  });

  it("formats JSON", async () => {
    const file = join(worktree, "data.json");
    const result = await formatFile(worktree, file, '{"a":1,"b":2}', { configOverride: null });
    expect(result.skipped).toBe(false);
    if (result.skipped) throw new Error("unreachable");
    expect(result.parser).toBe("json");
    expect(result.formatted).toBe('{ "a": 1, "b": 2 }\n');
  });

  it("formats markdown", async () => {
    const file = join(worktree, "readme.md");
    const result = await formatFile(worktree, file, "# Hello   \n\n\nworld\n", {
      configOverride: null,
    });
    expect(result.skipped).toBe(false);
    if (result.skipped) throw new Error("unreachable");
    expect(result.parser).toBe("markdown");
    expect(result.formatted).toBe("# Hello\n\nworld\n");
  });

  it("reports changed=false when the input is already well-formatted", async () => {
    const file = join(worktree, "clean.js");
    const original = "const foo = 1;\n";
    const result = await formatFile(worktree, file, original, { configOverride: null });
    expect(result.skipped).toBe(false);
    if (result.skipped) throw new Error("unreachable");
    expect(result.changed).toBe(false);
    expect(result.formatted).toBe(original);
  });

  it("returns skipped=true for files Prettier has no parser for", async () => {
    const file = join(worktree, "binary.bin");
    const result = await formatFile(worktree, file, "anything", { configOverride: null });
    expect(result.skipped).toBe(true);
    if (!result.skipped) throw new Error("unreachable");
    expect(result.reason).toMatch(/no parser/i);
  });

  it("returns skipped=true for arbitrary unknown extensions", async () => {
    const file = join(worktree, "a.xyz123");
    const result = await formatFile(worktree, file, "anything", { configOverride: null });
    expect(result.skipped).toBe(true);
  });

  it("resolves a relative path against the worktree", async () => {
    const result = await formatFile(worktree, "rel.js", "const a=1\n", {
      configOverride: null,
    });
    expect(result.skipped).toBe(false);
    if (result.skipped) throw new Error("unreachable");
    expect(result.file).toBe(join(worktree, "rel.js"));
    expect(result.formatted).toBe("const a = 1;\n");
  });

  it("throws FILE_NOT_IN_WORKTREE for paths outside the worktree", async () => {
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "band-formatter-outside-")));
    const file = join(elsewhere, "outside.js");

    try {
      await expect(
        formatFile(worktree, file, "const a = 1;\n", { configOverride: null }),
      ).rejects.toMatchObject({ code: "FILE_NOT_IN_WORKTREE" });
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("throws PRETTIER_FAILED on syntax errors", async () => {
    const file = join(worktree, "broken.ts");
    try {
      await formatFile(worktree, file, "const x: =;\n", { configOverride: null });
      throw new Error("expected formatFile to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(FormatterError);
      expect((err as FormatterError).code).toBe("PRETTIER_FAILED");
    }
  });

  it("respects a project-level .prettierrc when configOverride is omitted", async () => {
    // Drop a config file at the worktree root that flips singleQuote on.
    writeFileSync(join(worktree, ".prettierrc"), JSON.stringify({ singleQuote: true }));
    const file = join(worktree, "quoted.js");

    // No configOverride — let resolveConfig walk up and find .prettierrc.
    const result = await formatFile(worktree, file, `const s = "hello";\n`);
    expect(result.skipped).toBe(false);
    if (result.skipped) throw new Error("unreachable");
    expect(result.formatted).toBe(`const s = 'hello';\n`);
  });

  it("formats CSS", async () => {
    const file = join(worktree, "styles.css");
    const result = await formatFile(worktree, file, ".a{color:red;background:blue}\n", {
      configOverride: null,
    });
    expect(result.skipped).toBe(false);
    if (result.skipped) throw new Error("unreachable");
    expect(result.parser).toBe("css");
    expect(result.formatted).toMatch(/color: red/);
  });

  it("formats YAML", async () => {
    const file = join(worktree, "x.yaml");
    const result = await formatFile(worktree, file, "a: 1 \nb: 2\n", { configOverride: null });
    expect(result.skipped).toBe(false);
    if (result.skipped) throw new Error("unreachable");
    expect(result.parser).toBe("yaml");
    expect(result.changed).toBe(true);
    expect(result.formatted).toBe("a: 1\nb: 2\n");
  });

  it("does not require the target file to exist on disk", async () => {
    // The procedure is pure — content comes in via the argument, not the
    // filesystem. A path that doesn't yet exist (e.g. a brand-new
    // untitled buffer the user wants to format before first save) is a
    // valid input as long as the path is inside the worktree.
    const file = join(worktree, "never-saved.ts");
    const result = await formatFile(worktree, file, "const a=1\n", { configOverride: null });
    expect(result.skipped).toBe(false);
    if (result.skipped) throw new Error("unreachable");
    expect(result.formatted).toBe("const a = 1;\n");
  });

  it("returns skipped=true for files covered by .prettierignore", async () => {
    // `prettier.getFileInfo` honours `.prettierignore` when called with
    // `resolveConfig: true` — exercised here to lock in the soft-skip
    // path the dispatcher relies on.
    writeFileSync(join(worktree, ".prettierignore"), "*.js\n");
    const file = join(worktree, "ignored.js");

    // Omit `configOverride` so the real config-resolution walk runs.
    const result = await formatFile(worktree, file, "const   a=1\n");
    expect(result.skipped).toBe(true);
    if (!result.skipped) throw new Error("unreachable");
    expect(result.reason).toMatch(/\.prettierignore/);
  });
});
