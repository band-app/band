/**
 * The repo `delta` for the explorer, search and changes flows. Its main worktree (`delta-main`)
 * holds a folder of 3,000 files (the scroll check), a 1.3 MB text file (too large to preview),
 * a binary file, a PNG, markdown, code with a very long line, and a working tree with one file
 * of each change kind: modified, added (staged), renamed (staged), deleted and untracked.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const BULK_FILES = 3000;

function write(dir, path, content) {
  const file = join(dir, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

const INDEX_OLD = [
  "import { parse } from './parser';",
  "",
  "export function main(args: string[]): number {",
  "  const value = parse(args[0] ?? '0');",
  "  return value;",
  "}",
  "",
].join("\n");

const INDEX_NEW = [
  "import { parse } from './parser';",
  "",
  "/** Runs the tool and returns its exit code. */",
  "export function main(args: string[]): number {",
  "  const value = parse(args[0] ?? '0');",
  "  if (Number.isNaN(value)) return 1;",
  "  return value;",
  "}",
  "",
].join("\n");

const GUIDE = ["# Guide", "", "Run `delta --help` for the commands.", "", "```sh", "delta run", "```", ""].join("\n");

export async function seedExplorer(state, root, { trpc, png }) {
  const dir = join(root, "delta");
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: dir,
      stdio: "ignore",
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    });
  mkdirSync(dir, { recursive: true });
  git("init", "-q", "-b", "main");
  write(dir, "README.md", "# Delta\n\nA **sample** project.\n\n- one\n- two\n\nSee [the guide](docs/guide.md).\n");
  write(dir, "docs/guide.md", GUIDE);
  write(dir, "src/index.ts", INDEX_OLD);
  write(dir, "src/util.js", "export const answer = 42;\nexport function twice(n) {\n  return n * 2;\n}\n");
  write(dir, "src/old.ts", "export const obsolete = true;\n");
  write(dir, "src/long-line.ts", `export const long = "${"x".repeat(300)}";\nexport const short = 1;\n`);
  write(dir, "assets/pixel.png", png);
  write(dir, "assets/blob.bin", Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00, 0xfe]));
  write(dir, "data/big.txt", Array.from({ length: 30_000 }, (_, i) => `line ${i} of the big file, padded out to make it large`).join("\n"));
  for (let i = 1; i <= BULK_FILES; i++) {
    write(dir, `bulk/f${String(i).padStart(4, "0")}.txt`, `file ${i}\n`);
  }
  // A file long enough that a match on line 400 is off screen until the viewer jumps to it.
  write(
    dir,
    "docs/long.txt",
    Array.from({ length: 500 }, (_, i) => (i + 1 === 400 ? "line 400: needle400 is here" : `row ${i + 1} of the long file`)).join("\n") + "\n",
  );
  git("add", ".");
  git("commit", "-q", "-m", "init");
  await trpc(state, "repos.add", { path: dir });

  // The working tree: one file of each kind of change.
  write(dir, "src/index.ts", INDEX_NEW);
  git("mv", "src/util.js", "src/helpers.js");
  // Edited after the move and staged, so the rename carries a diff.
  write(dir, "src/helpers.js", "export const answer = 42;\nexport const question = 'unknown';\nexport function twice(n) {\n  return n * 2;\n}\n");
  git("add", "src/helpers.js");
  write(dir, "src/staged-new.ts", "export const added = true;\n");
  git("add", "src/staged-new.ts");
  rmSync(join(dir, "src/old.ts"));
  write(dir, "notes.txt", "remember the milk\n");
  return dir;
}

/** A change on disk the hub did not make, for the pull-to-refresh flows. */
export function explorerChange(state, name = "fresh.txt") {
  const dir = join(state.home, "repos", "delta");
  write(dir, name, "arrived after the list was open\n");
}

