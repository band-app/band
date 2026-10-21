/**
 * Settings > Agent logins: add Claude Code logins (the secret is write-only), choose a default,
 * override it for one repo, pick one for a chat, and remove one. Real hub, temp BAND_HOME. The
 * ACP stub agent records which credential variables Band gave it, so the last test checks that
 * the chat's pick reached the agent. `apps/hub/tests/agent-logins.test.ts` covers the rules.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorktreeId } from "@/dashboard";
import { acpStubEnv, type StubRequest, stubRequests } from "./helpers/acp-stub";
import {
  cleanupTmpHome,
  createTmpHome,
  resetClientState,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { trpcMutateData } from "./helpers/trpc";
import { ChatPanePage } from "./pages/ChatPanePage";
import { SettingsPage } from "./pages/SettingsPage";

test.use({ viewport: { width: 1280, height: 800 } });

const TOKEN = "e2e-agent-logins-token";
const TEAM_SECRET = "sk-ant-oat01-E2E-TEAM-SECRET-111";
const SPARE_SECRET = "sk-ant-oat01-E2E-SPARE-SECRET-222";

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const repoDir = join(tmpHome, "logins");
  mkdirSync(repoDir, { recursive: true });
  seedState(tmpHome, {
    repos: [
      {
        name: "logins",
        path: repoDir,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: repoDir }],
      },
    ],
  });
  seedSettings(tmpHome, {
    tokenSecret: TOKEN,
    defaultCodingAgent: "claude-code",
    codingAgents: [
      { id: "claude-code", type: "claude-code", label: "Claude Code" },
      { id: "codex", type: "codex", label: "Codex" },
    ],
  });
  server = await startServer({
    tmpHome,
    env: {
      ...acpStubEnv(tmpHome),
      BAND_TEST_ACP_LOG_ENV: "CLAUDE_CODE_OAUTH_TOKEN",
    },
  });
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

test("adds, defaults, overrides and removes a login without ever showing its secret", async ({
  page,
}) => {
  const settingsPage = new SettingsPage(page, server.url, TOKEN);
  await settingsPage.goto();
  await settingsPage.openDialog("agent-logins");

  // The setup token kind says what it cannot do.
  await expect(settingsPage.agentLoginNote()).toBeVisible();
  // A Codex key login is used only where Codex has no login of its own.
  await expect(settingsPage.agentLoginCodexNote()).toContainText("no Codex login of their own");

  await settingsPage.addAgentLogin("claude-code", "setup-token", "Team", TEAM_SECRET);
  await settingsPage.addAgentLogin("claude-code", "setup-token", "Spare", SPARE_SECRET);
  const team = settingsPage.agentLoginRow("Team");
  await settingsPage.expectRowVisible(team);
  await expect(team).toContainText("CLAUDE_CODE_OAUTH_TOKEN");
  await expect(settingsPage.dialog).not.toContainText(TEAM_SECRET);
  await expect(settingsPage.dialog).not.toContainText(SPARE_SECRET);

  // The secret is a vault item, which Credentials lists by name only.
  await settingsPage.openSection("credentials");
  await expect(settingsPage.dialog).not.toContainText(TEAM_SECRET);
  await settingsPage.openSection("agent-logins");

  await settingsPage.setAgentLoginDefault("claude-code", "Team");
  await expect.poll(() => settingsPage.agentLoginDefaultLabel("claude-code")).toBe("Team");

  // A repo can use another login than the default, on its repo page.
  await settingsPage.openRepoSettings("logins");
  const override = settingsPage.repoLoginOverride("claude-code", "logins");
  await settingsPage.expectRowVisible(override);
  // Codex takes logins but has none, so its row has no picker, only where to add one.
  await expect(settingsPage.repoLoginRows("logins")).toHaveCount(2);
  await expect(settingsPage.repoLoginOverride("codex", "logins")).toHaveCount(0);
  await settingsPage.setRepoLoginOverride("claude-code", "logins", "Spare");
  // The override shows after a reload, marked with a chip.
  await settingsPage.goto();
  await settingsPage.openRepoSettings("logins");
  await expect(settingsPage.repoLoginOverrideChip("logins")).toBeVisible();
  await expect
    .poll(() => settingsPage.repoLoginOverrideLabel("claude-code", "logins"))
    .toBe("Spare");

  await settingsPage.openSection("agent-logins");
  await settingsPage.removeAgentLogin("Spare");
  await expect(settingsPage.agentLoginRow("Spare")).toHaveCount(0);
  // Removing a login clears the override that used it.
  await settingsPage.openRepoSettings("logins");
  await expect(override).toHaveValue("");
  await expect(settingsPage.repoLoginOverrideChip("logins")).toHaveCount(0);
});

test("a chat can pick a login, and the agent gets it", async ({ page }) => {
  const settingsPage = new SettingsPage(page, server.url, TOKEN);
  await settingsPage.goto();
  await settingsPage.openDialog("agent-logins");
  await settingsPage.addAgentLogin("claude-code", "setup-token", "Picked", SPARE_SECRET);

  const chatPane = new ChatPanePage(page, server.url, TOKEN);
  await chatPane.goto(toWorktreeId("logins", "main", "local"));
  await chatPane.waitForReady();
  await expect(chatPane.loginMenuButton).toBeVisible();
  await chatPane.selectLogin("Picked");
  await expect(chatPane.loginMenuCurrent).toHaveText("Picked");

  await chatPane.typeMessage("hello");
  await chatPane.submit();
  await expect(chatPane.assistantMessage('Heard "hello"')).toBeVisible();
  const started = stubRequests(tmpHome, "session/new").at(-1) as
    | (StubRequest & { env?: { NAMED?: Record<string, string | null> } })
    | undefined;
  expect(started?.env?.NAMED?.CLAUDE_CODE_OAUTH_TOKEN).toBe(SPARE_SECRET);
});

test("a token without the admin flag sees a notice instead of the logins", async ({ page }) => {
  const { token: plain } = await trpcMutateData<{ token: string }>(
    server.url,
    TOKEN,
    "tokens.createDevice",
    { label: "e2e plain agent-logins device" },
  );
  const settingsPage = new SettingsPage(page, server.url, plain);
  await settingsPage.goto();
  await settingsPage.openDialog("agent-logins");

  await expect(settingsPage.agentLoginsDenied()).toBeVisible();
  await expect(settingsPage.agentLoginRow("Team")).toHaveCount(0);
});
