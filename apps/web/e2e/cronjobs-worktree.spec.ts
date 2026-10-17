/**
 * Cronjobs belong to a worktree and can name an agent and an agent session.
 *
 * Real production binary, no tRPC mocks, page objects only. The dialog lists the default-branch
 * worktree first, will not save without a worktree, and the job list shows each job's worktree,
 * agent and session.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { gitInHome } from "./helpers/git";
import {
  cleanupTmpHome,
  createTmpHome,
  resetClientState,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { CronjobsDialog } from "./pages/CronjobsDialog";

const TOKEN = "e2e-cronjobs-worktree-token";

test.use({ viewport: { width: 1280, height: 800 } });

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const path = join(tmpHome, "ticker");
  mkdirSync(path, { recursive: true });
  gitInHome(path, ["init", "-b", "main"], tmpHome);
  gitInHome(path, ["commit", "--allow-empty", "-m", "init"], tmpHome);
  const featPath = join(tmpHome, "ticker-feat");
  gitInHome(path, ["worktree", "add", "-b", "feat", featPath], tmpHome);
  seedState(tmpHome, {
    repos: [
      {
        name: "ticker",
        path,
        defaultBranch: "main",
        worktrees: [
          { branch: "feat", path: featPath },
          { branch: "main", path },
        ],
      },
    ],
  });
  seedSettings(tmpHome, {
    tokenSecret: TOKEN,
    codingAgents: [
      { id: "claude-code", type: "claude-code", label: "Claude Code" },
      { id: "codex", type: "codex", label: "Codex" },
    ],
  });
  server = await startServer({ tmpHome });
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await server?.close();
  cleanupTmpHome(tmpHome);
});

test.describe("cronjobs belong to a worktree", () => {
  test("a person picks a worktree, an agent and a session, and the list shows them", async ({
    page,
  }) => {
    const cronjobs = new CronjobsDialog(page, server.url, TOKEN);
    await cronjobs.goto();
    await cronjobs.open();
    await cronjobs.openNewCronjob();

    await cronjobs.fillBasics({
      name: "Pinned loop",
      prompt: "check the board",
      cron: "0 * * * *",
    });
    // No worktree yet: the job cannot be saved.
    await expect(cronjobs.saveButton).toBeDisabled();

    await cronjobs.repoSelect.click();
    await cronjobs.repoOption("ticker").click();
    // The default-branch worktree is listed first.
    const options = await cronjobs.worktreeOptions();
    expect(options[0]).toBe("main (default branch)");
    expect(options).toContain("feat");
    await page.getByRole("option", { name: "feat" }).click();

    await cronjobs.pickAgent("Codex");
    await cronjobs.sessionInput.fill("sess-42");
    await expect(cronjobs.saveButton).toBeEnabled();
    await cronjobs.saveButton.click();

    const card = cronjobs.job("Pinned loop");
    await expect(card).toBeVisible();
    await expect(card.getByTestId("cronjobs__job-worktree")).toHaveText("ticker-feat");
    await expect(card.getByTestId("cronjobs__job-agent")).toHaveText("codex");
    await expect(card.getByTestId("cronjobs__job-session")).toContainText("sess-42");
  });

  test("a job on the default-branch worktree with no agent shows the default agent", async ({
    page,
  }) => {
    const cronjobs = new CronjobsDialog(page, server.url, TOKEN);
    await cronjobs.goto();
    await cronjobs.open();
    await cronjobs.openNewCronjob();

    await cronjobs.fillBasics({ name: "Main watch", prompt: "watch main", cron: "30 * * * *" });
    await cronjobs.pickWorktree("ticker", "main (default branch)");
    await cronjobs.saveButton.click();

    const card = cronjobs.job("Main watch");
    await expect(card.getByTestId("cronjobs__job-worktree")).toHaveText("ticker-main");
    await expect(card.getByTestId("cronjobs__job-agent")).toHaveText("default agent");
    await expect(card.getByTestId("cronjobs__job-session")).toHaveCount(0);
  });
});
