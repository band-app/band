/**
 * One repo, two hosts, the same branch (scenario S8). A worktree is identified by host, repo and
 * branch, so `feat/same` on worker A and on worker B are two worktrees with the ids
 * `proj-feat-same@<hostA>` and `proj-feat-same@<hostB>`. Everything the UI keys on that id has to
 * keep them apart: sidebar selection in the three groupings, the URL, chats, terminals, files,
 * Changes, Checks, the desktop viewer, removal and origin links.
 *
 * Real production hub with BAND_LOCAL_HOST=off, two real `band-worker` processes with their own
 * temp HOME, root and state dir, a real browser. The only fakes are the ones on the workers' own
 * network edge: a `gh` per worker (Express stub behind BAND_GH_BIN) and an RFB server per worker
 * behind a fake `x11vnc`. No tRPC mocking, no `page.route`. Everything runs in temp dirs.
 */

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { expect, test } from "@playwright/test";
import { type GhStub, ghStub } from "../../hub/tests/fixtures/gh-stub";
import {
  FAKE_REPO,
  pullRequestNode,
  reviewQueryData,
} from "../../hub/tests/fixtures/github-review-data";
import { type RfbStub, startRfbStub } from "./fixtures/rfb-stub";
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
import { ChangesPanelPage } from "./pages/ChangesPanelPage";
import { FileTreesPage } from "./pages/FileTreesPage";
import { FileViewerPage } from "./pages/FileViewerPage";
import { PrChecksPanelPage } from "./pages/PrChecksPanelPage";
import { TerminalSurface } from "./pages/TerminalSurface";
import { TwoHostsPage } from "./pages/TwoHostsPage";

const TOKEN = "e2e-worktree-two-hosts-token";
const REPO = "proj";
const BRANCH = "feat/same";
const SAME = "feat-same";
const FILE = "hello.txt";
const CHAT_A = "chat_two_hosts_a";
const CHAT_B = "chat_two_hosts_b";

test.use({ viewport: { width: 1920, height: 900 } });
test.describe.configure({ mode: "serial" });

interface Host {
  id: string;
  name: string;
  root: string;
  worker: WorkerHandle;
  gh: GhStub;
  rfb: RfbStub;
  /** Worktree id of `feat/same` on this host. */
  same: string;
  /** Where `feat/same` is checked out on this host. */
  checkout: string;
}

let server: ServerHandle;
let tmpHome: string;
let a: Host;
let b: Host;
const scratch: string[] = [];

const tmpDir = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
};

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8" });

function makeRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, FILE), "hello\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
}

async function startHost(name: string, vncSize: [number, number]): Promise<Host> {
  const issued = await trpcMutateData<{ token: string; hostId: string }>(
    server.url,
    TOKEN,
    "tokens.issueWorkerBootstrap",
    { hostName: name, labels: [] },
  );
  const root = tmpDir(`band-e2e-two-${name}-root-`);
  makeRepo(join(root, REPO));
  const rfb = await startRfbStub();
  rfb.setSize(...vncSize);
  const gh = await ghStub.start();
  // A fake x11vnc on PATH and a DISPLAY make the worker report the `desktop` capability.
  const bin = tmpDir(`band-e2e-two-${name}-bin-`);
  writeFileSync(join(bin, "x11vnc"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "x11vnc"), 0o755);
  const worker = startWorker({
    env: {
      BAND_HUB_URL: server.url,
      BAND_BOOTSTRAP_TOKEN: issued.token,
      BAND_WORKER_ID: issued.hostId,
      DISPLAY: ":99",
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      BAND_DESKTOP_VNC_PORT: String(rfb.port),
      ...gh.env,
    },
    root,
    stateDir: tmpDir(`band-e2e-two-${name}-state-`),
    home: tmpDir(`band-e2e-two-${name}-home-`),
  });
  return {
    id: issued.hostId,
    name,
    root,
    worker,
    gh,
    rfb,
    same: `${REPO}-${SAME}@${issued.hostId}`,
    checkout: join(root, ".band-worktrees", REPO, BRANCH),
  };
}

async function waitOnline(host: Host): Promise<void> {
  await expect
    .poll(
      async () => {
        const { hosts } = await trpcQuery<{
          hosts: Array<{ id: string; status: string; capabilities: string[] }>;
        }>(server.url, TOKEN, "hosts.list");
        const row = hosts.find((h) => h.id === host.id);
        return row?.status === "online" && row.capabilities.includes("desktop");
      },
      { timeout: 30_000 },
    )
    .toBe(true);
}

/** `worktrees.create` as an agent in `caller` makes it: the headers name the caller's worktree and chat. */
async function createOn(
  host: Host,
  branch: string,
  caller?: { worktreeId: string; chatId?: string },
): Promise<void> {
  const res = await fetch(`${server.url}/trpc/worktrees.create`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: `band_token=${TOKEN}`,
      ...(caller
        ? {
            "x-band-worktree-id": caller.worktreeId,
            ...(caller.chatId ? { "x-band-chat-id": caller.chatId } : {}),
          }
        : {}),
    },
    body: JSON.stringify({
      repo: REPO,
      branch,
      hostId: host.id,
      hostRepoPath: join(host.root, REPO),
      ...(caller ? {} : { noOrigin: true }),
    }),
  });
  if (!res.ok) throw new Error(`worktrees.create failed: ${res.status} ${await res.text()}`);
}

const listedIds = async (): Promise<string[]> => {
  const { repos } = await trpcQuery<{
    repos: Array<{ name: string; worktrees: Array<{ worktreeId: string }> }>;
  }>(server.url, TOKEN, "repos.list");
  return repos.find((r) => r.name === REPO)?.worktrees.map((w) => w.worktreeId) ?? [];
};

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  // `proj` lives on the workers only: the hub holds no checkout and no worktree of it.
  seedState(tmpHome, {
    repos: [{ name: REPO, path: "", defaultBranch: "main", worktrees: [] }],
  });
  server = await startServer({ tmpHome, env: { BAND_LOCAL_HOST: "off" } });

  a = await startHost("box-a", [64, 48]);
  b = await startHost("box-b", [80, 60]);
  await waitOnline(a);
  await waitOnline(b);

  await createOn(a, BRANCH);
  await createOn(b, BRANCH);
  await expect
    .poll(async () => (await listedIds()).sort())
    .toEqual(expect.arrayContaining([a.same, b.same]));
  for (const host of [a, b]) {
    expect(existsSync(host.checkout)).toBe(true);
    // The remote is added after the worktrees exist, so creating them never tries the network.
    git(join(host.root, REPO), "remote", "add", "origin", `git@github.com:acme/widgets.git`);
  }

  // The same path holds different content on the two hosts: host A has an uncommitted edit of
  // a tracked file, host B has committed another version of it.
  writeFileSync(join(a.checkout, FILE), "content from host A\n");
  writeFileSync(join(b.checkout, FILE), "content from host B\n");
  git(b.checkout, "commit", "-q", "-am", "host B version");

  // Each worker's own `gh` reports a different pull request for the branch.
  a.gh.setReviewQuery(
    FAKE_REPO,
    BRANCH,
    reviewQueryData({
      pullRequests: [pullRequestNode({ number: 11, title: "Pull request seen from host A" })],
    }),
  );
  b.gh.setReviewQuery(
    FAKE_REPO,
    BRANCH,
    reviewQueryData({
      pullRequests: [pullRequestNode({ number: 22, title: "Pull request seen from host B" })],
    }),
  );

  await trpcMutate(server.url, TOKEN, "chats.create", {
    worktreeId: a.same,
    id: CHAT_A,
    name: "Chat on A",
  });
  await trpcMutate(server.url, TOKEN, "chats.create", {
    worktreeId: b.same,
    id: CHAT_B,
    name: "Chat on B",
  });
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  for (const host of [a, b]) {
    await host?.worker.kill();
    await host?.gh.stop();
    await host?.rfb.close();
  }
  await server?.close();
  cleanupTmpHome(tmpHome);
  for (const dir of scratch) cleanupTmpHome(dir);
});

for (const mode of ["repo", "origin", "host"] as const) {
  test(`the ${mode} grouping selects only the host's own row (item 1)`, async ({ page }) => {
    const app = new TwoHostsPage(page, server.url, TOKEN);
    await app.open(a.same);
    await app.groupBy(mode);

    await expect(app.card(a.same)).toBeVisible();
    await expect(app.card(b.same)).toBeVisible();
    await app.expectOnlySelected(a.same);
    await expect(app.card(b.same)).not.toHaveAttribute("aria-current", "page");

    await app.select(b.same);
    await app.expectOnlySelected(b.same);
    await expect(app.card(a.same)).not.toHaveAttribute("aria-current", "page");

    await app.select(a.same);
    await app.expectOnlySelected(a.same);

    if (mode === "host") {
      // BAND_LOCAL_HOST=off: the hub's own machine is not a host in the list.
      await expect(app.sidebar.hostHeader(a.id)).toContainText("box-a");
      await expect(app.sidebar.hostHeader(b.id)).toContainText("box-b");
      await expect(app.sidebar.hostHeader("local")).toHaveCount(0);
      await expect(app.sidebar.hostRepoHeader(a.id, REPO)).toBeVisible();
      await expect(app.sidebar.hostRepoHeader(b.id, REPO)).toBeVisible();
      await expect(app.sidebar.row(a.same)).toBeVisible();
      await expect(app.sidebar.row(b.same)).toBeVisible();
    }
  });
}

test("the URL names the host, a deep link opens it, reload keeps it and back returns (item 2)", async ({
  page,
}) => {
  const app = new TwoHostsPage(page, server.url, TOKEN);
  await app.open(a.same);
  await app.expectOnlySelected(a.same);
  expect(app.currentPath()).toBe(`/worktree/${REPO}-${SAME}@${a.id}`);

  await app.select(b.same);
  await app.expectOnlySelected(b.same);
  expect(app.currentPath()).toBe(`/worktree/${REPO}-${SAME}@${b.id}`);

  await app.reload();
  await app.expectOnlySelected(b.same);

  await app.goBack();
  await app.expectOnlySelected(a.same);
  await expect(app.card(b.same)).not.toHaveAttribute("aria-current", "page");

  // A fresh page load of B's deep link selects B and not A.
  await app.open(b.same);
  await app.expectOnlySelected(b.same);
});

test("a chat stays on its host and a terminal runs on the selected host (item 3)", async ({
  page,
}) => {
  const app = new TwoHostsPage(page, server.url, TOKEN);
  await app.open(a.same);
  await expect(app.chatTab(a.same, CHAT_A)).toBeVisible();
  await expect(app.chatTab(a.same, CHAT_B)).toHaveCount(0);

  await app.select(b.same);
  await app.expectOnlySelected(b.same);
  await expect(app.chatTab(b.same, CHAT_B)).toBeVisible();
  await expect(app.chatTab(b.same, CHAT_A)).toHaveCount(0);

  // The terminal that opens with B selected is a shell in B's checkout, under B's root.
  await app.worktree.clickTerminalAddTab(b.same);
  const terminal = new TerminalSurface(page, b.same);
  await expect(terminal.wrapper).toBeVisible();
  const where = `case "$PWD" in ${b.root}/*) echo B;; ${a.root}/*) echo A;; *) echo ?;; esac`;
  await terminal.typeLine(`echo WHERE=$(${where}) LEAF=$(basename "$PWD")`);
  await expect.poll(() => terminal.readScreenText()).toContain("WHERE=B LEAF=same");
});

test("a file, the Changes panel and the Checks tab show the selected host's data (item 4)", async ({
  page,
}) => {
  // A fresh page per host keeps the other host's panels out of the DOM.
  const app = new TwoHostsPage(page, server.url, TOKEN);
  const trees = new FileTreesPage(page, app.worktree);
  const viewer = new FileViewerPage(page);

  await app.open(a.same);
  await trees.openFilesTab(FILE);
  await trees.openFile(FILE);
  await viewer.expectContent("content from host A");
  await viewer.expectNotContent("content from host B");

  await app.open(b.same);
  await trees.openFilesTab(FILE);
  await trees.openFile(FILE);
  await viewer.expectContent("content from host B");
  await viewer.expectNotContent("content from host A");

  // Changes: only A has an uncommitted change.
  const changesA = new ChangesPanelPage(page, server.url, TOKEN);
  await changesA.goto(a.same);
  await expect(changesA.sectionRow("unstaged", FILE)).toBeVisible();
  const changesB = new ChangesPanelPage(page, server.url, TOKEN);
  await changesB.goto(b.same);
  await expect(changesB.sectionRow("unstaged", FILE)).toHaveCount(0);
  await expect(changesB.section("unstaged")).toHaveCount(0);

  // Checks: each worktree's review comes from its own host's gh.
  const checks = new PrChecksPanelPage(page, server.url, TOKEN);
  await checks.goto(a.same);
  await expect(checks.number).toHaveText("#11");
  await expect(checks.title).toHaveText("Pull request seen from host A");
  await checks.goto(b.same);
  await expect(checks.number).toHaveText("#22");
  await expect(checks.title).toHaveText("Pull request seen from host B");
  expect(a.gh.requests.some((r) => r.cwd === a.checkout)).toBe(true);
  expect(b.gh.requests.some((r) => r.cwd === b.checkout)).toBe(true);
  expect(a.gh.requests.some((r) => r.cwd === b.checkout)).toBe(false);
  expect(b.gh.requests.some((r) => r.cwd === a.checkout)).toBe(false);
});

test("the desktop viewer opens the selected host's desktop (item 5)", async ({ page }) => {
  const app = new TwoHostsPage(page, server.url, TOKEN);

  await app.open(a.same);
  await app.desktop.headerButton.click();
  await expect(app.desktop.dialog).toBeVisible();
  await app.desktop.expectFramebuffer();
  await expect(app.desktop.hostName).toHaveText("box-a");
  await expect(app.desktop.resolution).toHaveText("64x48");
  await app.desktop.close();

  await app.open(b.same);
  await app.desktop.headerButton.click();
  await expect(app.desktop.dialog).toBeVisible();
  await app.desktop.expectFramebuffer();
  await expect(app.desktop.hostName).toHaveText("box-b");
  await expect(app.desktop.resolution).toHaveText("80x60");
});

test("an origin link from a child started on B points at B (item 7)", async ({ page }) => {
  await createOn(b, "child-of-b", { worktreeId: b.same, chatId: CHAT_B });
  const childId = `${REPO}-child-of-b@${b.id}`;
  await expect.poll(listedIds).toContain(childId);

  const app = new TwoHostsPage(page, server.url, TOKEN);
  await app.open(a.same);
  await app.select(childId);
  await app.expectOnlySelected(childId);
  await expect(app.sidebar.startedFromLink).toHaveAttribute("data-origin-worktree", b.same);

  await app.sidebar.startedFromLink.click();
  await app.expectOnlySelected(b.same);
  await expect(app.card(a.same)).not.toHaveAttribute("aria-current", "page");

  // In the Origin grouping the child nests under B's row, not A's.
  await app.groupBy("origin");
  await expect(app.sidebar.row(childId)).toHaveAttribute("data-depth", "1");
  const order = (await app.sidebar.rowOrder()).map((r) => r.id);
  expect(order.indexOf(childId)).toBe(order.indexOf(b.same) + 1);
});

test("removing the worktree on A leaves B selectable with its chat and files (item 6)", async ({
  page,
}) => {
  const app = new TwoHostsPage(page, server.url, TOKEN);
  await app.open(b.same);
  // A clean worktree is removed without the confirmation dialog for unsaved work.
  git(a.checkout, "checkout", "--", FILE);
  await expect(app.worktree.gitDirtyMark(a.same)).toHaveCount(0);
  await app.worktree.deleteWorktreeFromSidebar(a.same);

  await expect.poll(listedIds).not.toContain(a.same);
  await expect.poll(listedIds).toContain(b.same);
  await expect(app.card(a.same)).toHaveCount(0);
  await expect(app.card(b.same)).toBeVisible();
  expect(existsSync(a.checkout)).toBe(false);
  expect(existsSync(b.checkout)).toBe(true);

  // B is still selected, and a fresh load of it still shows its chat and its own file.
  await app.expectOnlySelected(b.same);
  await app.open(b.same);
  await app.expectOnlySelected(b.same);
  await expect(app.chatTab(b.same, CHAT_B)).toBeVisible();
  const trees = new FileTreesPage(page, app.worktree);
  const viewer = new FileViewerPage(page);
  await trees.openFilesTab(FILE);
  await trees.openFile(FILE);
  await viewer.expectContent("content from host B");
});
