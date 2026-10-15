/**
 * Agent status on center tabs.
 *
 * A chat or terminal tab carries its agent's status in the slot at its end: a
 * spinner while the agent works, a dot for the other states. This holds for the
 * shown tab too. A tab under the pointer puts its close button in that slot
 * instead.
 *
 * Real server, no tRPC mocking. The chat runs against the ACP stub agent,
 * whose "start" turn stays open until Band sends `session/cancel`. The
 * terminal's status comes from Claude Code hooks posted through the real
 * `statuses.notify` mutation, the way `band notify` forwards them from a Band
 * terminal.
 */

import { mkdirSync } from "node:fs";
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
import { CenterTabFocus } from "./pages/CenterTabFocus";
import { ChatPanePage } from "./pages/ChatPanePage";
import { WorktreePage } from "./pages/WorktreePage";

const TOKEN = "e2e-center-tab-agent-status-token";
// One repo per test, so one test's agent status doesn't reach the other.
const REPOS = ["tabstatuschat", "tabstatusterm", "tabstatusswitch"];
const [CHAT_WS, TERM_WS, SWITCH_WS] = REPOS.map((p) => toWorktreeId(p, "main", "local"));

test.use({ viewport: { width: 1280, height: 800 } });

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  seedState(tmpHome, {
    repos: REPOS.map((name) => {
      const repoDir = join(tmpHome, name);
      mkdirSync(repoDir, { recursive: true });
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

test("a hidden chat tab shows a spinner while its agent works", async ({ page }) => {
  const chatPane = new ChatPanePage(page, server.url, TOKEN);
  const worktree = new WorktreePage(page, server.url, TOKEN);
  await chatPane.goto(CHAT_WS);
  await chatPane.waitForReady();

  await chatPane.typeMessage("start a long task");
  await chatPane.submit();
  await expect(chatPane.assistantMessage("working")).toBeVisible();

  // The shown chat tab shows its status too; hovering swaps in the close button.
  await expect(worktree.tabStatus("chat")).toHaveAttribute("data-status", "working");
  await worktree.movePointerAway();
  await expect(worktree.tabCloseButton("chat")).toHaveCSS("opacity", "0");
  await worktree.hoverTab("chat");
  await expect(worktree.tabCloseButton("chat")).toHaveCSS("opacity", "1");

  await worktree.activateTab("terminal");
  await expect(worktree.tabContainer("terminal")).toHaveAttribute("data-selected", "true");
  await expect(worktree.tabStatus("chat")).toHaveAttribute("data-status", "working");
  await expect(worktree.tabCloseButton("chat")).toHaveCSS("opacity", "0");

  // A turn the user stopped leaves nothing to show.
  await worktree.activateTab("chat");
  await chatPane.clickStop();
  await expect(chatPane.submitButton).toBeVisible();
  await worktree.activateTab("terminal");
  await expect(worktree.tabContainer("terminal")).toHaveAttribute("data-selected", "true");
  await expect(worktree.tabStatus("chat")).toHaveCount(0);
});

test("a hidden terminal tab shows its Claude Code session's status", async ({ page }) => {
  const chatPane = new ChatPanePage(page, server.url, TOKEN);
  const worktree = new WorktreePage(page, server.url, TOKEN);
  const cwd = join(tmpHome, "tabstatusterm");
  await chatPane.goto(TERM_WS);
  // Opens a chat and shows it, so the default terminal tab is hidden.
  await chatPane.waitForReady();
  await expect(worktree.tabContainer("chat")).toHaveAttribute("data-selected", "true");
  const terminalId = await worktree.firstTerminalTabId();
  expect(terminalId).not.toBe("");
  await expect(worktree.tabStatus("terminal")).toHaveCount(0);

  await worktree.reportTerminalHook({
    cwd,
    terminalId,
    sessionId: "tab-status-session",
    hook: { hook_event_name: "PreToolUse", tool_name: "Bash" },
  });
  await expect(worktree.tabStatus("terminal")).toHaveAttribute("data-status", "working");

  await worktree.reportTerminalHook({
    cwd,
    terminalId,
    sessionId: "tab-status-session",
    hook: { hook_event_name: "Stop" },
  });
  await expect(worktree.tabStatus("terminal")).toHaveAttribute("data-status", "done");

  // Showing the terminal keeps its status in the slot.
  await worktree.activateTab("terminal");
  await expect(worktree.tabContainer("terminal")).toHaveAttribute("data-selected", "true");
  await expect(worktree.tabStatus("terminal")).toHaveAttribute("data-status", "done");
  await worktree.hoverTab("terminal");
  await expect(worktree.tabCloseButton("terminal")).toHaveCSS("opacity", "1");
});

test("the Ctrl+Tab list shows a terminal's agent status and follows changes", async ({ page }) => {
  const chatPane = new ChatPanePage(page, server.url, TOKEN);
  const worktree = new WorktreePage(page, server.url, TOKEN);
  const focus = new CenterTabFocus(page);
  const cwd = join(tmpHome, "tabstatusterm");
  await chatPane.goto(TERM_WS);
  await chatPane.waitForReady();
  const terminalId = await worktree.firstTerminalTabId();
  await worktree.reportTerminalHook({
    cwd,
    terminalId,
    sessionId: "switcher-status-session",
    hook: { hook_event_name: "PreToolUse", tool_name: "Bash" },
  });
  await expect(worktree.tabStatus("terminal")).toHaveAttribute("data-status", "working");

  await focus.openSwitcher();
  await expect(focus.switcherStatus(terminalId)).toHaveAttribute("data-status", "working");

  // The row follows a change while the list is open.
  await worktree.reportTerminalHook({
    cwd,
    terminalId,
    sessionId: "switcher-status-session",
    hook: { hook_event_name: "Stop" },
  });
  await expect(focus.switcherStatus(terminalId)).toHaveAttribute("data-status", "done");
  await focus.pressEscapeWhileHeld();
  await focus.releaseControl();
});

test("the Ctrl+Tab list shows a chat's session title and working spinner", async ({ page }) => {
  const chatPane = new ChatPanePage(page, server.url, TOKEN);
  const worktree = new WorktreePage(page, server.url, TOKEN);
  const focus = new CenterTabFocus(page);
  await chatPane.goto(SWITCH_WS);
  await chatPane.waitForReady();
  await chatPane.typeMessage("start fixing the login redirect");
  await chatPane.submit();
  await expect(chatPane.assistantMessage("working")).toBeVisible();
  await worktree.activateTab("terminal");
  await expect(worktree.tabContainer("terminal")).toHaveAttribute("data-selected", "true");

  await focus.openSwitcher();
  const row = focus.switcherRow("start fixing the login redirect");
  await expect(row).toBeVisible();
  await expect(focus.rowStatus(row)).toHaveAttribute("data-status", "working");
  await focus.pressEscapeWhileHeld();
  await focus.releaseControl();
});
