/**
 * End-to-end coverage for extension editors on the local direct path: in the desktop app, a
 * fixture extension's editor (`apps/web/e2e/fixtures/extensions/text-editor`, `*.band-test`) reads
 * and saves its file on this Mac's worker over 127.0.0.1, and the remote hub sees neither the
 * `GET` nor the `PUT` of the file.
 *
 * Setup as in `desktop-direct-path.spec.ts`: the real Electron app against a throwaway HOME and a
 * real second hub, this Mac installed as a worker through the fake `launchctl`. The spec watches
 * the requests the window makes, the way DevTools shows them. No tRPC mocking, no `page.route()`.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
import { ExtensionEditorPage } from "../e2e/pages/ExtensionEditorPage";
import { FileTreesPage } from "../e2e/pages/FileTreesPage";
import { WorktreePage } from "../e2e/pages/WorktreePage";
import { type LaunchedDesktop, launchDesktop } from "./helpers/desktop-app";
import { DesktopDashboardPage } from "./pages/DesktopDashboardPage";
import { ThisComputerPage } from "./pages/ThisComputerPage";

const REMOTE_TOKEN = "desktop-direct-ext-e2e-remote-token";
const FAKE_LAUNCHCTL = join(import.meta.dirname, "fixtures", "fake-launchctl.mjs");
const EXTENSION_FIXTURE = join(
  import.meta.dirname,
  "..",
  "e2e",
  "fixtures",
  "extensions",
  "text-editor",
);
const LABEL = "app.band.worker";
const NOTE = "note.band-test";
const SECOND = "second.band-test";

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

const fileUrl = (base: string, worktreeId: string, path: string) =>
  `${base}/api/worktree-file/${encodeURIComponent(worktreeId)}/${path}`;

/** A file's bytes read through the remote hub, which reads this Mac's worker. */
async function hubRead(worktreeId: string, path: string): Promise<Buffer> {
  const res = await fetch(fileUrl(remote.url, worktreeId, path), {
    headers: { Authorization: `Bearer ${REMOTE_TOKEN}` },
  });
  if (!res.ok) throw new Error(`hub read of ${path} answered ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
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

function seedRemoteRepo(parent: string): string {
  const work = join(parent, "proj");
  const origin = join(parent, "proj.git");
  mkdirSync(work, { recursive: true });
  git(work, ["init", "-q", "-b", "main"]);
  writeFileSync(join(work, "README.md"), "# proj\n");
  git(work, ["add", "."]);
  git(work, ["commit", "-q", "-m", "seed"]);
  git(parent, ["init", "-q", "--bare", "-b", "main", origin]);
  git(work, ["push", "-q", origin, "main"]);
  return origin;
}

/** The fake launchd starts the worker with the app's temp HOME, never the real one. */
function launchctl(...args: string[]): void {
  spawnSync(FAKE_LAUNCHCTL, args, {
    env: {
      ...process.env,
      HOME: home,
      BAND_FAKE_LAUNCHD_DIR: join(home, "fake-launchd"),
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

const portOf = (url: string) => new URL(url).port;

test.beforeAll(async () => {
  remoteHome = createTmpHome();
  seedSettings(remoteHome, {
    tokenSecret: REMOTE_TOKEN,
    webServerPort: await getRandomPort(),
  });
  // The hub reads its extensions folder at first use, so the fixture goes in before it starts.
  cpSync(EXTENSION_FIXTURE, join(remoteHome, ".band", "extensions", "text-editor"), {
    recursive: true,
  });
  remote = await startServer({ tmpHome: remoteHome });
});

test.afterAll(async () => {
  await desktop?.close();
  if (home) launchctl("bootout", `gui/0/${LABEL}`);
  await remote?.close();
  cleanupTmpHome(remoteHome);
  if (home) cleanupTmpHome(home);
});

test("S1, S2, S4, S5, S6: an extension editor reads and saves on this Mac's worker, and the hub sees no file bytes", async () => {
  test.setTimeout(300_000);
  home = createTmpHome();
  const localPort = await getRandomPort();
  seedSettings(home, {
    tokenSecret: "desktop-direct-ext-e2e-local-token",
    webServerPort: localPort,
  });
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
      BAND_TEST_ACP_AGENT: ACP_STUB_AGENT_PATH,
    },
  });
  await desktop.closeDevTools();

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
  await hubCall("worktrees.create", { repo: "proj", branch: "direct-ext", hostId });
  const worktreeId = toWorktreeId("proj", "direct-ext", hostId);
  for (const [path, content] of [
    [NOTE, "hello from the worker\n"],
    [SECOND, "second file\n"],
  ]) {
    await hubCall("worktree.createFile", { worktreeId, path, content });
  }
  const dashboard = new DesktopDashboardPage(desktop.window);
  await dashboard.reload();

  const log = dashboard.watchRequestLog();
  const hubPort = portOf(remote.url);
  const fileRoute = (u: string) => new URL(u).pathname.startsWith("/api/worktree-file/");
  const hubFileRequests = (method: string) =>
    log.filter((r) => r.method === method && portOf(r.url) === hubPort && fileRoute(r.url));
  const directFileRequests = (method: string) =>
    log.filter(
      (r) => r.method === method && /^http:\/\/127\.0\.0\.1:\d+\//.test(r.url) && fileRoute(r.url),
    );

  const worktreePage = new WorktreePage(desktop.window, "app://placeholder", "");
  const trees = new FileTreesPage(desktop.window, worktreePage);
  const editor = new ExtensionEditorPage(desktop.window, worktreePage, trees);
  // Opens the worktree (a deep link on the first call) and shows the file in the Explorer.
  await dashboard.openWorktree(worktreeId);
  await trees.openFilesTab(NOTE);
  await trees.waitForFileTreeRow(NOTE);

  // S1: the editor's bytes come from the worker over loopback.
  await editor.open(NOTE);
  await expect(editor.textarea(NOTE)).toHaveValue("hello from the worker\n");
  expect(directFileRequests("GET").length).toBeGreaterThan(0);
  expect(hubFileRequests("GET")).toEqual([]);

  // S2: the save is written by the worker, and the hub gets no PUT.
  await editor.replaceText(NOTE, "saved over loopback\n");
  await editor.save(NOTE);
  await expect(editor.status(NOTE)).toHaveText("saved");
  await expect(editor.dirtyDot(NOTE)).toHaveCount(0);
  expect((await hubRead(worktreeId, NOTE)).toString("utf8")).toBe("saved over loopback\n");
  expect(directFileRequests("PUT").length).toBeGreaterThan(0);
  expect(hubFileRequests("PUT")).toEqual([]);
  expect(hubFileRequests("GET")).toEqual([]);

  // S4: the file changes on disk while the editor holds unsaved edits, and the conflict shows.
  await editor.replaceText(NOTE, "my unsaved edit\n");
  await expect(editor.dirtyDot(NOTE)).toBeVisible();
  await hubCall("worktree.saveFile", { worktreeId, path: NOTE, content: "changed elsewhere\n" });
  await expect(editor.conflictBanner).toBeVisible({ timeout: 30_000 });
  await editor.keepMine.click();
  await editor.save(NOTE);
  await expect(editor.dirtyDot(NOTE)).toHaveCount(0);
  expect((await hubRead(worktreeId, NOTE)).toString("utf8")).toBe("my unsaved edit\n");
  await editor.closeTab(NOTE);

  // S5: the worker restarts. The direct path rests for a while, and an editor opened and saved
  // in that window uses the hub route, or the new listener once it is back. Either way the bytes
  // land exactly once and the editor shows no error.
  launchctl("kickstart", "-k", `gui/0/${LABEL}`);
  await expect(async () => {
    const res = await fetch(`${remote.url}/trpc/hosts.list`, {
      headers: { Authorization: `Bearer ${REMOTE_TOKEN}` },
    });
    const body = (await res.json()) as {
      result: { data: { hosts: { id: string; status: string }[] } };
    };
    expect(body.result.data.hosts.find((h) => h.id === hostId)?.status).toBe("online");
  }).toPass({ timeout: 60_000 });
  await trees.openFilesTab(SECOND);
  await trees.waitForFileTreeRow(SECOND);
  await editor.open(SECOND);
  await expect(editor.textarea(SECOND)).toHaveValue("second file\n");
  await editor.replaceText(SECOND, "saved after the restart\n");
  await editor.save(SECOND);
  await expect(editor.status(SECOND)).toHaveText("saved", { timeout: 30_000 });
  expect((await hubRead(worktreeId, SECOND)).toString("utf8")).toBe("saved after the restart\n");
  await editor.closeTab(SECOND);

  // S6: timings of a 20 MB file on the direct path and through the hub, measured from this
  // process with the same token the window would use. The numbers go into the report.
  const big = Buffer.alloc(20 * 1024 * 1024, "x");
  await hubCall("worktree.createFile", { worktreeId, path: "big.band-test", content: "" });
  const access = await hubCall<{ port: number; token: string } | null>("worktree.directAccess", {
    worktreeId,
    hostId,
  });
  expect(access).not.toBeNull();
  const direct = {
    base: `http://127.0.0.1:${access?.port}`,
    auth: `Bearer ${access?.token}`,
  };
  const viaHub = { base: remote.url, auth: `Bearer ${REMOTE_TOKEN}` };
  const timings: Record<string, number> = {};
  for (const [name, target] of [
    ["direct", direct],
    ["hub", viaHub],
  ] as const) {
    const url = fileUrl(target.base, worktreeId, "big.band-test");
    let started = performance.now();
    const put = await fetch(url, {
      method: "PUT",
      headers: { Authorization: target.auth, "Content-Type": "application/octet-stream" },
      body: big,
    });
    expect(put.status).toBe(204);
    timings[`${name} save ms`] = Math.round(performance.now() - started);
    started = performance.now();
    const get = await fetch(url, { headers: { Authorization: target.auth } });
    expect((await get.arrayBuffer()).byteLength).toBe(big.byteLength);
    timings[`${name} open ms`] = Math.round(performance.now() - started);
  }
  test
    .info()
    .annotations.push({ type: "S6 timings (20 MB)", description: JSON.stringify(timings) });
  console.log(`S6 timings (20 MB): ${JSON.stringify(timings)}`);
});
