/**
 * Agent status states in the sidebar, the tab strip and the worktree picker (⌘K).
 *
 * Each state has its own mark and tooltip: working (yellow dot), monitoring
 * (ring), question (amber "?"), done (green dot) and failed (red dot). Idle
 * shows none. Real server, no tRPC mocking: a worktree's status comes from the
 * real `statuses.update` mutation, a terminal tab's from Claude Code hooks
 * posted through `statuses.notify`, the way `band notify` forwards them.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { toWorktreeId } from "@/dashboard";

import {
  cleanupTmpHome,
  createTmpHome,
  resetClientState,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { ChatPanePage } from "./pages/ChatPanePage";
import { WorktreePage } from "./pages/WorktreePage";
import { WorktreePicker } from "./pages/WorktreePicker";

const TOKEN = "e2e-agent-status-states-token";
const REPO = "statesrepo";
const WORKTREE = toWorktreeId(REPO, "main", "local");

test.use({ viewport: { width: 1280, height: 800 } });

const STATES = [
  { status: "working", label: "Agent running", tooltip: "Agent running..." },
  { status: "monitoring", label: "Monitoring", tooltip: "Loop or background task running" },
  { status: "question", label: "Waiting for your answer", tooltip: "Waiting for your answer" },
  { status: "done", label: "Finished", tooltip: "Finished" },
  { status: "failed", label: "Failed", tooltip: "Failed" },
] as const;

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const repoDir = join(tmpHome, REPO);
  mkdirSync(repoDir, { recursive: true });
  // A git repo, so the default branch shows as a worktree card.
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: repoDir,
      env: {
        PATH: process.env.PATH,
        HOME: tmpHome,
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@test.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@test.com",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
      },
    });
  git("init", "-b", "main");
  writeFileSync(join(repoDir, "README.md"), "# States\n");
  git("add", ".");
  git("commit", "-m", "init");
  seedState(tmpHome, {
    repos: [
      {
        name: REPO,
        path: repoDir,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: repoDir }],
      },
    ],
  });
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  server = await startServer({ tmpHome });
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

test("the sidebar card shows a distinct mark for each state", async ({ page }, testInfo) => {
  const worktree = new WorktreePage(page, server.url, TOKEN);
  await worktree.goto(WORKTREE);
  await worktree.waitForReady();

  for (const { status, label } of STATES) {
    // The status stream has no replay, so re-send until the mark shows.
    await expect
      .poll(
        async () => {
          await worktree.setAgentStatus(WORKTREE, status);
          return worktree.agentStatusDot(WORKTREE).getAttribute("data-status");
        },
        { timeout: 15_000 },
      )
      .toBe(status);

    // The mark names its state for screen readers, and its tooltip carries the same meaning.
    await expect(worktree.agentStatusDot(WORKTREE).getByRole("img")).toHaveAttribute(
      "aria-label",
      label,
    );
    // Hovering the mark shows its tooltip (a worktree with no tab statuses shows the state's own).
    await expect(await worktree.agentStatusTooltip(WORKTREE)).toContainText(
      STATES.find((s) => s.status === status)?.tooltip ?? "",
    );
    await testInfo.attach(`sidebar-${status}`, {
      body: await worktree.worktreeCard(WORKTREE).screenshot(),
      contentType: "image/png",
    });
    await page.mouse.move(0, 0);
  }

  // Idle shows no mark.
  await worktree.setAgentStatus(WORKTREE, "idle");
  await expect(worktree.agentStatusDot(WORKTREE)).toHaveCount(0);
});

test("the worktree picker shows the same marks", async ({ page }, testInfo) => {
  const worktree = new WorktreePage(page, server.url, TOKEN);
  const picker = new WorktreePicker(page);
  await worktree.goto(WORKTREE);
  await worktree.waitForReady();

  for (const { status } of STATES) {
    await expect
      .poll(
        async () => {
          await worktree.setAgentStatus(WORKTREE, status);
          return worktree.agentStatusDot(WORKTREE).getAttribute("data-status");
        },
        { timeout: 15_000 },
      )
      .toBe(status);

    await worktree.openWorktreePickerViaShortcut();
    await picker.waitVisible();
    await expect(picker.agentStatus(WORKTREE)).toHaveAttribute("data-status", status);
    await testInfo.attach(`picker-${status}`, {
      body: await picker.dialog.screenshot(),
      contentType: "image/png",
    });
    await picker.dismiss();
    await expect(picker.dialog).toBeHidden();
  }
});

test("a hidden terminal tab shows each hook state", async ({ page }, testInfo) => {
  const chatPane = new ChatPanePage(page, server.url, TOKEN);
  const worktree = new WorktreePage(page, server.url, TOKEN);
  const cwd = join(tmpHome, REPO);
  await chatPane.goto(WORKTREE);
  // Opens a chat and shows it, so the default terminal tab is hidden.
  await chatPane.waitForReady();
  await expect(worktree.tabContainer("chat")).toHaveAttribute("data-selected", "true");
  const terminalId = await worktree.firstTerminalTabId();
  expect(terminalId).not.toBe("");

  const hooks = [
    { status: "working", hook: { hook_event_name: "PreToolUse", tool_name: "Bash" } },
    {
      status: "monitoring",
      hook: { hook_event_name: "Stop", session_crons: [{ id: "cron-1", cron: "*/5 * * * *" }] },
    },
    { status: "question", hook: { hook_event_name: "PermissionRequest", tool_name: "Bash" } },
    { status: "done", hook: { hook_event_name: "Stop" } },
    { status: "failed", hook: { hook_event_name: "StopFailure" } },
  ] as const;
  for (const { status, hook } of hooks) {
    await worktree.reportTerminalHook({ cwd, terminalId, sessionId: "states-session", hook });
    await expect(worktree.tabStatus("terminal")).toHaveAttribute("data-status", status);
    // Every mark but the spinner carries its tooltip as the native title.
    if (status !== "working") {
      await expect(worktree.tabStatus("terminal")).toHaveAttribute(
        "title",
        STATES.find((s) => s.status === status)?.tooltip ?? "",
      );
    }
    await testInfo.attach(`tab-${status}`, {
      body: await worktree.tab("terminal").screenshot(),
      contentType: "image/png",
    });
  }
});
