/**
 * A worker joins and leaves the Hosts screen live, and a workspace can be
 * created on it from the New Workspace dialog (plan step 2.3).
 *
 * The test follows the user's path: "Add worker" prints the bootstrap token and
 * command, the real `band-worker` binary runs that command's environment, and
 * the host row turns online without a reload. The outcome of the workspace
 * creation is read back from the hub, which records the host on the worktree.
 * Everything runs in temp dirs, never the real `~/.band`.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  cleanupTmpHome,
  createTmpHome,
  resetClientState,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { trpcQuery } from "./helpers/trpc";
import { parseWorkerCommand, startWorker, type WorkerHandle } from "./helpers/worker";
import { SettingsPage } from "./pages/SettingsPage";
import { WorkspacePage } from "./pages/WorkspacePage";

const TOKEN = "e2e-remote-host-token";
const PROJECT = "remote-proj";

let server: ServerHandle;
let tmpHome: string;
const workerDirs: string[] = [];
let worker: WorkerHandle | undefined;

const tmpDir = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  workerDirs.push(dir);
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
  writeFileSync(join(dir, "README.md"), "hello\n");
  execFileSync("git", ["add", "."], { cwd: dir, env });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir, env });
}

let hubRepo: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  hubRepo = join(tmpDir("band-e2e-hubrepo-"), PROJECT);
  makeRepo(hubRepo);
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  seedState(tmpHome, {
    projects: [
      {
        name: PROJECT,
        path: hubRepo,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: hubRepo }],
      },
    ],
  });
  server = await startServer({ tmpHome });
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await worker?.kill();
  await server.close();
  cleanupTmpHome(tmpHome);
  for (const dir of workerDirs) cleanupTmpHome(dir);
});

test("a worker turns its host row online and offline", async ({ page }) => {
  const settingsPage = new SettingsPage(page, server.url, TOKEN);
  await settingsPage.goto();
  await settingsPage.openDialog();
  await settingsPage.addWorker("e2e-box", "");

  const env = parseWorkerCommand(await settingsPage.readWorkerCommand());
  const hostId = env.BAND_WORKER_ID;
  expect(hostId).toMatch(/^h-[0-9a-f]+$/);
  const row = settingsPage.hostRow(hostId);
  await expect(row).toHaveAttribute("data-status", "offline");

  // The worker runs the command the screen printed, with its own temp dirs.
  const root = tmpDir("band-e2e-root-");
  makeRepo(join(root, PROJECT));
  worker = startWorker({
    env: {
      BAND_HUB_URL: env.BAND_HUB_URL,
      BAND_BOOTSTRAP_TOKEN: env.BAND_BOOTSTRAP_TOKEN,
      BAND_WORKER_ID: hostId,
    },
    root,
    stateDir: tmpDir("band-e2e-state-"),
    home: tmpDir("band-e2e-whome-"),
  });

  // The row follows the hub's status stream, with no reload.
  await expect(row).toHaveAttribute("data-status", "online", { timeout: 20_000 });

  await worker.kill();
  await expect(row).toHaveAttribute("data-status", "offline", { timeout: 20_000 });
});

test("creates a workspace on the worker from the New Workspace dialog", async ({ page }) => {
  const { hostId, root, handle } = await joinWorker();
  worker = handle;

  const workspacePage = new WorkspacePage(page, server.url, TOKEN);
  await workspacePage.goto(`${PROJECT}-main`);
  await workspacePage.waitForReady();
  await workspacePage.createWorkspaceOnHost({
    project: PROJECT,
    hostId,
    hostProjectPath: join(root, PROJECT),
    branch: "on-worker",
  });

  await expect
    .poll(
      async () => {
        const { projects } = await trpcQuery<{
          projects: Array<{ name: string; worktrees: Array<{ name: string; hostId?: string }> }>;
        }>(server.url, TOKEN, "projects.list");
        return projects
          .find((p) => p.name === PROJECT)
          ?.worktrees.find((w) => w.name === "on-worker")?.hostId;
      },
      { timeout: 20_000 },
    )
    .toBe(hostId);
});

test("the Hosts screen shows what the worker offers and removes it once offline", async ({
  page,
}) => {
  const { hostId, root, handle } = await joinWorker();
  worker = handle;

  const settingsPage = new SettingsPage(page, server.url, TOKEN);
  await settingsPage.goto();
  await settingsPage.openDialog();
  await expect(settingsPage.hostAgents(hostId)).toContainText("claude-code");
  await expect(settingsPage.hostRoots(hostId)).toContainText(root);

  // An online host cannot be removed.
  await expect(settingsPage.hostRemoveButton(hostId)).toBeDisabled();

  await worker.kill();
  await expect(settingsPage.hostRow(hostId)).toHaveAttribute("data-status", "offline", {
    timeout: 20_000,
  });
  await settingsPage.removeHost(hostId);
  await expect(settingsPage.hostRow(hostId)).toHaveCount(0);
});

test("the New Workspace dialog lists the worker's roots and explains a bad path", async ({
  page,
}) => {
  const { hostId, root, handle } = await joinWorker();
  worker = handle;

  const workspacePage = new WorkspacePage(page, server.url, TOKEN);
  await workspacePage.goto(`${PROJECT}-main`);
  await workspacePage.waitForReady();
  await workspacePage.fillNewWorkspaceOnHost({
    project: PROJECT,
    hostId,
    hostProjectPath: "~/not-here",
    branch: "bad-path",
  });
  await expect(workspacePage.newWorkspaceHostRoots).toContainText(root);

  // `~` is the worker's home, which is not under its root, so the error names the root.
  await workspacePage.submitNewWorkspace();
  await expect(workspacePage.newWorkspaceError).toContainText("not-here");
  await expect(workspacePage.newWorkspaceError).toContainText(root);

  // A relative path is refused with the instruction to use an absolute one.
  await workspacePage.newWorkspaceHostPathInput.fill("proj");
  await workspacePage.submitNewWorkspace();
  await expect(workspacePage.newWorkspaceError).toContainText("absolute path");
});

/** Issues a bootstrap token through the API and starts a worker with it. */
async function joinWorker() {
  const res = await fetch(`${server.url}/trpc/tokens.issueWorkerBootstrap`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `band_token=${TOKEN}` },
    body: JSON.stringify({ hostName: "e2e-dialog-box", labels: [] }),
  });
  expect(res.ok).toBe(true);
  const { result } = (await res.json()) as { result: { data: { token: string; hostId: string } } };
  const { token, hostId } = result.data;
  const root = tmpDir("band-e2e-root-");
  makeRepo(join(root, PROJECT));
  const handle = startWorker({
    env: { BAND_HUB_URL: server.url, BAND_BOOTSTRAP_TOKEN: token, BAND_WORKER_ID: hostId },
    root,
    stateDir: tmpDir("band-e2e-state-"),
    home: tmpDir("band-e2e-whome-"),
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
      { timeout: 20_000 },
    )
    .toBe("online");
  return { hostId, root, handle };
}
