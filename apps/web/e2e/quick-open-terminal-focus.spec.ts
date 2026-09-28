/**
 * A terminal that finishes connecting while Quick Open is open must leave the
 * typed query alone.
 *
 * A new terminal focuses itself when its socket first connects
 * (`terminal-cache.ts`). When that happened while the user typed in Quick
 * Open, the dialog's focus trap pulled focus back into the input with the
 * query selected, and the next keystroke replaced everything typed so far.
 * On a slow runner the default layout's first terminal connects late enough
 * to land mid-query, which is how `client-state-shared-tabs.spec.ts` opened
 * the wrong file. The terminal now leaves focus in an open dialog.
 *
 * The spec opens the new terminal with ⌘T while Quick Open is open, so the
 * connect lands between two parts of the query every run.
 *
 * Real server, no tRPC mocking, no route interception. The terminal socket
 * is only observed (its first frame), never altered.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorkspaceId } from "@/dashboard";
import { gitInHome as git } from "./helpers/git";
import {
  cleanupTmpHome,
  createTmpHome,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { WorkspacePage } from "./pages/WorkspacePage";

const TOKEN = "e2e-quick-open-terminal-focus-token";
const PROJECT = "quick-open-focus-repo";
const WORKSPACE = toWorkspaceId(PROJECT, "main");

test.use({ viewport: { width: 1280, height: 800 } });

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const repo = join(tmpHome, PROJECT);
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-b", "main"], tmpHome);
  for (const file of ["notes-alpha.txt", "notes-beta.txt"]) {
    writeFileSync(join(repo, file), `${file}\n`);
  }
  git(repo, ["add", "."], tmpHome);
  git(repo, ["commit", "-m", "initial"], tmpHome);
  seedState(tmpHome, {
    projects: [
      {
        name: PROJECT,
        path: repo,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: repo }],
      },
    ],
  });
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  server = await startServer({ tmpHome });
});

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

test("a terminal connecting while Quick Open is open keeps the typed query", async ({ page }) => {
  const workspacePage = new WorkspacePage(page, server.url, TOKEN);
  const connectedTerminals = workspacePage.trackConnectedTerminalSockets();
  await workspacePage.goto(WORKSPACE);
  await workspacePage.waitForReady();
  // The default layout's terminal connects first, so its focus grab can't
  // land in the middle of the steps below.
  await expect.poll(connectedTerminals).toBeGreaterThan(0);
  const before = connectedTerminals();

  await workspacePage.openQuickOpen();
  await workspacePage.typeQuickOpen("notes-");
  await workspacePage.pressNewTerminalShortcut();
  await expect.poll(connectedTerminals).toBeGreaterThan(before);
  await workspacePage.continueTypingQuickOpen("alpha.txt");

  await expect(workspacePage.quickOpenInput).toBeFocused();
  await expect(workspacePage.quickOpenInput).toHaveValue("notes-alpha.txt");
});
