// Integration tests for the project folder and the project-level coordinator chat (plan step T.1). A real hub (the
// production bundle on a random port, auth on), real git repos with bare remotes, and the scripted ACP stub as the
// coding agent. The folder is what the host builds under `<BAND_HOME>/projects/<project>`: the context working copy
// with a checkout of each repo's default branch in `repos/<repo>`.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type StubRequest, stubRequests, TEST_TOKEN } from "./helpers/acp-chat";
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
import { waitFor } from "./helpers/wait-for";

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

interface Checkout {
  repo: string;
  path: string;
  branch: string;
  upstream: string;
  status: string;
  ahead: number;
  behind: number;
  dirty: boolean;
  error?: string;
}

interface FolderState {
  hostId: string;
  folder: string;
  checkouts: Checkout[];
}

interface ProjectView {
  id: string;
  name: string;
  coordinator: { chatId: string } | null;
}

let home: string;
let server: ServerHandle;
let shop: ProjectView;

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

const remoteOf = (name: string) => join(home, "remotes", `${name}.git`);
const cloneOf = (name: string) => join(home, "repos", name);
const folderState = async () =>
  (await q<{ folder: FolderState }>("projects.folder", { project: "shop" })).folder;
const checkoutOf = async (repo: string) =>
  (await folderState()).checkouts.find((c) => c.repo === repo);

/** A commit pushed to a repo's remote from a separate clone, as a teammate would. */
function pushFromElsewhere(name: string, file: string, message: string): void {
  const other = join(home, "teammates", name);
  if (!existsSync(other)) {
    mkdirSync(join(home, "teammates"), { recursive: true });
    git(home, "clone", "-q", remoteOf(name), other);
  }
  git(other, "pull", "-q", "--ff-only");
  writeFileSync(join(other, file), `${message}\n`);
  git(other, "add", ".");
  git(other, "commit", "-q", "-m", message);
  git(other, "push", "-q", "origin", "main");
}

/** Sends a prompt to the coordinator and waits for the stub agent to answer it. */
async function coordinatorTurn(text: string): Promise<void> {
  const before = stubRequests(home, "session/prompt").length;
  await m("chats.send", {
    worktreeId: `project:${shop.id}`,
    chatId: shop.coordinator?.chatId,
    message: text,
  });
  await waitFor(() => stubRequests(home, "session/prompt").length > before || undefined, {
    label: `prompt "${text}"`,
    timeoutMs: 30_000,
  });
}

async function listTools(bearer: string): Promise<string[]> {
  const client = new Client({ name: "folder-test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${server.url}/mcp-proxy/band-coordinator`), {
      requestInit: { headers: { Authorization: bearer } },
    }),
  );
  try {
    return (await client.listTools()).tools.map((t) => t.name).sort();
  } finally {
    await client.close();
  }
}

async function callTool(bearer: string, name: string, args: Record<string, unknown>) {
  const client = new Client({ name: "folder-test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${server.url}/mcp-proxy/band-coordinator`), {
      requestInit: { headers: { Authorization: bearer } },
    }),
  );
  try {
    const res = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    const text = res.content.map((c) => c.text).join("");
    return { isError: res.isError === true, text };
  } finally {
    await client.close();
  }
}

const bootServer = () =>
  startServer({
    remoteHost: false,
    tmpHome: home,
    env: {
      BAND_SERVE_UI: "false",
      BAND_TEST_ACP_STATE: join(home, "acp-stub-state"),
      BAND_TEST_ACP_LOG: join(home, "acp-stub-log.jsonl"),
      // Every coordinator turn fetches, so a test sees a commit that lands between two turns.
      BAND_PROJECT_FETCH_THROTTLE_MS: "0",
    },
  });

beforeAll(async () => {
  home = createTmpHome("band-project-folder-");
  const names = ["api", "client", "docs"];
  const repos = names.map((name) => {
    git(home, "init", "-q", "--bare", "-b", "main", remoteOf(name));
    mkdirSync(join(home, "repos"), { recursive: true });
    git(home, "clone", "-q", remoteOf(name), cloneOf(name));
    git(cloneOf(name), "checkout", "-q", "-B", "main");
    writeFileSync(join(cloneOf(name), "README.md"), `${name} readme\n`);
    mkdirSync(join(cloneOf(name), "src"), { recursive: true });
    writeFileSync(join(cloneOf(name), "src", "main.ts"), `export const name = "${name}";\n`);
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
  server = await bootServer();
  shop = (
    await m<{ project: ProjectView }>("projects.create", {
      name: "shop",
      repos: [{ repo: "api" }, { repo: "client" }],
    })
  ).project;
}, 180_000);

afterAll(async () => {
  await server?.close();
  if (home) removeTmpHome(home);
});

describe("the coordinator runs in the project folder (S1)", () => {
  let session: StubRequest;
  let folder: string;

  it("starts a coordinator chat with no worktree whose session cwd is the project folder", async () => {
    folder = join(realpathSync(home), ".band", "projects", "shop");
    session = await waitFor(() => stubRequests(home, "session/new").find((r) => r.cwd === folder), {
      label: "session/new in the project folder",
      timeoutMs: 60_000,
    });
    expect(shop.coordinator?.chatId).toBeTruthy();
    const dashboard = await q<{
      agents: Array<{
        chatId: string;
        role: string;
        worktreeId: string | null;
        repo: string | null;
      }>;
    }>("projects.dashboard", { project: "shop" });
    const coordinator = dashboard.agents.find((a) => a.role === "coordinator");
    expect(coordinator).toMatchObject({
      chatId: shop.coordinator?.chatId,
      worktreeId: null,
      repo: null,
    });
    // No `coordinator-<project>` worktree exists in any repo.
    const { repos } = await q<{ repos: Array<{ worktrees: Array<{ name: string }> }> }>(
      "repos.list",
    );
    expect(repos.flatMap((r) => r.worktrees.map((w) => w.name))).not.toContain("coordinator-shop");
  });

  it("holds the context files and a checkout of each repo on band/<project>/<default> tracking origin", async () => {
    const state = await waitFor(
      async () => {
        const f = await folderState();
        return f?.checkouts.length === 2 ? f : undefined;
      },
      { label: "folder state", timeoutMs: 30_000 },
    );
    expect(state.folder).toBe(folder);
    expect(existsSync(join(folder, "notes.md"))).toBe(true);
    for (const repo of ["api", "client"]) {
      const dir = join(folder, "repos", repo);
      expect(readFileSync(join(dir, "README.md"), "utf8")).toBe(`${repo} readme\n`);
      expect(git(dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("band/shop/main");
      expect(git(dir, "rev-parse", "--abbrev-ref", "@{u}")).toBe("origin/main");
      expect(git(dir, "config", "--worktree", "push.default")).toBe("upstream");
    }
    expect(state.checkouts.map((c) => c.status)).toEqual(["current", "current"]);
  });

  it("keeps repos/ out of the context repo, so a turn never commits the code", async () => {
    await coordinatorTurn("hello");
    await waitFor(
      () => (git(folder, "status", "--porcelain").includes("repos") ? undefined : true),
      {
        label: "repos/ ignored",
      },
    );
    expect(git(folder, "status", "--porcelain")).not.toContain("repos/");
    expect(session.params.mcpServers).toBeTruthy();
  });

  it("names the project folder and the repo tools in the charter, in AGENTS.md, which never syncs", async () => {
    const folder = join(realpathSync(home), ".band", "projects", "shop");
    const charter = readFileSync(join(folder, "AGENTS.md"), "utf8");
    expect(charter).toContain("repos/<repo>/");
    expect(charter).toContain("repo_read");
    expect(charter).toContain("Code changes go through worker agents (worktree_create)");
    // Each host writes its own copy from the project's settings, so git leaves both files out.
    const status = git(folder, "status", "--porcelain", "--ignored");
    expect(status).not.toMatch(/^\?\? (AGENTS|CLAUDE)\.md/m);
    expect(git(folder, "ls-files", "AGENTS.md", "CLAUDE.md")).toBe("");

    // A policy change rewrites it.
    await m("projects.update", { project: "shop", policy: { maxConcurrent: 7 } });
    await waitFor(
      () =>
        readFileSync(join(folder, "AGENTS.md"), "utf8").includes("at most 7 worker agents")
          ? true
          : undefined,
      { label: "AGENTS.md after a policy change" },
    );
  });
});

describe("a hand-made commit pushes with plain git push (S2)", () => {
  it("lands on the default branch of the remote", async () => {
    const dir = join(realpathSync(home), ".band", "projects", "shop", "repos", "api");
    writeFileSync(join(dir, "by-hand.md"), "made in the project folder\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "by hand in the project folder");
    git(dir, "push", "-q");
    expect(git(remoteOf("api"), "log", "main", "-1", "--format=%s")).toBe(
      "by hand in the project folder",
    );
    await waitFor(
      async () => ((await checkoutOf("api"))?.status === "current" ? true : undefined),
      {
        label: "api checkout current after the push",
        timeoutMs: 30_000,
      },
    );
  });
});

describe("the next coordinator turn brings checkouts up to date (S3)", () => {
  it("fast-forwards a clean checkout and leaves a dirty one alone, reporting behind and dirty", async () => {
    const folder = join(realpathSync(home), ".band", "projects", "shop");
    const clientReadme = join(folder, "repos", "client", "README.md");
    writeFileSync(clientReadme, "my unsaved edit\n");
    pushFromElsewhere("api", "api-news.md", "news for api");
    pushFromElsewhere("client", "client-news.md", "news for client");

    await coordinatorTurn("what is new?");

    await waitFor(
      async () => ((await checkoutOf("api"))?.status === "updated" ? true : undefined),
      {
        label: "api fast-forwarded",
        timeoutMs: 30_000,
      },
    );
    expect(readFileSync(join(folder, "repos", "api", "api-news.md"), "utf8")).toBe(
      "news for api\n",
    );

    const client = await checkoutOf("client");
    expect(client).toMatchObject({ status: "behind", behind: 1, ahead: 0, dirty: true });
    expect(existsSync(join(folder, "repos", "client", "client-news.md"))).toBe(false);
    expect(readFileSync(clientReadme, "utf8")).toBe("my unsaved edit\n");
  });

  it("does not fast-forward a checkout that has a commit of its own", async () => {
    const folder = join(realpathSync(home), ".band", "projects", "shop");
    const dir = join(folder, "repos", "api");
    writeFileSync(join(dir, "mine.md"), "local only\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "local only");
    pushFromElsewhere("api", "api-news-2.md", "more news for api");

    await coordinatorTurn("again");

    await waitFor(async () => ((await checkoutOf("api"))?.status === "behind" ? true : undefined), {
      label: "api behind with a local commit",
      timeoutMs: 30_000,
    });
    expect(await checkoutOf("api")).toMatchObject({ ahead: 1, behind: 1, dirty: false });
    expect(existsSync(join(dir, "api-news-2.md"))).toBe(false);
    expect(git(dir, "log", "-1", "--format=%s")).toBe("local only");
  });
});

describe("repo tools read only the project's repos (S4)", () => {
  let bearer: string;

  beforeAll(async () => {
    const session = await waitFor(
      () => stubRequests(home, "session/new").find((r) => r.cwd.endsWith("/projects/shop")),
      { label: "coordinator session" },
    );
    const entries = session.params.mcpServers as Array<{
      headers: Array<{ name: string; value: string }>;
    }>;
    bearer = entries[0].headers.find((h) => h.name === "Authorization")?.value ?? "";
  });

  it("lists the repo tools next to the dispatch tools", async () => {
    expect(await listTools(bearer)).toEqual([
      "chats_read",
      "chats_send",
      "project_status",
      "repo_log",
      "repo_read",
      "repo_search",
      "worktree_create",
      "worktree_stop",
      "worktrees_list",
    ]);
  });

  it("reads a file, a directory, searches and shows the log of a project repo", async () => {
    const file = await callTool(bearer, "repo_read", { repo: "client", path: "src/main.ts" });
    expect(file.isError).toBe(false);
    expect(file.text).toContain('export const name = \\"client\\"');

    const dir = await callTool(bearer, "repo_read", { repo: "client", path: "" });
    expect(dir.text).toContain("README.md");
    expect(dir.text).toContain("src");
    expect(dir.text).not.toContain('.git"');

    const found = await callTool(bearer, "repo_search", { repo: "api", query: "api readme" });
    expect(found.text).toContain("README.md");

    const log = await callTool(bearer, "repo_log", { repo: "api", n: 5 });
    expect(log.text).toContain("local only");
    expect(log.text).toContain("init");
  });

  it("refuses a repo outside the project and a path outside the repo", async () => {
    // docs is registered with Band but is not one of this project's repos.
    const other = await callTool(bearer, "repo_read", { repo: "docs", path: "README.md" });
    expect(other.isError).toBe(true);
    expect(other.text).toContain('not in project "shop"');

    const up = await callTool(bearer, "repo_read", { repo: "api", path: "../client/README.md" });
    expect(up.isError).toBe(true);
    expect(up.text).toContain("outside the repo");

    const gitDir = await callTool(bearer, "repo_read", { repo: "api", path: ".git/config" });
    expect(gitDir.isError).toBe(true);

    const search = await callTool(bearer, "repo_search", { repo: "docs", query: "docs" });
    expect(search.isError).toBe(true);
    const log = await callTool(bearer, "repo_log", { repo: "../docs", n: 1 });
    expect(log.isError).toBe(true);
  });
});

describe("repos added to and removed from the project (T.1)", () => {
  it("refuses to remove a checkout with uncommitted changes or unpushed commits", async () => {
    const dirty = await trpcMutate(
      server.url,
      "projects.removeRepo",
      { project: "shop", repo: "client" },
      TEST_TOKEN,
    );
    expect(dirty.status).toBe(409);
    expect(await dirty.text()).toContain("uncommitted changes");

    const unpushed = await trpcMutate(
      server.url,
      "projects.removeRepo",
      { project: "shop", repo: "api" },
      TEST_TOKEN,
    );
    expect(unpushed.status).toBe(409);
    expect(await unpushed.text()).toContain("unpushed commit");
    // Nothing was removed.
    const { project } = await q<{ project: { repos: Array<{ repo: string }> } }>("projects.get", {
      project: "shop",
    });
    expect(project.repos.map((r) => r.repo).sort()).toEqual(["api", "client"]);
  });

  it("removes a clean checkout and its branch, and adds a checkout for a new repo", async () => {
    const folder = join(realpathSync(home), ".band", "projects", "shop");
    const dir = join(folder, "repos", "client");
    git(dir, "checkout", "--", "README.md");
    await m("projects.syncFolder", { project: "shop" });
    expect(existsSync(join(dir, "client-news.md"))).toBe(true);

    await m("projects.removeRepo", { project: "shop", repo: "client" });
    expect(existsSync(dir)).toBe(false);
    expect(git(cloneOf("client"), "branch", "--list", "band/shop/main")).toBe("");

    await m("projects.addRepo", { project: "shop", repo: "docs" });
    await waitFor(
      () => (existsSync(join(folder, "repos", "docs", "README.md")) ? true : undefined),
      {
        label: "docs checkout",
        timeoutMs: 30_000,
      },
    );
    expect(git(join(folder, "repos", "docs"), "rev-parse", "--abbrev-ref", "HEAD")).toBe(
      "band/shop/main",
    );
  });

  it("checks out a repo added by URL straight into the project, before the call returns", async () => {
    const folder = join(realpathSync(home), ".band", "projects", "shop");
    const remote = join(home, "billing.git");
    const work = join(home, "billing-work");
    git(home, "init", "-q", "--bare", "-b", "main", remote);
    git(home, "clone", "-q", remote, work);
    git(work, "checkout", "-q", "-B", "main");
    writeFileSync(join(work, "README.md"), "billing readme\n");
    git(work, "add", ".");
    git(work, "commit", "-q", "-m", "init");
    git(work, "push", "-q", "-u", "origin", "main");

    const repo = await m<{ name: string }>("repos.addByUrl", {
      remoteUrl: remote,
      defaultBranch: "main",
      project: "shop",
    });
    // No coordinator turn, restart or Fetch and pull ran: the add made the checkout itself.
    expect(existsSync(join(folder, "repos", repo.name, "README.md"))).toBe(true);
    const checkout = (await folderState()).checkouts.find((c) => c.repo === repo.name);
    expect(checkout?.status).not.toBe("error");
  });
});

describe("a plain terminal in the project folder", () => {
  it("opens in the project folder", async () => {
    const opened = await m<{ terminalId: string; worktreeId: string; folder: string }>(
      "projects.openTerminal",
      { project: "shop" },
    );
    expect(opened.worktreeId).toBe(`project:${shop.id}`);
    const out = join(home, "terminal-pwd.txt");
    await m("terminal.send", { terminalId: opened.terminalId, data: `pwd > ${out}\n` });
    const written = await waitFor(
      () =>
        existsSync(out) && readFileSync(out, "utf8").trim()
          ? readFileSync(out, "utf8").trim()
          : undefined,
      { label: "pwd output", timeoutMs: 30_000 },
    );
    expect(realpathSync(written)).toBe(realpathSync(opened.folder));
    expect(opened.folder).toBe(join(realpathSync(home), ".band", "projects", "shop"));
  });

  it("opens through terminal.create with the project's worktree id, in the folder", async () => {
    const created = await m<{ terminalId: string; worktreeId: string }>("terminal.create", {
      worktreeId: `project:${shop.id}`,
    });
    expect(created.worktreeId).toBe(`project:${shop.id}`);
    const out = join(home, "terminal-create-pwd.txt");
    await m("terminal.send", { terminalId: created.terminalId, data: `pwd > ${out}\n` });
    const written = await waitFor(
      () =>
        existsSync(out) && readFileSync(out, "utf8").trim()
          ? readFileSync(out, "utf8").trim()
          : undefined,
      { label: "pwd output", timeoutMs: 30_000 },
    );
    expect(realpathSync(written)).toBe(
      realpathSync(join(realpathSync(home), ".band", "projects", "shop")),
    );
  });

  it("refuses a project id that does not exist", async () => {
    const res = await trpcMutate(
      server.url,
      "terminal.create",
      { worktreeId: "project:prj-0000000000" },
      TEST_TOKEN,
    );
    expect(res.status).not.toBe(200);
  });
});

describe("the project folder's checkouts are no worktrees of their repos", () => {
  it("leaves them out of repos.list after a sync, which a boot runs", async () => {
    const checkout = join(realpathSync(home), ".band", "projects", "shop", "repos", "api");
    await waitFor(async () => (await folderState())?.checkouts.find((c) => c.repo === "api"), {
      label: "api checkout",
      timeoutMs: 30_000,
    });
    expect(git(checkout, "rev-parse", "--abbrev-ref", "HEAD")).toBe("band/shop/main");
    // A worktree made outside Band shows that the boot's sync ran: it lists that one and not the
    // project folder's checkout, which git lists the same way.
    const outside = join(realpathSync(home), "api-outside");
    git(cloneOf("api"), "worktree", "add", "-q", "-b", "outside", outside);
    await server.close();
    server = await bootServer();
    type Listed = { repos: Array<{ name: string; worktrees: Array<{ path: string }> }> };
    const paths = await waitFor(
      async () => {
        const { repos } = await q<Listed>("repos.list");
        const listed = repos.find((r) => r.name === "api")?.worktrees.map((w) => w.path) ?? [];
        return listed.includes(outside) ? listed : undefined;
      },
      { label: "boot sync", timeoutMs: 30_000 },
    );
    expect(paths).not.toContain(checkout);
  }, 120_000);
});
