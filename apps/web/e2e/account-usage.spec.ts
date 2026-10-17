/**
 * The sidebar footer's Settings button is icon-only, and a usage button opens a
 * popover with the Claude and Codex account limits the hub reads from its own
 * logins. The hub runs for real with a Claude and a Codex login in its HOME and
 * the two usage endpoints stubbed (`fixtures/usage-stub.ts`).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { startUsageStub, type UsageStub } from "./fixtures/usage-stub";
import {
  cleanupTmpHome,
  createTmpHome,
  resetClientState,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { AccountUsagePage } from "./pages/AccountUsagePage";

const TOKEN = "e2e-account-usage-token";
const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
const claudeBody = (five: number, week: number, fable: number) => ({
  five_hour: {
    utilization: five,
    resets_at: new Date(Date.now() + 2 * 3_600_000 + 30_000).toISOString(),
  },
  seven_day: { utilization: week, resets_at: inHours(100) },
  seven_day_fable: { utilization: fable, resets_at: inHours(100) },
});

let server: ServerHandle;
let tmpHome: string;
let stub: UsageStub;

test.beforeAll(async () => {
  stub = await startUsageStub(claudeBody(17, 3, 0), {
    plan_type: "plus",
    rate_limit: {
      primary_window: { used_percent: 4, limit_window_seconds: 18000 },
      secondary_window: { used_percent: 1, limit_window_seconds: 604800 },
    },
  });
  tmpHome = createTmpHome();
  seedState(tmpHome, { repos: [] });
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  mkdirSync(join(tmpHome, ".claude"), { recursive: true });
  writeFileSync(
    join(tmpHome, ".claude", ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "e2e-claude-token", subscriptionType: "max" } }),
  );
  writeFileSync(
    join(tmpHome, ".claude.json"),
    JSON.stringify({ oauthAccount: { emailAddress: "me@example.com" } }),
  );
  mkdirSync(join(tmpHome, ".codex"), { recursive: true });
  writeFileSync(
    join(tmpHome, ".codex", "auth.json"),
    JSON.stringify({ tokens: { access_token: "e2e-codex-token" } }),
  );
  server = await startServer({
    tmpHome,
    env: {
      BAND_CLAUDE_USAGE_URL: stub.claudeUrl,
      BAND_CODEX_USAGE_URL: stub.codexUrl,
      BAND_USAGE_KEYCHAIN: "off",
    },
  });
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await server.close();
  await stub.close();
  cleanupTmpHome(tmpHome);
});

test("Settings is icon-only with a tooltip and the usage button sits beside the other footer icons", async ({
  page,
}) => {
  const usage = new AccountUsagePage(page, server.url, TOKEN);
  await usage.goto();

  await expect(usage.settingsButton).toBeVisible();
  await expect(usage.settingsButton).toHaveText("");
  await usage.settingsButton.hover();
  await expect(usage.settingsTooltip).toBeVisible();
  await expect(usage.usageButton).toBeVisible();
});

test("the popover lists Claude and Codex with plan, reset time and labelled bars", async ({
  page,
}) => {
  stub.setClaude(claudeBody(17, 3, 0));
  const usage = new AccountUsagePage(page, server.url, TOKEN);
  await usage.goto();
  await usage.open();

  const claude = usage.row("claude");
  await expect(claude).toContainText("Max");
  await expect(claude).toContainText("me@example.com");
  await expect(claude).toContainText(/Resets in 2h \d+m/);
  await expect(usage.bar("Claude", "5h")).toHaveAttribute("aria-valuenow", "17");
  await expect(usage.bar("Claude", "wk")).toHaveAttribute("aria-valuenow", "3");
  await expect(usage.bar("Claude", "Fable")).toHaveAttribute("aria-valuenow", "0");

  const codex = usage.row("codex");
  await expect(codex).toContainText("Plus");
  await expect(usage.bar("Codex", "5h")).toHaveAttribute("aria-valuenow", "4");
  await expect(usage.bar("Codex", "wk")).toHaveAttribute("aria-valuenow", "1");
});

test("Refresh reads past the cache and the button shows the highest percentage", async ({
  page,
}) => {
  stub.setClaude(claudeBody(17, 3, 0));
  const usage = new AccountUsagePage(page, server.url, TOKEN);
  await usage.goto();
  await usage.open();
  await expect(usage.bar("Claude", "5h")).toHaveAttribute("aria-valuenow", "17");

  // The hub's cached answer still says 17 until a refresh is asked for.
  stub.setClaude(claudeBody(92, 3, 0));
  const before = stub.claudeRequests();
  await usage.refresh();
  await expect(usage.bar("Claude", "5h")).toHaveAttribute("aria-valuenow", "92");
  expect(stub.claudeRequests()).toBeGreaterThan(before);
  await expect(usage.highestPercent).toHaveText("92%");
});
