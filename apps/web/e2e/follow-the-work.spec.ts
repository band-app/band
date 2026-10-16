/**
 * Follow the work: a worktree whose host is offline continues on another host from the hub's
 * checkpoint. Two real workers (A and B) dial a real hub. A worktree on A has a finished chat turn
 * and an uncommitted file, so the hub holds a checkpoint with the agent session. A is killed, and:
 *
 *   - a repo limited to A says so plainly when someone messages in it (S3, in the UI);
 *   - messaging the worktree on A opens the offer, accepting restores it on B, the agent session
 *     resumes there and the message arrives there (S1);
 *   - the header and the sidebar card show the move (S5);
 *   - when A returns with a file changed after the checkpoint, the old copy shows Diverged with its
 *     diff, and "Bring these changes over" applies it to the new copy (S4).
 *
 * The coding agent is the scripted ACP stub, per worker, with its request log. The remotes are
 * local bare repos. No tRPC mocking, no `page.route`.
 */

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { ACP_STUB_AGENT_PATH, acpStubEnv } from "./helpers/acp-stub";
import {
  cleanupTmpHome,
  createTmpHome,
  resetClientState,
  type ServerHandle,
  seedSettings,
  startServer,
} from "./helpers/server";
import { trpcMutateData, trpcQuery } from "./helpers/trpc";
import { startWorker, type WorkerHandle } from "./helpers/worker";
import { ChatPanePage } from "./pages/ChatPanePage";
import { CheckpointsPage } from "./pages/CheckpointsPage";
import { FollowPage } from "./pages/FollowPage";
import { SidebarGroupingPage } from "./pages/SidebarGroupingPage";
import { WorktreePage } from "./pages/WorktreePage";

const TOKEN = "e2e-follow-the-work-token";

test.use({ viewport: { width: 1920, height: 900 } });
test.describe.configure({ mode: "serial" });

interface Worker {
  name: string;
  hostId: string;
  root: string;
  stateDir: string;
  home: string;
  stubLog: string;
  env: Record<string, string>;
  handle: WorkerHandle;
}

let server: ServerHandle;
let tmpHome: string;
let a: Worker;
let b: Worker;
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

interface RepoRow {
  name: string;
  worktrees: Array<{
    worktreeId: string;
    name: string;
    path: string;
    hostId?: string;
    supersededBy?: string;
    continuedFrom?: { reason: string };
    divergence?: { state: string };
  }>;
}
const worktreeRow = async (repo: string, name: string, hostId: string) =>
  (await trpcQuery<{ repos: RepoRow[] }>(server.url, TOKEN, "repos.list")).repos
    .find((r) => r.name === repo)
    ?.worktrees.find((w) => w.name === name && w.hostId === hostId);

async function hostStatus(hostId: string): Promise<string | undefined> {
  const { hosts } = await trpcQuery<{ hosts: Array<{ id: string; status: string }> }>(
    server.url,
    TOKEN,
    "hosts.list",
  );
  return hosts.find((h) => h.id === hostId)?.status;
}

function launchWorker(w: Omit<Worker, "handle">): Worker {
  return {
    ...w,
    handle: startWorker({ env: w.env, root: w.root, stateDir: w.stateDir, home: w.home }),
  };
}

async function addWorker(name: string): Promise<Worker> {
  const issued = await trpcMutateData<{ token: string; hostId: string }>(
    server.url,
    TOKEN,
    "tokens.issueWorkerBootstrap",
    { hostName: name, labels: [] },
  );
  const home = tmpDir(`band-e2e-follow-${name}-home-`);
  // The worker's capability report probes the real `claude` CLI, which is not logged in here. A
  // stand-in on the probe path that exits 0 for `--version` and `auth status` makes the agent
  // installed and logged in, the way a configured machine reports it.
  const agentBin = tmpDir(`band-e2e-follow-${name}-bin-`);
  writeFileSync(join(agentBin, "claude"), '#!/bin/sh\necho "claude 1.0.0"\n');
  chmodSync(join(agentBin, "claude"), 0o755);
  const stubState = join(home, "acp-state");
  mkdirSync(stubState, { recursive: true });
  const w = launchWorker({
    name,
    hostId: issued.hostId,
    root: tmpDir(`band-e2e-follow-${name}-root-`),
    stateDir: tmpDir(`band-e2e-follow-${name}-state-`),
    home,
    stubLog: join(home, "stub-log.jsonl"),
    env: {
      BAND_HUB_URL: server.url,
      BAND_BOOTSTRAP_TOKEN: issued.token,
      BAND_WORKER_ID: issued.hostId,
      BAND_TEST_ACP_AGENT: ACP_STUB_AGENT_PATH,
      BAND_TEST_ACP_STATE: stubState,
      BAND_TEST_ACP_LOG: join(home, "stub-log.jsonl"),
      BAND_AGENT_SESSION_DIRS: stubState,
      BAND_AGENT_BIN_DIRS: agentBin,
    },
  });
  await expect.poll(() => hostStatus(w.hostId), { timeout: 30_000 }).toBe("online");
  return w;
}

/** A bare remote with one commit, registered on the hub and cloned into each worker's root. */
async function addRepo(name: string, workers: Worker[]): Promise<void> {
  const parent = tmpDir(`band-e2e-follow-${name}-remote-`);
  const seed = join(parent, "seed");
  mkdirSync(seed, { recursive: true });
  git(seed, "init", "-q", "-b", "main");
  writeFileSync(join(seed, "hello.txt"), "hello\n");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "init");
  const bare = join(parent, `${name}.git`);
  git(parent, "clone", "-q", "--bare", seed, bare);
  git(bare, "symbolic-ref", "HEAD", "refs/heads/main");
  for (const w of workers) git(w.root, "clone", "-q", bare, name);
  await trpcMutateData(server.url, TOKEN, "repos.addByUrl", {
    remoteUrl: bare,
    defaultBranch: "main",
  });
}

async function createWorktree(w: Worker, repo: string, branch: string): Promise<string> {
  await trpcMutateData(server.url, TOKEN, "worktrees.create", {
    repo,
    branch,
    hostId: w.hostId,
    hostRepoPath: join(w.root, repo),
  });
  await expect.poll(async () => (await worktreeRow(repo, branch, w.hostId))?.path).toBeTruthy();
  return `${repo}-${branch}@${w.hostId}`;
}

const stubPrompts = (w: Worker): string[] => {
  if (!existsSync(w.stubLog)) return [];
  return readFileSync(w.stubLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { method: string; params: { prompt?: unknown } })
    .filter((r) => r.method === "session/prompt")
    .map((r) => JSON.stringify(r.params.prompt));
};
const stubMethods = (w: Worker): string[] => {
  if (!existsSync(w.stubLog)) return [];
  return readFileSync(w.stubLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => (JSON.parse(l) as { method: string }).method);
};

let openId = "";
let lockedId = "";
let buttonId = "";
let soloMainId = "";
let noCheckpointId = "";
let continuedId = "";

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  server = await startServer({
    tmpHome,
    // A short lease: A's worktrees open elsewhere two seconds after it drops.
    env: { BAND_LOCAL_HOST: "off", BAND_WORKER_LEASE_MS: "2000", ...acpStubEnv(tmpHome) },
  });
  a = await addWorker("box-a");
  b = await addWorker("box-b");
  await addRepo("app", [a, b]);
  await addRepo("locked", [a]);
  await addRepo("solo", [a]);
  // B holds the repo once it has a worktree of it, which a restore needs.
  await createWorktree(b, "app", "seed-b");

  openId = await createWorktree(a, "app", "feat-one");
  buttonId = await createWorktree(a, "app", "feat-button");
  noCheckpointId = await createWorktree(a, "app", "feat-bare");
  lockedId = await createWorktree(a, "locked", "feat-lock");
  // The repo's own checkout of main on A is a worktree too, once A reports the clone.
  await createWorktree(a, "solo", "feat-solo");
  await trpcMutateData(server.url, TOKEN, "repos.addFromWorker", {
    hostId: a.hostId,
    path: join(a.root, "solo"),
  });
  soloMainId = `solo-main@${a.hostId}`;
  await trpcMutateData(server.url, TOKEN, "repos.update", {
    name: "locked",
    allowedHostIds: [a.hostId],
  });
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await a?.handle.kill();
  await b?.handle.kill();
  await server.close();
  cleanupTmpHome(tmpHome);
  for (const dir of scratch) cleanupTmpHome(dir);
});

test("a finished turn and an uncommitted file give feat-one a checkpoint with the session", async ({
  page,
}) => {
  const path = (await worktreeRow("app", "feat-one", a.hostId))?.path ?? "";
  writeFileSync(join(path, "hello.txt"), "hello from A\n");

  const chat = new ChatPanePage(page, server.url, TOKEN);
  await chat.goto(openId);
  await chat.waitForReady();
  await chat.typeMessage("first message");
  await chat.submit();
  await expect(chat.thinkingIndicator).toBeHidden({ timeout: 30_000 });

  await expect
    .poll(async () => {
      await trpcMutateData(server.url, TOKEN, "checkpoints.take", { worktreeId: openId });
      const { checkpoints } = await trpcQuery<{ checkpoints: Array<{ sessions: number }> }>(
        server.url,
        TOKEN,
        "checkpoints.list",
        { worktreeId: openId },
      );
      return checkpoints[0]?.sessions ?? 0;
    })
    .toBeGreaterThan(0);

  const buttonPath = (await worktreeRow("app", "feat-button", a.hostId))?.path ?? "";
  writeFileSync(join(buttonPath, "hello.txt"), "edited for the button flow\n");
  await trpcMutateData(server.url, TOKEN, "checkpoints.take", { worktreeId: buttonId });
  await trpcMutateData(server.url, TOKEN, "checkpoints.take", { worktreeId: soloMainId });
  // The limited repo needs a checkpoint too, so only the restriction can stop it.
  await trpcMutateData(server.url, TOKEN, "checkpoints.take", { worktreeId: lockedId }).catch(
    () => undefined,
  );
  await a.handle.kill();
  await expect.poll(() => hostStatus(a.hostId), { timeout: 30_000 }).not.toBe("online");
  // The old owner's lease must be over before the offer opens up.
  await expect
    .poll(
      async () =>
        (
          await trpcQuery<{ blocked?: { reason: string } }>(server.url, TOKEN, "follow.offer", {
            worktreeId: openId,
          })
        ).blocked?.reason,
      { timeout: 30_000 },
    )
    .not.toBe("lease-active");
});

test("a repo limited to the offline host says so, with no host to choose (S3)", async ({
  page,
}) => {
  const follow = new FollowPage(page);
  const chat = new ChatPanePage(page, server.url, TOKEN);
  await chat.goto(lockedId);
  await chat.waitForReady();
  await chat.typeMessage("anyone there?");
  await chat.submit();

  await expect(follow.dialog).toBeVisible({ timeout: 30_000 });
  await expect(follow.question).toContainText("only available on");
  await expect(follow.question).toContainText("box-a");
  await expect(follow.targets).toHaveCount(0);
  await follow.dismiss();
});

test("offline worktrees are faded with an icon, and their menu offers Open on another host or says why not", async ({
  page,
}) => {
  const checkpoints = new CheckpointsPage(page);
  const app = new WorktreePage(page, server.url, TOKEN);
  await app.goto(openId);
  await app.waitForReady();

  await expect(checkpoints.offlineIcon(openId)).toBeVisible();
  await expect(checkpoints.card(openId)).toHaveCSS("opacity", "0.6");
  await checkpoints.showOfflineDetails(openId);
  await expect(checkpoints.offlineDetails).toContainText("box-a is offline");
  await expect(checkpoints.offlineDetails).toContainText("Last checkpoint");

  await checkpoints.openCardMenu(openId);
  await expect(checkpoints.moveItem()).toBeEnabled();
  await checkpoints.closeCardMenu();

  // The default branch is offered too while its host is offline.
  await checkpoints.openCardMenu(soloMainId);
  await expect(checkpoints.moveItem()).toBeEnabled();
  await checkpoints.closeCardMenu();

  // No checkpoint: shown, disabled, with the reason.
  await page.mouse.move(0, 0);
  await expect(checkpoints.offlineDetails).toHaveCount(0);
  await checkpoints.showOfflineDetails(noCheckpointId);
  await expect(checkpoints.offlineDetails).toContainText("No checkpoint");
  await checkpoints.openCardMenu(noCheckpointId);
  await expect(checkpoints.moveItem()).toBeDisabled();
  await expect(checkpoints.moveReason()).toBeVisible();
  await checkpoints.closeCardMenu();

  // A repo limited to one host is never offered for transfer.
  await checkpoints.openCardMenu(lockedId);
  await expect(checkpoints.moveItem()).toBeDisabled();
  await expect(checkpoints.moveReason()).toContainText("box-a");
});

test("the notice of an offline worktree has an Open on another host button that continues it on B", async ({
  page,
}) => {
  const follow = new FollowPage(page);
  const checkpoints = new CheckpointsPage(page);
  const app = new WorktreePage(page, server.url, TOKEN);
  await app.goto(buttonId);
  await app.waitForReady();

  await expect(checkpoints.noticeHost).toContainText("box-a is offline");
  await expect(checkpoints.noticeBlocked).toHaveCount(0);
  await expect(checkpoints.panel).toHaveCount(0);
  await checkpoints.openElsewhereButton.click();

  await expect(follow.dialog).toBeVisible();
  await expect(follow.target(b.hostId)).toBeChecked();
  await expect(follow.notes).toContainText("Ignored files");
  await follow.accept();
  await expect(follow.dialog).toBeHidden({ timeout: 90_000 });

  const moved = await worktreeRow("app", "feat-button", b.hostId);
  expect(moved?.continuedFrom?.reason).toBe("manual");
  expect((await worktreeRow("app", "feat-button", a.hostId))?.supersededBy).toBe(
    `app-feat-button@${b.hostId}`,
  );
});

test("messaging a worktree on an offline host offers B, continues there and delivers the message (S1)", async ({
  page,
}) => {
  const follow = new FollowPage(page);
  const chat = new ChatPanePage(page, server.url, TOKEN);
  await chat.goto(openId);
  await chat.waitForReady();
  await chat.typeMessage("second message");
  await chat.submit();

  await expect(follow.dialog).toBeVisible({ timeout: 30_000 });
  await expect(follow.question).toContainText(
    "box-a is offline. Continue on box-b from the checkpoint",
  );
  await expect(follow.target(b.hostId)).toBeChecked();
  await expect(follow.notes).toContainText("Ignored files");
  await expect(follow.notes).toContainText("Running processes");
  await expect(follow.notes).toContainText("Setup runs");
  await follow.accept();

  continuedId = `app-feat-one@${b.hostId}`;
  await expect(follow.dialog).toBeHidden({ timeout: 90_000 });
  // The agent session resumed on B and the message was delivered there.
  await expect
    .poll(() => stubPrompts(b).some((p) => p.includes("second message")), { timeout: 60_000 })
    .toBe(true);
  expect(stubMethods(b).some((m) => m === "session/resume" || m === "session/load")).toBe(true);
  expect(stubPrompts(a).some((p) => p.includes("second message"))).toBe(false);

  const moved = await worktreeRow("app", "feat-one", b.hostId);
  expect(moved?.continuedFrom?.reason).toBe("manual");
  expect((await worktreeRow("app", "feat-one", a.hostId))?.supersededBy).toBe(continuedId);
});

test("the sidebar clock shows until the continued worktree is opened, then only the menu line remains (S1, S3, S4, S5)", async ({
  page,
}) => {
  const follow = new FollowPage(page);
  const app = new WorktreePage(page, server.url, TOKEN);
  const grouping = new SidebarGroupingPage(page);
  // Open another worktree, so the continued one is unseen.
  await app.goto(openId);
  await app.waitForReady();

  await expect(follow.headerContinuedFrom).toHaveCount(0);
  await expect(follow.cardContinuedFrom(continuedId)).toHaveAttribute(
    "aria-label",
    /^Continued from box-a/,
  );

  await grouping.selectMode("host");
  await expect(follow.cardContinuedFrom(continuedId)).toHaveAttribute(
    "aria-label",
    /^Continued from box-a/,
  );

  // Opening it marks the continuation seen, and the mark survives a reload.
  await app.goto(continuedId);
  await app.waitForReady();
  await expect(follow.cardContinuedFrom(continuedId)).toHaveCount(0);
  await app.reload();
  await app.waitForReady();
  await expect(follow.cardContinuedFrom(continuedId)).toHaveCount(0);

  // The record stays reachable from the context menu.
  await expect(await follow.openCardContinuedFromLine(continuedId)).toContainText(
    /^Continued from box-a/,
  );
});

test("the continued worktree opens its chat on the new host with its history, even from a stale saved layout (S5, S6, S8)", async ({
  page,
}) => {
  const chat = new ChatPanePage(page, server.url, TOKEN);
  const app = new WorktreePage(page, server.url, TOKEN);
  const checkpoints = new CheckpointsPage(page);
  const grouping = new SidebarGroupingPage(page);
  const { chats } = await trpcQuery<{ chats: Array<{ id: string }> }>(
    server.url,
    TOKEN,
    "chats.list",
    { worktreeId: continuedId },
  );
  const chatId = chats[0]?.id ?? "";
  expect(chatId).not.toBe("");

  // A layout saved before the move names the old worktree in the panel's params.
  await app.seedGlobalLayout(continuedId, {
    grid: {
      root: {
        type: "branch",
        data: [
          { type: "leaf", data: { views: [chatId], activeView: chatId, id: "1" }, size: 1000 },
        ],
        size: 800,
      },
      width: 1000,
      height: 800,
      orientation: "HORIZONTAL",
    },
    panels: {
      [chatId]: {
        id: chatId,
        contentComponent: "chat",
        tabComponent: "chat",
        title: "Chat",
        params: { worktreeId: `app-feat-one@${a.hostId}`, chatId },
      },
    },
    activeGroup: "1",
  });
  await app.goto(continuedId);
  await app.waitForReady();

  await expect(chat.chatTab(chatId)).toBeVisible();
  await expect(chat.userMessage("first message")).toBeVisible({ timeout: 30_000 });

  // The cards show icons with names, not status text, and each carries its host's name.
  await grouping.selectMode("repo");
  await expect(checkpoints.supersededBadge(openId)).toHaveAttribute(
    "aria-label",
    `Superseded by ${continuedId}`,
  );
  await expect(checkpoints.card(openId)).not.toContainText("Superseded");
  await expect(checkpoints.card(continuedId)).not.toContainText("Continued from");
  await expect(grouping.hostTag(checkpoints.card(continuedId))).toHaveText("box-b");
});

test("when A returns with a newer change, the old copy is Diverged and the change can be brought over (S4)", async ({
  page,
}) => {
  const follow = new FollowPage(page);
  const oldId = openId;
  // A change made on A after the checkpoint, while the hub could not see it.
  const oldPath = (await worktreeRow("app", "feat-one", a.hostId))?.path ?? "";
  writeFileSync(join(oldPath, "after.txt"), "written on A after the checkpoint\n");

  a = launchWorker({ ...a });
  await expect.poll(() => hostStatus(a.hostId), { timeout: 30_000 }).toBe("online");
  await expect
    .poll(async () => (await worktreeRow("app", "feat-one", a.hostId))?.divergence?.state, {
      timeout: 60_000,
    })
    .toBe("diverged");

  const app = new WorktreePage(page, server.url, TOKEN);
  await app.goto(continuedId);
  await app.waitForReady();
  await expect(follow.divergedBadge(oldId)).toBeVisible();

  // With A online again, its own checkout of main is offered for a move too.
  const checkpoints = new CheckpointsPage(page);
  await checkpoints.openCardMenu(soloMainId);
  await expect(checkpoints.cardMenu).toBeVisible();
  await expect(checkpoints.moveItem()).toBeVisible();
  await checkpoints.closeCardMenu();
  await follow.openDivergence(oldId);
  await expect(follow.panelFile("after.txt")).toBeVisible();
  await follow.panelFile("after.txt").click();
  await expect(follow.panelDiff).toContainText("written on A after the checkpoint");

  // Discarding a diverged copy asks twice, and the second ask names what would be lost.
  await follow.reviewDiscardOfDivergedCopy();
  await expect(follow.discardLoss).toContainText("1 changed file");
  await follow.keepOldCopy();
  expect(existsSync(join(oldPath, "after.txt"))).toBe(true);

  await follow.bringOver();
  await expect(follow.panelNotice).toContainText("Brought over 1 file");
  const newPath = (await worktreeRow("app", "feat-one", b.hostId))?.path ?? "";
  expect(readFileSync(join(newPath, "after.txt"), "utf8")).toBe(
    "written on A after the checkpoint\n",
  );
  // Nothing was deleted on the old host.
  expect(existsSync(join(oldPath, "after.txt"))).toBe(true);
});
