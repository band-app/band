// Black-box integration tests for GitHub project avatars.
//
// Real production server against a tmp HOME, real git repos with real
// `origin` remotes, and github.com replaced by an Express stub through
// `BAND_GITHUB_URL`. Assertions go through `projects.list`, the
// `/api/project-avatar/<name>` route, the stub's request log, and a server
// restart (the on-disk cache must survive it and serve while offline).

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  const flakyRequests: CapturedAvatarRequest[] = [];
  const evilRedirectRequests: CapturedAvatarRequest[] = [];

  beforeAll(async () => {
    tmpHome = createTmpHome("band-project-avatars-");
    const project = (name: string, origin?: string) => {
      const path = makeRepo(tmpHome, name, origin);
      return { name, path, defaultBranch: "main", worktrees: [{ branch: "main", path }] };
    };
    const plainPath = join(tmpHome, "notes");
    mkdirSync(plainPath, { recursive: true });
    seedState(tmpHome, {
      projects: [
        project("widgets", "https://github.com/Acme-Org/widgets.git"),
        // Same owner over SSH, different case: shares the cached avatar.
        project("gadgets", "git@github.com:acme-org/gadgets.git"),
        project("ghost", "https://github.com/ghost-owner/haunt.git"),
        project("flaky", "https://github.com/flaky-owner/outage.git"),
        project("html", "https://github.com/html-owner/page.git"),
        project("vector", "https://github.com/svg-owner/drawing.git"),
        project("moved", "https://github.com/moved-owner/relocated.git"),
        project("hijack", "https://github.com/evil-owner/redirect.git"),
        // Never fetched before the offline restart below.
        project("fresh", "https://github.com/fresh-owner/new.git"),
        // Remote forms and hosts, checked through `projects.list` only.
        project("ssh-url", "ssh://git@github.com/acme-org/tools"),
        project("ssh-443", "ssh://git@ssh.github.com:443/acme-org/infra.git"),
        project("www", "https://www.GitHub.com/acme-org/site.git"),
        project("ghes", "git@github.example.com:platform/api.git"),
        project("ghec", "https://octo.ghe.com/team/app.git"),
        project("tool", "https://gitlab.com/acme/tool.git"),
        project("bucket", "git@bitbucket.org:acme/bucket.git"),
        project("selfhosted", "https://git.example.com/acme/internal.git"),
        project("dotted", "https://github.com/a.b/dotted.git"),
        project("local"),
        {
          name: "notes",
          path: plainPath,
          defaultBranch: "main",
          kind: "plain" as const,
          worktrees: [{ branch: "main", path: plainPath }],
        },
      ],
    });
    seedSettings(tmpHome, { tokenSecret: TOKEN });

    stub = await githubStub.start();
    stub.setAvatar("Acme-Org", AVATAR_PNG, { onRequest: (r) => acmeRequests.push(r) });
    stub.setAvatarStatus("ghost-owner", 404, { onRequest: (r) => ghostRequests.push(r) });
    stub.setAvatarStatus("flaky-owner", 503, { onRequest: (r) => flakyRequests.push(r) });
    stub.setAvatar("html-owner", Buffer.from("<html></html>"), { contentType: "text/html" });
    stub.setAvatar(
      "svg-owner",
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
      { contentType: "image/svg+xml" },
    );
    // github.com redirects to its CDN; a same-origin hop stands in for it.
    stub.setAvatarRedirect("moved-owner", "/cdn-target.png?size=64");
    stub.setAvatar("cdn-target", AVATAR_PNG);
    stub.setAvatarRedirect("evil-owner", "http://169.254.169.254/latest/meta-data", {
      onRequest: (r) => evilRedirectRequests.push(r),
    });
    server = await startServer({ tmpHome, env: { BAND_GITHUB_URL: stub.baseUrl } });
  }, 30_000);

  afterAll(async () => {
    await server?.close();
    await stub?.stop();
    rmSync(tmpHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("rejects an avatar request without a token", async () => {
    const res = await fetchAvatar(server, "widgets", null);
    expect(res.status).toBe(401);
  });

  it("projects.list offers an avatar for github.com and GitHub Enterprise remotes only", async () => {
    const projects = await listProjects(server);
    const avatar = (name: string, label: string) => ({
      src: `/api/project-avatar/${name}`,
      label,
    });
    expect(projects.get("widgets")?.avatar).toEqual(avatar("widgets", "Acme-Org/widgets"));
    expect(projects.get("gadgets")?.avatar).toEqual(avatar("gadgets", "acme-org/gadgets"));
    expect(projects.get("ssh-url")?.avatar).toEqual(avatar("ssh-url", "acme-org/tools"));
    expect(projects.get("ssh-443")?.avatar).toEqual(avatar("ssh-443", "acme-org/infra"));
    expect(projects.get("www")?.avatar).toEqual(avatar("www", "acme-org/site"));
    expect(projects.get("ghes")?.avatar).toEqual(avatar("ghes", "platform/api"));
    expect(projects.get("ghec")?.avatar).toEqual(avatar("ghec", "team/app"));
    for (const name of ["tool", "bucket", "selfhosted", "dotted", "local", "notes"]) {
      expect(projects.get(name)?.avatar, name).toBeNull();
    }
  });

  it("fetches the owner avatar once and serves it from cache for every repo of that owner", async () => {
    const first = await fetchAvatar(server, "widgets");
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("image/png");
    expect(first.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(Buffer.from(await first.arrayBuffer())).toEqual(AVATAR_PNG);

    const sameOwner = await fetchAvatar(server, "gadgets");
    expect(sameOwner.status).toBe(200);
    expect(Buffer.from(await sameOwner.arrayBuffer())).toEqual(AVATAR_PNG);

    const again = await fetchAvatar(server, "widgets");
    expect(again.status).toBe(200);

    expect(acmeRequests).toEqual([{ method: "GET", path: "/Acme-Org.png", query: { size: "64" } }]);
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

  it("backs off after a GitHub server error instead of retrying on every request", async () => {
    expect((await fetchAvatar(server, "flaky")).status).toBe(404);
    expect((await fetchAvatar(server, "flaky")).status).toBe(404);
    expect(flakyRequests).toEqual([
      { method: "GET", path: "/flaky-owner.png", query: { size: "64" } },
    ]);
    // A transient failure is not "no avatar": the UI keeps asking later.
    const projects = await listProjects(server);
    expect(projects.get("flaky")?.avatar).toEqual({
      src: "/api/project-avatar/flaky",
      label: "flaky-owner/outage",
    });
  });

  it("refuses non-raster responses, including SVG", async () => {
    expect((await fetchAvatar(server, "html")).status).toBe(404);
    expect((await fetchAvatar(server, "vector")).status).toBe(404);
    const projects = await listProjects(server);
    expect(projects.get("html")?.avatar).toBeNull();
    expect(projects.get("vector")?.avatar).toBeNull();
  });

  it("follows a same-origin redirect and refuses one to another host", async () => {
    const moved = await fetchAvatar(server, "moved");
    expect(moved.status).toBe(200);
    expect(Buffer.from(await moved.arrayBuffer())).toEqual(AVATAR_PNG);

    expect((await fetchAvatar(server, "hijack")).status).toBe(404);
    expect(evilRedirectRequests).toHaveLength(1);
  });

  it("serves a stale cached avatar after a restart while GitHub is unreachable", async () => {
    await server.close();
    await stub.stop();
    // Age the cached avatar past its 24 h TTL so the restarted server has to
    // try GitHub first, and falls back to the stale copy when that fails.
    const sidecar = join(tmpHome, ".band", "cache", "github-avatars", "github.com__acme-org.json");
    const meta = JSON.parse(readFileSync(sidecar, "utf-8")) as { fetchedAt: number };
    expect(meta).toMatchObject({ status: "ok", contentType: "image/png" });
    writeFileSync(sidecar, JSON.stringify({ ...meta, fetchedAt: Date.now() - 48 * 3600_000 }));

    // A port nothing listens on: every fetch to "github.com" is refused.
    const deadUrl = `http://127.0.0.1:${await getRandomPort()}`;
    server = await startServer({ tmpHome, env: { BAND_GITHUB_URL: deadUrl } });

    const res = await fetchAvatar(server, "widgets");
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(AVATAR_PNG);

    // Nothing cached for this owner: the UI keeps its folder icon.
    expect((await fetchAvatar(server, "fresh")).status).toBe(404);
  }, 30_000);
});
