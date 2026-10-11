/**
 * Dialogs fit a phone screen. On 375, 390 and 430 px wide viewports these dialogs must not
 * overflow horizontally: Add repo (worker folder picker with a long folder name, and By URL with
 * a long remote URL), New worktree, Settings (several pages), the add-worker result, Add device
 * (QR and sign-in link), the desktop viewer in fit mode, and the delete-worktree and
 * restart-terminal-service confirmations. For each: the document is no wider than the
 * window, the dialog has no horizontal scroll of its own, and no child sticks out of the dialog
 * box. The primary button stays inside the window. Real hub and worker, never the real `~/.band`.
 * Screenshots at 390 px land in the Playwright output directory.
 */

import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { toWorktreeId } from "@band-app/shared/worktree-id";
import { expect, type TestInfo, test } from "@playwright/test";
import { type RfbStub, startRfbStub } from "./fixtures/rfb-stub";
import { gitInHome as git } from "./helpers/git";
import {
  cleanupTmpHome,
  createTmpHome,
  resetClientState,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { trpcMutate } from "./helpers/trpc";
import { parseWorkerCommand, startWorker, type WorkerHandle } from "./helpers/worker";
import { AddRepoPage, measureDialogOverflow } from "./pages/AddRepoPage";
import { DesktopViewerPage } from "./pages/DesktopViewerPage";
import { SettingsPage } from "./pages/SettingsPage";
import { WorktreePage } from "./pages/WorktreePage";

const TOKEN = "e2e-dialogs-mobile-overflow-token";
const LONG_FOLDER = "a-folder-with-a-very-long-name-that-cannot-fit-on-a-phone-screen-at-all";
const LONG_URL = `https://example.com/an-organisation-with-a-long-name/${LONG_FOLDER}.git`;
const WIDTHS = [375, 390, 430];
const REPO = "overflow-proj";
const FEATURE = "feature-with-a-quite-long-branch-name-to-delete";
const SETTINGS_PAGES = [
  "general",
  "repos",
  "hosts",
  "devices",
  "credentials",
  "mcp",
  "runners",
] as const;

let server: ServerHandle;
let tmpHome: string;
let stub: RfbStub;
let worker: WorkerHandle | undefined;
let hostId = "";
const dirs: string[] = [];

const tmpDir = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
};

test.beforeAll(async ({ browser }) => {
  stub = await startRfbStub();
  tmpHome = createTmpHome();
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  // A hub repo with a second worktree, so the sidebar can offer New worktree and Delete.
  const hubRepo = join(tmpDir("band-e2e-dialogs-mobile-hub-"), REPO);
  mkdirSync(hubRepo, { recursive: true });
  git(hubRepo, ["init", "-b", "main"], tmpHome);
  writeFileSync(join(hubRepo, "README.md"), "# proj\n");
  git(hubRepo, ["add", "."], tmpHome);
  git(hubRepo, ["commit", "-m", "seed"], tmpHome);
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

  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const settingsPage = new SettingsPage(page, server.url, TOKEN);
  await settingsPage.goto();
  await settingsPage.openDialog("hosts");
  await settingsPage.addWorker("mobile-overflow-worker-with-a-long-name", "");
  const env = parseWorkerCommand(await settingsPage.readWorkerCommand());
  hostId = env.BAND_WORKER_ID;

  const workerHome = tmpDir("band-e2e-dialogs-mobile-home-");
  const folder = join(workerHome, LONG_FOLDER);
  mkdirSync(folder, { recursive: true });
  git(folder, ["init", "-b", "main"], workerHome);
  writeFileSync(join(folder, "README.md"), "# long\n");
  git(folder, ["add", "."], workerHome);
  git(folder, ["commit", "-m", "seed"], workerHome);
  // The desktop capability needs a DISPLAY and an executable named x11vnc on the PATH.
  const bin = tmpDir("band-e2e-dialogs-mobile-bin-");
  writeFileSync(join(bin, "x11vnc"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "x11vnc"), 0o755);
  worker = startWorker({
    env: {
      BAND_HUB_URL: env.BAND_HUB_URL,
      BAND_BOOTSTRAP_TOKEN: env.BAND_BOOTSTRAP_TOKEN,
      BAND_WORKER_ID: hostId,
      DISPLAY: ":99",
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      BAND_DESKTOP_VNC_PORT: String(stub.port),
    },
    root: tmpDir("band-e2e-dialogs-mobile-root-"),
    stateDir: tmpDir("band-e2e-dialogs-mobile-state-"),
    home: workerHome,
  });
  await expect(settingsPage.hostRow(hostId)).toHaveAttribute("data-status", "online", {
    timeout: 20_000,
  });
  await context.close();
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await worker?.kill();
  await stub?.close();
  await server.close();
  cleanupTmpHome(tmpHome);
  for (const dir of dirs) cleanupTmpHome(dir);
});

for (const width of WIDTHS) {
  test.describe(`at ${width}px`, () => {
    test.use({ viewport: { width, height: 844 } });

    test("Add repo from a worker fits the screen", async ({ page }, testInfo) => {
      await new SettingsPage(page, server.url, TOKEN).goto();
      const addRepo = new AddRepoPage(page);
      await addRepo.open();
      await addRepo.chooseWorker(hostId);
      await expect(addRepo.pickerEntry(LONG_FOLDER)).toBeVisible();
      await expectFits(await addRepo.overflow());
      await addRepo.openFolder(LONG_FOLDER);
      await expectFits(await addRepo.overflow());
      await expect(addRepo.pickerSelectButton()).toBeInViewport({ ratio: 1 });
      if (width === 390) await addRepo.screenshot(shotPath(testInfo, "add-repo-worker.png"));
      await addRepo.useCurrentFolder();
      await expect(addRepo.rootConfirmation()).toBeVisible();
      await expectFits(await addRepo.overflow());
      await expect(addRepo.confirmRootButton()).toBeInViewport({ ratio: 1 });
    });

    test("Add repo by URL fits the screen", async ({ page }, testInfo) => {
      await new SettingsPage(page, server.url, TOKEN).goto();
      const addRepo = new AddRepoPage(page);
      await addRepo.open();
      await addRepo.chooseUrl();
      await addRepo.fillUrl(LONG_URL);
      await expectFits(await addRepo.overflow());
      await expect(addRepo.urlSubmitButton()).toBeInViewport({ ratio: 1 });
      if (width === 390) await addRepo.screenshot(shotPath(testInfo, "add-repo-url.png"));
    });

    test("New worktree fits the screen", async ({ page }) => {
      await new SettingsPage(page, server.url, TOKEN).goto();
      const worktreePage = new WorktreePage(page, server.url, TOKEN);
      await worktreePage.openNewWorktreeDialog(REPO);
      await expectFits(await measureDialogOverflow(worktreePage.newWorktreeDialog));
    });

    test("Delete worktree confirmation fits the screen", async ({ page }) => {
      // A clean worktree is deleted at once, so give this one an uncommitted file. The hub
      // reads its status before the page loads.
      const branch = `${FEATURE}-${width}`;
      const created = await createWorktree(branch);
      writeFileSync(join(created.path, "uncommitted.txt"), "not committed\n");
      const worktreeId = toWorktreeId(REPO, branch, "local");
      await trpcMutate(server.url, TOKEN, "statuses.refreshBranchStatus", { worktreeId });
      await new SettingsPage(page, server.url, TOKEN).goto();
      const worktreePage = new WorktreePage(page, server.url, TOKEN);
      await worktreePage.deleteWorktreeFromSidebar(worktreeId);
      const dialog = page.getByRole("dialog", { name: "Delete worktree" });
      await expect(dialog).toBeVisible();
      await expectFits(await measureDialogOverflow(dialog));
      await expect(dialog.getByRole("button", { name: "Delete" })).toBeInViewport({ ratio: 1 });
    });

    test("Restart terminal service confirmation fits the screen", async ({ page }) => {
      const settingsPage = new SettingsPage(page, server.url, TOKEN);
      await settingsPage.goto();
      await settingsPage.openDialog("terminal");
      await settingsPage.restartTerminalServiceButton().click();
      const dialog = settingsPage.restartTerminalServiceDialog();
      await expect(dialog).toBeVisible();
      await expectFits(await measureDialogOverflow(dialog));
    });

    test("Settings pages fit the screen", async ({ page }) => {
      const settingsPage = new SettingsPage(page, server.url, TOKEN);
      await settingsPage.goto();
      await settingsPage.openDialog();
      for (const section of SETTINGS_PAGES) {
        await settingsPage.openSection(section);
        await expectFits(await measureDialogOverflow(settingsPage.dialog));
      }
    });

    test("Desktop viewer in fit mode fits the screen", async ({ page }) => {
      const settingsPage = new SettingsPage(page, server.url, TOKEN);
      await settingsPage.goto();
      await settingsPage.openDialog("hosts");
      const viewer = new DesktopViewerPage(page);
      await viewer.hostRowButton(hostId).click();
      await expect(viewer.dialog).toBeVisible();
      await viewer.expectFramebuffer();
      await expect(viewer.fitButton).toBeChecked();
      await expectFits(await measureDialogOverflow(viewer.dialog));
    });

    test("Settings Hosts with a new worker token fits the screen", async ({ page }) => {
      const settingsPage = new SettingsPage(page, server.url, TOKEN);
      await settingsPage.goto();
      await settingsPage.openDialog("hosts");
      await settingsPage.addWorker(`phone-worker-${width}-with-a-long-host-name`, "");
      await expect(settingsPage.workerCommand()).toBeVisible();
      await expectFits(await measureDialogOverflow(settingsPage.dialog));
    });

    test("Add device fits the screen", async ({ page }) => {
      const settingsPage = new SettingsPage(page, server.url, TOKEN);
      await settingsPage.goto();
      await settingsPage.openDialog("devices");
      await settingsPage.addDevice("a-phone-with-a-rather-long-device-label");
      await expect(settingsPage.deviceResult()).toBeVisible();
      const dialog = page.getByTestId("settings__add-device-dialog");
      await expectFits(await measureDialogOverflow(dialog));
    });
  });
}

/** Where a screenshot goes: `E2E_SHOTS_DIR` when set (for the handover), else the test output. */
function shotPath(testInfo: TestInfo, name: string): string {
  return process.env.E2E_SHOTS_DIR
    ? join(process.env.E2E_SHOTS_DIR, name)
    : testInfo.outputPath(name);
}

/** Creates a worktree on the hub's own host and returns where it is on disk. */
async function createWorktree(branch: string): Promise<{ path: string }> {
  const res = await fetch(`${server.url}/trpc/worktrees.create`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `band_token=${TOKEN}` },
    body: JSON.stringify({ repo: REPO, branch }),
  });
  if (!res.ok) throw new Error(`worktrees.create failed: ${res.status}`);
  return ((await res.json()) as { result: { data: { path: string } } }).result.data;
}

function expectFits(o: Awaited<ReturnType<AddRepoPage["overflow"]>>): void {
  expect(o.documentScrollWidth).toBeLessThanOrEqual(o.innerWidth);
  expect(o.dialogScrollWidth).toBeLessThanOrEqual(o.dialogClientWidth);
  expect(o.escaping).toEqual([]);
}
