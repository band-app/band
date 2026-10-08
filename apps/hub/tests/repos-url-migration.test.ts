// S4: an install from before repos were identified by remote URL. The DB is migrated up to the
// step before `repo_remote_url`, seeded with path-based repos, then migrated forward and booted
// by a real hub. Everything lives in temp dirs, never in ~/.band.

import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/node-sqlite";
import { migrate } from "drizzle-orm/node-sqlite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedSettings } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  startServer,
  trpcData,
  trpcMutate,
  trpcQuery,
} from "./helpers/server";
import { waitFor } from "./helpers/wait-for";

const TOKEN = "repos-url-migration-secret";
const migrationsDir = join(import.meta.dirname, "../src/server/infra/db/migrations");
const NEW_MIGRATION = readdirSync(migrationsDir).find((n) => n.endsWith("_repo_remote_url")) ?? "";

interface RepoView {
  name: string;
  path: string;
  remoteUrl?: string;
  worktrees: Array<{ name: string; path: string; projectId?: string }>;
}

const scratch: string[] = [];
const tmp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
};
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });

function makeRepo(dir: string, origin?: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "a\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  if (origin) git(dir, "remote", "add", "origin", origin);
}

let server: ServerHandle;
let withOrigin: string;
let withoutOrigin: string;
let worktreePath: string;

const q = <T>(procedure: string, input?: unknown) =>
  trpcQuery(server.url, procedure, input, TOKEN).then(async (res) => {
    if (res.status !== 200) throw new Error(`${procedure}: HTTP ${res.status} ${await res.text()}`);
    return trpcData<T>(res);
  });

beforeAll(async () => {
  expect(NEW_MIGRATION).not.toBe("");
  const hubHome = createTmpHome("band-repos-url-migration-");
  scratch.push(hubHome);
  const checkouts = tmp("band-repos-url-migration-repos-");
  withOrigin = join(checkouts, "app");
  withoutOrigin = join(checkouts, "scratch");
  makeRepo(withOrigin, "https://user:tok3n@github.com/acme/app.git");
  makeRepo(withoutOrigin);
  worktreePath = join(checkouts, "app-feat");
  git(withOrigin, "worktree", "add", "-q", "-b", "feat", worktreePath);

  const bandDir = join(hubHome, ".band");
  mkdirSync(bandDir, { recursive: true });
  const sqlite = new DatabaseSync(join(bandDir, "band.db"));
  sqlite.exec("PRAGMA foreign_keys = ON");
  const before = join(hubHome, "migrations-before");
  cpSync(migrationsDir, before, { recursive: true });
  for (const name of readdirSync(before).filter((n) => /^\d/.test(n) && n >= NEW_MIGRATION)) {
    rmSync(join(before, name), { recursive: true });
  }
  const db = drizzle({ client: sqlite });
  migrate(db, { migrationsFolder: before });
  const insertRepo = sqlite.prepare(
    "INSERT INTO repos (name, path, default_branch, sort_order) VALUES (?, ?, 'main', ?)",
  );
  insertRepo.run("app", withOrigin, 0);
  insertRepo.run("scratch", withoutOrigin, 1);
  const insertWt = sqlite.prepare(
    "INSERT INTO worktrees (repo_name, name, branch, path) VALUES (?, ?, ?, ?)",
  );
  insertWt.run("app", "main", "main", withOrigin);
  insertWt.run("app", "feat", "feat", worktreePath);
  insertWt.run("scratch", "main", "main", withoutOrigin);
  // The migration under test, then the DB is a pre-change one that only gained the columns.
  migrate(db, { migrationsFolder: migrationsDir });
  expect(sqlite.prepare("SELECT remote_url FROM repos WHERE name = 'app'").get()).toEqual({
    remote_url: null,
  });
  sqlite.close();

  seedSettings(hubHome, { tokenSecret: TOKEN });
  server = await startServer({
    tmpHome: hubHome,
    remoteHost: false,
    env: { BAND_SERVE_UI: "false" },
  });
}, 120_000);

afterAll(async () => {
  await server?.close();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
});

describe("upgrading a path-based install", () => {
  it("fills remote_url from origin without credentials, and leaves a repo with no origin alone", async () => {
    const repos = await waitFor(
      async () => {
        const { repos } = await q<{ repos: RepoView[] }>("repos.list");
        return repos.find((r) => r.name === "app")?.remoteUrl ? repos : undefined;
      },
      { label: "remote_url backfilled", timeoutMs: 20_000 },
    );
    const app = repos.find((r) => r.name === "app");
    expect(app?.remoteUrl).toBe("https://github.com/acme/app.git");
    expect(JSON.stringify(repos)).not.toContain("tok3n");
    expect(repos.find((r) => r.name === "scratch")?.remoteUrl).toBeUndefined();
  });

  it("keeps every repo and worktree where it was", async () => {
    const { repos } = await q<{ repos: RepoView[] }>("repos.list");
    const app = repos.find((r) => r.name === "app");
    expect(app?.path).toBe(withOrigin);
    expect(app?.worktrees.map((w) => w.path).sort()).toEqual([withOrigin, worktreePath].sort());
    expect(repos.find((r) => r.name === "scratch")?.path).toBe(withoutOrigin);
  });

  it("makes no default project and leaves the repos and their worktrees in none", async () => {
    const { projects } = await q<{ projects: Array<{ name: string }> }>("projects.list");
    expect(projects).toEqual([]);
    const { repos } = await q<{ repos: RepoView[] }>("repos.list");
    expect(repos.map((r) => r.name).sort()).toEqual(["app", "scratch"]);
    for (const repo of repos) {
      for (const wt of repo.worktrees)
        expect(wt.projectId, `${repo.name}/${wt.name}`).toBeUndefined();
    }
  });

  it("still creates a worktree on the hub's own checkout", async () => {
    const res = await trpcMutate(
      server.url,
      "worktrees.create",
      { repo: "app", branch: "after-upgrade" },
      TOKEN,
    );
    expect(res.status).toBe(200);
    const { path } = await trpcData<{ path: string }>(res);
    expect(existsSync(join(path, "a.txt"))).toBe(true);
    expect(git(path, "branch", "--show-current").trim()).toBe("after-upgrade");
  });
});
