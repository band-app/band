// Integration tests for the scheduled project retro (plan step 6.5). A real hub (the production bundle on a
// random port, auth on) with real git repos. The retro agent is the scripted ACP stub: its turn calls
// `retro_propose` through the `band-retro` MCP entry Band put in the session, with a fixed proposal. The
// tests then decide the items through tRPC and read the project context back, as the UI does.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
  execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv, stdio: "pipe" });

interface RetroItem {
  id: string;
  target: string;
  path: string;
  diff: string;
  base: string | null;
  status: string;
  error?: string;
  result?: { commit?: string; dispatch?: string; requestId?: string };
}
interface Proposal {
  id: string;
  status: string;
  summary: string | null;
  error: string | null;
  items: RetroItem[];
}

const NEW_NOTES = "# Notes\n\nShort and current.\n";
const LEARNING = "learnings/2026-10-01-agent.md";

let home: string;
let server: ServerHandle;
let projectId: string;

const call = (kind: "m" | "q", proc: string, input?: unknown) =>
  kind === "m"
    ? trpcMutate(server.url, proc, input, TEST_TOKEN)
    : trpcQuery(server.url, proc, input, TEST_TOKEN);
const m = async <T>(proc: string, input: unknown) => {
  const res = await call("m", proc, input);
  expect(res.status, `${proc}: ${await res.clone().text()}`).toBe(200);
  return trpcData<T>(res);
};
const q = async <T>(proc: string, input?: unknown) => {
  const res = await call("q", proc, input);
  expect(res.status, `${proc}: ${await res.clone().text()}`).toBe(200);
  return trpcData<T>(res);
};

const proposals = (project = "shop") =>
  q<{ proposals: Proposal[] }>("projects.retroProposals", { project }).then((r) => r.proposals);

/** Runs a retro and waits for the agent's proposal to be stored. */
async function runRetro(project = "shop"): Promise<Proposal> {
  const { proposal } = await m<{ proposal: Proposal }>("projects.retroRun", { project });
  expect(proposal.status).toBe("running");
  return waitFor(
    async () => {
      const found = (await proposals(project)).find((p) => p.id === proposal.id);
      return found && found.status !== "running" ? found : undefined;
    },
    { label: "the retro proposal", timeoutMs: 30_000 },
  );
}

const decide = (proposalId: string, itemId: string, decision: "accept" | "reject") =>
  m<{ proposal: Proposal }>("projects.retroDecide", { proposalId, itemId, decision }).then(
    (r) => r.proposal,
  );

const itemOf = (p: Proposal, id: string) => p.items.find((i) => i.id === id) as RetroItem;

beforeAll(async () => {
  home = createTmpHome("band-retro-");
  const repos = ["api", "client"].map((name) => {
    const path = join(home, "repos", name);
    mkdirSync(path, { recursive: true });
    git(path, "init", "-q", "-b", "main");
    writeFileSync(join(path, "README.md"), `${name}\n`);
    git(path, "add", ".");
    git(path, "commit", "-q", "-m", "init");
    return { name, path, defaultBranch: "main", worktrees: [{ branch: "main", path }] };
  });
  seedState(home, { repos });
  seedSettings(home, {
    tokenSecret: TEST_TOKEN,
    codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
    defaultCodingAgent: "claude-code",
  });
  const scenario = join(home, "scenario.json");
  writeFileSync(
    scenario,
    JSON.stringify({
      turns: [
        {
          match: "^Retro for the Band project",
          steps: [
            {
              mcpCall: {
                name: "retro",
                server: "band-retro",
                tool: "retro_propose",
                args: {
                  summary: "One learning is folded into the notes.",
                  items: [
                    {
                      target: "project-context",
                      path: "notes.md",
                      content: NEW_NOTES,
                      rationale: "The notes repeat the learning of 2026-10-01.",
                    },
                    {
                      target: "project-context",
                      path: LEARNING,
                      moveTo: "learnings/archive/2026-10-01-agent.md",
                      rationale: "Folded into notes.md.",
                    },
                    {
                      target: "repo",
                      repo: "api",
                      path: "CLAUDE.md",
                      change: "Add a line: run the checks before every push.",
                      rationale: "Two handoffs report a push that skipped the checks.",
                    },
                  ],
                },
              },
            },
            { say: "proposed" },
          ],
        },
        { steps: [{ say: "ok" }] },
      ],
    }),
  );
  server = await startServer({
    remoteHost: false,
    tmpHome: home,
    env: {
      BAND_SERVE_UI: "false",
      BAND_TEST_ACP_STATE: join(home, "acp-stub-state"),
      BAND_TEST_ACP_LOG: join(home, "acp-stub-log.jsonl"),
      BAND_TEST_ACP_HTTP_LOG: join(home, "acp-stub-http.jsonl"),
      BAND_TEST_ACP_SCENARIO: scenario,
    },
  });
  const created = await m<{ project: { id: string } }>("projects.create", {
    name: "shop",
    repos: [{ repo: "api" }, { repo: "client" }],
  });
  projectId = created.project.id;
  const notes = await q<{ commit: string }>("context.file", { name: "shop", path: "notes.md" });
  await m("context.write", {
    name: "shop",
    path: LEARNING,
    content: "# Learning\n\nPushes skipped the checks.\n",
    message: "Add a learning",
    base: notes.commit,
  });
}, 180_000);

afterAll(async () => {
  await server?.close();
  if (home) removeTmpHome(home);
});

describe("retro access", () => {
  it("refuses a non-admin token and no token on the retro procedures", async () => {
    const { token } = await m<{ token: string }>("tokens.createDevice", { label: "viewer" });
    for (const t of [token, "bad-token"]) {
      const want = t === token ? 403 : 401;
      expect(
        (await trpcMutate(server.url, "projects.retroRun", { project: "shop" }, t)).status,
      ).toBe(want);
      expect(
        (await trpcQuery(server.url, "projects.retroProposals", { project: "shop" }, t)).status,
      ).toBe(want);
    }
  });
});

describe("the retro schedule (S4)", () => {
  it("is off by default, with the weekly schedule filled in", async () => {
    const { project } = await q<{
      project: { effectivePolicy: { retro: { enabled: boolean; cron: string } } };
    }>("projects.get", { project: "shop" });
    expect(project.effectivePolicy.retro).toEqual({ enabled: false, cron: "0 9 * * 1" });
    const { retro } = await q<{ retro: { enabled: boolean; nextRunAt: number | null } }>(
      "projects.retroStatus",
      { project: "shop" },
    );
    expect(retro).toMatchObject({ enabled: false, nextRunAt: null, running: false });
  });

  it("is editable per project: a new cron moves the next run, off clears it", async () => {
    await m("projects.update", {
      project: "shop",
      policy: { retro: { enabled: true, cron: "30 8 * * 2" } },
    });
    const on = await q<{ retro: { enabled: boolean; cron: string; nextRunAt: number | null } }>(
      "projects.retroStatus",
      { project: "shop" },
    );
    expect(on.retro).toMatchObject({ enabled: true, cron: "30 8 * * 2" });
    const next = new Date(on.retro.nextRunAt as number);
    expect([next.getDay(), next.getHours(), next.getMinutes()]).toEqual([2, 8, 30]);

    await m("projects.update", {
      project: "shop",
      policy: { retro: { enabled: true, cron: "0 6 * * 5" } },
    });
    const moved = await q<{ retro: { nextRunAt: number } }>("projects.retroStatus", {
      project: "shop",
    });
    const day = new Date(moved.retro.nextRunAt);
    expect([day.getDay(), day.getHours()]).toEqual([5, 6]);

    await m("projects.update", { project: "shop", policy: {} });
    const off = await q<{ retro: { enabled: boolean; nextRunAt: number | null } }>(
      "projects.retroStatus",
      { project: "shop" },
    );
    expect(off.retro).toMatchObject({ enabled: false, nextRunAt: null });
  });

  it("refuses a cron expression that does not parse", async () => {
    const res = await call("m", "projects.update", {
      project: "shop",
      policy: { retro: { enabled: true, cron: "not a cron" } },
    });
    expect(res.status).toBe(400);
  });
});

let first: Proposal;

describe("a triggered retro stores a proposal with diffs (S1)", () => {
  it("runs the agent on the reviewer lane with the retro tool only, and stores its items", async () => {
    first = await runRetro();
    expect(first.status).toBe("pending");
    expect(first.summary).toBe("One learning is folded into the notes.");
    expect(first.items.map((i) => [i.id, i.target, i.path, i.status])).toEqual([
      ["i1", "project-context", "notes.md", "pending"],
      ["i2", "project-context", LEARNING, "pending"],
      ["i3", "repo", "CLAUDE.md", "pending"],
    ]);

    const { chats } = await q<{
      chats: Array<{ model: string; labels: Record<string, string> }>;
    }>("chats.list", { worktreeId: `project:${projectId}` });
    const retroChat = chats.find((c) => c.labels["band:retro"]);
    expect(retroChat).toMatchObject({ model: "sonnet", labels: { "band:retro": projectId } });

    const session = (await waitFor(
      async () =>
        stubRequests(home, "session/new").find((r: StubRequest) =>
          (r.params.mcpServers as Array<{ name: string }>).some((s) => s.name === "band-retro"),
        ),
      { label: "the retro session" },
    )) as StubRequest;
    const servers = session.params.mcpServers as Array<{ name: string }>;
    expect(servers.map((s) => s.name)).toEqual(["band-retro"]);
    const meta = session.params._meta as { systemPrompt?: { append?: string } };
    expect(meta.systemPrompt?.append).toContain('retro agent of the Band project "shop"');
  });

  it("shows each context edit as a diff against the current file, and keeps the base commit", () => {
    const notes = itemOf(first, "i1");
    expect(notes.diff).toContain("--- a/notes.md");
    expect(notes.diff).toContain("+Short and current.");
    expect(notes.base).toMatch(/^[0-9a-f]{40}$/);
    expect(itemOf(first, "i2").diff).toBe(
      `rename from ${LEARNING}\nrename to learnings/archive/2026-10-01-agent.md`,
    );
    expect(itemOf(first, "i3").diff).toContain("run the checks before every push");
  });

  it("changes nothing until an item is decided", async () => {
    const notes = await q<{ content: string }>("context.file", { name: "shop", path: "notes.md" });
    expect(notes.content).not.toContain("Short and current.");
  });
});

describe("accepting and rejecting items (S2)", () => {
  it("commits an accepted notes.md edit to the project context as the coordinator", async () => {
    const after = await decide(first.id, "i1", "accept");
    expect(itemOf(after, "i1")).toMatchObject({ status: "accepted" });
    const notes = await q<{ content: string }>("context.file", { name: "shop", path: "notes.md" });
    expect(notes.content).toBe(NEW_NOTES);
    const { commits } = await q<{ commits: Array<{ author: string; subject: string }> }>(
      "context.log",
      { name: "shop", path: "notes.md", limit: 1 },
    );
    expect(commits[0]).toMatchObject({
      author: "coordinator",
      subject: "retro: The notes repeat the learning of 2026-10-01.",
    });
  });

  it("leaves the file as it was when an item is rejected", async () => {
    const after = await decide(first.id, "i2", "reject");
    expect(itemOf(after, "i2").status).toBe("rejected");
    const kept = await q<{ content: string }>("context.file", { name: "shop", path: LEARNING });
    expect(kept.content).toContain("Pushes skipped the checks.");
    const res = await call("m", "projects.retroDecide", {
      proposalId: first.id,
      itemId: "i2",
      decision: "accept",
    });
    expect(res.status).toBe(400);
  });

  it("refuses an accept when the file changed since the proposal, and the item can be retried", async () => {
    // The first retro already put its notes in place, so a second proposal needs different notes to diff against.
    const draft = await q<{ commit: string }>("context.file", { name: "shop", path: "notes.md" });
    await m("context.write", {
      name: "shop",
      path: "notes.md",
      content: "# Notes\n\nA long draft.\n",
      message: "Draft the notes",
      base: draft.commit,
    });
    const second = await runRetro();
    const notes = await q<{ commit: string }>("context.file", { name: "shop", path: "notes.md" });
    await m("context.write", {
      name: "shop",
      path: "notes.md",
      content: "# Notes\n\nSomeone edited these meanwhile.\n",
      message: "Edit the notes",
      base: notes.commit,
    });
    const after = await decide(second.id, "i1", "accept");
    expect(itemOf(after, "i1").status).toBe("failed");
    expect(itemOf(after, "i1").error).toContain("changed since");
    expect(after.status).toBe("pending");
    const current = await q<{ content: string }>("context.file", {
      name: "shop",
      path: "notes.md",
    });
    expect(current.content).toContain("Someone edited these meanwhile.");

    // Archiving moves the learning in one commit.
    const moved = await decide(second.id, "i2", "accept");
    expect(itemOf(moved, "i2").status).toBe("accepted");
    const archived = await q<{ content: string }>("context.file", {
      name: "shop",
      path: "learnings/archive/2026-10-01-agent.md",
    });
    expect(archived.content).toContain("Pushes skipped the checks.");
    const gone = await call("q", "context.file", { name: "shop", path: LEARNING });
    expect(gone.status).toBe(400);
  });
});

describe("a repo edit becomes a dispatch (S3)", () => {
  it("waits for approval in steer mode, with the proposed change in the brief", async () => {
    const after = await decide(first.id, "i3", "accept");
    const item = itemOf(after, "i3");
    expect(item.status).toBe("accepted");
    expect(item.result?.dispatch).toBe("pending approval");

    const { dispatches } = await q<{
      dispatches: Array<{
        id: string;
        status: string;
        repos: string[];
        branch: string;
        brief: string;
      }>;
    }>("projects.dispatches", { project: "shop", status: "pending" });
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]).toMatchObject({
      id: item.result?.requestId,
      status: "pending",
      repos: ["api"],
    });
    expect(dispatches[0]?.branch).toMatch(/^retro-/);
    expect(dispatches[0]?.brief).toContain("run the checks before every push");
    // Nothing was created before the user approved.
    const { project } = await q<{ project: { worktrees: unknown[] } }>("projects.get", {
      project: "shop",
    });
    expect(project.worktrees).toHaveLength(0);
  });

  it("marks the proposal reviewed once every item is decided", async () => {
    const current = (await proposals()).find((p) => p.id === first.id) as Proposal;
    expect(current.status).toBe("reviewed");
  });

  it("refuses the repo edit in observe mode and leaves the item to retry", async () => {
    // A fresh project, because the scripted proposal archives a learning into a path the first one used.
    await m("projects.create", {
      name: "ops",
      repos: [{ repo: "api" }],
      policy: { autonomy: "observe" },
    });
    const notes = await q<{ commit: string }>("context.file", { name: "ops", path: "notes.md" });
    await m("context.write", {
      name: "ops",
      path: LEARNING,
      content: "# Learning\n\nPushes skipped the checks again.\n",
      message: "Add a learning",
      base: notes.commit,
    });
    const third = await runRetro("ops");
    const after = await decide(third.id, "i3", "accept");
    expect(itemOf(after, "i3").status).toBe("failed");
    expect(itemOf(after, "i3").error).toContain("observe");
  });
});
