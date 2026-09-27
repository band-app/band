/**
 * A TypeScript git repo whose workspace can run a real language server.
 *
 * Band's LSP manager (`src/server/infra/lsp/lsp-manager.ts`) spawns
 * `typescript-language-server` from `<worktree>/node_modules/.bin` (or the
 * shell PATH), and the server loads `typescript` from the project. The repo's
 * `node_modules` links both to the packages this app already installs, so a
 * test gets the real language server with no install step and nothing
 * mocked. `node_modules` is git-ignored so it never shows up as a change.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const APP_NODE_MODULES = join(import.meta.dirname, "..", "..", "node_modules");

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@test.com",
};

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, env: gitEnv });
}

/**
 * Create the repo at `repoPath` on branch `branch`, commit `committed`
 * (workspace-relative path to content), then write `working` over it
 * uncommitted. Returns the commit's SHA.
 */
export function createTsLspRepo(opts: {
  repoPath: string;
  branch: string;
  committed: Record<string, string>;
  working?: Record<string, string>;
}): string {
  const { repoPath } = opts;
  const write = (files: Record<string, string>) => {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(repoPath, path)), { recursive: true });
      writeFileSync(join(repoPath, path), content);
    }
  };

  mkdirSync(repoPath, { recursive: true });
  git(repoPath, ["init", "-b", opts.branch]);
  write({
    ".gitignore": "node_modules\n",
    "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }),
    ...opts.committed,
  });
  git(repoPath, ["add", "."]);
  git(repoPath, ["commit", "-m", "initial"]);
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoPath, env: gitEnv })
    .toString()
    .trim();
  if (opts.working) write(opts.working);

  mkdirSync(join(repoPath, "node_modules/.bin"), { recursive: true });
  symlinkSync(
    realpathSync(join(APP_NODE_MODULES, "typescript")),
    join(repoPath, "node_modules/typescript"),
  );
  symlinkSync(
    join(APP_NODE_MODULES, ".bin/typescript-language-server"),
    join(repoPath, "node_modules/.bin/typescript-language-server"),
  );
  return sha;
}
