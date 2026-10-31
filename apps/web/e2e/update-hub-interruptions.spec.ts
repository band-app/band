/**
 * Update hub while an agent turn runs: the button opens a dialog that lists the turn, and nothing
 * runs until the admin confirms. With no turn running the update starts at once
 * (`update-hub.spec.ts` covers that). The turn is the ACP stub blocked until cancelled.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  type ReleasesStub,
  startReleasesStub,
} from "../../hub/tests/fixtures/github-releases-stub";
import { acpStubEnv } from "./helpers/acp-stub";
import {
  cleanupTmpHome,
  createTmpHome,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { UpdatePanelPage } from "./pages/UpdatePanelPage";

const TOKEN = "e2e-update-hub-interruptions-token";
const REPO = "busyproj";
const WORKTREE = `${REPO}-main`;

let releases: ReleasesStub;
let server: ServerHandle;
let tmpHome: string;
let record: string;

test.beforeAll(async () => {
  releases = await startReleasesStub("v9.0.0");
  tmpHome = createTmpHome();
  const repoDir = join(tmpHome, "repo");
  mkdirSync(repoDir, { recursive: true });
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
  record = join(tmpHome, "ran");
  const script = join(tmpHome, "update-hub.sh");
  writeFileSync(script, `touch ${record}\n`);
  seedSettings(tmpHome, {
    tokenSecret: TOKEN,
    codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
    hubUpdate: { command: `sh ${script}` },
  });
  server = await startServer({
    tmpHome,
    env: {
      ...acpStubEnv(tmpHome, {
        turns: [{ steps: [{ say: "working " }, { waitForCancel: true }] }],
      }),
      BAND_GITHUB_API_URL: releases.url,
      BAND_INSTALL_METHOD: "npm",
      BAND_HUB_VERSION: "0.50.0",
    },
  });
});

test.afterAll(async () => {
  await server?.close();
  await releases?.close();
  cleanupTmpHome(tmpHome);
});

test("Update hub lists the running turn and waits for the confirm", async ({ page }) => {
  const res = await fetch(`${server.url}/api/chats/busy-chat/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `band_token=${TOKEN}` },
    body: JSON.stringify({ worktreeId: WORKTREE, text: "long task" }),
  });
  expect(res.ok).toBe(true);

  await expect
    .poll(async () => {
      const r = await fetch(`${server.url}/trpc/workers.hubInterruptions`, {
        headers: { Cookie: `band_token=${TOKEN}` },
      });
      const body = (await r.json()) as { result?: { data: { agents: { busy: boolean }[] } } };
      return body.result?.data.agents.some((a) => a.busy) ?? false;
    })
    .toBe(true);

  const update = new UpdatePanelPage(page, server.url, TOKEN);
  await update.goto();
  await update.openPanel();
  await expect(update.hubUpdateButton()).toBeVisible();
  await update.clickUpdateHub();
  await expect(update.hubUpdateDialog()).toBeVisible();
  await expect(update.hubUpdateAgents()).toHaveCount(1);
  await expect(update.hubUpdateAgents()).toContainText(WORKTREE);
  expect(existsSync(record)).toBe(false);

  await update.confirmHubUpdate();
  await expect.poll(() => existsSync(record)).toBe(true);
});
