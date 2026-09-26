// Black-box integration tests for GitHub project avatars.
//
// Real production server against a tmp HOME, real git repos with real
// `origin` remotes, and github.com replaced by an Express stub through
// `BAND_GITHUB_URL`. Assertions go through `projects.list`, the
// `/api/project-avatar/<name>` route, the stub's request log, and a server
// restart (the on-disk cache must survive it and serve while offline).

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CapturedAvatarRequest, type GitHubStub, githubStub } from "./fixtures/github-stub";
import { AVATAR_PNG } from "./fixtures/github-test-data";
import { seedSettings, seedState } from "./helpers/seed-state";
import {
  createTmpHome,
  getRandomPort,
  type ServerHandle,
  startServer,
  trpcData,
  trpcQuery,
} from "./helpers/server";

const TOKEN = "project-avatars-token";

interface ListedProject {
  name: string;
  avatar: { src: string; label: string } | null;
}

function gitEnv(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: home,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
}

/** Create a git repo at `<home>/<name>`, with `origin` set when given. */
function makeRepo(home: string, name: string, origin?: string): string {
  const path = join(home, name);
  mkdirSync(path, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: path, env: gitEnv(home) });
  if (origin) {
    execFileSync("git", ["remote", "add", "origin", origin], { cwd: path, env: gitEnv(home) });
  }
  return path;
}

function fetchAvatar(server: ServerHandle, project: string, token: string | null = TOKEN) {
  return fetch(`${server.url}/api/project-avatar/${encodeURIComponent(project)}`, {
    headers: token ? { Cookie: `band_token=${token}` } : {},
  });
}

async function listProjects(server: ServerHandle): Promise<Map<string, ListedProject>> {
  const res = await trpcQuery(server.url, "projects.list", undefined, TOKEN);
  expect(res.status).toBe(200);
  const data = await trpcData<{ projects: ListedProject[] }>(res);
  return new Map(data.projects.map((p) => [p.name, p]));
}

describe("GitHub project avatars", () => {
  let tmpHome: string;
  let stub: GitHubStub;
  let server: ServerHandle;
  const acmeRequests: CapturedAvatarRequest[] = [];
  const ghostRequests: CapturedAvatarRequest[] = [];

  beforeAll(async () => {
    tmpHome = createTmpHome("band-project-avatars-");
    const project = (name: string, path: string, kind: "git" | "plain" = "git") => ({
      name,
      path,
      defaultBranch: "main",
      kind,
      worktrees: [{ branch: "main", path }],
    });
    const plainPath = join(tmpHome, "notes");
    mkdirSync(plainPath, { recursive: true });
    seedState(tmpHome, {
      projects: [
        project("widgets", makeRepo(tmpHome, "widgets", "https://github.com/Acme-Org/widgets.git")),
        // Same owner over SSH, different case: shares the cached avatar.
        project("gadgets", makeRepo(tmpHome, "gadgets", "git@github.com:acme-org/gadgets.git")),
        project("ghost", makeRepo(tmpHome, "ghost", "https://github.com/ghost-owner/haunt.git")),
        // Never fetched before the offline restart below.
        project("fresh", makeRepo(tmpHome, "fresh", "https://github.com/fresh-owner/new.git")),
        project("tool", makeRepo(tmpHome, "tool", "https://gitlab.com/acme/tool.git")),
        project("local", makeRepo(tmpHome, "local")),
        project("notes", plainPath, "plain"),
      ],
    });
    seedSettings(tmpHome, { tokenSecret: TOKEN });

    stub = await githubStub.start();
    stub.setAvatar("Acme-Org", AVATAR_PNG, { onRequest: (r) => acmeRequests.push(r) });
    stub.setAvatarStatus("ghost-owner", 404, { onRequest: (r) => ghostRequests.push(r) });
    server = await startServer({ tmpHome, env: { BAND_GITHUB_URL: stub.baseUrl } });
  }, 30_000);

  afterAll(async () => {
    await server?.close();
    await stub?.stop();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("rejects an avatar request without a token", async () => {
    const res = await fetchAvatar(server, "widgets", null);
    expect(res.status).toBe(401);
  });

  it("projects.list offers an avatar only for GitHub-hosted git projects", async () => {
    const projects = await listProjects(server);
    expect(projects.get("widgets")?.avatar).toEqual({
      src: "/api/project-avatar/widgets",
      label: "Acme-Org/widgets",
    });
    expect(projects.get("gadgets")?.avatar).toEqual({
      src: "/api/project-avatar/gadgets",
      label: "acme-org/gadgets",
    });
    expect(projects.get("tool")?.avatar).toBeNull();
    expect(projects.get("local")?.avatar).toBeNull();
    expect(projects.get("notes")?.avatar).toBeNull();
  });

  it("fetches the owner avatar once and serves it from cache for every repo of that owner", async () => {
    const first = await fetchAvatar(server, "widgets");
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await first.arrayBuffer())).toEqual(AVATAR_PNG);

    const sameOwner = await fetchAvatar(server, "gadgets");
    expect(sameOwner.status).toBe(200);
    expect(Buffer.from(await sameOwner.arrayBuffer())).toEqual(AVATAR_PNG);

    const again = await fetchAvatar(server, "widgets");
    expect(again.status).toBe(200);

    expect(acmeRequests).toEqual([{ method: "GET", path: "/Acme-Org.png", query: { size: "64" } }]);
  });

  it("versions the avatar URL once the image is cached", async () => {
    const projects = await listProjects(server);
    expect(projects.get("widgets")?.avatar?.src).toMatch(/^\/api\/project-avatar\/widgets\?v=\d+$/);
  });

  it("returns 404 for projects without a GitHub avatar and for unknown projects", async () => {
    for (const name of ["tool", "local", "notes", "does-not-exist"]) {
      const res = await fetchAvatar(server, name);
      expect(res.status, name).toBe(404);
    }
  });

  it("remembers an owner GitHub has no avatar for and stops offering it", async () => {
    expect((await fetchAvatar(server, "ghost")).status).toBe(404);
    expect((await fetchAvatar(server, "ghost")).status).toBe(404);
    expect(ghostRequests).toEqual([
      { method: "GET", path: "/ghost-owner.png", query: { size: "64" } },
    ]);
    const projects = await listProjects(server);
    expect(projects.get("ghost")?.avatar).toBeNull();
  });

  it("serves the cached avatar after a restart while GitHub is unreachable", async () => {
    await server.close();
    await stub.stop();
    // A port nothing listens on: every fetch to "github.com" is refused.
    const deadUrl = `http://127.0.0.1:${await getRandomPort()}`;
    server = await startServer({ tmpHome, env: { BAND_GITHUB_URL: deadUrl } });

    const res = await fetchAvatar(server, "widgets");
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(AVATAR_PNG);
    expect(acmeRequests).toHaveLength(1);

    // Nothing cached for this owner: the UI keeps its folder icon.
    expect((await fetchAvatar(server, "fresh")).status).toBe(404);
  }, 30_000);
});
