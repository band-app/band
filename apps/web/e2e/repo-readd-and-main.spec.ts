/**
 * Add repo on a desktop screen, a repo whose primary host has no default branch checked out, and
 * adding a repo again from a second worker. The user path: the folder list keeps a usable height
 * with a filter and no empty area under the action row (S1), a repo still lists its main from
 * another host or shows a "not checked out" row with actions when the primary's clone is on a
 * feature branch (S3), and picking the same repository on a second worker registers that clone,
 * says so, and offers to make it the primary host (S4).
 *
 * Real production hub with BAND_LOCAL_HOST=off and two real `band-worker` processes with their own
 * temp HOME, root and state dir. Remotes are local bare repos. No tRPC mocking, no `page.route`.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  cleanupTmpHome,
  createTmpHome,
  resetClientState,
  type ServerHandle,
  seedSettings,
  startServer,
} from "./helpers/server";
import { trpcMutateData, trpcQuery } from "./helpers/trpc";
import { startWorker, type WorkerHandle } from "./helpers/worker";
import { AddRepoPage } from "./pages/AddRepoPage";
import { MainMissingPage } from "./pages/MainMissingPage";
import { SettingsPage } from "./pages/SettingsPage";

const TOKEN = "e2e-repo-readd-and-main-token";

test.use({ viewport: { width: 1440, height: 900 } });
test.describe.configure({ mode: "serial" });

interface Host {
  id: string;
  name: string;
  root: string;
  home: string;
  worker: WorkerHandle;
}

let server: ServerHandle;
let tmpHome: string;
let a: Host;
let b: Host;
const scratch: string[] = [];

const tmpDir = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
};

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8" });

/** A bare remote with one commit on main. */
function makeRemote(name: string): string {
  const parent = tmpDir(`band-e2e-readd-${name}-`);
  const seed = join(parent, "seed");
  mkdirSync(seed, { recursive: true });
  git(seed, "init", "-q", "-b", "main");
  writeFileSync(join(seed, "hello.txt"), `hello from ${name}\n`);
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "init");
  const bare = join(parent, `${name}.git`);
  git(parent, "clone", "-q", "--bare", seed, bare);
  git(bare, "symbolic-ref", "HEAD", "refs/heads/main");
  return bare;
}

async function startHost(name: string): Promise<Host> {
  const issued = await trpcMutateData<{ token: string; hostId: string }>(
    server.url,
    TOKEN,
    "tokens.issueWorkerBootstrap",
    { hostName: name, labels: [] },
  );
  const root = tmpDir(`band-e2e-readd-${name}-root-`);
  const home = tmpDir(`band-e2e-readd-${name}-home-`);
  const worker = startWorker({
    env: {
      BAND_HUB_URL: server.url,
      BAND_BOOTSTRAP_TOKEN: issued.token,
      BAND_WORKER_ID: issued.hostId,
    },
    root,
    stateDir: tmpDir(`band-e2e-readd-${name}-state-`),
    home,
  });
  return { id: issued.hostId, name, root, home, worker };
}

interface RepoRow {
  name: string;
  primaryHostId: string | null;
  mainMissing: { hostId: string } | null;
  clones: Array<{ hostId: string }>;
  worktrees: Array<{ worktreeId: string }>;
}
const repoRow = async (name: string): Promise<RepoRow | undefined> =>
  (await trpcQuery<{ repos: RepoRow[] }>(server.url, TOKEN, "repos.list")).repos.find(
    (r) => r.name === name,
  );

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  server = await startServer({ tmpHome, env: { BAND_LOCAL_HOST: "off" } });
  a = await startHost("box-a");
  b = await startHost("box-b");
  await expect
    .poll(async () => {
      const { hosts } = await trpcQuery<{ hosts: Array<{ id: string; status: string }> }>(
        server.url,
        TOKEN,
        "hosts.list",
      );
      return [a.id, b.id].every((id) => hosts.find((h) => h.id === id)?.status === "online");
    })
    .toBe(true);
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await a?.worker.kill();
  await b?.worker.kill();
  await server.close();
  cleanupTmpHome(tmpHome);
  for (const dir of scratch) cleanupTmpHome(dir);
});

test("the folder list keeps a usable height with a filter and nothing sits below the action row (S1)", async ({
  page,
}, testInfo) => {
  for (let i = 0; i < 25; i++) mkdirSync(join(a.home, `projects-${String(i).padStart(2, "0")}`));
  const settings = new SettingsPage(page, server.url, TOKEN);
  await settings.goto();
  const addRepo = new AddRepoPage(page);
  await addRepo.open();
  await addRepo.chooseWorker(a.id);
  await addRepo.filter("proje");
  await expect(addRepo.pickerEntry("projects-00")).toBeVisible();

  await addRepo.screenshot(testInfo.outputPath("add-repo-desktop-filter.png"));
  const list = await addRepo.folderList();
  expect(list.visibleRows).toBeGreaterThanOrEqual(5);
  expect(list.height).toBeGreaterThanOrEqual(240);
  expect(list.scrolls).toBe(true);
  // The button sits in a 12px padded row that ends at the dialog's edge: nothing empty below it.
  expect(await addRepo.gapBelowFooter()).toBeLessThanOrEqual(16);
});

test("a repo still lists its main when the primary host's clone is on another branch (S3)", async ({
  page,
}) => {
  const remote = makeRemote("tool");
  git(a.home, "clone", "-q", remote, "tool");
  git(join(a.home, "tool"), "checkout", "-q", "-b", "feat");
  git(b.home, "clone", "-q", remote, "tool");

  const settings = new SettingsPage(page, server.url, TOKEN);
  await settings.goto();
  const addRepo = new AddRepoPage(page);
  await addRepo.open();
  await addRepo.chooseWorker(a.id);
  await addRepo.openFolder("tool");
  await addRepo.useCurrentFolder();
  await addRepo.hosts.chooseAllHosts();
  await addRepo.confirmRoot();
  await expect(addRepo.closed()).toBeHidden();

  // Only A's clone exists, and it is on `feat`: the sidebar says main is not checked out on A.
  const solo = await repoRow("tool");
  expect(solo?.primaryHostId).toBe(a.id);
  expect(solo?.mainMissing).toEqual({ hostId: a.id });
  const missing = new MainMissingPage(page);
  await settings.goto();
  await expect(missing.row()).toHaveAttribute("data-primary-host", a.id);

  // B holds main. Registering B's clone lists it, so the row is gone and the repo lists main.
  await addRepo.open();
  await addRepo.chooseWorker(b.id);
  await addRepo.openFolder("tool");
  await addRepo.useCurrentFolder();
  await addRepo.confirmRoot();
  await expect(addRepo.existingMessage()).toBeVisible();
  await addRepo.doneExisting();
  await expect.poll(async () => (await repoRow("tool"))?.mainMissing).toBeNull();
  const after = await repoRow("tool");
  expect(after?.worktrees.map((w) => w.worktreeId)).toContain(`tool-main@${b.id}`);
});

test("a repo added again from a second worker registers that clone and offers to make it primary (S4)", async ({
  page,
}) => {
  const remote = makeRemote("lib");
  git(a.home, "clone", "-q", remote, "lib");
  git(b.home, "clone", "-q", remote, "lib");

  const settings = new SettingsPage(page, server.url, TOKEN);
  await settings.goto();
  const addRepo = new AddRepoPage(page);
  await addRepo.open();
  await addRepo.chooseWorker(a.id);
  await addRepo.openFolder("lib");
  await addRepo.useCurrentFolder();
  await addRepo.hosts.chooseAllHosts();
  await addRepo.confirmRoot();
  await expect(addRepo.closed()).toBeHidden();
  expect((await repoRow("lib"))?.primaryHostId).toBe(a.id);

  await addRepo.open();
  await addRepo.chooseWorker(b.id);
  await addRepo.openFolder("lib");
  await addRepo.useCurrentFolder();
  await addRepo.confirmRoot();
  await expect(addRepo.existingMessage()).toHaveAttribute("data-host-id", b.id);
  await expect(addRepo.existingMessage()).toHaveAttribute("data-repo", "lib");
  await expect
    .poll(async () => (await repoRow("lib"))?.clones.map((c) => c.hostId).sort())
    .toEqual([a.id, b.id].sort());
  expect((await repoRow("lib"))?.primaryHostId).toBe(a.id);

  await addRepo.makePrimary();
  await expect.poll(async () => (await repoRow("lib"))?.primaryHostId).toBe(b.id);
  await addRepo.doneExisting();
  await expect(addRepo.closed()).toBeHidden();
});
