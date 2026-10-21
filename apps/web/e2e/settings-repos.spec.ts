/**
 * Settings > Repos: the overview of every repo and one page per repo. The overview lists each
 * repo's remote, allowed workers, worktree count, checkpoints and login overrides, and its filter
 * has focus so typing a name and pressing Enter opens that repo. A repo page saves its label and
 * workers through the existing procedures, lists the MCP servers and cronjobs that reach the repo,
 * and keeps Remove disabled while the repo has worktrees.
 *
 * Real production hub with a temp BAND_HOME. The repos are seeded rows (one added by URL with a
 * local bare repo as its remote); the hub's own host is the worker a repo is limited to.
 */

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toWorktreeId } from "@band-app/shared/worktree-id";
import { expect, test } from "@playwright/test";
import { gitInHome as git } from "./helpers/git";
import {
  cleanupTmpHome,
  createTmpHome,
  resetClientState,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { trpcMutate, trpcMutateData, trpcQuery } from "./helpers/trpc";
import { CronjobsDialog } from "./pages/CronjobsDialog";
import { SettingsPage } from "./pages/SettingsPage";

const TOKEN = "e2e-settings-repos-token";
const BUSY = "alpha-busy";
const LIMITED = "beta-limited";
const REMOTE = "gamma-remote";
const LABEL_WORK = "lbl_e2e_work";
const LABEL_HOME = "lbl_e2e_home";
const FEATURE = "feat/one";
const MCP_SCOPED = "scoped-to-alpha";
const MCP_ALL = "for-every-repo";
const CRON_NAME = "nightly-alpha";

let server: ServerHandle;
let tmpHome: string;
let remotesDir: string;
let remoteUrl: string;
let cronId: string;
let offlineHostId: string;

interface RepoRow {
  name: string;
  label?: string | null;
  allowedHostIds: string[] | null;
  primaryHostId: string | null;
}
const repoRow = async (name: string) =>
  (await trpcQuery<{ repos: RepoRow[] }>(server.url, TOKEN, "repos.list")).repos.find(
    (r) => r.name === name,
  );

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  remotesDir = realpathSync(mkdtempSync(join(tmpdir(), "band-e2e-settings-repos-")));
  remoteUrl = join(remotesDir, `${REMOTE}.git`);
  git(remotesDir, ["init", "--bare", "-b", "main", remoteUrl], remotesDir);

  seedSettings(tmpHome, {
    tokenSecret: TOKEN,
    labels: [
      { id: LABEL_WORK, name: "Work", color: "#3b82f6" }, // theme-lint-ignore-line: seeded user data
      { id: LABEL_HOME, name: "Home", color: "#22c55e" }, // theme-lint-ignore-line: seeded user data
    ],
  });
  seedState(tmpHome, {
    repos: [
      {
        name: BUSY,
        path: `/tmp/fake/${BUSY}`,
        defaultBranch: "main",
        label: LABEL_WORK,
        worktrees: [
          { branch: "main", path: `/tmp/fake/${BUSY}` },
          { branch: FEATURE, path: `/tmp/fake/${BUSY}-feature` },
        ],
      },
      {
        name: LIMITED,
        path: `/tmp/fake/${LIMITED}`,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: `/tmp/fake/${LIMITED}` }],
      },
    ],
  });
  server = await startServer({ tmpHome });

  await trpcMutate(server.url, TOKEN, "repos.addByUrl", { remoteUrl, defaultBranch: "main" });
  await trpcMutate(server.url, TOKEN, "repos.update", {
    name: LIMITED,
    allowedHostIds: ["local"],
    primaryHostId: "local",
  });
  await trpcMutate(server.url, TOKEN, "mcp.add", {
    name: MCP_SCOPED,
    url: "https://mcp.example.invalid/mcp",
    scopeRepos: [BUSY],
  });
  await trpcMutate(server.url, TOKEN, "mcp.add", {
    name: MCP_ALL,
    url: "https://mcp-all.example.invalid/mcp",
  });
  await trpcMutate(server.url, TOKEN, "cronjobs.create", {
    name: CRON_NAME,
    prompt: "Check the build",
    cronExpression: "0 7 * * *",
    worktreeId: toWorktreeId(BUSY, FEATURE, "local"),
  });
  const jobs = await trpcQuery<{ jobs: { id: string; name: string }[] }>(
    server.url,
    TOKEN,
    "cronjobs.list",
  );
  cronId = jobs.jobs.find((j) => j.name === CRON_NAME)?.id ?? "";
  expect(cronId).not.toBe("");
  // A worker that never connects: only the repos with no host list may run on it.
  offlineHostId = (
    await trpcMutateData<{ hostId: string }>(server.url, TOKEN, "tokens.issueWorkerBootstrap", {
      hostName: "e2e-offline",
      labels: [],
    })
  ).hostId;
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
  rmSync(remotesDir, { recursive: true, force: true });
});

test("Repos is the last settings page, under no heading of its own, and Environment is gone (S1)", async ({
  page,
}) => {
  const settings = new SettingsPage(page, server.url, TOKEN);
  await settings.goto();
  await settings.openDialog();

  await expect(settings.navEntry("general")).toBeVisible();
  await expect(settings.navEntries().last()).toHaveAttribute("data-testid", "settings__nav-repos");
  await expect(settings.navEntryById("environment")).toHaveCount(0);
  await expect(settings.navGroups().last()).toHaveAttribute("data-group", "Worktree");
  await expect(settings.navGroup("Repos")).toHaveCount(0);
});

test("the overview lists every repo, and Enter in the focused filter opens the match (S2)", async ({
  page,
}) => {
  const settings = new SettingsPage(page, server.url, TOKEN);
  await settings.goto();
  await settings.openDialog("repos");

  await expect(settings.repoRows()).toHaveCount(3);
  await expect(settings.repoCell(REMOTE, "url")).toHaveText(remoteUrl);
  await expect(settings.repoCell(BUSY, "workers")).toHaveAttribute("data-allowed", "all");
  await expect(settings.repoCell(LIMITED, "workers")).toHaveAttribute("data-allowed", "local");
  await expect(settings.repoCell(BUSY, "worktrees")).toHaveText("1");
  await expect(settings.repoCell(BUSY, "checkpoints")).toHaveAttribute("data-enabled", "true");
  await expect(settings.repoCell(LIMITED, "checkpoints")).toHaveAttribute("data-enabled", "false");
  await expect(settings.repoCell(BUSY, "logins")).toHaveAttribute("data-overrides", "0");

  // The worker and label filters narrow the table.
  await settings.filterReposByLabel(LABEL_WORK);
  await expect(settings.repoRows()).toHaveCount(1);
  await expect(settings.repoRow(BUSY)).toBeVisible();
  await settings.filterReposByLabel("");
  await settings.filterReposByWorker("local");
  await expect(settings.repoRows()).toHaveCount(3);
  await settings.filterReposByWorker(offlineHostId);
  await expect(settings.repoRows()).toHaveCount(2);
  await expect(settings.repoRow(LIMITED)).toHaveCount(0);
  await settings.filterReposByWorker("");

  // The text filter matches a label name and a remote URL too.
  await settings.filterRepos("Work");
  await expect(settings.repoRows()).toHaveCount(1);
  await expect(settings.repoRow(BUSY)).toBeVisible();
  await settings.filterRepos("-remote.git");
  await expect(settings.repoRows()).toHaveCount(1);
  await expect(settings.repoRow(REMOTE)).toBeVisible();

  // The filter has focus, so typing goes straight into it.
  await settings.goto();
  await settings.openDialog("repos");
  await expect(settings.repoFilter()).toBeFocused();
  await settings.filterReposAndOpen("gamma");
  await expect(settings.repoPage(REMOTE)).toBeVisible();
  await expect(settings.repoUrl(REMOTE)).toHaveText(remoteUrl);
  await expect(settings.repoBranch(REMOTE)).toHaveText("main");

  await settings.backToRepos();
  await expect(settings.repoRows()).toHaveCount(3);
});

test("the label picked on a repo page is saved and shows after a reload (S3)", async ({ page }) => {
  const settings = new SettingsPage(page, server.url, TOKEN);
  await settings.goto();
  await settings.openRepoSettings(REMOTE);
  await expect(settings.repoLabelSelect(REMOTE)).toHaveValue("");

  await settings.setRepoLabel(REMOTE, LABEL_HOME);
  await expect.poll(async () => (await repoRow(REMOTE))?.label).toBe(LABEL_HOME);

  await settings.goto();
  await settings.openRepoSettings(REMOTE);
  await expect(settings.repoLabelSelect(REMOTE)).toHaveValue(LABEL_HOME);

  await settings.setRepoLabel(REMOTE, "");
  await expect.poll(async () => (await repoRow(REMOTE))?.label ?? null).toBeNull();
});

test("allowed workers and the primary worker are saved and show after a reload (S3)", async ({
  page,
}) => {
  const settings = new SettingsPage(page, server.url, TOKEN);
  await settings.goto();
  await settings.openRepoSettings(REMOTE);
  await settings.repoHosts(REMOTE).expectAllHosts();

  await settings.repoHosts(REMOTE).chooseOnly(["local"]);
  await settings.repoHosts(REMOTE).choosePrimary("local");
  await settings.saveRepoHosts(REMOTE);
  await expect.poll(async () => (await repoRow(REMOTE))?.allowedHostIds).toEqual(["local"]);
  await expect(settings.repoLimitedNote(REMOTE)).toBeVisible();

  await settings.goto();
  await settings.openRepoSettings(REMOTE);
  await settings.repoHosts(REMOTE).expectOnly(["local"], "local");

  await settings.repoHosts(REMOTE).chooseAllHosts();
  await settings.saveRepoHosts(REMOTE);
  await expect.poll(async () => (await repoRow(REMOTE))?.allowedHostIds).toBeNull();
});

test("a repo page lists the MCP servers and cronjobs that reach it, with links (S5)", async ({
  page,
}) => {
  const settings = new SettingsPage(page, server.url, TOKEN);
  await settings.goto();
  await settings.openRepoSettings(BUSY);

  await expect(settings.repoMcpServers(BUSY)).toHaveCount(2);
  await expect(settings.repoMcpServer(BUSY, MCP_SCOPED)).toBeVisible();
  await expect(settings.repoCronjobs(BUSY)).toHaveCount(1);
  await expect(settings.repoCronjobs(BUSY)).toHaveAttribute("data-cronjob", cronId);

  // On another repo's page the scoped server and the cronjob are absent.
  await settings.backToRepos();
  await settings.openRepo(LIMITED);
  await expect(settings.repoMcpServers(LIMITED)).toHaveCount(1);
  await expect(settings.repoMcpServer(LIMITED, MCP_ALL)).toBeVisible();
  await expect(settings.repoCronjobs(LIMITED)).toHaveCount(0);

  // "Open in MCP" goes to Settings > MCP.
  await settings.openMcpFromRepo(LIMITED, MCP_ALL);
  await expect(settings.navEntry("mcp")).toHaveAttribute("aria-current", "page");

  // "Open in Cronjobs" closes Settings and opens the Cronjobs dialog.
  await settings.openRepoSettings(BUSY);
  await settings.repoCronjobOpenButton(BUSY, cronId).click();
  await expect(settings.dialog).toHaveCount(0);
  await expect(new CronjobsDialog(page, server.url, TOKEN).dialog).toBeVisible();
});

test("Remove is disabled while the repo has worktrees (S6)", async ({ page }) => {
  const settings = new SettingsPage(page, server.url, TOKEN);
  await settings.goto();
  await settings.openRepoSettings(BUSY);

  await expect(settings.repoRemoveButton(BUSY)).toBeVisible();
  await expect(settings.repoRemoveButton(BUSY)).toBeDisabled();
  // The Workers section counts the same worktree on the worker that holds it.
  await expect(settings.repoClone(BUSY, "local")).toHaveAttribute("data-worktrees", "1");
});
