// Integration tests for projects (plan step 6.1). A real hub (the production bundle on a random port,
// auth on) with two real git repos. Worktrees are made with the real `git`. Agents reach their project
// context through the context MCP tools, called with the worktree headers an agent carries.

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
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

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv, stdio: "pipe" });
}

interface ProjectView {
  id: string;
  name: string;
  title: string;
  description: string;
  contextName: string;
  coordinatorAgent: string | null;
  coordinatorModel: string;
  labels: string[];
  policy: Record<string, unknown>;
  repos: Array<{ repo: string; role: string | null }>;
  worktrees: Array<{ worktreeId: string; repo: string; name: string }>;
  context: { kind: string } | null;
}

interface ReposList {
  repos: Array<{
    name: string;
    worktrees: Array<{ worktreeId: string; name: string; projectId?: string }>;
  }>;
}

let home: string;
let server: ServerHandle;
const scratch: string[] = [];

const m = async <T>(proc: string, input: unknown) => {
  const res = await trpcMutate(server.url, proc, input, TEST_TOKEN);
  expect(res.status, `${proc}: ${await res.clone().text()}`).toBe(200);
  return trpcData<T>(res);
};
const q = async <T>(proc: string, input?: unknown) => {
  const res = await trpcQuery(server.url, proc, input, TEST_TOKEN);
  expect(res.status, `${proc}: ${await res.clone().text()}`).toBe(200);
  return trpcData<T>(res);
};

/** The error a failing mutation answers with. */
async function mFails(
  proc: string,
  input: unknown,
  token = TEST_TOKEN,
): Promise<{ status: number; message: string }> {
  const res = await trpcMutate(server.url, proc, input, token);
  const body = (await res.json()) as { error?: { message?: string } };
  return { status: res.status, message: body.error?.message ?? "" };
}

const project = async (ref: string) =>
  (await q<{ project: ProjectView }>("projects.get", { project: ref })).project;

const auth = ["-c", `http.extraHeader=Authorization: Bearer ${TEST_TOKEN}`];

/** Commits a file into a context repo through a clone and pushes it. */
function seedContextFile(name: string, path: string, body: string): void {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `band-prj-${name}-`)));
  scratch.push(dir);
  git(dir, ...auth, "clone", "-q", `${server.url}/git/context/${name}.git`, "wc");
  const wc = join(dir, "wc");
  mkdirSync(join(wc, path, ".."), { recursive: true });
  writeFileSync(join(wc, path), body);
  git(wc, "add", "-A");
  git(wc, "commit", "-q", "-m", "seed");
  git(wc, ...auth, "push", "-q", "origin", "HEAD");
}

/** Calls a context tool the way an agent in `worktreeId` does. */
async function contextSearch(worktreeId: string, query: string) {
  const client = new Client({ name: "projects-test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), {
      requestInit: {
        headers: { Authorization: `Bearer ${TEST_TOKEN}`, "x-band-worktree-id": worktreeId },
      },
    }),
  );
  try {
    const res = (await client.callTool({ name: "context_search", arguments: { query } })) as {
      content: Array<{ text: string }>;
    };
    return JSON.parse(res.content.map((c) => c.text).join("")) as {
      results: Array<{ contextName: string; hit: { path: string } }>;
      searched: string[];
    };
  } finally {
    await client.close();
  }
}

beforeAll(async () => {
  home = createTmpHome("band-projects-");
  const repos = ["api", "client", "docs"].map((name) => {
    const path = join(home, "repos", name);
    mkdirSync(path, { recursive: true });
    git(path, "init", "-q", "-b", "main");
    writeFileSync(join(path, "README.md"), `${name}\n`);
    git(path, "add", ".");
    git(path, "commit", "-q", "-m", "init");
    return { name, path, defaultBranch: "main", worktrees: [{ branch: "main", path }] };
  });
  seedState(home, { repos });
  seedSettings(home, { tokenSecret: TEST_TOKEN });
  server = await startServer({
    remoteHost: false,
    tmpHome: home,
    env: { BAND_SERVE_UI: "false" },
  });
}, 120_000);

afterAll(async () => {
  await server?.close();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
  if (home) removeTmpHome(home);
});

describe("a fresh hub", () => {
  it("has no project, and its repos and worktrees belong to none", async () => {
    const { projects } = await q<{ projects: ProjectView[] }>("projects.list");
    expect(projects).toEqual([]);
    const { repos } = await q<ReposList>("repos.list");
    expect(repos.map((r) => r.name).sort()).toEqual(["api", "client", "docs"]);
    for (const repo of repos) {
      for (const wt of repo.worktrees) expect(wt.projectId, wt.worktreeId).toBeUndefined();
    }
    const personal = await trpcQuery(
      server.url,
      "projects.get",
      { project: "personal" },
      TEST_TOKEN,
    );
    expect(personal.status).toBe(404);
  });
});

describe("projects.create", () => {
  it("creates a project with its repos, roles and a scaffolded project context (S1)", async () => {
    const { project: created } = await m<{ project: ProjectView }>("projects.create", {
      name: "shop",
      description: "Checkout revamp",
      repos: [{ repo: "api", role: "api" }, { repo: "client" }],
      labels: ["pool=eu"],
      policy: { maxConcurrent: 3, isolationFloor: "container" },
    });
    expect(created).toMatchObject({
      name: "shop",
      description: "Checkout revamp",
      contextName: "shop",
      labels: ["pool=eu"],
      policy: { maxConcurrent: 3, isolationFloor: "container" },
      repos: [
        { repo: "api", role: "api" },
        { repo: "client", role: null },
      ],
      worktrees: [],
      context: { kind: "project" },
    });
    expect(
      (await q<{ projects: ProjectView[] }>("projects.list")).projects.map((p) => p.name),
    ).toContain("shop");

    const { contexts } = await q<{ contexts: Array<{ name: string; kind: string }> }>(
      "context.list",
    );
    expect(contexts).toContainEqual(expect.objectContaining({ name: "shop", kind: "project" }));
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "band-prj-scaffold-")));
    scratch.push(dir);
    git(dir, ...auth, "clone", "-q", `${server.url}/git/context/shop.git`, "wc");
    for (const file of ["notes.md", "docs/.gitkeep", "inbox/.gitkeep", "handoffs/.gitkeep"]) {
      expect(existsSync(join(dir, "wc", file)), file).toBe(true);
    }
    expect(readFileSync(join(dir, "wc", "notes.md"), "utf8")).toContain("# Notes");
  });

  it("drops the retired retro schedule from a policy and keeps the rest", async () => {
    const { project: created } = await m<{
      project: ProjectView & { effectivePolicy: Record<string, unknown> };
    }>("projects.create", {
      name: "p-retro",
      policy: { maxConcurrent: 2, retro: { enabled: true, cron: "0 9 * * 1" } },
    });
    expect(created.policy).toEqual({ maxConcurrent: 2 });
    expect(created.effectivePolicy).toMatchObject({ maxConcurrent: 2 });
    expect(created.effectivePolicy).not.toHaveProperty("retro");
  });

  it("answers by id or by name, and refuses bad input", async () => {
    const byName = await project("shop");
    expect((await project(byName.id)).name).toBe("shop");

    expect((await mFails("projects.create", { name: "shop" })).status).toBe(409);
    expect(await mFails("projects.create", { name: "Bad Name" })).toMatchObject({ status: 400 });
    const missingRepo = await mFails("projects.create", {
      name: "ghosty",
      repos: [{ repo: "nope" }],
    });
    expect(missingRepo).toMatchObject({
      status: 400,
      message: expect.stringContaining('No repo named "nope"'),
    });
    expect(
      (await mFails("projects.create", { name: "dup", repos: [{ repo: "api" }, { repo: "api" }] }))
        .status,
    ).toBe(400);
    expect((await mFails("projects.create", { name: "p-pol", policy: { bogus: 1 } })).status).toBe(
      400,
    );
    expect((await mFails("projects.get", { project: "missing" })).status).toBeGreaterThanOrEqual(
      400,
    );
    // A refused create leaves no context repo behind.
    const { contexts } = await q<{ contexts: Array<{ name: string }> }>("context.list");
    expect(contexts.map((c) => c.name)).not.toContain("ghosty");
  });

  it("uses an existing project context when one is named, once", async () => {
    await m("context.create", { name: "borko-ctx", kind: "project" });
    const { project: linked } = await m<{ project: ProjectView }>("projects.create", {
      name: "borko",
      contextName: "borko-ctx",
    });
    expect(linked.contextName).toBe("borko-ctx");
    const again = await mFails("projects.create", { name: "borko-two", contextName: "borko-ctx" });
    expect(again).toMatchObject({
      status: 409,
      message: expect.stringContaining('belongs to project "borko"'),
    });
    const user = await mFails("projects.create", { name: "borko-three", contextName: "nope" });
    expect(user.status).toBe(400);
  });

  it("lets any device token read and only an admin change (S1)", async () => {
    const viewer = (await m<{ token: string }>("tokens.createDevice", { label: "viewer" })).token;
    const list = await trpcQuery(server.url, "projects.list", undefined, viewer);
    expect(list.status).toBe(200);
    const denied = await mFails("projects.create", { name: "sneaky" }, viewer);
    expect(denied.status).toBe(403);
    const attach = await trpcMutate(
      server.url,
      "worktrees.create",
      { repo: "any", branch: "x", projectId: "shop" },
      viewer,
    );
    expect(attach.status).toBe(403);
    expect((await trpcQuery(server.url, "projects.list", undefined, "")).status).toBe(401);
    expect((await trpcMutate(server.url, "projects.create", { name: "anon" }, "")).status).toBe(
      401,
    );
  });
});

describe("coordinator model (S5)", () => {
  it("defaults to opus and is editable", async () => {
    const created = await project("shop");
    expect(created.coordinatorModel).toBe("opus");
    expect(created.coordinatorAgent).toBeNull();

    const { project: updated } = await m<{ project: ProjectView }>("projects.update", {
      project: "shop",
      coordinatorModel: "sonnet",
      coordinatorAgent: "claude-code",
      description: "Checkout revamp, phase 2",
    });
    expect(updated).toMatchObject({
      coordinatorModel: "sonnet",
      coordinatorAgent: "claude-code",
      description: "Checkout revamp, phase 2",
    });
    expect((await project("shop")).coordinatorModel).toBe("sonnet");

    const { project: other } = await m<{ project: ProjectView }>("projects.create", {
      name: "picky",
      coordinatorModel: "haiku",
    });
    expect(other.coordinatorModel).toBe("haiku");
    expect(
      (await mFails("projects.update", { project: "shop", coordinatorModel: "" })).status,
    ).toBe(400);
  });
});

describe("projects.charter", () => {
  it("returns the coordinator's charter, and 404 for an unknown project", async () => {
    const { charter } = await q<{ charter: string | null }>("projects.charter", {
      project: "shop",
    });
    expect(charter).toContain('coordinator of the Band project "shop"');
    expect(charter).toContain("- api (role: api)");
    const missing = await trpcQuery(
      server.url,
      "projects.charter",
      { project: "ghost" },
      TEST_TOKEN,
    );
    expect(missing.status).toBe(404);
  });
});

describe("renaming a project", () => {
  it("changes the title and keeps the name its folders and context use", async () => {
    const { project: renamed } = await m<{ project: ProjectView }>("projects.update", {
      project: "picky",
      title: "Picky eater",
    });
    expect(renamed).toMatchObject({ name: "picky", title: "Picky eater", contextName: "picky" });
    expect((await project("picky")).title).toBe("Picky eater");
    // Naming it back to its name clears the title.
    const { project: back } = await m<{ project: ProjectView }>("projects.update", {
      project: "picky",
      title: "picky",
    });
    expect(back.title).toBe("");
  });

  it("refuses a title over 100 characters and a non-admin token, and keeps the title", async () => {
    await m("projects.update", { project: "picky", title: "Picky eater" });
    const long = await mFails("projects.update", { project: "picky", title: "x".repeat(101) });
    expect(long.status).toBe(400);
    const viewer = (await m<{ token: string }>("tokens.createDevice", { label: "renamer" })).token;
    const denied = await mFails("projects.update", { project: "picky", title: "Sneaky" }, viewer);
    expect(denied.status).toBe(403);
    expect((await project("picky")).title).toBe("Picky eater");
  });
});

describe("worktrees in a project", () => {
  it("appears under the project and gives its agent the project context (S2)", async () => {
    seedContextFile("shop", "docs/checkout.md", "The zebra protocol governs checkout retries.\n");
    const { project: shop } = await m<{ project: ProjectView }>("projects.update", {
      project: "shop",
    });

    const created = await m<{ ok: boolean; path: string }>("worktrees.create", {
      repo: "api",
      branch: "feat-checkout",
      projectId: shop.id,
    });
    expect(created.path).toContain("feat-checkout");

    const listed = (await q<ReposList>("repos.list")).repos.find((r) => r.name === "api");
    expect(listed?.worktrees.find((w) => w.name === "feat-checkout")?.projectId).toBe(shop.id);
    // A worktree that no project claims belongs to no project.
    expect(listed?.worktrees.find((w) => w.name === "main")?.projectId).toBeUndefined();

    const detail = await project("shop");
    expect(detail.worktrees).toEqual([
      expect.objectContaining({
        worktreeId: "api-feat-checkout",
        repo: "api",
        name: "feat-checkout",
      }),
    ]);

    const inProject = await contextSearch("api-feat-checkout", "zebra protocol");
    expect(inProject.searched).toContain("shop");
    expect(inProject.results.map((r) => r.hit.path)).toContain("docs/checkout.md");
    const outside = await contextSearch("api-main", "zebra protocol");
    expect(outside.searched).not.toContain("shop");
    expect(outside.results).toEqual([]);
  });

  it("refuses a worktree whose repo is not in the project, before creating anything", async () => {
    const res = await mFails("worktrees.create", {
      repo: "docs",
      branch: "feat-x",
      projectId: "shop",
    });
    expect(res).toMatchObject({
      status: 400,
      message: expect.stringContaining('Repo "docs" is not in project "shop"'),
    });
    expect(existsSync(join(home, ".band", "worktrees", "docs", "feat-x"))).toBe(false);
    const listed = (await q<ReposList>("repos.list")).repos.find((r) => r.name === "docs");
    expect(listed?.worktrees.map((w) => w.name)).toEqual(["main"]);
    expect(
      (await mFails("worktrees.create", { repo: "api", branch: "feat-y", projectId: "missing" }))
        .status,
    ).toBe(404);
  });

  it("attaches and detaches an existing worktree", async () => {
    const attach = await m<{ project: ProjectView }>("projects.attachWorktree", {
      project: "shop",
      worktreeId: "client-main",
    });
    expect(attach.project.worktrees.map((w) => w.worktreeId)).toEqual([
      "api-feat-checkout",
      "client-main",
    ]);
    expect(
      (await mFails("projects.attachWorktree", { project: "shop", worktreeId: "docs-main" }))
        .status,
    ).toBe(400);
    expect(
      (await mFails("projects.attachWorktree", { project: "shop", worktreeId: "client-nope" }))
        .status,
    ).toBe(400);
    await m("projects.detachWorktree", { worktreeId: "client-main" });
    expect((await project("shop")).worktrees.map((w) => w.worktreeId)).toEqual([
      "api-feat-checkout",
    ]);
  });

  it("keeps the project after a repo sync rewrites the worktree rows", async () => {
    await q<ReposList>("repos.list");
    await m("repos.reorder", { names: ["client", "api", "docs"] });
    expect((await project("shop")).worktrees.map((w) => w.worktreeId)).toEqual([
      "api-feat-checkout",
    ]);
  });
});

describe("removing repos and projects (S4)", () => {
  it("refuses to remove a repo that has active worktrees, and says which", async () => {
    const refused = await mFails("projects.removeRepo", { project: "shop", repo: "api" });
    expect(refused.status).toBe(409);
    expect(refused.message).toContain('Cannot remove repo "api" from project "shop"');
    expect(refused.message).toContain("api/feat-checkout");
    expect((await project("shop")).repos.map((r) => r.repo)).toContain("api");
  });

  it("refuses to remove a project that still has worktrees", async () => {
    const refused = await mFails("projects.remove", { project: "shop" });
    expect(refused.status).toBe(409);
    expect(refused.message).toContain("still has 1 worktree");
  });

  it("allows both once the worktree is detached, and keeps the context repo", async () => {
    await m("projects.detachWorktree", { worktreeId: "api-feat-checkout" });
    const { project: after } = await m<{ project: ProjectView }>("projects.removeRepo", {
      project: "shop",
      repo: "api",
    });
    expect(after.repos.map((r) => r.repo)).toEqual(["client"]);
    expect((await mFails("projects.removeRepo", { project: "shop", repo: "api" })).status).toBe(
      400,
    );

    const added = await m<{ project: ProjectView }>("projects.addRepo", {
      project: "shop",
      repo: "docs",
      role: "docs",
    });
    expect(added.project.repos).toEqual([
      { repo: "client", role: null },
      { repo: "docs", role: "docs" },
    ]);
    const relabeled = await m<{ project: ProjectView }>("projects.addRepo", {
      project: "shop",
      repo: "docs",
      role: "handbook",
    });
    expect(relabeled.project.repos.find((r) => r.repo === "docs")?.role).toBe("handbook");

    await m("projects.remove", { project: "shop" });
    expect(
      (await q<{ projects: ProjectView[] }>("projects.list")).projects.map((p) => p.name),
    ).not.toContain("shop");
    const { contexts } = await q<{ contexts: Array<{ name: string }> }>("context.list");
    expect(contexts.map((c) => c.name)).toContain("shop");
  });

  it("drops a removed repo from its projects and deletes the context on request", async () => {
    await m("projects.create", { name: "tail", repos: [{ repo: "docs" }] });
    await m("repos.remove", { name: "docs" });
    expect((await project("tail")).repos).toEqual([]);
    await m("projects.remove", { project: "tail", removeContext: true });
    const { contexts } = await q<{ contexts: Array<{ name: string }> }>("context.list");
    expect(contexts.map((c) => c.name)).not.toContain("tail");
  });
});

describe("removing any project", () => {
  it("removes every project that has no worktrees, leaving none", async () => {
    const before = (await q<{ projects: ProjectView[] }>("projects.list")).projects;
    expect(before.length).toBeGreaterThan(0);
    for (const p of before) await m("projects.remove", { project: p.id });
    expect((await q<{ projects: ProjectView[] }>("projects.list")).projects).toEqual([]);
    // The repos stay, in no project.
    const { repos } = await q<ReposList>("repos.list");
    expect(repos.map((r) => r.name).sort()).toEqual(["api", "client"]);
  });
});
