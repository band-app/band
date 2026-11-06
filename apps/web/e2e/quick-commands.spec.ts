/**
 * Quick commands: save a terminal command or an agent prompt once, run it from the tab bar menu or a
 * terminal's right-click menu, and manage them in Settings.
 *
 * Real production hub against a temp `~/.band/` with two repos (`band` and `other`), a real shell in
 * the terminals and the scripted ACP stub as the coding agent.
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
import { trpcMutate } from "./helpers/trpc";
import { ChatPanePage } from "./pages/ChatPanePage";
import { QuickCommandsPage } from "./pages/QuickCommandsPage";

const TOKEN = "e2e-quick-commands-token";
const BAND = toWorktreeId("band", "main", "local");
const OTHER = toWorktreeId("other", "main", "local");

test.use({ viewport: { width: 1280, height: 800 } });
test.describe.configure({ mode: "serial" });

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const dirs = Object.fromEntries(
    ["band", "other"].map((name) => {
      const dir = join(tmpHome, name);
      mkdirSync(dir, { recursive: true });
      return [name, dir];
    }),
  );
  seedState(tmpHome, {
    repos: ["band", "other"].map((name) => ({
      name,
      path: dirs[name],
      defaultBranch: "main",
      worktrees: [{ branch: "main", path: dirs[name] }],
    })),
  });
  seedSettings(tmpHome, {
    tokenSecret: TOKEN,
    codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
    defaultCodingAgent: "claude-code",
  });
  server = await startServer({
    tmpHome,
    env: acpStubEnv(tmpHome, { turns: [{ match: "say hi", steps: [{ say: "hi there" }] }] }),
  });
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

const create = (input: object) => trpcMutate(server.url, TOKEN, "quickCommands.create", input);

test("S1: the dialog saves a terminal command scoped to the worktree's repo", async ({
  page,
}, testInfo) => {
  const qc = new QuickCommandsPage(page, server.url, TOKEN);
  await qc.goto(BAND);
  await qc.openAddDialogFromMenu();
  await expect(qc.saveButton).toBeDisabled();
  await expect(qc.advancedSummary()).toContainText("band");
  await testInfo.attach("add-quick-command-dialog", {
    body: await qc.screenshot(),
    contentType: "image/png",
  });

  await qc.fillTerminalCommand({
    label: "Start dev server",
    command: "echo QC_RAN_$((40+2))",
    appendEnter: true,
  });
  await expect(qc.saveButton).toBeEnabled();
  await qc.save(true);

  await qc.openMenu();
  await expect(qc.menuItem("Start dev server")).toBeVisible();
});

test("S2: the menu runs a terminal command in a new tab and respects scope", async ({ page }) => {
  await create({
    label: "Everywhere",
    repo: null,
    action: "terminal",
    command: "echo GLOBAL_RAN",
    appendEnter: true,
  });
  await create({
    label: "Only band",
    repo: "band",
    action: "terminal",
    command: "echo BAND_ONLY",
    appendEnter: true,
  });
  const qc = new QuickCommandsPage(page, server.url, TOKEN);

  await qc.goto(OTHER);
  await qc.openMenu();
  await expect(qc.menuItem("Everywhere")).toBeVisible();
  await expect(qc.menuItem("Only band")).toHaveCount(0);
  await expect(qc.menuItem("Start dev server")).toHaveCount(0);
  await qc.closeMenu();

  await qc.goto(BAND);
  await qc.pick("Start dev server");
  await expect.poll(() => qc.terminalScreens(), { timeout: 30_000 }).toContain("QC_RAN_42");
});

test("S3: Append Enter off types the text at the prompt without running it", async ({ page }) => {
  await create({
    label: "Typed only",
    repo: "band",
    action: "terminal",
    command: "echo TYPED_$((1+1))",
    appendEnter: false,
  });
  const qc = new QuickCommandsPage(page, server.url, TOKEN);
  await qc.goto(BAND);
  // Open a fresh terminal first, so the right-click lands on a terminal this test owns.
  await qc.pick("Everywhere");
  await expect.poll(() => qc.terminalScreens(), { timeout: 30_000 }).toContain("GLOBAL_RAN");
  await qc.openTerminalSubmenu();
  await qc.terminalSubmenuItem("Typed only").click();
  await expect
    .poll(() => qc.terminalScreens(), { timeout: 30_000 })
    .toContain("echo TYPED_$((1+1))");
  const lines = (await qc.terminalScreens()).split("\n").map((l) => l.trim());
  expect(lines).not.toContain("TYPED_2");
});

test("S4: an agent command starts a chat with its prompt", async ({ page }) => {
  await create({
    label: "Say hi",
    repo: "band",
    action: "agent",
    agentId: "claude-code",
    prompt: "say hi",
  });
  const qc = new QuickCommandsPage(page, server.url, TOKEN);
  const chat = new ChatPanePage(page, server.url, TOKEN);
  await qc.goto(BAND);
  await qc.pick("Say hi");
  await expect(chat.userMessage("say hi")).toBeVisible({ timeout: 30_000 });
  await expect(chat.assistantMessage("hi there")).toBeVisible();
});

test("S6: Save stays disabled while the form is invalid", async ({ page }) => {
  const qc = new QuickCommandsPage(page, server.url, TOKEN);
  await qc.goto(BAND);
  await qc.openAddDialogFromMenu();
  await qc.fillTerminalCommand({ label: "x".repeat(81), command: "ls", appendEnter: true });
  await expect(qc.saveButton).toBeDisabled();
  await qc.fillTerminalCommand({ label: "ok", command: "   ", appendEnter: true });
  await expect(qc.saveButton).toBeDisabled();
  await qc.fillTerminalCommand({ label: "ok", command: "ls", appendEnter: true });
  await expect(qc.saveButton).toBeEnabled();
});

test("S7: Settings lists, searches and deletes quick commands", async ({ page }) => {
  const qc = new QuickCommandsPage(page, server.url, TOKEN);
  await qc.openSettings();
  await expect(qc.settingsRow("Only band")).toContainText("band");
  await expect(qc.settingsRow("Everywhere")).toContainText("All repos");
  await expect(qc.settingsRow("Say hi")).toContainText("Claude Code");

  await qc.editFromSettings("Say hi", "Greet");
  await expect(qc.settingsRow("Greet")).toBeVisible();

  await qc.searchSettings("typed");
  await expect(qc.settingsRows()).toHaveCount(1);
  await qc.deleteFromSettings("Typed only");
  await expect(qc.settingsRows()).toHaveCount(0);
});
