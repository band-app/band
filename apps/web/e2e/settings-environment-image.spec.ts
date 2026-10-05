/**
 * Settings > Environment > Image: a repo whose environment has a `build`
 * shows its current image, the status and log of its latest build and a
 * "Build image" button, driven through the real Settings dialog against the
 * real server.
 *
 * Docker is the external service. The server runs the docker stub
 * (`apps/hub/tests/fixtures/docker-stub-bin.mjs`) through `BAND_DOCKER_BIN`,
 * and the repos are real git repositories because the builder reads the
 * default branch from git.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  cleanupTmpHome,
  createTmpHome,
  resetClientState,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { SettingsPage } from "./pages/SettingsPage";

const TOKEN = "e2e-settings-environment-image-token";
const DOCKER_STUB = join(import.meta.dirname, "../../hub/tests/fixtures/docker-stub-bin.mjs");

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@test.com",
};

const REPOS: Record<string, string> = {
  "img-ok": "FROM busybox\n",
  "img-fail": "FROM busybox\nRUN FAIL_BUILD\n",
};

let server: ServerHandle;
let tmpHome: string;
let reposRoot: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const stubState = join(tmpHome, "docker-stub-state.json");
  writeFileSync(stubState, JSON.stringify({ images: { "band-worker:latest": "sha256:worker" } }));
  const root = mkdtempSync(join(tmpdir(), "band-e2e-env-image-"));
  reposRoot = root;
  const repos = Object.entries(REPOS).map(([name, dockerfile]) => {
    const path = join(root, name);
    mkdirSync(join(path, ".band"), { recursive: true });
    writeFileSync(join(path, "Dockerfile"), dockerfile);
    writeFileSync(
      join(path, ".band", "environment.json"),
      JSON.stringify({ build: { dockerfile: "Dockerfile" }, install: "echo installed" }),
    );
    execFileSync("git", ["init", "-b", "main"], { cwd: path, env: gitEnv });
    execFileSync("git", ["add", "."], { cwd: path, env: gitEnv });
    execFileSync("git", ["commit", "-m", "init"], { cwd: path, env: gitEnv });
    return { name, path, defaultBranch: "main", worktrees: [{ branch: "main", path }] };
  });
  seedState(tmpHome, { repos });
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  server = await startServer({
    tmpHome,
    env: { BAND_DOCKER_BIN: DOCKER_STUB, STUB_DOCKER_STATE: stubState },
  });
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
  rmSync(reposRoot, { recursive: true, force: true });
});

test("building an image shows the log and makes it the current image", async ({ page }) => {
  const settingsPage = new SettingsPage(page, server.url, TOKEN);
  await settingsPage.goto();
  await settingsPage.openDialog("environment");
  await settingsPage.expandEnvironment("img-ok");

  await expect(settingsPage.environmentImage()).toHaveAttribute("data-current", "");
  await settingsPage.buildEnvironmentImage();

  await expect(settingsPage.environmentImage()).toHaveAttribute(
    "data-current",
    /band-env\/img-ok:[0-9a-f]{16}/,
  );
  await expect(settingsPage.environmentImage()).toHaveAttribute("data-status", "ready");
  await expect(settingsPage.environmentImageLog()).toContainText("docker build");
  await expect(settingsPage.environmentImageLog()).toContainText("Done: band-env/img-ok");
});

test("a failed build shows its error and leaves no current image", async ({ page }) => {
  const settingsPage = new SettingsPage(page, server.url, TOKEN);
  await settingsPage.goto();
  await settingsPage.openDialog("environment");
  await settingsPage.expandEnvironment("img-fail");

  await settingsPage.buildEnvironmentImage();

  await expect(settingsPage.environmentImage()).toHaveAttribute("data-status", "failed");
  await expect(settingsPage.environmentImage()).toHaveAttribute("data-current", "");
  await expect(settingsPage.environmentImageLog()).toContainText("FAIL_BUILD");
  await expect(settingsPage.environmentImageError()).toBeHidden();
});
