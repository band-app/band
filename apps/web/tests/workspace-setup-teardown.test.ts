// Integration tests for the `.band/config.json` `setup` / `teardown`
// commands, which run in a terminal tab of the workspace.
//
//   - setup runs in parallel with the agent: the first prompt reaches the
//     agent while setup is still running, and a failing setup neither holds
//     it back nor drops it. The setup output (and how it ended) is readable
//     from the setup terminal.
//   - teardown runs in a terminal (a PTY from the terminal pool, which sets
//     `BAND_DISPATCH=terminal`) and `workspaces.remove` waits for it before
//     it returns.
//
// Real production server, real git repo, real PTYs, real SQLite. The coding
// agent is the scripted stub ACP agent (`startAcpServer`), which answers
// every prompt and logs each request so the test can see the prompt arrive.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toWorkspaceId } from "@/dashboard";
import { startAcpServer, stubRequests } from "./helpers/acp-chat";
import { seedSettings, seedState } from "./helpers/seed-state";
import { createTmpHome, type ServerHandle, trpcMutate, trpcQuery } from "./helpers/server";
import { waitFor } from "./helpers/wait-for";

const TOKEN = "workspace-setup-teardown-token";
const PROJECT = "hookproj";

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@test.com",
};

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf-8" });
}

function createGitRepo(parentDir: string, name: string): string {
  const repoPath = join(parentDir, name);
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, ["init", "-b", "main"]);
  writeFileSync(join(repoPath, "README.md"), "# hook test\n");
  git(repoPath, ["add", "."]);
  git(repoPath, ["commit", "-m", "init"]);
  return repoPath;
}

/** Boot a server on a fresh home whose project declares the given hooks. */
async function bootWithConfig(
  prefix: string,
  config: { setup?: string; teardown?: string },
): Promise<{ server: ServerHandle; home: string; repoPath: string }> {
  const home = createTmpHome(prefix);
  const repoPath = createGitRepo(home, PROJECT);
  // Untracked, so new worktrees lack it and the server falls back to the
  // project's copy, which is the common real-world layout.
  mkdirSync(join(repoPath, ".band"), { recursive: true });
  writeFileSync(join(repoPath, ".band", "config.json"), JSON.stringify(config));
  seedState(home, {
    projects: [
      {
        name: PROJECT,
        path: repoPath,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: repoPath }],
      },
    ],
  });
  seedSettings(home, {
    tokenSecret: TOKEN,
    codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
    defaultCodingAgent: "claude-code",
  });
  const server = await startAcpServer({ home });
  return { server, home, repoPath };
}

/** Create a workspace; returns its worktree path. */
async function createWorkspace(
  server: ServerHandle,
  branch: string,
  prompt?: string,
): Promise<string> {
  const res = await trpcMutate(
    server.url,
    "workspaces.create",
    { project: PROJECT, branch, ...(prompt ? { prompt } : {}) },
    TOKEN,
  );
  const body = await res.text();
  expect(res.status, body).toBe(200);
  return (JSON.parse(body) as { result: { data: { path: string } } }).result.data.path;
}

async function listTerminalIds(server: ServerHandle, workspaceId: string): Promise<string[]> {
  const res = await trpcQuery(server.url, "terminal.list", { workspaceId }, TOKEN);
  const body = await res.text();
  expect(res.status, body).toBe(200);
  return (
    JSON.parse(body) as { result: { data: { terminals: { terminalId: string }[] } } }
  ).result.data.terminals.map((t) => t.terminalId);
}

async function readOutput(server: ServerHandle, terminalId: string): Promise<string> {
  const res = await trpcQuery(server.url, "terminal.output", { terminalId }, TOKEN);
  const body = await res.text();
  expect(res.status, body).toBe(200);
  return (JSON.parse(body) as { result: { data: { output: string } } }).result.data.output;
}

/** Wait until one of the workspace's terminals prints `marker`; returns that terminal. */
async function waitForTerminalOutput(
  server: ServerHandle,
  workspaceId: string,
  marker: string,
): Promise<{ terminalId: string; output: string }> {
  return waitFor(
    async () => {
      for (const terminalId of await listTerminalIds(server, workspaceId)) {
        const output = await readOutput(server, terminalId);
        if (output.includes(marker)) return { terminalId, output };
      }
      return undefined;
    },
    { label: `terminal output containing ${marker}`, timeoutMs: 15_000 },
  );
}

function promptTexts(home: string): (string | undefined)[] {
  return stubRequests(home, "session/prompt").map(
    (r) => (r.params.prompt as { text?: string }[])[0]?.text,
  );
}

describe("setup runs in a terminal, in parallel with the agent", () => {
  let server: ServerHandle;
  let home: string;

  beforeAll(async () => {
    // Never finishes on its own: the prompt must not wait for it.
    ({ server, home } = await bootWithConfig("band-setup-parallel-", {
      setup: "echo SETUP-STARTED; sleep 600",
    }));
  });

  afterAll(async () => {
    await server.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("delivers the prompt while setup is still running in its own terminal", async () => {
    const workspaceId = toWorkspaceId(PROJECT, "feat/slow-setup");
    await createWorkspace(server, "feat/slow-setup", "prompt during slow setup");

    const { terminalId: setupTerminal, output } = await waitForTerminalOutput(
      server,
      workspaceId,
      "SETUP-STARTED",
    );
    expect(output).toContain("[band] running setup: echo SETUP-STARTED; sleep 600");

    const prompts = await waitFor(
      async () => {
        const texts = promptTexts(home);
        return texts.includes("prompt during slow setup") ? texts : undefined;
      },
      { label: "prompt reached the agent", timeoutMs: 15_000 },
    );
    expect(prompts).toEqual(["prompt during slow setup"]);

    // The setup is still running: its terminal never printed a result.
    expect(await readOutput(server, setupTerminal)).not.toContain("[band] setup finished");
  });
});

describe("a failing setup does not drop the prompt", () => {
  let server: ServerHandle;
  let home: string;

  beforeAll(async () => {
    ({ server, home } = await bootWithConfig("band-setup-failing-", {
      setup: "echo SETUP-FAILING; exit 3",
    }));
  });

  afterAll(async () => {
    await server.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("shows the exit code in the setup terminal and still delivers the prompt", async () => {
    const workspaceId = toWorkspaceId(PROJECT, "feat/bad-setup");
    await createWorkspace(server, "feat/bad-setup", "prompt despite failing setup");

    const { output } = await waitForTerminalOutput(
      server,
      workspaceId,
      "[band] setup finished with exit code 3",
    );
    expect(output).toContain("SETUP-FAILING");

    const prompts = await waitFor(
      async () => {
        const texts = promptTexts(home);
        return texts.includes("prompt despite failing setup") ? texts : undefined;
      },
      { label: "prompt reached the agent", timeoutMs: 15_000 },
    );
    expect(prompts).toEqual(["prompt despite failing setup"]);
  });
});

describe("teardown runs in a terminal before the workspace is removed", () => {
  let server: ServerHandle;
  let home: string;
  let markerPath: string;

  beforeAll(async () => {
    const markerDir = createTmpHome("band-teardown-marker-");
    markerPath = join(markerDir, "teardown-marker");
    // The sleep proves `remove` waits: the marker is written last.
    ({ server, home } = await bootWithConfig("band-teardown-", {
      teardown: `sleep 1; printf 'dispatch=%s cwd=%s' "$BAND_DISPATCH" "$(pwd -P)" > '${markerPath}'`,
    }));
  });

  afterAll(async () => {
    await server.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    rmSync(join(markerPath, ".."), { recursive: true, force: true });
  });

  it("runs the teardown in the worktree's terminal and waits for it", async () => {
    const worktreePath = await createWorkspace(server, "feat/teardown");
    expect(existsSync(worktreePath)).toBe(true);
    const realWorktreePath = realpathSync(worktreePath);

    const res = await trpcMutate(
      server.url,
      "workspaces.remove",
      { project: PROJECT, name: "feat/teardown" },
      TOKEN,
    );
    const body = await res.text();
    expect(res.status, body).toBe(200);

    // Written by the teardown before `remove` returned. `BAND_DISPATCH` is
    // set only for shells the terminal pool spawns, so this also proves the
    // command ran in a workspace terminal rather than a hidden subprocess.
    expect(readFileSync(markerPath, "utf-8")).toBe(`dispatch=terminal cwd=${realWorktreePath}`);

    const workspaceId = toWorkspaceId(PROJECT, "feat/teardown");
    const remaining = await waitFor(
      async () => {
        const ids = await listTerminalIds(server, workspaceId);
        return ids.length === 0 ? ids : undefined;
      },
      { label: "teardown terminal killed with the workspace" },
    );
    expect(remaining).toEqual([]);
  });

  it("rejects workspaces.remove without the band_token cookie (401)", async () => {
    const res = await fetch(`${server.url}/trpc/workspaces.remove`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: PROJECT, name: "feat/teardown" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("a failing teardown does not stop the removal", () => {
  let server: ServerHandle;
  let home: string;

  beforeAll(async () => {
    ({ server, home } = await bootWithConfig("band-teardown-failing-", {
      teardown: "echo TEARDOWN-FAILING; exit 4",
    }));
  });

  afterAll(async () => {
    await server.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("removes the workspace and its worktree anyway", async () => {
    const worktreePath = await createWorkspace(server, "feat/bad-teardown");

    const res = await trpcMutate(
      server.url,
      "workspaces.remove",
      { project: PROJECT, name: "feat/bad-teardown" },
      TOKEN,
    );
    const body = await res.text();
    expect(res.status, body).toBe(200);

    const listRes = await trpcQuery(server.url, "projects.list", undefined, TOKEN);
    const listBody = await listRes.text();
    expect(listRes.status, listBody).toBe(200);
    const { projects } = (
      JSON.parse(listBody) as {
        result: { data: { projects: { name: string; worktrees: { branch: string }[] }[] } };
      }
    ).result.data;
    const project = projects.find((p) => p.name === PROJECT);
    expect(project?.worktrees.map((wt) => wt.branch)).toEqual(["main"]);

    // The worktree directory goes in the background after `remove` returns.
    await waitFor(async () => (existsSync(worktreePath) ? undefined : true), {
      label: "worktree directory removed",
    });
  });
});
