import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { seedSettings, seedState } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  trpcMutate as sharedTrpcMutate,
  trpcQuery as sharedTrpcQuery,
  startServer,
  trpcData,
} from "./helpers/server";

// Integration tests for browser profiles and the per-project default
// profile (`browserProfiles.*`, `browsers.create` / `browsers.setProfile`).
//
// The behaviour under test: a project remembers which browser profile its
// tabs use, and a new tab in ANY workspace of that project opens with it.
// Switching a tab's profile updates the project default. Driven through the
// production server bundle over tRPC HTTP.
//
// The Chrome cookie import itself runs in the desktop app and is covered by
// `apps/desktop/tests/chrome-import.test.ts`; the server only stores
// profile metadata.

const TOKEN = "browser-profiles-test-token";

function trpcMutate(serverUrl: string, procedure: string, input?: unknown) {
  return sharedTrpcMutate(serverUrl, procedure, input, TOKEN);
}

function trpcQuery(serverUrl: string, procedure: string, input?: unknown) {
  return sharedTrpcQuery(serverUrl, procedure, input, TOKEN);
}

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@test.com",
};

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf-8" });
}

function createGitRepo(parentDir: string, name: string): string {
  const repoPath = join(parentDir, name);
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, ["init", "-b", "main"]);
  writeFileSync(join(repoPath, "README.md"), "# Test\n");
  git(repoPath, ["add", "."]);
  git(repoPath, ["commit", "-m", "init"]);
  return repoPath;
}

interface Profile {
  id: string;
  name: string;
  source: string | null;
}

interface Browser {
  id: string;
  workspaceId: string;
  profileId: string | null;
}

async function createProfile(serverUrl: string, name: string, id?: string): Promise<Profile> {
  const res = await trpcMutate(serverUrl, "browserProfiles.create", {
    name,
    source: "chrome",
    ...(id ? { id } : {}),
  });
  expect(res.status).toBe(200);
  return (await trpcData<{ profile: Profile }>(res)).profile;
}

async function createBrowser(
  serverUrl: string,
  workspaceId: string,
  extra: Record<string, unknown> = {},
): Promise<Browser> {
  const res = await trpcMutate(serverUrl, "browsers.create", { workspaceId, ...extra });
  expect(res.status).toBe(200);
  return (await trpcData<{ browser: Browser }>(res)).browser;
}

async function setTabProfile(serverUrl: string, browserId: string, profileId: string | null) {
  const res = await trpcMutate(serverUrl, "browsers.setProfile", { browserId, profileId });
  expect(res.status).toBe(200);
}

/** Open the `/cdp` proxy socket for a tab and resolve with its close code. */
function cdpCloseCode(serverUrl: string, bandTabId: string): Promise<number> {
  const url = `${serverUrl.replace(/^http/, "ws")}/cdp?bandTabId=${encodeURIComponent(bandTabId)}`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { Cookie: `band_token=${TOKEN}` } });
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("CDP socket did not close"));
    }, 5_000);
    ws.on("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    ws.on("error", () => {});
  });
}

async function projectDefault(serverUrl: string, projectName: string): Promise<string | null> {
  const res = await trpcQuery(serverUrl, "browserProfiles.getProjectDefault", { projectName });
  expect(res.status).toBe(200);
  return (await trpcData<{ profileId: string | null }>(res)).profileId;
}

describe("browser profiles — per-project default", () => {
  let server: ServerHandle;
  let tmpHome: string;
  // Two workspaces of project "alpha", one of project "beta".
  const alphaMain = "alpha-main";
  const alphaFeature = "alpha-feature";
  const betaMain = "beta-main";

  beforeAll(async () => {
    tmpHome = createTmpHome("band-browser-profiles-");
    const alphaPath = createGitRepo(tmpHome, "alpha");
    const alphaFeaturePath = join(tmpHome, "alpha-feature-wt");
    git(alphaPath, ["worktree", "add", "-b", "feature", alphaFeaturePath]);
    const betaPath = createGitRepo(tmpHome, "beta");
    seedState(tmpHome, {
      projects: [
        {
          name: "alpha",
          path: alphaPath,
          defaultBranch: "main",
          worktrees: [
            { branch: "main", path: alphaPath },
            { branch: "feature", path: alphaFeaturePath },
          ],
        },
        {
          name: "beta",
          path: betaPath,
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: betaPath }],
        },
      ],
    });
    seedSettings(tmpHome, { tokenSecret: TOKEN });
    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("rejects browserProfiles calls without the band_token cookie (401)", async () => {
    const res = await fetch(`${server.url}/trpc/browserProfiles.create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    });
    expect(res.status).toBe(401);
    const setProfile = await fetch(`${server.url}/trpc/browsers.setProfile`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ browserId: "browser_x", profileId: null }),
    });
    expect(setProfile.status).toBe(401);
  });

  it("opens new tabs in the Default profile when the project has none", async () => {
    const browser = await createBrowser(server.url, alphaMain);
    expect(browser.profileId).toBeNull();
    expect(await projectDefault(server.url, "alpha")).toBeNull();
  });

  it("switching a tab's profile becomes the default for every workspace of the project", async () => {
    const work = await createProfile(server.url, "Work (Chrome)");
    const tab = await createBrowser(server.url, alphaMain);

    const res = await trpcMutate(server.url, "browsers.setProfile", {
      browserId: tab.id,
      profileId: work.id,
    });
    expect(res.status).toBe(200);
    expect((await trpcData<{ browser: Browser }>(res)).browser.profileId).toBe(work.id);
    expect(await projectDefault(server.url, "alpha")).toBe(work.id);

    // A new tab in ANOTHER workspace of the same project opens with it…
    const sibling = await createBrowser(server.url, alphaFeature);
    expect(sibling.profileId).toBe(work.id);
    // …and survives a round-trip through browsers.get (what the pane reads).
    const getRes = await trpcQuery(server.url, "browsers.get", { browserId: sibling.id });
    expect((await trpcData<{ browser: Browser }>(getRes)).browser.profileId).toBe(work.id);

    // Another project is unaffected.
    const other = await createBrowser(server.url, betaMain);
    expect(other.profileId).toBeNull();
  });

  it("an explicit profile on create overrides the project default without changing it", async () => {
    const personal = await createProfile(server.url, "Personal (Chrome)");
    const before = await projectDefault(server.url, "alpha");

    const explicit = await createBrowser(server.url, alphaMain, { profileId: personal.id });
    expect(explicit.profileId).toBe(personal.id);
    const explicitDefault = await createBrowser(server.url, alphaMain, { profileId: null });
    expect(explicitDefault.profileId).toBeNull();

    expect(await projectDefault(server.url, "alpha")).toBe(before);
  });

  it("switching a tab back to Default resets the project default", async () => {
    const tab = await createBrowser(server.url, alphaFeature);
    const res = await trpcMutate(server.url, "browsers.setProfile", {
      browserId: tab.id,
      profileId: null,
    });
    expect(res.status).toBe(200);
    expect(await projectDefault(server.url, "alpha")).toBeNull();
    expect((await createBrowser(server.url, alphaMain)).profileId).toBeNull();
  });

  it("setProjectDefault and projectDefaults drive the Settings rows", async () => {
    const qa = await createProfile(server.url, "QA");
    const setRes = await trpcMutate(server.url, "browserProfiles.setProjectDefault", {
      projectName: "beta",
      profileId: qa.id,
    });
    expect(setRes.status).toBe(200);

    const listRes = await trpcQuery(server.url, "browserProfiles.projectDefaults");
    const { defaults } = await trpcData<{
      defaults: { projectName: string; profileId: string }[];
    }>(listRes);
    expect(defaults).toContainEqual({ projectName: "beta", profileId: qa.id });
    expect((await createBrowser(server.url, betaMain)).profileId).toBe(qa.id);
  });

  it("deleting a profile moves its project and its tabs back to Default", async () => {
    const doomed = await createProfile(server.url, "Doomed");
    const tab = await createBrowser(server.url, alphaMain);
    await setTabProfile(server.url, tab.id, doomed.id);
    expect(await projectDefault(server.url, "alpha")).toBe(doomed.id);

    const res = await trpcMutate(server.url, "browserProfiles.remove", { profileId: doomed.id });
    expect(res.status).toBe(200);

    expect(await projectDefault(server.url, "alpha")).toBeNull();
    const getRes = await trpcQuery(server.url, "browsers.get", { browserId: tab.id });
    expect((await trpcData<{ browser: Browser }>(getRes)).browser.profileId).toBeNull();
    const listRes = await trpcQuery(server.url, "browserProfiles.list");
    const { profiles } = await trpcData<{ profiles: Profile[] }>(listRes);
    expect(profiles.map((p) => p.id)).not.toContain(doomed.id);
  });

  it("rejects unknown profiles with 404 and duplicate ids with 409", async () => {
    const tab = await createBrowser(server.url, alphaMain);
    const unknown = await trpcMutate(server.url, "browsers.setProfile", {
      browserId: tab.id,
      profileId: "profile_missing",
    });
    expect(unknown.status).toBe(404);
    const unknownCreate = await trpcMutate(server.url, "browsers.create", {
      workspaceId: alphaMain,
      profileId: "profile_missing",
    });
    expect(unknownCreate.status).toBe(404);
    const unknownTab = await trpcMutate(server.url, "browsers.setProfile", {
      browserId: "browser_missing",
      profileId: null,
    });
    expect(unknownTab.status).toBe(404);
    const unknownDefault = await trpcMutate(server.url, "browserProfiles.setProjectDefault", {
      projectName: "alpha",
      profileId: "profile_missing",
    });
    expect(unknownDefault.status).toBe(404);
    const unknownRemove = await trpcMutate(server.url, "browserProfiles.remove", {
      profileId: "profile_missing",
    });
    expect(unknownRemove.status).toBe(404);

    await createProfile(server.url, "Fixed id", "profile_fixed");
    const dup = await trpcMutate(server.url, "browserProfiles.create", {
      id: "profile_fixed",
      name: "Again",
    });
    expect(dup.status).toBe(409);
  });

  it("removing a project forgets its default profile", async () => {
    const profile = await createProfile(server.url, "Beta only");
    const setRes = await trpcMutate(server.url, "browserProfiles.setProjectDefault", {
      projectName: "beta",
      profileId: profile.id,
    });
    expect(setRes.status).toBe(200);
    expect(await projectDefault(server.url, "beta")).toBe(profile.id);

    const res = await trpcMutate(server.url, "projects.remove", { name: "beta" });
    expect(res.status).toBe(200);

    const listRes = await trpcQuery(server.url, "browserProfiles.projectDefaults");
    const { defaults } = await trpcData<{
      defaults: { projectName: string; profileId: string }[];
    }>(listRes);
    expect(defaults.map((d) => d.projectName)).not.toContain("beta");
  });

  it("never relays raw CDP for a tab in a browser profile", async () => {
    // Raw CDP can read a session's cookies, so imported cookies would pass
    // through this server. Default-profile tabs keep the relay; with no
    // desktop connected they fail later, with 4001.
    const profile = await createProfile(server.url, "Streamed?");
    const profileTab = await createBrowser(server.url, alphaMain, { profileId: profile.id });
    expect(await cdpCloseCode(server.url, profileTab.id)).toBe(4003);

    const defaultTab = await createBrowser(server.url, alphaMain, { profileId: null });
    expect(await cdpCloseCode(server.url, defaultTab.id)).toBe(4001);
  });

  it("rejects profile ids that could not be a partition name", async () => {
    const res = await trpcMutate(server.url, "browserProfiles.create", {
      id: "../escape",
      name: "Bad",
    });
    expect(res.status).toBe(400);
  });
});
