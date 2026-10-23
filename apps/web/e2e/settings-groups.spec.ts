/**
 * Settings > Groups: create, rename, recolor, reorder (drag, menu, Alt+arrows) and delete worktree
 * groups, with the sidebar following, and the repo settings page without the Label picker it used to have.
 *
 * Real production hub against a temp `~/.band/` with two real git repos. Two groups are seeded:
 * One holds app's main worktree and Two holds lib's. Every Groups control saves at once.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { gitInHome } from "./helpers/git";
import {
  cleanupTmpHome,
  createTmpHome,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { trpcQuery } from "./helpers/trpc";
import { SettingsPage } from "./pages/SettingsPage";
import { SidebarGroupsPage, UNGROUPED } from "./pages/SidebarGroupsPage";
import { WorktreePage } from "./pages/WorktreePage";

const TOKEN = "e2e-settings-groups-token";
const ONE = "grp_one";
const TWO = "grp_two";

test.use({ viewport: { width: 1280, height: 800 } });
test.describe.configure({ mode: "serial" });

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const makeRepo = (name: string) => {
    const path = join(tmpHome, name);
    mkdirSync(path, { recursive: true });
    gitInHome(path, ["init", "-b", "main"], tmpHome);
    writeFileSync(join(path, "README.md"), `# ${name}\n`);
    gitInHome(path, ["add", "."], tmpHome);
    gitInHome(path, ["commit", "-m", "initial"], tmpHome);
    return path;
  };
  const app = makeRepo("app");
  const lib = makeRepo("lib");
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  seedState(tmpHome, {
    groups: [
      { id: ONE, name: "One", color: "#8b5cf6" },
      { id: TWO, name: "Two", color: "#3b82f6" },
    ],
    repos: [
      {
        name: "app",
        path: app,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: app, groupId: ONE }],
      },
      {
        name: "lib",
        path: lib,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: lib, groupId: TWO }],
      },
    ],
  });
  server = await startServer({ tmpHome });
});

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

async function groupRowIds(settings: SettingsPage): Promise<string[]> {
  return settings
    .groupRows()
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-group-id") ?? ""));
}

test("creating, renaming, recoloring and reordering groups shows in the sidebar (S8)", async ({
  page,
}) => {
  const settings = new SettingsPage(page, server.url, TOKEN);
  const sidebar = new SidebarGroupsPage(page);
  await new WorktreePage(page, server.url, TOKEN).goto("app-main");
  await settings.openDialog("groups");
  await expect.poll(() => groupRowIds(settings)).toEqual([ONE, TWO]);

  await settings.addGroup("Three");
  await expect.poll(async () => (await groupRowIds(settings)).length).toBe(3);
  const three = (await groupRowIds(settings))[2];
  await expect(settings.groupNameInput(three)).toHaveText("Three");

  await settings.renameGroup(ONE, "Uno");
  await settings.setGroupColor(TWO, "red");
  await settings.moveGroup(three, "up");
  await expect.poll(() => groupRowIds(settings)).toEqual([ONE, three, TWO]);

  // The server holds all of it.
  await expect
    .poll(
      async () => (await trpcQuery<{ groups: unknown[] }>(server.url, TOKEN, "groups.list")).groups,
    )
    .toEqual([
      { id: ONE, name: "Uno", color: "#8b5cf6" },
      { id: three, name: "Three", color: expect.any(String) },
      { id: TWO, name: "Two", color: "#ef4444" },
    ]);

  // And so does the sidebar.
  await settings.closeDialog();
  await expect.poll(() => sidebar.headerOrder()).toEqual([ONE, three, TWO]);
  await expect(sidebar.groupHeader(ONE)).toContainText("Uno");
  await expect(sidebar.groupHeader(three)).toContainText("Three");
  await expect(sidebar.groupDot(TWO)).toHaveCSS("background-color", "rgb(239, 68, 68)");
  await expect
    .poll(() => sidebar.sections())
    .toEqual({
      [ONE]: ["0:app-main"],
      [three]: [],
      [TWO]: ["0:lib-main"],
      [UNGROUPED]: [],
    });
});

test("deleting a group leaves its worktrees ungrouped (S8)", async ({ page }) => {
  const settings = new SettingsPage(page, server.url, TOKEN);
  const sidebar = new SidebarGroupsPage(page);
  await new WorktreePage(page, server.url, TOKEN).goto("app-main");
  await settings.openDialog("groups");
  await settings.deleteGroup(ONE);
  await expect(settings.groupRow(ONE)).toHaveCount(0);

  await settings.closeDialog();
  await expect(sidebar.groupHeader(ONE)).toHaveCount(0);
  await expect(sidebar.groupHeader(UNGROUPED)).toHaveCount(0);
  await expect.poll(async () => (await sidebar.sections())[UNGROUPED]).toEqual(["0:app-main"]);
  await expect.poll(async () => (await sidebar.sections())[TWO]).toEqual(["0:lib-main"]);
});

test("the repo settings page has no Label picker (S8)", async ({ page }) => {
  const settings = new SettingsPage(page, server.url, TOKEN);
  await settings.goto();
  await settings.openRepoSettings("app");
  await expect(settings.repoPage("app")).toBeVisible();
  // The page has rendered its sections before the absence means anything.
  await expect(settings.repoUrl("app")).toBeVisible();
  await expect(settings.repoLabelPicker("app")).toHaveCount(0);
});

test("S13: each row shows only the handle, color dot, name and menu, with no swatches or arrows", async ({
  page,
}, testInfo) => {
  const settings = new SettingsPage(page, server.url, TOKEN);
  await new WorktreePage(page, server.url, TOKEN).goto("lib-main");
  await settings.openDialog("groups");
  await expect(settings.groupRowButtons(TWO)).toHaveCount(4);
  await expect(settings.groupMenuItem("move-up")).toHaveCount(0);
  await expect(settings.groupNameInput(TWO)).toHaveText("Two");
  await testInfo.attach("settings-groups.png", {
    body: await settings.dialog.screenshot(),
    contentType: "image/png",
  });
});

test("S13: a bad name shows an error icon, and Escape cancels the edit", async ({ page }) => {
  const settings = new SettingsPage(page, server.url, TOKEN);
  await new WorktreePage(page, server.url, TOKEN).goto("lib-main");
  await settings.openDialog("groups");
  await settings.groupNameInput(TWO).click();
  const field = settings.groupNameField(TWO);
  await field.fill("");
  await expect(settings.groupNameError).toBeVisible();
  await field.fill("three");
  await expect(settings.groupNameError).toBeVisible();
  await field.press("Escape");
  await expect(field).toHaveCount(0);
  await expect(settings.groupNameInput(TWO)).toHaveText("Two");
});

test("S13: groups reorder by dragging the handle and with Alt+arrows, and the order is saved", async ({
  page,
}) => {
  const settings = new SettingsPage(page, server.url, TOKEN);
  await new WorktreePage(page, server.url, TOKEN).goto("lib-main");
  await settings.openDialog("groups");
  const three = (await groupRowIds(settings))[0];
  expect([three, TWO]).toEqual(await groupRowIds(settings));

  await settings.dragGroupRow(three, TWO);
  await expect.poll(() => groupRowIds(settings)).toEqual([TWO, three]);
  await expect
    .poll(async () =>
      (await trpcQuery<{ groups: { id: string }[] }>(server.url, TOKEN, "groups.list")).groups.map(
        (g) => g.id,
      ),
    )
    .toEqual([TWO, three]);

  await settings.pressOnGroupRow(three, "Alt+ArrowUp");
  await expect.poll(() => groupRowIds(settings)).toEqual([three, TWO]);
  await settings.pressOnGroupRow(three, "Alt+ArrowDown");
  await expect.poll(() => groupRowIds(settings)).toEqual([TWO, three]);

  // The first group's menu can't move it up.
  await settings.openGroupRowMenu(TWO);
  await expect(settings.groupMenuItem("move-up")).toBeDisabled();
  await page.keyboard.press("Escape");
});

test("S13: New group adds a row with the name field focused, and Escape on it removes it", async ({
  page,
}) => {
  const settings = new SettingsPage(page, server.url, TOKEN);
  await new WorktreePage(page, server.url, TOKEN).goto("lib-main");
  await settings.openDialog("groups");
  await settings.addGroupButton().click();
  await expect(settings.newGroupRow).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(settings.newGroupRow).toHaveCount(0);
  await expect.poll(async () => (await groupRowIds(settings)).length).toBe(2);
});

test("S13: deleting an empty group needs no confirmation, one with worktrees asks first, and the last one leaves an empty state", async ({
  page,
}) => {
  const settings = new SettingsPage(page, server.url, TOKEN);
  await new WorktreePage(page, server.url, TOKEN).goto("lib-main");
  await settings.openDialog("groups");
  const [first, second] = await groupRowIds(settings);
  // `three` is empty and `TWO` holds lib-main, whichever order the earlier test left them in.
  const empty = first === TWO ? second : first;
  await settings.deleteGroup(empty, false);
  await expect(settings.groupRow(empty)).toHaveCount(0);

  await settings.deleteGroup(TWO);
  await expect(settings.groupRow(TWO)).toHaveCount(0);
  await expect(settings.dialog.getByTestId("settings-groups__empty")).toBeVisible();
});
