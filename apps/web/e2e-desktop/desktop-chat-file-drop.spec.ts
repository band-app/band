/**
 * Dropping files from the file manager onto a chat pane in the desktop app.
 *
 * The REAL Electron app is launched against a throwaway HOME, with a real local hub (and, for
 * the remote case, a second real hub). The scripted ACP agent is the only stub.
 *
 * Test boundary: a real Finder drag cannot be automated. The drag events are dispatched on the
 * page, but the `File` objects come from a file input filled by Playwright, so they are backed
 * by files on disk and Electron's `webUtils.getPathForFile` returns their real paths. Dropping a
 * folder is not covered (an input cannot hold one); a folder is a `File` with no media type and
 * takes the same path branch as the `.ts` file here.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorktreeId } from "@/dashboard";
import { acpStubEnv, stubRequests } from "../e2e/helpers/acp-stub";
import {
  cleanupTmpHome,
  createTmpHome,
  getRandomPort,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "../e2e/helpers/server";
import { isPackagedRun, type LaunchedDesktop, launchDesktop } from "./helpers/desktop-app";
import { DesktopDashboardPage } from "./pages/DesktopDashboardPage";

const LOCAL_TOKEN = "desktop-drop-local-token";
const REMOTE_TOKEN = "desktop-drop-remote-token";
const LOCAL_WORKTREE = toWorktreeId("dropproj", "main", "local");
const REMOTE_WORKTREE = toWorktreeId("remotedrop", "main", "local");
const PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

async function seedHome(repoName: string, token: string): Promise<{ home: string; port: number }> {
  const home = createTmpHome();
  const repo = join(home, "repo");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "README.md"), "# fixture\n");
  seedState(home, {
    repos: [
      {
        name: repoName,
        path: repo,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: repo }],
      },
    ],
  });
  const port = await getRandomPort();
  seedSettings(home, {
    tokenSecret: token,
    webServerPort: port,
    codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
  });
  acpStubEnv(home, { turns: [{ steps: [{ say: "Got the files" }] }] });
  return { home, port };
}

let remote: ServerHandle;
let remoteHome: string;
let dropDir: string;
const homes: string[] = [];
let desktop: LaunchedDesktop | null = null;

test.beforeAll(async () => {
  remoteHome = (await seedHome("remotedrop", REMOTE_TOKEN)).home;
  remote = await startServer({ tmpHome: remoteHome, env: acpStubEnv(remoteHome) });
  dropDir = createTmpHome();
  writeFileSync(join(dropDir, "pixel.png"), PIXEL_PNG);
  writeFileSync(join(dropDir, "notes.md"), "# notes\n");
  writeFileSync(join(dropDir, "app.ts"), "export const x = 1;\n");
  writeFileSync(join(dropDir, "lib.ts"), "export const y = 2;\n");
});

test.afterAll(async () => {
  await remote?.close();
  cleanupTmpHome(remoteHome);
  cleanupTmpHome(dropDir);
  for (const home of homes) cleanupTmpHome(home);
});

test.afterEach(async () => {
  await desktop?.close();
  desktop = null;
});

async function launchLocal(): Promise<{ dashboard: DesktopDashboardPage; home: string }> {
  const hub = await seedHome("dropproj", LOCAL_TOKEN);
  homes.push(hub.home);
  desktop = await launchDesktop({
    answeredWorkerPrompt: [remote.url],
    home: hub.home,
    hubPort: hub.port,
    env: acpStubEnv(hub.home, { turns: [{ steps: [{ say: "Got the files" }] }] }),
  });
  const dashboard = new DesktopDashboardPage(desktop.window);
  await dashboard.expectRepoListed("dropproj");
  await dashboard.openWorktree(LOCAL_WORKTREE);
  await dashboard.chat.waitForReady();
  return { dashboard, home: hub.home };
}

test("S1: a PNG and a .md dropped on the message list attach and reach the agent", async () => {
  const { dashboard, home } = await launchLocal();
  const chat = dashboard.chat;

  await chat.startDrag({ files: [join(dropDir, "pixel.png"), join(dropDir, "notes.md")] });
  await chat.dragEvent("dragover", "messages");
  await expect(chat.dropOverlay).toBeVisible();
  await chat.dropOnChat("messages");
  await expect(chat.dropOverlay).toHaveCount(0);
  await expect(chat.attachments).toHaveCount(2);
  expect(await chat.promptValue()).toBe("");

  // A packaged app has no scripted agent, so the send step runs unpackaged only.
  if (!isPackagedRun()) {
    await chat.typeMessage("look at these");
    await chat.submit();
    await expect(chat.assistantMessage("Got the files")).toBeVisible({ timeout: 30_000 });
    const [sent] = stubRequests(home, "session/prompt");
    const blocks = sent.params.prompt as { type: string }[];
    expect(blocks.some((b) => b.type === "image")).toBe(true);
    expect(JSON.stringify(blocks)).toContain("notes");
  }
});

test("S2: .ts files insert their absolute paths, one per line, and nothing is attached", async () => {
  const { dashboard } = await launchLocal();
  const chat = dashboard.chat;

  await chat.typeMessage("see");
  await chat.startDrag({ files: [join(dropDir, "app.ts"), join(dropDir, "lib.ts")] });
  await chat.dropOnChat("messages");
  await expect.poll(() => chat.promptValue()).toContain(join(dropDir, "app.ts"));
  const value = await chat.promptValue();
  expect(value.split("\n")).toEqual(["see", join(dropDir, "app.ts"), join(dropDir, "lib.ts")]);
  await expect(chat.attachments).toHaveCount(0);
  await expect(chat.composerNotice).toHaveCount(0);
});

test("S3: with the worktree on a hub elsewhere, a .ts file is refused with a notice and a PNG still attaches", async () => {
  const hub = await seedHome("unused", LOCAL_TOKEN);
  homes.push(hub.home);
  mkdirSync(join(hub.home, ".band"), { recursive: true });
  writeFileSync(
    join(hub.home, ".band", "desktop-hub.json"),
    JSON.stringify({ mode: "remote", url: remote.url, token: REMOTE_TOKEN }),
  );
  desktop = await launchDesktop({
    answeredWorkerPrompt: [remote.url],
    home: hub.home,
    hubPort: hub.port,
  });
  const dashboard = new DesktopDashboardPage(desktop.window);
  await dashboard.expectRepoListed("remotedrop");
  await dashboard.openWorktree(REMOTE_WORKTREE);
  await dashboard.chat.waitForReady();
  const chat = dashboard.chat;

  await chat.startDrag({ files: [join(dropDir, "app.ts"), join(dropDir, "pixel.png")] });
  await chat.dropOnChat("messages");
  await expect(chat.composerNotice).toContainText("this worktree is on");
  await expect(chat.composerNotice).toContainText("on this machine");
  expect(await chat.promptValue()).toBe("");
  await expect(chat.attachments).toHaveCount(1);
  await expect(chat.attachments.first()).toHaveAttribute("data-file-name", "pixel.png");
});

test("S6: a file dropped outside the chat never navigates the window", async () => {
  const { dashboard } = await launchLocal();
  const chat = dashboard.chat;
  const before = dashboard.url();

  await chat.startDrag({ files: [join(dropDir, "pixel.png")] });
  expect(await chat.dropOutsideChat()).toBe(true);
  await expect(chat.dropOverlay).toHaveCount(0);
  expect(dashboard.url()).toBe(before);
  await chat.waitForReady();
});
