/**
 * Agent status on every tab of one worktree (S12, S13).
 *
 * Two chats and a terminal Claude Code session run in one worktree in different
 * states at once. Each tab shows its own state, the sidebar card shows the most
 * urgent one, and the card's tooltip lists every tab. A terminal tab split into
 * panes marks each pane with its own state and the tab shows the higher one.
 *
 * Real server, no tRPC mocking. The chats run against the ACP stub agent, the
 * terminal sessions report through Claude Code hooks posted to the real
 * `statuses.notify` mutation, the way `band notify` forwards them.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { toWorktreeId } from "@/dashboard";

import { acpStubEnv } from "./helpers/acp-stub";
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

const TOKEN = "e2e-agent-status-tabs-token";
// One repo per test, so one test's agent status doesn't reach the other.
const REPOS = ["tabsmixed", "tabspanes"];
const [MIXED_WS, PANES_WS] = REPOS.map((p) => toWorktreeId(p, "main", "local"));

test.use({ viewport: { width: 1280, height: 800 } });

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  seedState(tmpHome, {
    repos: REPOS.map((name) => {
      const repoDir = join(tmpHome, name);
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
      writeFileSync(join(repoDir, "README.md"), `# ${name}\n`);
      git("add", ".");
      git("commit", "-m", "init");
      return {
        name,
        path: repoDir,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: repoDir }],
      };
    }),
  });
  seedSettings(tmpHome, {
    tokenSecret: TOKEN,
    codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
  });
  server = await startServer({
    tmpHome,
    env: acpStubEnv(tmpHome, {
      turns: [
        {
          match: "^deploy",
          steps: [
            {
              permission: {
                toolCall: {
                  toolCallId: "tc-deploy",
                  title: "Deploy to prod",
                  kind: "execute",
                  status: "pending",
                },
                options: [
                  { optionId: "allow", name: "Allow", kind: "allow_once" },
                  { optionId: "reject", name: "Reject", kind: "reject_once" },
                ],
              },
              after: { allow: [{ say: "Deployed." }], reject: [{ say: "Not deployed." }] },
            },
          ],
        },
        { match: "^start", steps: [{ say: "working " }, { waitForCancel: true }] },
        { steps: [{ say: "done" }] },
      ],
    }),
  });
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

test("two chats and a terminal session each show their own state, and the card lists all three", async ({
  page,
}, testInfo) => {
  const chatPane = new ChatPanePage(page, server.url, TOKEN);
  const worktree = new WorktreePage(page, server.url, TOKEN);
  const cwd = join(tmpHome, REPOS[0]);

  // Chat 1 asks for permission: question.
  await chatPane.goto(MIXED_WS);
  await chatPane.waitForReady();
  const questionChatId = await worktree.firstChatTabId();
  await chatPane.typeMessage("deploy please");
  await chatPane.submit();
  await expect(chatPane.permissionCards).toHaveCount(1);

  // Chat 2 runs a long turn: working.
  const workingChatId = await worktree.openChatAndGetId(MIXED_WS);
  expect(workingChatId).not.toBe(questionChatId);
  await worktree.activateChatTab(workingChatId);
  await chatPane.typeMessage("start a long task");
  await chatPane.submit();
  await expect(chatPane.assistantMessage("working")).toBeVisible();

  // The terminal session finished: done.
  const terminalId = await worktree.firstTerminalTabId();
  expect(terminalId).not.toBe("");
  await worktree.reportTerminalHook({
    cwd,
    terminalId,
    sessionId: "tabs-mixed-session",
    hook: { hook_event_name: "Stop" },
  });

  await expect(worktree.chatTabStatusById(questionChatId)).toHaveAttribute(
    "data-status",
    "question",
  );
  // The shown chat tab carries its state too.
  await expect(worktree.chatTabStatusById(workingChatId)).toHaveAttribute("data-status", "working");
  await expect(worktree.terminalTabStatusById(terminalId)).toHaveAttribute("data-status", "done");

  // The worktree shows the most urgent state.
  await expect(worktree.agentStatusDot(MIXED_WS)).toHaveAttribute("data-status", "question");
  const tooltip = await worktree.agentStatusTooltip(MIXED_WS);
  await expect(tooltip).toContainText(/Chat \d: question/);
  await expect(tooltip).toContainText(/Chat \d: working/);
  await expect(tooltip).toContainText("Terminal 1: done");

  await testInfo.attach("tabs-and-card", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
});

test("split terminal panes each carry a marker and the tab shows the higher state", async ({
  page,
}, testInfo) => {
  const worktree = new WorktreePage(page, server.url, TOKEN);
  const cwd = join(tmpHome, REPOS[1]);
  await worktree.goto(PANES_WS);
  await worktree.waitForReady();

  await worktree.focusTerminal();
  await worktree.splitTerminalRight();
  await expect(worktree.terminalPanes()).toHaveCount(2);
  const [firstPane, secondPane] = await worktree.paneOrder();
  expect(firstPane).toBeTruthy();
  expect(secondPane).toBeTruthy();

  await worktree.reportTerminalHook({
    cwd,
    terminalId: firstPane,
    sessionId: "pane-session-1",
    hook: { hook_event_name: "Stop" },
  });
  await worktree.reportTerminalHook({
    cwd,
    terminalId: secondPane,
    sessionId: "pane-session-2",
    hook: { hook_event_name: "PreToolUse", tool_name: "Bash" },
  });

  await expect(worktree.paneStatus(firstPane)).toHaveAttribute("data-status", "done");
  await expect(worktree.paneStatus(secondPane)).toHaveAttribute("data-status", "working");
  // working outranks done, so the tab shows working.
  await expect(worktree.tabStatus("terminal")).toHaveAttribute("data-status", "working");

  await testInfo.attach("split-panes", {
    body: await page.screenshot(),
    contentType: "image/png",
  });

  // When the working pane finishes too, the tab follows.
  await worktree.reportTerminalHook({
    cwd,
    terminalId: secondPane,
    sessionId: "pane-session-2",
    hook: { hook_event_name: "Stop" },
  });
  await expect(worktree.paneStatus(secondPane)).toHaveAttribute("data-status", "done");
  await expect(worktree.tabStatus("terminal")).toHaveAttribute("data-status", "done");
});
