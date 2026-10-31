/**
 * End-to-end coverage for the local direct path: the desktop app
 * talks to this Mac's own worker on 127.0.0.1 for a worktree that lives there, and falls back to
 * the hub when the worker goes away.
 *
 * Architecture, as in `desktop-this-computer-worker.spec.ts`:
 *
 *   - The REAL Electron app is launched against a throwaway HOME, with a real second hub as its
 *     remote hub. "Add this computer" installs the real bundled worker as the Mac's service.
 *   - The only fake is `launchctl` (`fixtures/fake-launchctl.mjs`), which starts and restarts
 *     that worker from its plist. The repo's remote is a local bare repository.
 *   - No tRPC mocking and no `page.route()`. The spec watches which sockets and requests the
 *     window opens, the way DevTools shows them.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toWorktreeId } from "@band-app/shared/worktree-id";
import { expect, test } from "@playwright/test";
import { ACP_STUB_AGENT_PATH } from "../e2e/helpers/acp-stub";
import {
  cleanupTmpHome,
  createTmpHome,
  getRandomPort,
  type ServerHandle,
  seedSettings,
  startServer,
} from "../e2e/helpers/server";
import { ChatPanePage } from "../e2e/pages/ChatPanePage";
import { FileTreesPage } from "../e2e/pages/FileTreesPage";
import { FileViewerPage } from "../e2e/pages/FileViewerPage";
import { WorktreePage } from "../e2e/pages/WorktreePage";
import { isPackagedRun, type LaunchedDesktop, launchDesktop } from "./helpers/desktop-app";
import { DesktopDashboardPage } from "./pages/DesktopDashboardPage";
import { ThisComputerPage } from "./pages/ThisComputerPage";

const REMOTE_TOKEN = "desktop-direct-e2e-remote-token";
const FAKE_LAUNCHCTL = join(import.meta.dirname, "fixtures", "fake-launchctl.mjs");
const LABEL = "app.band.worker";

let remote: ServerHandle;
let remoteHome: string;
let home: string;
let desktop: LaunchedDesktop | null = null;

async function hubCall<T>(path: string, input: unknown): Promise<T> {
  const res = await fetch(`${remote.url}/trpc/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${REMOTE_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await res.json()) as { result?: { data: T }; error?: { message: string } };
  if (!body.result) throw new Error(body.error?.message ?? `hub answered ${res.status}`);
  return body.result.data;
}

async function hostStatus(id: string): Promise<string | undefined> {
  const res = await fetch(`${remote.url}/trpc/hosts.list`, {
    headers: { Authorization: `Bearer ${REMOTE_TOKEN}` },
  });
  const body = (await res.json()) as {
    result: { data: { hosts: { id: string; status: string }[] } };
  };
  return body.result.data.hosts.find((h) => h.id === id)?.status;
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
}

/** A bare repository with one commit on `main`, to clone from. */
function seedRemoteRepo(parent: string): string {
  const work = join(parent, "proj");
  const origin = join(parent, "proj.git");
  mkdirSync(work, { recursive: true });
  git(work, ["init", "-q", "-b", "main"]);
  writeFileSync(join(work, "README.md"), "# proj\n");
  mkdirSync(join(work, "src"));
  writeFileSync(join(work, "src", "app.ts"), "export const answer = 42;\n");
  git(work, ["add", "."]);
  git(work, ["commit", "-q", "-m", "seed"]);
  git(parent, ["init", "-q", "--bare", "-b", "main", origin]);
  git(work, ["push", "-q", origin, "main"]);
  return origin;
}

/**
 * The fake launchd starts the worker with its own `HOME`, so it must be the app's temp HOME:
 * with the real one the worker would read and write the real `~/.band/worker`.
 */
function launchctl(...args: string[]): void {
  spawnSync(FAKE_LAUNCHCTL, args, {
    env: {
      ...process.env,
      HOME: home,
      BAND_FAKE_LAUNCHD_DIR: join(home, "fake-launchd"),
      // A worker this restarts runs owned chats with the scripted agent, as the first one did.
      BAND_TEST_ACP_AGENT: ACP_STUB_AGENT_PATH,
    },
  });
}

function workerId(): string {
  const plist = readFileSync(join(home, "Library", "LaunchAgents", `${LABEL}.plist`), "utf8");
  const id = /<key>BAND_WORKER_ID<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1];
  if (!id) throw new Error("the installed service has no worker id");
  return id;
}

/** The worker keeps shells in a terminal daemon that outlives it. Stop it with the test. */
function stopTerminalDaemons(): void {
  const runDir = join(home, ".band", "worker", "run");
  let names: string[] = [];
  try {
    names = readdirSync(runDir).filter((n) => /^terminal-daemon-v\d+.*\.pid$/.test(n));
  } catch {
    return;
  }
  for (const name of names) {
    try {
      // The pid file is JSON, as `stopTerminalDaemons` in `apps/worker/src/terminals.ts` reads it.
      const { pid } = JSON.parse(readFileSync(join(runDir, name), "utf8")) as { pid: number };
      process.kill(pid, "SIGTERM");
    } catch {
      // No record, or already gone.
    }
  }
}

const portOf = (url: string) => new URL(url).port;

test.beforeAll(async () => {
  remoteHome = createTmpHome();
  seedSettings(remoteHome, {
    tokenSecret: REMOTE_TOKEN,
    webServerPort: await getRandomPort(),
    enableLSP: true,
  });
  remote = await startServer({ tmpHome: remoteHome });
});

test.afterAll(async () => {
  await desktop?.close();
  launchctl("bootout", `gui/0/${LABEL}`);
  stopTerminalDaemons();
  await remote?.close();
  cleanupTmpHome(remoteHome);
  if (home) cleanupTmpHome(home);
});

test("S1, S2, S4: a terminal and files on this Mac's worker go to 127.0.0.1, and to the hub while the worker restarts", async () => {
  // Installing the worker, a restart that waits for the old process, and the retry pause.
  test.setTimeout(300_000);
  home = createTmpHome();
  const localPort = await getRandomPort();
  seedSettings(home, { tokenSecret: "desktop-direct-e2e-local-token", webServerPort: localPort });
  writeFileSync(
    join(home, ".band", "desktop-hub.json"),
    JSON.stringify({ mode: "remote", url: remote.url, token: REMOTE_TOKEN }),
  );
  mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
  desktop = await launchDesktop({
    home,
    hubPort: localPort,
    env: {
      BAND_LAUNCHCTL_BIN: FAKE_LAUNCHCTL,
      BAND_FAKE_LAUNCHD_DIR: join(home, "fake-launchd"),
      // The worker owns its chats and starts their agent: the scripted one, not a real Claude.
      BAND_TEST_ACP_AGENT: ACP_STUB_AGENT_PATH,
    },
  });
  // The tab strip below needs room: docked DevTools leave the page too narrow on the CI Mac.
  await desktop.closeDevTools();

  // Make this Mac a worker of the remote hub, and put a worktree on it.
  const thisComputer = new ThisComputerPage(desktop.window);
  await expect(thisComputer.prompt).toBeVisible({ timeout: 30_000 });
  await thisComputer.promptNotNow.click();
  await thisComputer.openHostsSettings();
  await thisComputer.add.click();
  await expect(thisComputer.state).toHaveAttribute("data-status", "online", { timeout: 90_000 });
  const hostId = workerId();
  await hubCall("repos.addByUrl", {
    remoteUrl: seedRemoteRepo(join(home, "remotes")),
    name: "proj",
    defaultBranch: "main",
  });
  await hubCall("worktrees.create", { repo: "proj", branch: "direct-e2e", hostId });
  const worktreeId = toWorktreeId("proj", "direct-e2e", hostId);
  // A second file, written through the hub, for the file read after the restart.
  await hubCall("worktree.createFile", {
    worktreeId,
    path: "notes.txt",
    content: "after restart\n",
  });
  // Reload so the window asks the app for its worker id again, now that one is installed.
  const dashboard = new DesktopDashboardPage(desktop.window);
  await dashboard.reload();

  const sockets = dashboard.watchSockets();
  const requests = dashboard.watchRequests();
  const hubPort = portOf(remote.url);
  const terminalSockets = () => sockets.filter((u) => new URL(u).pathname === "/terminal");
  const directSockets = () => terminalSockets().filter((u) => portOf(u) !== hubPort);
  const hubSockets = () => terminalSockets().filter((u) => portOf(u) === hubPort);

  const worktreePage = new WorktreePage(desktop.window, "app://placeholder", "");
  const terminal = await dashboard.openNewTerminalTab(worktreeId);
  /** Make the terminal the shown tab, and wait until its input is on screen. */
  const showTerminal = () =>
    expect(async () => {
      if (!(await terminal.input.isVisible()))
        await worktreePage.activateTabInNarrowWindow("terminal");
      await expect(terminal.input).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
  await expect(async () => {
    await terminal.typeLine("echo direct-$((40+2))");
    expect(await terminal.readScreenText()).toContain("direct-42");
  }).toPass({ timeout: 30_000 });

  // S1: the terminal socket went to the worker on loopback, not to the hub.
  expect(directSockets().length).toBeGreaterThan(0);
  expect(directSockets()[0]).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/terminal\?/);
  expect(hubSockets()).toEqual([]);
  // S2: the file tree and a file read go there too, and not to the hub.
  const files = new FileTreesPage(desktop.window, worktreePage);
  const viewer = new FileViewerPage(desktop.window);
  await files.openFilesTab("README.md");
  await files.openFile("README.md");
  await expect.poll(() => viewer.readText(), { timeout: 15_000 }).toContain("proj");
  const directCalls = () =>
    requests.filter((u) => /^http:\/\/127\.0\.0\.1:\d+\/direct\/worktree\./.test(u));
  // A hub call names its procedures in the path, several at once when batched.
  const hubCalls = (procedure: string) =>
    requests.filter(
      (u) =>
        portOf(u) === hubPort &&
        new RegExp(`/trpc/(?:[^?]*,)?${procedure.replace(".", "\\.")}(?:[,?]|$)`).test(u),
    );
  for (const procedure of ["worktree.listFiles", "worktree.getFile"]) {
    expect(
      directCalls().some((u) => u.endsWith(`/direct/${procedure}`)),
      procedure,
    ).toBe(true);
    expect(hubCalls(procedure), procedure).toEqual([]);
  }
  // File changes come from the worker's /watch socket, and the hub holds no watch subscription for it.
  const socketsAt = (pathname: string) => sockets.filter((u) => new URL(u).pathname === pathname);
  expect(socketsAt("/watch").length).toBeGreaterThan(0);
  expect(socketsAt("/watch").every((u) => /^ws:\/\/127\.0\.0\.1:\d+\//.test(u))).toBe(true);
  // A TypeScript file asks for a language server, and the socket goes to the worker too. The
  // bundled worker ships no language server, so this checks where the editor connects, and the
  // answers of a real one are in apps/hub/tests/direct-path.test.ts.
  await files.expandFileTreeFolder("src", "src/app.ts");
  await files.openFile("src/app.ts");
  await expect.poll(() => socketsAt("/lsp").length, { timeout: 30_000 }).toBeGreaterThan(0);
  expect(socketsAt("/lsp").every((u) => /^ws:\/\/127\.0\.0\.1:\d+\//.test(u))).toBe(true);
  // Changes go there as well.
  await files.openChangesTab("notes.txt");
  expect(directCalls().some((u) => u.endsWith("/direct/worktree.getChanges"))).toBe(true);
  expect(hubCalls("worktree.getChanges")).toEqual([]);
  await worktreePage.selectRightPanelTab("explorer");
  expect(directCalls().every((u) => portOf(u) === portOf(directSockets()[0] as string))).toBe(true);

  // Back to the terminal for the restart. The file tab is closed first: the shared tab list may
  // make an open file tab the active one again while the worker is away.
  // Opening a second file replaced the README preview tab.
  await worktreePage.closeFileTab("src/app.ts");
  await showTerminal();

  // S4: the worker restarts. The terminal reconnects through the hub with its screen, by itself.
  launchctl("kickstart", "-k", `gui/0/${LABEL}`);
  await expect.poll(() => hubSockets().length, { timeout: 30_000 }).toBeGreaterThan(0);
  await expect.poll(() => hostStatus(hostId), { timeout: 60_000 }).toBe("online");
  await showTerminal();
  await expect(async () => {
    await terminal.typeLine("echo after-$((3+4))");
    expect(await terminal.readScreenText()).toContain("after-7");
  }).toPass({ timeout: 60_000 });

  // S4: a file opened after the restart reads without an error. It goes through the hub while
  // the direct path rests (15 s after the failure) and to the new listener after that, so which
  // one answers depends on how long the restart took. The terminal above already fell back.
  await files.openFilesTab("notes.txt");
  await files.openFile("notes.txt");
  await expect.poll(() => viewer.readText(), { timeout: 30_000 }).toContain("after restart");
  await expect(viewer.errorBanner).toHaveCount(0);
  await worktreePage.closeFileTab("notes.txt");

  // The watch and language server sockets fall back the same way. The watch socket dropped with
  // the worker, so the explorer must still see a file created now (through the hub watch while the
  // direct path rests, or the new listener after), and the editor must still get a language server
  // socket, to whichever side answers.
  await hubCall("worktree.createFile", {
    worktreeId,
    path: "after-restart.txt",
    content: "created after the restart\n",
  });
  await worktreePage.selectRightPanelTab("explorer");
  await expect(files.fileTreeRow("after-restart.txt")).toBeVisible({ timeout: 60_000 });
  const lspBefore = socketsAt("/lsp").length;
  await files.openFile("src/app.ts");
  await expect.poll(() => socketsAt("/lsp").length, { timeout: 30_000 }).toBeGreaterThan(lspBefore);
  await worktreePage.closeFileTab("src/app.ts");

  // After the 15 s rest, a new editor connects to the worker again.
  const directLspBefore = () => socketsAt("/lsp").filter((u) => portOf(u) !== hubPort).length;
  const lspDirectBefore = directLspBefore();
  await expect(async () => {
    await files.openFile("src/app.ts");
    try {
      await expect.poll(directLspBefore, { timeout: 4_000 }).toBeGreaterThan(lspDirectBefore);
    } finally {
      // Closed on every attempt, so the next one opens a new language server socket.
      await worktreePage.closeFileTab("src/app.ts");
    }
  }).toPass({ timeout: 90_000, intervals: [5_000] });
  await showTerminal();

  // Once the listener is back and the UI's retry pause is over, a new tab in the same page
  // (no reload, which would forget the pause) connects to the worker again.
  const directBefore = directSockets().length;
  await expect(async () => {
    await worktreePage.pressNewTerminalShortcut();
    await expect
      .poll(() => directSockets().length, { timeout: 5_000 })
      .toBeGreaterThan(directBefore);
  }).toPass({ timeout: 60_000, intervals: [5_000] });

  // Chat ownership S1: this Mac's worker runs the chat, and the message and its event stream go
  // to the worker's port, not the hub's. A packaged run has no stub agent.
  // Last, because the chat tab stays the shown tab, and once the direct path is back from the
  // restart above.
  if (!isPackagedRun()) {
    const chatId = "direct-e2e-chat";
    await hubCall("chats.create", { worktreeId, id: chatId, name: "Chat" });
    const chat = new ChatPanePage(desktop.window, "app://placeholder", "");
    await expect(async () => {
      await worktreePage.activateTabInNarrowWindow("chat");
      await chat.chatTab(chatId).click();
      await expect(chat.promptInput).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
    await chat.typeMessage("hello on this Mac");
    await chat.submit();
    await expect(chat.assistantMessage("hello on this Mac")).toBeVisible({ timeout: 60_000 });
    const chatCalls = (route: string) =>
      requests.filter((u) => new URL(u).pathname === `/api/chats/${chatId}/${route}`);
    for (const route of ["messages", "events"]) {
      expect(
        chatCalls(route).some((u) => /^http:\/\/127\.0\.0\.1:\d+\//.test(u)),
        route,
      ).toBe(true);
      expect(
        chatCalls(route).filter((u) => portOf(u) === hubPort),
        route,
      ).toEqual([]);
    }
  }
});
