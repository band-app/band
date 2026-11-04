/**
 * The Resources dialog: a Memory / CPU / Storage switch, one card and section per machine, and
 * the Band processes on each machine with the worktree and chat they belong to.
 *
 * Real production hub, a real `band-worker` named "e2e-box" with a terminal and a chat whose agent
 * is the scripted ACP stub, a real browser, temp dirs only.
 *
 * Out of scope: the "Desktop app" machine. It self-gates on `isDesktop` and reads its data over
 * the Electron IPC (`get_app_metrics`), and this web-build harness never boots Electron. The
 * negative is asserted below. `mapAppMetrics` is covered by `apps/desktop/tests/app-metrics.test.ts`;
 * the IPC channel, the preload entry and the Electron rows stay uncovered, pending desktop e2e.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toWorktreeId } from "@band-app/shared/worktree-id";
import { expect, test } from "@playwright/test";
import { ACP_STUB_AGENT_PATH } from "./helpers/acp-stub";
import {
  cleanupTmpHome,
  createTmpHome,
  resetClientState,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { trpcMutate, trpcMutateData, trpcQuery } from "./helpers/trpc";
import { startWorker, type WorkerHandle } from "./helpers/worker";
import { ResourcesPage } from "./pages/ResourcesPage";

const TOKEN = "e2e-resources-token";
const REPO = "resources-fixture";

test.use({ viewport: { width: 1280, height: 800 } });
test.describe.configure({ mode: "serial" });

let server: ServerHandle;
let tmpHome: string;
let worker: WorkerHandle | undefined;
let hostId = "";
let remote = "";
let terminalId = "";
const dirs: string[] = [];

const tmpDir = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
};

function makeRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
  };
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, env });
  writeFileSync(join(dir, "seed.bin"), Buffer.alloc(1024 * 1024));
  execFileSync("git", ["add", "."], { cwd: dir, env });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir, env });
}

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const hubRepo = join(tmpDir("band-e2e-resources-"), REPO);
  makeRepo(hubRepo);
  seedSettings(tmpHome, {
    tokenSecret: TOKEN,
    codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
    defaultCodingAgent: "claude-code",
  });
  seedState(tmpHome, {
    repos: [
      {
        name: REPO,
        path: hubRepo,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: hubRepo }],
      },
    ],
  });
  server = await startServer({ tmpHome });

  const issued = await trpcMutateData<{ token: string; hostId: string }>(
    server.url,
    TOKEN,
    "tokens.issueWorkerBootstrap",
    { hostName: "e2e-box", labels: [] },
  );
  hostId = issued.hostId;
  const workerRoot = tmpDir("band-e2e-resources-wroot-");
  makeRepo(join(workerRoot, REPO));
  // A `claude` the capability probe finds, so the worker reports the agent as installed and logged in.
  const agentBin = tmpDir("band-e2e-resources-bin-");
  writeFileSync(join(agentBin, "claude"), '#!/bin/sh\necho "claude 1.0.0"\n', { mode: 0o755 });
  worker = startWorker({
    env: {
      BAND_HUB_URL: server.url,
      BAND_BOOTSTRAP_TOKEN: issued.token,
      BAND_WORKER_ID: hostId,
      BAND_TEST_ACP_AGENT: ACP_STUB_AGENT_PATH,
      BAND_AGENT_BIN_DIRS: agentBin,
      ANTHROPIC_API_KEY: "test-key",
    },
    root: workerRoot,
    stateDir: tmpDir("band-e2e-resources-state-"),
    home: tmpDir("band-e2e-resources-whome-"),
  });
  await expect
    .poll(
      async () => {
        const { hosts } = await trpcQuery<{ hosts: Array<{ id: string; status: string }> }>(
          server.url,
          TOKEN,
          "hosts.list",
        );
        return hosts.find((h) => h.id === hostId)?.status;
      },
      { timeout: 30_000 },
    )
    .toBe("online");
  remote = toWorktreeId(REPO, "feature", hostId);
  await trpcMutate(server.url, TOKEN, "worktrees.create", {
    repo: REPO,
    branch: "feature",
    hostId,
    hostRepoPath: join(workerRoot, REPO),
    noOrigin: true,
  });
  await trpcMutate(server.url, TOKEN, "chats.create", {
    worktreeId: remote,
    id: "chat_resources",
    name: "Resources chat",
  });
  // One turn starts the chat's agent process on the worker.
  const sent = await fetch(`${server.url}/api/chats/chat_resources/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `band_token=${TOKEN}` },
    body: JSON.stringify({ worktreeId: remote, text: "hello" }),
  });
  expect(sent.status).toBeLessThan(300);
  terminalId = crypto.randomUUID();
  await trpcMutate(server.url, TOKEN, "terminal.create", { worktreeId: remote, id: terminalId });
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await worker?.kill();
  await server.close();
  cleanupTmpHome(tmpHome);
  for (const dir of dirs) cleanupTmpHome(dir);
});

test("Memory lists the hub and the worker, with the worker's terminal and agent (S1)", async ({
  page,
}) => {
  const resources = new ResourcesPage(page, server.url, TOKEN);
  await resources.open();

  await expect(resources.card("local")).toBeVisible();
  await expect(resources.card(hostId)).toBeVisible();
  await expect(resources.section("local")).toBeVisible();
  await expect(resources.section(hostId)).toBeVisible();
  // The Electron machine is desktop-only and never renders in this web-build harness.
  await expect(resources.card("desktop-app")).toHaveCount(0);

  const terminal = resources.processes(hostId, "terminals").filter({ hasText: "feature" });
  await expect(terminal).toBeVisible();
  await expect(resources.worktreeLinks(terminal)).toContainText("feature");
  await expect(resources.value(terminal)).toHaveText(/\d+(\.\d+)? (KB|MB|GB)/);

  const agent = resources.processes(hostId, "agents").filter({ hasText: "Resources chat" });
  await expect(agent).toBeVisible();
  await expect(resources.worktreeLinks(agent)).toContainText("feature");
  await expect(resources.chatLabel(agent)).toContainText("Resources chat");
  await expect(resources.value(agent)).toHaveText(/\d+(\.\d+)? (KB|MB|GB)/);
});

test("CPU ranks a busy loop in the terminal first among the top consumers (S2)", async ({
  page,
}) => {
  try {
    await trpcMutate(server.url, TOKEN, "terminal.send", {
      terminalId,
      data: "while :; do :; done\n",
    });
    const resources = new ResourcesPage(page, server.url, TOKEN);
    await resources.open();
    await resources.switchTo("cpu");

    await expect(resources.topConsumers).toBeVisible();
    // The page refreshes every 5 s, so the first row settles on the loop once it has run for a while.
    await expect(resources.topRows.first()).toHaveAttribute("data-kind", "terminal", {
      timeout: 45_000,
    });
    await expect(resources.value(resources.topRows.first())).toHaveText(/\d+(\.\d)?%/);
    await expect(
      resources.processes(hostId, "terminals").filter({ hasText: "feature" }),
    ).toBeVisible();
  } finally {
    // Stop the loop even when an assertion failed, so it does not run into the next tests.
    await trpcMutate(server.url, TOKEN, "terminal.send", { terminalId, data: "\u0003" });
  }
});

test("Storage measures worktrees on the worker and shows its free disk (S3)", async ({ page }) => {
  const resources = new ResourcesPage(page, server.url, TOKEN);
  await resources.open();
  await resources.switchTo("storage");

  await expect(resources.storage(hostId)).toBeVisible();
  await expect(resources.freeDisk(hostId)).toContainText(/\d/);
  const repoRow = resources.repoRow(hostId, REPO);
  await expect(repoRow).toBeVisible();
  await resources.expandRepo(hostId, REPO);
  await expect(resources.worktreeSizes(hostId).filter({ hasText: "feature" })).toHaveText(/MB|GB/);
});

test("a worker that is offline shows as unavailable and the rest still renders (S4)", async ({
  page,
}) => {
  await worker?.kill();
  await expect
    .poll(
      async () => {
        const { hosts } = await trpcQuery<{ hosts: Array<{ id: string; status: string }> }>(
          server.url,
          TOKEN,
          "hosts.list",
        );
        return hosts.find((h) => h.id === hostId)?.status;
      },
      { timeout: 30_000 },
    )
    .not.toBe("online");
  const resources = new ResourcesPage(page, server.url, TOKEN);
  await resources.open();
  await expect(resources.unavailable(hostId)).toBeVisible();
  await expect(resources.card(hostId)).toHaveAttribute("data-status", "unavailable");
  await expect(resources.card("local")).toHaveAttribute("data-status", "ok");
  await expect(resources.section("local")).toBeVisible();
});

test.describe("phone width", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("cards wrap, rows drop the bar and nothing scrolls sideways (S6)", async ({ page }) => {
    const resources = new ResourcesPage(page, server.url, TOKEN);
    await resources.open();
    await expect(resources.card("local")).toBeVisible();
    await expect(resources.card("local")).toBeInViewport();
    await expect(resources.section(hostId)).toBeVisible();
    await expect.poll(() => resources.scrollsSideways()).toBe(false);
    await resources.switchTo("cpu");
    await expect(resources.topConsumers).toBeVisible();
    await expect(resources.topRows.first().getByTestId("resources__bar")).toBeHidden();
    await expect.poll(() => resources.scrollsSideways()).toBe(false);
  });
});
