/**
 * Extension worktree panels (docs/extensions.md). A real hub, two real `band-worker` processes and
 * a real browser. The echo-service fixture extension (service, panel, tool) is installed on the
 * hub. Worker A runs its service; worker B is restricted, so it never does. The panel runs in a
 * sandboxed iframe and speaks the panel protocol over a MessagePort. No tRPC mocking.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorktreeId } from "@/dashboard";
import { echoArchive } from "../../hub/tests/helpers/extension-archive";
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
import { ExtensionPanelPage } from "./pages/ExtensionPanelPage";

test.use({ viewport: { width: 1440, height: 900 } });
test.describe.configure({ mode: "serial" });

const TOKEN = "e2e-extension-panel-token";
const REPO = "panelrepo";

let server: ServerHandle;
let tmpHome: string;
const workers: WorkerHandle[] = [];
const scratch: string[] = [];
const ids: { a: string; b: string } = { a: "", b: "" };

const tmpDir = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });

async function addWorker(label: "a" | "b"): Promise<string> {
  const issued = await trpcMutateData<{ token: string; hostId: string }>(
    server.url,
    TOKEN,
    "tokens.issueWorkerBootstrap",
    { hostName: `worker-${label}`, labels: [] },
  );
  const root = tmpDir(`band-e2e-panel-${label}-root-`);
  const repo = join(root, REPO);
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "hello.txt"), "hello\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  workers.push(
    startWorker({
      env: {
        BAND_HUB_URL: server.url,
        BAND_BOOTSTRAP_TOKEN: issued.token,
        BAND_WORKER_ID: issued.hostId,
      },
      root,
      stateDir: tmpDir(`band-e2e-panel-${label}-state-`),
      home: tmpDir(`band-e2e-panel-${label}-home-`),
    }),
  );
  await expect
    .poll(
      async () => {
        const { hosts } = await trpcQuery<{ hosts: Array<{ id: string; status: string }> }>(
          server.url,
          TOKEN,
          "hosts.list",
        );
        return hosts.find((h) => h.id === issued.hostId)?.status;
      },
      { timeout: 60_000 },
    )
    .toBe("online");
  await trpcMutate(server.url, TOKEN, "worktrees.create", {
    repo: REPO,
    branch: `wt-${label}`,
    hostId: issued.hostId,
    hostRepoPath: repo,
    noOrigin: true,
  });
  ids[label] = issued.hostId;
  return toWorktreeId(REPO, `wt-${label}`, issued.hostId);
}

let worktreeA = "";
let worktreeB = "";

test.beforeAll(async () => {
  test.setTimeout(240_000);
  tmpHome = createTmpHome();
  const hubRepo = join(tmpDir("band-e2e-panel-hubrepo-"), REPO);
  mkdirSync(hubRepo, { recursive: true });
  git(hubRepo, "init", "-q", "-b", "main");
  writeFileSync(join(hubRepo, "hello.txt"), "hello\n");
  git(hubRepo, "add", ".");
  git(hubRepo, "commit", "-q", "-m", "init");
  seedSettings(tmpHome, { tokenSecret: TOKEN });
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
  worktreeA = await addWorker("a");
  worktreeB = await addWorker("b");
  await trpcMutate(server.url, TOKEN, "hosts.setTrust", { hostId: ids.b, trust: "restricted" });
  const res = await fetch(`${server.url}/api/extensions/install`, {
    method: "POST",
    headers: { Cookie: `band_token=${TOKEN}` },
    body: echoArchive({ version: "1.0.0" }).bytes,
  });
  expect(res.status).toBe(200);
  await expect
    .poll(
      async () => {
        const { hosts } = await trpcQuery<{
          hosts: Array<{ id: string; capabilities: string[] }>;
        }>(server.url, TOKEN, "hosts.list");
        return hosts.find((h) => h.id === ids.a)?.capabilities.includes("echo");
      },
      { timeout: 60_000 },
    )
    .toBe(true);
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  for (const w of workers) await w.kill();
  await server?.close();
  cleanupTmpHome(tmpHome);
  for (const dir of scratch) cleanupTmpHome(dir);
});

test("S1: the + menu offers the panel on the worker that runs the service, not on others", async ({
  page,
}) => {
  const panel = new ExtensionPanelPage(page, server.url, TOKEN, "echo-service", "screen");
  await panel.open(worktreeA);
  await panel.openNewTabMenu();
  await expect(panel.menuItem).toBeVisible();

  await panel.open(worktreeB);
  await panel.openNewTabMenu();
  await expect(panel.menuItem).toHaveCount(0);

  await panel.open(toWorktreeId(REPO, "main", "local"));
  await panel.openNewTabMenu();
  await expect(panel.menuItem).toHaveCount(0);
});

test("S2: frames arrive in the panel, input waits for Take control, and a call returns", async ({
  page,
}) => {
  const panel = new ExtensionPanelPage(page, server.url, TOKEN, "echo-service", "screen");
  await panel.open(worktreeA);
  await panel.openFromMenu();
  await expect(panel.frames).toHaveText("3");
  await expect(panel.callResult).toHaveText('{"hello":"panel"}');
  await expect(panel.mode).toHaveText("View only");

  // Input before control is dropped by the hub: nothing comes back.
  await panel.sendButton.click();
  await expect(panel.echoes).toHaveCount(0);

  await panel.takeControl();
  await expect(panel.mode).toHaveText("Controlling");
  await expect(panel.pageMode).toHaveText("control");
  await panel.sendButton.click();
  await expect(panel.echoes).toHaveCount(1);
  await expect(panel.echoes.first()).toHaveText("echo:tap");
});

test("S8: a panel with defaultControl starts in control and Release stops input; one without starts view-only", async ({
  page,
}) => {
  const auto = new ExtensionPanelPage(page, server.url, TOKEN, "echo-service", "auto");
  await auto.open(worktreeA);
  await auto.openFromMenu();
  await expect(auto.frames).toHaveText("3");
  await expect(auto.mode).toHaveText("Controlling");
  await expect(auto.pageMode).toHaveText("control");
  await auto.sendButton.click();
  await expect(auto.echoes).toHaveCount(1);

  await auto.controlButton.click();
  await expect(auto.mode).toHaveText("View only");
  await auto.sendButton.click();
  await expect(auto.echoes).toHaveCount(1);
});
