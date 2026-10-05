/**
 * The "New agent" menu starts agents in this device's mode (issue #682).
 *
 * Each browser keeps its own mode in localStorage (`band.agent-mode`). A
 * browser set to `gui` gets a chat tab from New agent; one set to `tui` gets
 * a terminal running the agent's CLI. Two browsers with different modes on
 * the same server each get their own kind of tab. The server default
 * (`agents.defaultMode`) is saved from Settings.
 *
 * Real production server, real PTYs. The agent's CLI is a shell stub
 * configured as the agent definition's `command`; GUI sessions run the ACP
 * stub agent that `startServer` wires in. The exact argv of a TUI launch is
 * pinned by the backend test (`tests/agent-sessions.test.ts`).
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
import { SettingsPage } from "./pages/SettingsPage";
import { WorktreePage } from "./pages/WorktreePage";

const TOKEN = "e2e-new-agent-menu-token";
const REPO = "agentproj";
const WORKTREE = toWorktreeId(REPO, "main");

test.use({ viewport: { width: 1280, height: 800 } });

let server: ServerHandle;
let tmpHome: string;

/** An agent CLI stub that prints `marker` and stays running. */
function writeAgentCliStub(name: string, marker: string): string {
  const path = join(tmpHome, name);
  writeFileSync(path, `#!/bin/sh\necho ${marker}\nexec sleep 600\n`);
  chmodSync(path, 0o755);
  return path;
}

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const repoDir = join(tmpHome, "repo");
  mkdirSync(repoDir, { recursive: true });
  const claudeCli = writeAgentCliStub("stub-claude.sh", "CLAUDE_STUB_STARTED");
  const codexCli = writeAgentCliStub("stub-codex.sh", "CODEX_STUB_STARTED");

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
  seedSettings(tmpHome, {
    tokenSecret: TOKEN,
    codingAgents: [
      { id: "claude-code", type: "claude-code", label: "Claude Code", command: claudeCli },
      { id: "codex", type: "codex", label: "Codex", command: codexCli },
    ],
    defaultCodingAgent: "claude-code",
    // The server default differs from the GUI browser's mode, so its chat
    // proves the browser sent its own mode.
    agents: { defaultMode: "tui" },
    // DOM renderer, so the terminal's text is readable from its rows.
    useWebGLTerminalRenderer: false,
  });
  server = await startServer({ tmpHome });
});

// UI state lives on the server now: start each test from none, like the
// fresh localStorage each test's browser context used to give it.
test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

test.describe("New agent menu", () => {
  test("two browsers with different modes each start agents in their own mode", async ({
    browser,
  }) => {
    const guiContext = await browser.newContext();
    const tuiContext = await browser.newContext();
    try {
      const gui = new WorktreePage(await guiContext.newPage(), server.url, TOKEN);
      const tui = new WorktreePage(await tuiContext.newPage(), server.url, TOKEN);

      await gui.goto(WORKTREE);
      await gui.setDeviceAgentMode("gui");
      await expect(gui.chatAddTabButton(WORKTREE)).toBeVisible();
      await expect(gui.terminalTabs()).toHaveCount(1);
      await expect(gui.chatTabs()).toHaveCount(0);

      await gui.startAgentViaMenu(WORKTREE);
      await expect(gui.chatTabs()).toHaveCount(1);
      await expect(gui.terminalTabs()).toHaveCount(1);

      // The second browser sees the first one's chat (live sync), then starts
      // its own agent as a terminal.
      await tui.goto(WORKTREE);
      await tui.setDeviceAgentMode("tui");
      await expect(tui.chatAddTabButton(WORKTREE)).toBeVisible();
      await expect(tui.chatTabs()).toHaveCount(1);
      await expect(tui.terminalTabs()).toHaveCount(1);

      await tui.startAgentViaMenu(WORKTREE, "codex");
      await expect(tui.terminalTabs()).toHaveCount(2);
      await expect(tui.chatTabs()).toHaveCount(1);
      await expect
        .poll(() => tui.readTerminalRenderedText(WORKTREE), { timeout: 15_000 })
        .toContain("CODEX_STUB_STARTED");

      // The GUI browser shows the new session in the mode it runs in.
      await expect(gui.terminalTabs()).toHaveCount(2);
      await expect(gui.chatTabs()).toHaveCount(1);
    } finally {
      await guiContext.close();
      await tuiContext.close();
    }
  });

  test("the Settings page saves this device's agent mode", async ({ page }) => {
    const settings = new SettingsPage(page, server.url, TOKEN);
    await settings.goto();
    await settings.openDialog("agents");
    await settings.selectDeviceAgentMode("tui");
    await expect.poll(() => settings.readDeviceAgentMode()).toBe("tui");
    await settings.selectDeviceAgentMode("gui");
    await expect.poll(() => settings.readDeviceAgentMode()).toBe("gui");
  });

  // Last: it changes the server default the first test relies on.
  test("the Settings page saves the default agent mode", async ({ page }) => {
    const settings = new SettingsPage(page, server.url, TOKEN);
    await settings.goto();
    await settings.openDialog("agents");
    await settings.selectDefaultAgentMode("gui");
    await settings.save();
    await expect
      .poll(() => {
        const saved = JSON.parse(readFileSync(join(tmpHome, ".band", "settings.json"), "utf-8"));
        return saved.agents?.defaultMode;
      })
      .toBe("gui");
  });
});
