/**
 * Adding and removing a worktree's labels from the sidebar card.
 *
 * Real production hub against a temp `~/.band/` with one real git repo. Labels are stored on the
 * hub, so a reload and a second window show them too.
 *
 * Covers: add and remove from the dialog, the tag icon on the card, a second page seeing the
 * change, and a bad key being refused with nothing changed.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
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
import { trpcMutate } from "./helpers/trpc";
import { WorktreeLabelsPage } from "./pages/WorktreeLabelsPage";
import { WorktreePage } from "./pages/WorktreePage";

const TOKEN = "e2e-worktree-labels-token";
const WORKTREE = "app-feat-x";

test.use({ viewport: { width: 1280, height: 900 } });
test.describe.configure({ mode: "serial" });

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const app = join(tmpHome, "app");
  mkdirSync(app, { recursive: true });
  gitInHome(app, ["init", "-b", "main"], tmpHome);
  writeFileSync(join(app, "README.md"), "# app\n");
  gitInHome(app, ["add", "."], tmpHome);
  gitInHome(app, ["commit", "-m", "initial"], tmpHome);
  const checkout = join(tmpHome, "feat-x-checkout");
  gitInHome(app, ["worktree", "add", "-b", "feat-x", checkout], tmpHome);
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  // A group makes the sidebar use the Groups layout, whose cards show the repo name under the title.
  seedState(tmpHome, {
    groups: [{ id: "g-alpha", name: "Alpha", color: "#8b5cf6" }],
    repos: [
      {
        name: "app",
        path: app,
        defaultBranch: "main",
        worktrees: [
          { branch: "main", path: app, groupId: "g-alpha" },
          { branch: "feat-x", path: checkout, groupId: "g-alpha" },
        ],
      },
    ],
  });
  server = await startServer({ tmpHome });
});

test.beforeEach(async () => {
  resetClientState(tmpHome);
  await trpcMutate(server.url, TOKEN, "worktrees.setLabels", {
    worktreeId: WORKTREE,
    remove: ["merge", "team"],
  });
});

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

async function open(page: Page) {
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  await worktreePage.goto(WORKTREE);
  await worktreePage.waitForWorktreeReady(WORKTREE);
  return new WorktreeLabelsPage(page);
}

const listed = async () => {
  const res = await fetch(`${server.url}/trpc/repos.list`, {
    headers: { Cookie: `band_token=${TOKEN}` },
  });
  const body = (await res.json()) as {
    result: {
      data: {
        repos: Array<{ worktrees: Array<{ worktreeId: string; labels: Record<string, string> }> }>;
      };
    };
  };
  return body.result.data.repos.flatMap((r) => r.worktrees).find((w) => w.worktreeId === WORKTREE)
    ?.labels;
};

test("S6: adding and removing a label shows on the card, the hub and a second window", async ({
  page,
  context,
}) => {
  const labels = await open(page);
  await expect(labels.badge(WORKTREE)).toHaveCount(0);
  await labels.open(WORKTREE);
  await labels.add("merge", "auto");
  await labels.close();
  await expect(labels.badge(WORKTREE)).toBeVisible();
  await expect.poll(listed).toEqual({ merge: "auto" });

  const second = await context.newPage();
  const other = await open(second);
  await expect(other.badge(WORKTREE)).toBeVisible();

  await labels.open(WORKTREE);
  await labels.remove("merge");
  await labels.close();
  await expect(labels.badge(WORKTREE)).toHaveCount(0);
  await expect.poll(listed).toEqual({});
  await expect(other.badge(WORKTREE)).toHaveCount(0);
});

test("a key the hub refuses shows an error and changes nothing", async ({ page }) => {
  const labels = await open(page);
  await labels.open(WORKTREE);
  await labels.add("team", "core");
  await labels.tryAdd("has space", "x");
  await expect(labels.error).toBeVisible();
  await expect.poll(listed).toEqual({ team: "core" });
});
