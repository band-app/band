// Integration tests for the coordinator code browser (plan step T.1b). A real hub (the production bundle on a random
// port, auth on), real git repos with bare remotes. The browser's calls (`projects.code*`) read and change the
// default-branch checkout under `<BAND_HOME>/projects/<project>/repos/<repo>`.

import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_TOKEN } from "./helpers/acp-chat";
import { seedSettings, seedState } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  startServer,
  trpcData,
  trpcMutate,
  trpcQuery,
} from "./helpers/server";
import { removeTmpHome } from "./helpers/tmp-home";

const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv, stdio: "pipe" }).trim();

interface Status {
  branch: string;
  upstream: string;
  ahead: number;
  behind: number;
  dirty: boolean;
  diverged: boolean;
  files: Array<{ path: string; status: string }>;
  unpushed: Array<{ sha: string; subject: string }>;
  incoming: Array<{ sha: string; subject: string }>;
}

let home: string;
let server: ServerHandle;

const remoteOf = (name: string) => join(home, "remotes", `${name}.git`);
const cloneOf = (name: string) => join(home, "repos", name);
const checkoutOf = (name: string) => join(realpathSync(home), ".band", "projects", "shop", "repos", name);

const call = (kind: "query" | "mutate", proc: string, input: unknown) =>
  kind === "query"
    ? trpcQuery(server.url, proc, input, TEST_TOKEN)
    : trpcMutate(server.url, proc, input, TEST_TOKEN);
async function ok<T>(kind: "query" | "mutate", proc: string, input: unknown): Promise<T> {
  const res = await call(kind, proc, input);
  expect(res.status, `${proc}: ${await res.clone().text()}`).toBe(200);
  return trpcData<T>(res);
}
async function refused(kind: "query" | "mutate", proc: string, input: unknown): Promise<string> {
  const res = await call(kind, proc, input);
  expect(res.status, `${proc} should be refused`).toBe(400);
  return await res.text();
}
const status = (repo: string) =>
  ok<Status>("query", "projects.codeStatus", { project: "shop", repo });

function pushFromElsewhere(name: string, file: string, message: string): void {
  const other = join(home, "teammates", name);
  try {
    git(other, "pull", "-q", "--ff-only");
  } catch {
    mkdirSync(join(home, "teammates"), { recursive: true });
    git(home, "clone", "-q", remoteOf(name), other);
  }
  writeFileSync(join(other, file), `${message}\n`);
  git(other, "add", ".");
  git(other, "commit", "-q", "-m", message);
  git(other, "push", "-q", "origin", "main");
}

beforeAll(async () => {
  home = createTmpHome("band-code-browser-");
  const names = ["api", "client"];
  const repos = names.map((name) => {
    git(home, "init", "-q", "--bare", "-b", "main", remoteOf(name));
    mkdirSync(join(home, "repos"), { recursive: true });
    git(home, "clone", "-q", remoteOf(name), cloneOf(name));
    git(cloneOf(name), "checkout", "-q", "-B", "main");
    writeFileSync(join(cloneOf(name), "README.md"), `${name} readme\n`);
    mkdirSync(join(cloneOf(name), "src"), { recursive: true });
    writeFileSync(
      join(cloneOf(name), "src", "main.ts"),
      `export const name = "${name}";\n// needle-${name}\n`,
    );
    git(cloneOf(name), "add", ".");
    git(cloneOf(name), "commit", "-q", "-m", "init");
    git(cloneOf(name), "push", "-q", "-u", "origin", "main");
    return {
      name,
      path: cloneOf(name),
      defaultBranch: "main",
      worktrees: [{ branch: "main", path: cloneOf(name) }],
    };
  });
  seedState(home, { repos });
  seedSettings(home, {
    tokenSecret: TEST_TOKEN,
    codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
    defaultCodingAgent: "claude-code",
  });
  server = await startServer({
    remoteHost: false,
    tmpHome: home,
    env: {
      BAND_SERVE_UI: "false",
      BAND_TEST_ACP_STATE: join(home, "acp-stub-state"),
      BAND_TEST_ACP_LOG: join(home, "acp-stub-log.jsonl"),
      BAND_PROJECT_FETCH_THROTTLE_MS: "0",
    },
  });
  await ok("mutate", "projects.create", {
    name: "shop",
    repos: [{ repo: "api" }, { repo: "client" }],
  });
  await ok("mutate", "projects.syncFolder", { project: "shop" });
}, 180_000);

afterAll(async () => {
  await server?.close();
  if (home) removeTmpHome(home);
});

describe("browsing the checkout (S1)", () => {
  it("lists the tree and reads a file of each repo", async () => {
    for (const repo of ["api", "client"]) {
      const dir = await ok<{ kind: string; entries: Array<{ name: string }> }>(
        "query",
        "projects.codeRead",
        { project: "shop", repo, path: "" },
      );
      expect(dir.entries.map((e) => e.name)).toEqual(["src", "README.md"]);
      const file = await ok<{ kind: string; content: string }>("query", "projects.codeRead", {
        project: "shop",
        repo,
        path: "src/main.ts",
      });
      expect(file.content).toContain(`name = "${repo}"`);
    }
  });

  it("refuses a repo that is not in the project", async () => {
    expect(
      await refused("query", "projects.codeRead", { project: "shop", repo: "nope", path: "" }),
    ).toContain("not in project");
  });
});

describe("search stays in the checkout (S3)", () => {
  it("finds a match only in the searched repo", async () => {
    const api = await ok<Array<{ path: string; text: string }>>("query", "projects.codeSearch", {
      project: "shop",
      repo: "api",
      query: "needle-",
    });
    expect(api.map((m) => m.text.trim())).toEqual(["// needle-api"]);
    const client = await ok<Array<{ path: string; text: string }>>("query", "projects.codeSearch", {
      project: "shop",
      repo: "client",
      query: "needle-api",
    });
    expect(client).toEqual([]);
  });
});

describe("paths stay inside the checkout (S4)", () => {
  it("refuses ../, absolute paths, .git and a symlink that leaves the checkout", async () => {
    const outside = join(home, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "secret.txt"), "secret\n");
    symlinkSync(outside, join(checkoutOf("api"), "escape"));
    symlinkSync(join(outside, "secret.txt"), join(checkoutOf("api"), "escape.txt"));
    for (const path of [
      "../client/README.md",
      "../../../../etc/passwd",
      "/etc/passwd",
      ".git/config",
      "escape",
      "escape/secret.txt",
      "escape.txt",
    ]) {
      await refused("query", "projects.codeRead", { project: "shop", repo: "api", path });
    }
    for (const path of ["../client/README.md", "/etc/passwd", ".git/config"]) {
      await refused("query", "projects.codeDiff", {
        project: "shop",
        repo: "api",
        target: { kind: "working" },
        path,
      });
      await refused("mutate", "projects.codeCommit", {
        project: "shop",
        repo: "api",
        message: "x",
        paths: [path],
      });
    }
    // The symlinks sit in the checkout as untracked files, so clear them for the next tests.
    execFileSync("rm", [join(checkoutOf("api"), "escape"), join(checkoutOf("api"), "escape.txt")]);
  });

  it("refuses a commit sha that is not a sha", async () => {
    await refused("query", "projects.codeDiff", {
      project: "shop",
      repo: "api",
      target: { kind: "commit", sha: "--output=/tmp/x" },
    });
  });
});

describe("uncommitted work, commit and push (S2)", () => {
  it("shows the diff, commits chosen paths and pushes to origin/main", async () => {
    writeFileSync(join(checkoutOf("api"), "src", "main.ts"), 'export const name = "edited";\n');
    writeFileSync(join(checkoutOf("api"), "new.txt"), "brand new\n");
    writeFileSync(join(checkoutOf("api"), "left-out.txt"), "stays\n");
    let s = await status("api");
    expect(s.dirty).toBe(true);
    expect(s.files.map((f) => `${f.status}:${f.path}`).sort()).toEqual([
      "modified:src/main.ts",
      "untracked:left-out.txt",
      "untracked:new.txt",
    ]);
    const diff = await ok<{ diff: string }>("query", "projects.codeDiff", {
      project: "shop",
      repo: "api",
      target: { kind: "working" },
    });
    expect(diff.diff).toContain('+export const name = "edited";');
    expect(diff.diff).toContain("+brand new");

    await refused("mutate", "projects.codeCommit", {
      project: "shop",
      repo: "api",
      message: "   ",
      paths: ["new.txt"],
    });
    await ok("mutate", "projects.codeCommit", {
      project: "shop",
      repo: "api",
      message: "edit main and add new",
      paths: ["src/main.ts", "new.txt"],
    });
    s = await status("api");
    expect(s.ahead).toBe(1);
    expect(s.files.map((f) => f.path)).toEqual(["left-out.txt"]);
    expect(s.unpushed.map((c) => c.subject)).toEqual(["edit main and add new"]);

    await ok("mutate", "projects.codePush", { project: "shop", repo: "api" });
    expect(git(remoteOf("api"), "log", "-1", "--format=%s", "main")).toBe("edit main and add new");
    s = await status("api");
    expect(s.ahead).toBe(0);
    await refused("mutate", "projects.codePush", { project: "shop", repo: "api" });
  });
});

describe("pull is fast-forward only (S5)", () => {
  it("fast-forwards a behind checkout", async () => {
    pushFromElsewhere("client", "teammate.txt", "teammate change");
    // The status does not fetch, so it learns of the commit when the checkout is pulled.
    await ok("mutate", "projects.codePull", { project: "shop", repo: "client" });
    const s = await status("client");
    expect(s.behind).toBe(0);
    expect(git(checkoutOf("client"), "log", "-1", "--format=%s")).toBe("teammate change");
  });

  it("refuses to pull or push a diverged checkout and leaves it alone", async () => {
    writeFileSync(join(checkoutOf("client"), "mine.txt"), "mine\n");
    await ok("mutate", "projects.codeCommit", {
      project: "shop",
      repo: "client",
      message: "my commit",
    });
    pushFromElsewhere("client", "theirs.txt", "their commit");
    const head = git(checkoutOf("client"), "rev-parse", "HEAD");
    expect(
      await refused("mutate", "projects.codePull", { project: "shop", repo: "client" }),
    ).toContain("divergence");
    // The failed pull fetched, so the checkout now reports both sides.
    const s = await status("client");
    expect(s.diverged).toBe(true);
    expect(s.ahead).toBe(1);
    expect(s.behind).toBe(1);
    expect(s.incoming.map((c) => c.subject)).toEqual(["their commit"]);
    expect(
      await refused("mutate", "projects.codePush", { project: "shop", repo: "client" }),
    ).toContain("behind");
    expect(git(checkoutOf("client"), "rev-parse", "HEAD")).toBe(head);
    expect(git(remoteOf("client"), "log", "-1", "--format=%s", "main")).toBe("their commit");
  });
});
