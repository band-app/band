/**
 * A chat tab shows its agent's icon and the session's description (issue:
 * tabs showed no icon and the title "claude-code"). The "New agent" menu lists
 * every configured agent with its icon and marks the default. The Ctrl+Tab
 * list shows each row the way its tab does.
 *
 * Real production server, the ACP stub agent behind the chat, real Chromium
 * through page objects. The terminal row's status comes from Claude Code hooks
 * posted through the real `statuses.notify` mutation.
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

const TOKEN = "e2e-chat-tab-agent-identity-token";
const REPOS = ["identitytab", "identitymenu", "identityswitcher"];
const [TAB_WS, MENU_WS, SWITCHER_WS] = REPOS.map((p) => toWorktreeId(p, "main", "local"));
const RENAMED = "Login redirect fixed";

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
    codingAgents: [
      { id: "claude-code", type: "claude-code", label: "Claude Code" },
      { id: "codex", type: "codex", label: "Codex" },
    ],
    defaultCodingAgent: "claude-code",
    agents: { defaultMode: "gui" },
  });
  server = await startServer({
    tmpHome,
    env: acpStubEnv(tmpHome, {
      turns: [
        {
          match: "^rename",
          steps: [
            { say: "renamed " },
            { update: { sessionUpdate: "session_info_update", title: RENAMED } },
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

test("a new chat's tab shows the agent's icon and name until it has a session", async ({
  page,
}) => {
  const chatPane = new ChatPanePage(page, server.url, TOKEN);
  const worktree = new WorktreePage(page, server.url, TOKEN);
  await chatPane.goto(TAB_WS);
  await chatPane.waitForReady();

  await expect(worktree.chatTabAgentIcon("Claude")).toBeVisible();
  await expect(worktree.chatTabTitle()).toHaveText("Claude Code");
});

test("the tab title is the first prompt, then follows the agent's session title", async ({
  page,
}) => {
  const chatPane = new ChatPanePage(page, server.url, TOKEN);
  const worktree = new WorktreePage(page, server.url, TOKEN);
  await chatPane.goto(TAB_WS);
  await chatPane.waitForReady();

  await chatPane.typeMessage("Fix the login redirect");
  await chatPane.submit();
  await expect(chatPane.assistantMessage("done")).toBeVisible();
  await expect(worktree.chatTabTitle()).toHaveText("Fix the login redirect");
  await expect(worktree.chatTabAgentIcon("Claude")).toBeVisible();

  await chatPane.typeMessage("rename it");
  await chatPane.submit();
  await expect(worktree.chatTabTitle()).toHaveText(RENAMED);
});

test("New agent lists every configured agent with its icon and marks the default", async ({
  page,
}) => {
  const chatPane = new ChatPanePage(page, server.url, TOKEN);
  const worktree = new WorktreePage(page, server.url, TOKEN);
  await chatPane.goto(MENU_WS);
  await chatPane.waitForReady();

  await worktree.openNewAgentMenu(MENU_WS);
  await expect(worktree.newAgentItem("claude-code")).toHaveAttribute("data-default", "true");
  await expect(worktree.newAgentItemIcon("claude-code", "Claude")).toBeVisible();
  await expect(worktree.newAgentItem("codex")).not.toHaveAttribute("data-default", "true");
  await expect(worktree.newAgentItemIcon("codex", "Codex")).toBeVisible();
  await expect(worktree.newAgentFallbackItem()).toHaveCount(0);
});

test("the Ctrl+Tab list shows a chat's icon, title and spinner and a terminal's question mark", async ({
  page,
}) => {
  const chatPane = new ChatPanePage(page, server.url, TOKEN);
  const worktree = new WorktreePage(page, server.url, TOKEN);
  const focus = new CenterTabFocus(page);
  const cwd = join(tmpHome, "identityswitcher");
  await chatPane.goto(SWITCHER_WS);
  await chatPane.waitForReady();
  await chatPane.typeMessage("start fixing the login redirect");
  await chatPane.submit();
  await expect(chatPane.assistantMessage("working")).toBeVisible();

  const terminalId = await worktree.firstTerminalTabId();
  await worktree.reportTerminalHook({
    cwd,
    terminalId,
    sessionId: "identity-switcher-session",
    hook: { hook_event_name: "PreToolUse", tool_name: "AskUserQuestion" },
  });
  await expect(worktree.tabStatus("terminal")).toHaveAttribute("data-status", "question");
  await worktree.activateTab("terminal");
  await expect(worktree.tabContainer("terminal")).toHaveAttribute("data-selected", "true");

  await focus.openSwitcher();
  const chatRow = focus.switcherRow("start fixing the login redirect");
  await expect(chatRow).toBeVisible();
  await expect(focus.rowAgentIcon(chatRow, "Claude")).toBeVisible();
  await expect(focus.rowStatus(chatRow)).toHaveAttribute("data-status", "working");
  await expect(focus.switcherStatus(terminalId)).toHaveAttribute("data-status", "question");
  await focus.pressEscapeWhileHeld();
  await focus.releaseControl();
});
