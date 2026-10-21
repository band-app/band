/**
 * Settings > Workers: the command a coding agent runs as on one worker. An admin types a binary
 * name in the worker's row and the hub stores it; the row prints what the agent runs there and
 * whether the worker found the command on its PATH. Clearing the field goes back to the global
 * command. The launches themselves are covered in `apps/hub/tests/worker-agent-command.test.ts`.
 */

import { expect, test } from "@playwright/test";
import {
  cleanupTmpHome,
  createTmpHome,
  resetClientState,
  type ServerHandle,
  seedSettings,
  startServer,
} from "./helpers/server";
import { SettingsPage } from "./pages/SettingsPage";

const TOKEN = "e2e-hosts-agent-command-token";

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  seedSettings(tmpHome, {
    tokenSecret: TOKEN,
    codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
  });
  server = await startServer({ tmpHome });
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

test("an admin sets, sees and clears an agent command on a worker", async ({ page }) => {
  const settingsPage = new SettingsPage(page, server.url, TOKEN);
  await settingsPage.goto();
  await settingsPage.openDialog("hosts");

  await expect(settingsPage.hostAgentCommandEffective("local", "claude-code")).toHaveAttribute(
    "data-effective",
    "",
  );

  await settingsPage.setHostAgentCommand("local", "claude-code", "sh");
  await expect(settingsPage.hostAgentCommandEffective("local", "claude-code")).toHaveAttribute(
    "data-effective",
    "sh",
  );
  await expect(settingsPage.hostAgentCommandStatus("local", "claude-code")).toHaveAttribute(
    "data-state",
    "found",
  );

  await settingsPage.setHostAgentCommand("local", "claude-code", "no-such-claude-binary");
  await expect(settingsPage.hostAgentCommandEffective("local", "claude-code")).toHaveAttribute(
    "data-effective",
    "no-such-claude-binary",
  );
  await expect(settingsPage.hostAgentCommandNotFound("local", "claude-code")).toBeVisible();

  await settingsPage.clearHostAgentCommand("local", "claude-code");
  await expect(settingsPage.hostAgentCommandEffective("local", "claude-code")).toHaveAttribute(
    "data-effective",
    "",
  );
  await expect(settingsPage.hostAgentCommandNotFound("local", "claude-code")).toHaveCount(0);
});
