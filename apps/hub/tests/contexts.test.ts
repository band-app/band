// Integration tests for hub-held context repos and the media store (plan step 5.1). The real
// production server runs on a random port with auth on, against a temp BAND_HOME. Clients are
// the real `git` binary and plain fetch. Worker tokens come from the real bootstrap exchange.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedSettings, seedState } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  startServer,
  trpcData,
  trpcMutate,
  trpcQuery,
} from "./helpers/server";
import { waitFor } from "./helpers/wait-for";

const ADMIN = "contexts-admin-shared-secret";
const MEDIA_LIMIT = 4096;

let home: string;
let server: ServerHandle;
const scratch: string[] = [];

const tmp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
};

const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: gitEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Runs git with a Bearer token and returns the exit status and stderr instead of throwing. */
function gitAs(token: string, cwd: string, ...args: string[]): { ok: boolean; err: string } {
  try {
    git(cwd, "-c", `http.extraHeader=Authorization: Bearer ${token}`, ...args);
    return { ok: true, err: "" };
  } catch (e) {
    return { ok: false, err: String((e as { stderr?: string }).stderr ?? e) };
  }
}

const m = async <T>(proc: string, input: unknown) => {
  const res = await trpcMutate(server.url, proc, input, ADMIN);
  expect(res.status, `${proc}: ${await res.clone().text()}`).toBe(200);
  return trpcData<T>(res);
};
const q = async <T>(proc: string, input?: unknown) => {
  const res = await trpcQuery(server.url, proc, input, ADMIN);
  expect(res.status, `${proc}: ${await res.clone().text()}`).toBe(200);
  return trpcData<T>(res);
};

const gitUrl = (name: string) => `${server.url}/git/context/${name}.git`;

async function workerToken(labels: string[]): Promise<string> {
  const issued = await m<{ token: string; hostId: string }>("tokens.issueWorkerBootstrap", {
    hostName: `host-${labels.join("-") || "plain"}`,
    labels,
  });
  const res = await fetch(`${server.url}/api/workers/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: issued.token, workerId: issued.hostId }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { sessionToken: string }).sessionToken;
}

beforeAll(async () => {
  home = createTmpHome("band-contexts-");
  scratch.push(home);
  seedState(home, { projects: [] });
  seedSettings(home, { tokenSecret: ADMIN });
  server = await startServer({
    remoteHost: false,
    tmpHome: home,
    env: {
      BAND_SERVE_UI: "false",
      BAND_CONTEXT_ALLOW_LOCAL_REMOTES: "1",
      BAND_MEDIA_MAX_BYTES: String(MEDIA_LIMIT),
    },
  });
}, 90_000);

afterAll(async () => {
  await server?.close();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

describe("context repos over git smart HTTP", () => {
  it("scaffolds a user and a named context and clones, pushes and reads back", async () => {
    await m("context.create", { name: "user" });
    await m("context.create", { name: "alpha" });

    const repo = join(home, ".band", "context", "alpha.git");
    expect(existsSync(join(repo, "HEAD"))).toBe(true);
    // No sample hooks from a template, and git is told not to look for any.
    expect(existsSync(join(repo, "hooks"))).toBe(false);

    const dir = tmp("band-ctx-clone-");
    expect(gitAs(ADMIN, dir, "clone", "-q", gitUrl("alpha"), "alpha").ok).toBe(true);
    const files = git(join(dir, "alpha"), "ls-files").split("\n").filter(Boolean);
    expect(files).toEqual(
      expect.arrayContaining([
        "notes.md",
        "docs/.gitkeep",
        "media/.gitkeep",
        "inbox/.gitkeep",
        "handoffs/.gitkeep",
        "learnings/.gitkeep",
      ]),
    );

    const userDir = tmp("band-ctx-user-");
    expect(gitAs(ADMIN, userDir, "clone", "-q", gitUrl("user"), "u").ok).toBe(true);
    expect(git(join(userDir, "u"), "ls-files").split("\n")).toEqual(
      expect.arrayContaining(["preferences.md", "skills/.gitkeep"]),
    );

    const work = join(dir, "alpha");
    writeFileSync(join(work, "notes.md"), "# Notes\n\npushed over http\n");
    git(work, "commit", "-qam", "update notes");
    expect(gitAs(ADMIN, work, "push", "-q", "origin", "HEAD").ok).toBe(true);

    const again = tmp("band-ctx-again-");
    expect(gitAs(ADMIN, again, "clone", "-q", gitUrl("alpha"), "a").ok).toBe(true);
    expect(readFileSync(join(again, "a", "notes.md"), "utf8")).toContain("pushed over http");
  });

  it("refuses the wrong shapes: a second user context, a bad name and a duplicate", async () => {
    const dup = await trpcMutate(server.url, "context.create", { name: "alpha" }, ADMIN);
    expect(dup.status).toBe(400);
    const bad = await trpcMutate(server.url, "context.create", { name: "../escape" }, ADMIN);
    expect(bad.status).toBe(400);
    const reserved = await trpcMutate(
      server.url,
      "context.create",
      { name: "user", kind: "mission" },
      ADMIN,
    );
    expect(reserved.status).toBe(400);
  });

  it("answers 401 without credentials and 404 outside the three smart-protocol paths", async () => {
    const noAuth = await fetch(`${gitUrl("alpha")}/info/refs?service=git-upload-pack`);
    expect(noAuth.status).toBe(401);
    expect(noAuth.headers.get("www-authenticate")).toMatch(/Basic/);

    const auth = { Authorization: `Bearer ${ADMIN}` };
    for (const path of [
      "/git/context/..%2f..%2fsettings.git/info/refs?service=git-upload-pack",
      "/git/context/../alpha.git/info/refs",
      "/git/context/alpha.git/config",
      "/git/context/alpha.git/objects/info/packs",
      "/git/context/alpha.git/HEAD",
      "/git/context/nope.git/info/refs?service=git-upload-pack",
    ]) {
      const res = await fetch(`${server.url}${path}`, { headers: auth });
      expect(res.status, path).toBe(404);
    }
  });

  it("lets a non-admin device token read but not write", async () => {
    const dev = await m<{ token: string }>("tokens.createDevice", {
      label: "reader",
      admin: false,
    });
    const dir = tmp("band-ctx-dev-");
    expect(gitAs(dev.token, dir, "clone", "-q", gitUrl("alpha"), "a").ok).toBe(true);
    const work = join(dir, "a");
    writeFileSync(join(work, "x.md"), "x\n");
    git(work, "add", ".");
    git(work, "commit", "-qm", "x");
    const push = gitAs(dev.token, work, "push", "-q", "origin", "HEAD");
    expect(push.ok).toBe(false);
    expect(push.err).toMatch(/403/);
  });

  it("checks a worker's host labels against the context's labels", async () => {
    await m("context.create", { name: "epic", labels: ["org=epic"] });
    const match = await workerToken(["org=epic", "region=eu"]);
    const other = await workerToken(["org=other"]);
    const plain = await workerToken([]);

    const dir = tmp("band-ctx-worker-");
    const denied = gitAs(other, dir, "clone", "-q", gitUrl("epic"), "o");
    expect(denied.ok).toBe(false);
    expect(denied.err).toMatch(/403/);
    expect(gitAs(plain, dir, "clone", "-q", gitUrl("epic"), "p").ok).toBe(false);
    expect(gitAs(match, dir, "clone", "-q", gitUrl("epic"), "m").ok).toBe(true);

    // No labels on the context means any worker may pull it.
    expect(gitAs(plain, dir, "clone", "-q", gitUrl("alpha"), "alpha-plain").ok).toBe(true);

    // A worker's write access follows the context's setting.
    const work = join(dir, "m");
    writeFileSync(join(work, "learnings", "l.md"), "learned\n");
    git(work, "add", ".");
    git(work, "commit", "-qm", "learn");
    expect(gitAs(match, work, "push", "-q", "origin", "HEAD").ok).toBe(true);
    await m("context.update", { name: "epic", workerAccess: "read-only" });
    writeFileSync(join(work, "learnings", "l2.md"), "again\n");
    git(work, "add", ".");
    git(work, "commit", "-qm", "learn again");
    expect(gitAs(match, work, "push", "-q", "origin", "HEAD").ok).toBe(false);
    expect(gitAs(match, tmp("band-ctx-ro-"), "clone", "-q", gitUrl("epic"), "ro").ok).toBe(true);
  });

  it("does not let a worker session token through the hub's own API", async () => {
    const token = await workerToken([]);
    const res = await fetch(`${server.url}/trpc/context.list`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });
});

describe("a context linked to a remote", () => {
  let remote: string;
  let seed: string;

  const remoteLog = () => git(remote, "log", "--format=%s", "main").trim().split("\n");

  beforeAll(() => {
    remote = join(tmp("band-ctx-remote-"), "borko.git");
    mkdirSync(remote);
    git(remote, "init", "-q", "--bare", "-b", "main");
    seed = join(tmp("band-ctx-seed-"), "seed");
    mkdirSync(seed);
    git(seed, "init", "-q", "-b", "main");
    writeFileSync(join(seed, "preferences.md"), "from borko\n");
    git(seed, "add", ".");
    git(seed, "commit", "-qm", "borko one");
    git(seed, "remote", "add", "origin", remote);
    git(seed, "push", "-q", "origin", "main");
  });

  it("takes what the remote has instead of the scaffold, then mirrors both ways", async () => {
    const created = await m<{ context: { remoteUrl: string; syncError: string | null } }>(
      "context.create",
      { name: "borko", kind: "mission", remoteUrl: remote },
    );
    expect(created.context.remoteUrl).toBe(remote);

    const dir = tmp("band-ctx-link-");
    expect(gitAs(ADMIN, dir, "clone", "-q", gitUrl("borko"), "c").ok).toBe(true);
    const clone = join(dir, "c");
    expect(git(clone, "ls-files").trim()).toBe("preferences.md");

    // Remote to hub.
    writeFileSync(join(seed, "preferences.md"), "from borko, edited\n");
    git(seed, "commit", "-qam", "borko two");
    git(seed, "push", "-q", "origin", "main");
    const synced = await m<{ pulled: string[]; error?: string }>("context.sync", { name: "borko" });
    expect(synced.error).toBeUndefined();
    expect(synced.pulled).toEqual(["main"]);
    git(clone, "-c", `http.extraHeader=Authorization: Bearer ${ADMIN}`, "pull", "-q");
    expect(readFileSync(join(clone, "preferences.md"), "utf8")).toContain("edited");

    // Hub to remote: a push to the hub reaches the remote without a manual sync.
    writeFileSync(join(clone, "added-on-hub.md"), "hub\n");
    git(clone, "add", ".");
    git(clone, "commit", "-qm", "hub commit");
    expect(gitAs(ADMIN, clone, "push", "-q", "origin", "HEAD").ok).toBe(true);
    await waitFor(async () => (remoteLog().includes("hub commit") ? true : undefined), {
      label: "hub commit on the remote",
      timeoutMs: 15_000,
    });
    expect(remoteLog()).toEqual(["hub commit", "borko two", "borko one"]);
  });

  it("leaves a branch alone when both sides moved, and says so", async () => {
    git(seed, "pull", "-q", "origin", "main");
    writeFileSync(join(seed, "remote-side.md"), "r\n");
    git(seed, "add", ".");
    git(seed, "commit", "-qm", "remote side");
    git(seed, "push", "-q", "origin", "main");

    const dir = tmp("band-ctx-div-");
    gitAs(ADMIN, dir, "clone", "-q", gitUrl("borko"), "d");
    const clone = join(dir, "d");
    writeFileSync(join(clone, "hub-side.md"), "h\n");
    git(clone, "add", ".");
    git(clone, "commit", "-qm", "hub side");
    gitAs(ADMIN, clone, "push", "-q", "origin", "HEAD");
    // Both sides have moved. The hub's own debounced push comes 2 s later, so this sync runs first.
    const result = await m<{ diverged: string[]; error?: string }>("context.sync", {
      name: "borko",
    });
    expect(result.error).toBeUndefined();
    expect(result.diverged).toEqual(["main"]);
    const list = await q<{ contexts: Array<{ name: string; syncError: string | null }> }>(
      "context.list",
    );
    expect(list.contexts.find((c) => c.name === "borko")?.syncError).toMatch(/main/);
    expect(remoteLog()[0]).toBe("remote side");
  });

  it("refuses a remote with credentials in its URL and one that cannot be reached", async () => {
    const withCreds = await trpcMutate(
      server.url,
      "context.create",
      { name: "creds", remoteUrl: "https://user:secret@example.com/r.git" },
      ADMIN,
    );
    expect(withCreds.status).toBe(400);
    const missing = await trpcMutate(
      server.url,
      "context.create",
      { name: "ghost", remoteUrl: join(tmpdir(), "does-not-exist-band.git") },
      ADMIN,
    );
    expect(missing.status).toBe(400);
    expect(existsSync(join(home, ".band", "context", "ghost.git"))).toBe(false);
  });

  it("removes a context and its repo", async () => {
    await m("context.remove", { name: "borko" });
    expect(existsSync(join(home, ".band", "context", "borko.git"))).toBe(false);
    expect(readdirSync(join(home, ".band", "context")).includes("borko.git")).toBe(false);
    const gone = await fetch(`${gitUrl("borko")}/info/refs?service=git-upload-pack`, {
      headers: { Authorization: `Bearer ${ADMIN}` },
    });
    expect(gone.status).toBe(404);
  });
});

describe("media store", () => {
  const png = Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    Buffer.from("band-media-test"),
  ]);
  const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  const auth = { Authorization: `Bearer ${ADMIN}` };

  it("round-trips a blob under its content hash", async () => {
    const id = sha(png);
    const put = await fetch(`${server.url}/media/${id}`, {
      method: "PUT",
      headers: { ...auth, "content-type": "image/png" },
      body: png,
    });
    expect(put.status).toBe(201);
    expect(await put.json()).toMatchObject({ id, url: `band://media/${id}`, size: png.length });

    const again = await fetch(`${server.url}/media/${id}`, {
      method: "PUT",
      headers: { ...auth, "content-type": "image/png" },
      body: png,
    });
    expect(again.status).toBe(200);

    const get = await fetch(`${server.url}/media/${id}`, { headers: auth });
    expect(get.status).toBe(200);
    expect(get.headers.get("content-type")).toBe("image/png");
    expect(get.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await get.arrayBuffer()).equals(png)).toBe(true);

    const range = await fetch(`${server.url}/media/${id}`, {
      headers: { ...auth, Range: "bytes=0-3" },
    });
    expect(range.status).toBe(206);
    expect(range.headers.get("content-range")).toBe(`bytes 0-3/${png.length}`);
  });

  it("POST gives the content hash as the id, and the browser cookie can read it", async () => {
    const body = Buffer.from("# evidence\n");
    const res = await fetch(`${server.url}/media`, {
      method: "POST",
      headers: { ...auth, "content-type": "text/markdown; charset=utf-8" },
      body,
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    expect(id).toBe(sha(body));
    const viaCookie = await fetch(`${server.url}/media/${id}`, {
      headers: { cookie: `band_token=${ADMIN}` },
    });
    expect(viaCookie.status).toBe(200);
    const viaQuery = await fetch(`${server.url}/media/${id}?token=${ADMIN}`);
    expect(viaQuery.status).toBe(200);
  });

  it("refuses an id that is not the content hash, a disallowed type, an oversize body and no credentials", async () => {
    const wrongId = await fetch(`${server.url}/media/${"0".repeat(64)}`, {
      method: "PUT",
      headers: { ...auth, "content-type": "image/png" },
      body: png,
    });
    expect(wrongId.status).toBe(400);
    expect((await fetch(`${server.url}/media/${"0".repeat(64)}`, { headers: auth })).status).toBe(
      404,
    );

    const svg = Buffer.from("<svg onload=alert(1)/>");
    const type = await fetch(`${server.url}/media/${sha(svg)}`, {
      method: "PUT",
      headers: { ...auth, "content-type": "image/svg+xml" },
      body: svg,
    });
    expect(type.status).toBe(415);

    const big = Buffer.alloc(MEDIA_LIMIT + 1, 1);
    const over = await fetch(`${server.url}/media/${sha(big)}`, {
      method: "PUT",
      headers: { ...auth, "content-type": "image/png" },
      body: big,
    });
    expect(over.status).toBe(413);
    expect(
      readdirSync(join(home, ".band", "media")).filter((f) => f.startsWith(".upload-")),
    ).toEqual([]);

    expect((await fetch(`${server.url}/media/${sha(png)}`)).status).toBe(401);
    expect(
      (await fetch(`${server.url}/media/..%2f..%2fsettings.json`, { headers: auth })).status,
    ).toBe(404);
  });

  it("lets a worker session token upload evidence", async () => {
    const token = await workerToken([]);
    const body = Buffer.from("worker evidence");
    const res = await fetch(`${server.url}/media`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "text/plain" },
      body,
    });
    expect(res.status).toBe(201);
  });
});
