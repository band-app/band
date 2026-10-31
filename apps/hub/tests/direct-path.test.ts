// Integration tests for the local direct path: a client on a
// worker's own machine gets a short-lived token from the hub (`worktree.directAccess`) and then
// calls the worker on 127.0.0.1 for terminals, files, diff and search. A real `band-worker`
// process dials a real hub (the production bundle on a random port with auth on). The client
// here is the test itself, speaking the wire protocol the desktop app speaks.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { connect } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { DIRECT_FALLBACK_CLOSE_CODE, type DirectAccess } from "@band-app/shared/direct-access";
import { toWorktreeId } from "@band-app/shared/worktree-id";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { stopTerminalDaemons } from "../../worker/src/terminals";
import { TEST_TOKEN } from "./helpers/acp-chat";
import { seedSettings, seedState } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  startServer,
  trpcData,
  trpcMutate,
  trpcQuery,
} from "./helpers/server";
import { TerminalSocket } from "./helpers/terminal-socket";
import { removeTmpHome } from "./helpers/tmp-home";
import { waitFor } from "./helpers/wait-for";

const WORKER_BIN = join(import.meta.dirname, "../../worker/bin/band-worker.mjs");
/** Short, so the expiry case does not wait ten minutes. Every case asks for a fresh token. */
const TOKEN_TTL_MS = 3000;

const scratch: string[] = [];
const tmp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
}

function makeRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "hello.txt"), "hello from the repo\n");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "app.ts"), "export const answer = 42;\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
}

let hubHome: string;
let server: ServerHandle;
let hostId = "";
let bootstrapToken = "";
let root = "";
let stateDir = "";
let workerHome = "";
let worker: ChildProcess | null = null;
let WT_A = "";
let WT_B = "";

const q = <T>(procedure: string, input?: unknown) =>
  trpcQuery(server.url, procedure, input, TEST_TOKEN).then(async (res) => {
    if (res.status !== 200) throw new Error(`${procedure}: HTTP ${res.status} ${await res.text()}`);
    return trpcData<T>(res);
  });
const m = <T>(procedure: string, input: unknown) =>
  trpcMutate(server.url, procedure, input, TEST_TOKEN).then(async (res) => {
    if (res.status !== 200) throw new Error(`${procedure}: HTTP ${res.status} ${await res.text()}`);
    return trpcData<T>(res);
  });

/** The hub's answer for a call that fails: the message tRPC sends back. */
const hubError = async (procedure: string, input: unknown): Promise<string> => {
  const res = await trpcQuery(server.url, procedure, input, TEST_TOKEN);
  expect(res.status).toBe(500);
  return ((await res.json()) as { error: { message: string } }).error.message;
};

const accessFor = (worktreeId: string, forHost = hostId) =>
  m<DirectAccess | null>("worktree.directAccess", { worktreeId, hostId: forHost });

async function liveAccess(worktreeId: string): Promise<DirectAccess> {
  const access = await accessFor(worktreeId);
  if (!access) throw new Error(`no direct access for ${worktreeId}`);
  return access;
}

const directCall = (
  access: { port: number; token?: string },
  procedure: string,
  input: unknown,
  headers: Record<string, string> = {},
) =>
  fetch(`http://127.0.0.1:${access.port}/direct/${procedure}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(access.token && { authorization: `Bearer ${access.token}` }),
      ...headers,
    },
    body: JSON.stringify(input),
  });

/** One call on each path. Both must answer 200 with the same result. */
async function bothPaths(
  procedure: string,
  input: { worktreeId: string } & Record<string, unknown>,
) {
  const res = await directCall(await liveAccess(input.worktreeId), procedure, input);
  expect(res.status, `${procedure} on the direct path`).toBe(200);
  const direct = ((await res.json()) as { result: unknown }).result;
  const hub = await q(procedure, input);
  return { direct, hub };
}

function startWorker(): ChildProcess {
  const child = spawn(
    process.execPath,
    [
      WORKER_BIN,
      "--hub",
      server.url,
      "--token",
      bootstrapToken,
      "--root",
      root,
      "--state-dir",
      stateDir,
    ],
    {
      env: {
        // A test run inside a Band worktree inherits that worker's own `BAND_*` settings.
        ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("BAND_"))),
        HOME: workerHome,
        BAND_HOME: join(workerHome, ".band"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout?.on("data", () => undefined);
  child.stderr?.on("data", () => undefined);
  return child;
}

async function hostStatus(): Promise<string | undefined> {
  const { hosts } = await q<{ hosts: Array<{ id: string; status: string }> }>("hosts.list");
  return hosts.find((h) => h.id === hostId)?.status;
}

const waitForStatus = (status: string) =>
  waitFor(async () => ((await hostStatus()) === status ? true : undefined), {
    label: `worker ${status}`,
    timeoutMs: 20_000,
  });

async function createWorktree(branch: string): Promise<string> {
  await m("worktrees.create", {
    repo: "proj",
    branch,
    hostId,
    hostRepoPath: join(root, "proj"),
  });
  return toWorktreeId("proj", branch, hostId);
}

const worktreeDir = (branch: string) => join(root, ".band-worktrees", "proj", branch);

/** The status code a WebSocket upgrade is refused with, or `open` when it is accepted. */
function upgradeResult(
  url: string,
  protocols: string[],
  headers: Record<string, string> = {},
): Promise<number | "open"> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, protocols, { headers });
    ws.once("open", () => {
      ws.close();
      resolve("open");
    });
    ws.once("unexpected-response", (_req, res) => {
      resolve(res.statusCode ?? 0);
      ws.terminate();
    });
    ws.once("error", (err) => reject(err));
  });
}

/** Whether a TCP connection to `host:port` is accepted. A silent interface counts as not accepted. */
function tcpConnect(host: string, port: number): Promise<"connected" | "refused" | "timeout"> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    socket.setTimeout(2000, () => {
      socket.destroy();
      resolve("timeout");
    });
    socket.once("connect", () => {
      socket.destroy();
      resolve("connected");
    });
    socket.once("error", () => resolve("refused"));
  });
}

/** A raw request, for headers `fetch` will not let a caller set. */
function rawCall(
  port: number,
  token: string,
  headers: Record<string, string>,
): Promise<{ status: number; allowOrigin: string | undefined }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/direct/worktree.listFiles",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          ...headers,
        },
      },
      (res) => {
        res.resume();
        res.once("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            allowOrigin: res.headers["access-control-allow-origin"] as string | undefined,
          }),
        );
      },
    );
    req.once("error", reject);
    req.end(JSON.stringify({ worktreeId: WT_A }));
  });
}

beforeAll(async () => {
  hubHome = createTmpHome("band-direct-hub-");
  scratch.push(hubHome);
  const hubRepo = join(tmp("band-direct-hubrepo-"), "proj");
  makeRepo(hubRepo);
  seedSettings(hubHome, { tokenSecret: TEST_TOKEN });
  seedState(hubHome, {
    repos: [
      {
        name: "proj",
        path: hubRepo,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: hubRepo }],
      },
    ],
  });
  server = await startServer({
    tmpHome: hubHome,
    remoteHost: false,
    env: { BAND_SERVE_UI: "false", BAND_DIRECT_TOKEN_TTL_MS: String(TOKEN_TTL_MS) },
  });

  const issued = await m<{ token: string; hostId: string }>("tokens.issueWorkerBootstrap", {
    hostName: "this-mac",
    labels: [],
  });
  hostId = issued.hostId;
  bootstrapToken = issued.token;
  workerHome = tmp("band-direct-worker-home-");
  root = tmp("band-direct-worker-root-");
  stateDir = tmp("band-direct-worker-state-");
  makeRepo(join(root, "proj"));
  worker = startWorker();
  await waitForStatus("online");
  WT_A = await createWorktree("feat-a");
  WT_B = await createWorktree("feat-b");
}, 120_000);

afterAll(async () => {
  const child = worker;
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGKILL");
    await exited;
  }
  if (stateDir) stopTerminalDaemons(stateDir);
  await server?.close();
  for (const dir of scratch) removeTmpHome(dir);
});

describe("terminals on the direct path (S1)", () => {
  it("types, resizes and reattaches over 127.0.0.1, not the hub", async () => {
    const { terminalId } = await m<{ terminalId: string }>("terminal.create", {
      worktreeId: WT_A,
    });
    const access = await liveAccess(WT_A);
    expect(access.hostId).toBe(hostId);
    expect(access.port).not.toBe(Number(new URL(server.url).port));

    const first = await TerminalSocket.openDirect(access, { worktreeId: WT_A, terminalId });
    first.type("echo direct-$((40+2))\r");
    await first.waitForOutput("direct-42");
    first.resize(77, 21);
    first.type("stty size\r");
    await first.waitForOutput("21 77");
    await first.close();

    // Closing the tab and opening it again replays the screen from the worker.
    const again = await TerminalSocket.openDirect(await liveAccess(WT_A), {
      worktreeId: WT_A,
      terminalId,
    });
    await again.waitForOutput("direct-42");
    again.type("echo still-$((1+1))\r");
    await again.waitForOutput("still-2");
    await again.close();

    // It is the same PTY the hub serves.
    const viaHub = await TerminalSocket.open(server, {
      worktreeId: WT_A,
      terminalId,
      token: TEST_TOKEN,
    });
    await viaHub.waitForOutput("still-2");
    await viaHub.close();
  });

  it("attaches a new tab's socket once the hub has spawned its PTY", async () => {
    // The UI opens the socket while its `terminal.create` call is still on its way.
    const terminalId = crypto.randomUUID();
    const socket = TerminalSocket.openDirect(await liveAccess(WT_A), {
      worktreeId: WT_A,
      terminalId,
    });
    // A refusal while the create is in flight still fails the test at `await socket`.
    socket.catch(() => undefined);
    await m("terminal.create", { worktreeId: WT_A, id: terminalId });
    const live = await socket;
    live.type("echo fresh-$((5+5))\r");
    await live.waitForOutput("fresh-10");
    await live.close();
  });

  it("sends a terminal the worker never gets back to the hub, which spawns it", async () => {
    const terminalId = crypto.randomUUID();
    const access = await liveAccess(WT_A);
    const ws = new WebSocket(
      `ws://127.0.0.1:${access.port}/terminal?worktreeId=${encodeURIComponent(WT_A)}&terminalId=${terminalId}`,
      ["band", `band-token.${access.token}`],
    );
    const code = await new Promise<number>((resolve) => ws.once("close", resolve));
    expect(code).toBe(DIRECT_FALLBACK_CLOSE_CODE);
    // The client then connects to the hub, which spawns the terminal on the worker.
    const viaHub = await TerminalSocket.open(server, {
      worktreeId: WT_A,
      terminalId,
      token: TEST_TOKEN,
    });
    viaHub.type("echo spawned-$((6+6))\r");
    await viaHub.waitForOutput("spawned-12");
    await viaHub.close();
  });
});

describe("files, diff and search on the direct path (S2)", () => {
  beforeAll(() => {
    const dir = worktreeDir("feat-a");
    writeFileSync(join(dir, "hello.txt"), "hello, changed\n");
    writeFileSync(join(dir, "notes.md"), "# notes\nfind the needle here\n");
    git(dir, "add", "notes.md");
    writeFileSync(join(dir, "src", "untracked.ts"), "const needle = 1;\n");
  });

  it("answers the file tree and a file read as the hub does", async () => {
    for (const path of ["", "src"]) {
      const { direct, hub } = await bothPaths("worktree.listFiles", { worktreeId: WT_A, path });
      expect(direct).toEqual(hub);
    }
    const { direct, hub } = await bothPaths("worktree.getFile", {
      worktreeId: WT_A,
      path: "hello.txt",
    });
    expect(direct).toEqual(hub);
    expect(direct).toMatchObject({ content: "hello, changed\n" });
  });

  it("saves a file that the hub then reads", async () => {
    const res = await directCall(await liveAccess(WT_A), "worktree.saveFile", {
      worktreeId: WT_A,
      path: "notes.md",
      content: "# notes\nsaved directly, needle kept\n",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: { ok: true } });
    expect(readFileSync(join(worktreeDir("feat-a"), "notes.md"), "utf8")).toBe(
      "# notes\nsaved directly, needle kept\n",
    );
    const read = await q<{ content: string }>("worktree.getFile", {
      worktreeId: WT_A,
      path: "notes.md",
    });
    expect(read.content).toBe("# notes\nsaved directly, needle kept\n");
  });

  it("answers Changes, a file diff and the whole diff as the hub does", async () => {
    const changes = await bothPaths("worktree.getChanges", { worktreeId: WT_A });
    expect(changes.direct).toEqual(changes.hub);
    expect(JSON.stringify(changes.direct)).toContain("hello.txt");

    for (const input of [
      { worktreeId: WT_A, filePath: "hello.txt", section: "unstaged" },
      { worktreeId: WT_A, filePath: "notes.md", section: "staged" },
      { worktreeId: WT_A, filePath: "src/untracked.ts", section: "untracked" },
    ]) {
      const fileDiff = await bothPaths("worktree.getFileDiff", input);
      expect(fileDiff.direct).toEqual(fileDiff.hub);
    }
    const diff = await bothPaths("worktree.getDiff", { worktreeId: WT_A });
    expect(diff.direct).toEqual(diff.hub);
    expect(JSON.stringify(diff.direct)).toContain("hello, changed");
  });

  it("searches by file name and by content as the hub does", async () => {
    const byName = await bothPaths("worktree.searchFiles", {
      worktreeId: WT_A,
      query: "untrack",
    });
    expect(byName.direct).toEqual(byName.hub);
    expect(byName.direct).toEqual({ files: ["src/untracked.ts"] });

    const byContent = await bothPaths("worktree.searchContent", {
      worktreeId: WT_A,
      query: "needle",
    });
    // ripgrep searches files in parallel, so neither path orders its matches.
    const sorted = (reply: unknown) =>
      [...(reply as { results: { file: string }[] }).results].sort((x, y) =>
        x.file.localeCompare(y.file),
      );
    expect(sorted(byContent.direct)).toEqual(sorted(byContent.hub));
    expect(sorted(byContent.direct).map((r) => r.file)).toEqual(["notes.md", "src/untracked.ts"]);
  });
});

/** A GET on the listener's file routes, with the token as a header. */
const directGet = (
  access: { port: number; token?: string },
  path: string,
  headers: Record<string, string> = {},
) =>
  fetch(`http://127.0.0.1:${access.port}${path}`, {
    headers: { ...(access.token && { authorization: `Bearer ${access.token}` }), ...headers },
  });

const filePath = (worktreeId: string, path: string) =>
  `/api/worktree-file/${encodeURIComponent(worktreeId)}/${path.split("/").map(encodeURIComponent).join("/")}`;

describe("history, branches and explorer actions on the direct path (S1)", () => {
  it("answers commit history, a commit and the branch list as the hub does", async () => {
    const dir = worktreeDir("feat-a");
    writeFileSync(join(dir, "history.txt"), "one\n");
    git(dir, "add", "history.txt");
    git(dir, "commit", "-q", "-m", "add history");

    const signature = await bothPaths("worktree.getCommitHistorySignature", { worktreeId: WT_A });
    expect(signature.direct).toEqual(signature.hub);
    expect(signature.direct).not.toBe("");

    const history = await bothPaths("worktree.getCommitHistory", { worktreeId: WT_A, limit: 10 });
    expect(history.direct).toEqual(history.hub);
    const commits = (history.direct as { commits: { sha: string; subject: string }[] }).commits;
    expect(commits.map((c) => c.subject)).toEqual(["add history", "init"]);

    const details = await bothPaths("worktree.getCommitDetails", {
      worktreeId: WT_A,
      sha: commits[0].sha,
    });
    expect(details.direct).toEqual(details.hub);
    expect(JSON.stringify(details.direct)).toContain("history.txt");

    const branches = await bothPaths("worktree.listBranches", { worktreeId: WT_A });
    expect(branches.direct).toEqual(branches.hub);
    expect(JSON.stringify(branches.direct)).toContain("feat-b");
  });

  it("creates, copies, renames and deletes in the explorer, ", async () => {
    const dir = worktreeDir("feat-a");
    const call = async (procedure: string, input: Record<string, unknown>) => {
      const res = await directCall(await liveAccess(WT_A), procedure, {
        worktreeId: WT_A,
        ...input,
      });
      expect(res.status, procedure).toBe(200);
      return ((await res.json()) as { result: unknown }).result;
    };
    await call("worktree.createDirectory", { path: "made" });
    await call("worktree.createFile", { path: "made/a.txt", content: "made directly\n" });
    expect(readFileSync(join(dir, "made", "a.txt"), "utf8")).toBe("made directly\n");
    await call("worktree.copyPath", { fromPath: "made/a.txt", toPath: "made/b.txt" });
    await call("worktree.renamePath", { fromPath: "made/b.txt", toPath: "made/c.txt" });
    const listed = await q<{ entries: { name: string }[] }>("worktree.listFiles", {
      worktreeId: WT_A,
      path: "made",
    });
    expect(listed.entries.map((e) => e.name).sort()).toEqual(["a.txt", "c.txt"]);

    // resolvePath stays on the hub: a file outside the worker's roots must still be seen as existing.
    const notServed = await directCall(await liveAccess(WT_A), "worktree.resolvePath", {
      worktreeId: WT_A,
      path: "made/a.txt",
    });
    expect(notServed.status).toBe(404);

    await call("worktree.deletePath", { path: "made" });
    const gone = await q<{ entries: { name: string }[] }>("worktree.listFiles", {
      worktreeId: WT_A,
      path: "",
    });
    expect(gone.entries.map((e) => e.name)).not.toContain("made");
  });

  it("refuses an explorer path outside the worktree as the hub does", async () => {
    const input = { worktreeId: WT_A, path: "../escaped.txt", content: "" };
    const res = await directCall(await liveAccess(WT_A), "worktree.createFile", input);
    expect(res.status).toBe(500);
    const { error } = (await res.json()) as { error: { message: string } };
    const hub = await trpcMutate(server.url, "worktree.createFile", input, TEST_TOKEN);
    expect(error.message).toBe(
      ((await hub.json()) as { error: { message: string } }).error.message,
    );
  });
});

describe("file routes on the direct path (S2)", () => {
  const BYTES = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 251));

  beforeAll(() => {
    const dir = worktreeDir("feat-a");
    mkdirSync(join(dir, "assets"), { recursive: true });
    writeFileSync(join(dir, "assets", "clip.mp4"), BYTES);
    writeFileSync(join(dir, "assets", 'we"ird; näme.txt'), "odd name");
    symlinkSync(join(root, "outside.txt"), join(dir, "assets", "escape.txt"));
    writeFileSync(join(root, "outside.txt"), "outside the worktree");
    mkdirSync(join(root, ".band-uploads", WT_A), { recursive: true });
    writeFileSync(join(root, ".band-uploads", WT_A, "up.png"), BYTES);
    mkdirSync(join(root, ".band-shared", WT_A, "chat-1"), { recursive: true });
    writeFileSync(join(root, ".band-shared", WT_A, "chat-1", "note.txt"), "shared note");
  });

  it("serves the same bytes and headers as the hub, and a Range as 206", async () => {
    const access = await liveAccess(WT_A);
    const path = filePath(WT_A, "assets/clip.mp4");
    const direct = await directGet(access, path);
    expect(direct.status).toBe(200);
    expect(direct.headers.get("content-type")).toBe("video/mp4");
    expect(direct.headers.get("accept-ranges")).toBe("bytes");
    expect(direct.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await direct.arrayBuffer()).equals(BYTES)).toBe(true);
    const hub = await fetch(`${server.url}${path}`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(Buffer.from(await hub.arrayBuffer()).equals(BYTES)).toBe(true);

    const part = await directGet(access, path, { Range: "bytes=100-199" });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe(`bytes 100-199/${BYTES.length}`);
    expect(Buffer.from(await part.arrayBuffer()).equals(BYTES.subarray(100, 200))).toBe(true);
    const past = await directGet(access, path, { Range: `bytes=${BYTES.length + 10}-` });
    expect(past.status).toBe(416);
  });

  it("downloads as an attachment and refuses a folder", async () => {
    const access = await liveAccess(WT_A);
    const res = await directGet(access, `${filePath(WT_A, 'assets/we"ird; näme.txt')}?download=1`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain(
      "filename*=UTF-8''we%22ird%3B%20n%C3%A4me.txt",
    );
    expect(await res.text()).toBe("odd name");
    expect((await directGet(access, `${filePath(WT_A, "assets")}?download=1`)).status).toBe(400);
  });

  it("answers 400 for a path out of the worktree and 404 for a missing file", async () => {
    const access = await liveAccess(WT_A);
    const outOfTree = `/api/worktree-file/${encodeURIComponent(WT_A)}/${encodeURIComponent("../secret.txt")}`;
    expect((await directGet(access, outOfTree)).status).toBe(400);
    expect((await directGet(access, filePath(WT_A, "assets/escape.txt"))).status).toBe(400);
    expect((await directGet(access, filePath(WT_A, "assets/missing.png"))).status).toBe(404);
  });

  it("serves an upload and a shared file from the worker's directories", async () => {
    const access = await liveAccess(WT_A);
    const upload = await directGet(
      access,
      `/api/uploads/${encodeURIComponent(WT_A)}/${encodeURIComponent("up.png")}`,
    );
    expect(upload.status).toBe(200);
    expect(upload.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await upload.arrayBuffer()).equals(BYTES)).toBe(true);
    const shared = await directGet(
      access,
      `/api/shared/${encodeURIComponent(WT_A)}/chat-1/note.txt`,
    );
    expect(shared.status).toBe(200);
    expect(await shared.text()).toBe("shared note");
    expect(
      (await directGet(access, `/api/shared/${encodeURIComponent(WT_A)}/chat-1/missing.txt`))
        .status,
    ).toBe(404);
    // A name with a path in it never leaves the card's folder.
    expect(
      (
        await directGet(
          access,
          `/api/uploads/${encodeURIComponent(WT_A)}/${encodeURIComponent("../../outside.txt")}`,
        )
      ).status,
    ).toBe(400);
  });

  it("refuses no token, a bad token, another worktree's token and a hub token", async () => {
    const access = await liveAccess(WT_A);
    const path = filePath(WT_A, "assets/clip.mp4");
    expect((await directGet({ port: access.port }, path)).status).toBe(401);
    expect((await directGet({ port: access.port, token: "bwd_unknown" }, path)).status).toBe(401);
    expect((await directGet({ port: access.port, token: TEST_TOKEN }, path)).status).toBe(401);
    expect((await directGet(access, filePath(WT_B, "hello.txt"))).status).toBe(403);
    expect(
      (await directGet(access, `/api/shared/${encodeURIComponent(WT_B)}/chat-1/note.txt`)).status,
    ).toBe(403);
    // A page other than the desktop app's is refused, and a token in the URL is no credential.
    expect((await directGet(access, path, { Origin: "https://evil.example" })).status).toBe(403);
    expect((await directGet({ port: access.port }, `${path}?token=${access.token}`)).status).toBe(
      401,
    );
  });

  it("refuses a foreign Host header on the file routes", async () => {
    const access = await liveAccess(WT_A);
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: access.port,
          path: filePath(WT_A, "assets/clip.mp4"),
          headers: { host: "rebind.example", authorization: `Bearer ${access.token}` },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.once("error", reject);
      req.end();
    });
    expect(status).toBe(421);
  });

  it("answers 401 once the token has expired, so a client falls back to the hub", async () => {
    const access = await liveAccess(WT_A);
    const path = filePath(WT_A, "assets/clip.mp4");
    expect((await directGet(access, path)).status).toBe(200);
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, access.expiresAt - Date.now()) + 200),
    );
    expect((await directGet(access, path)).status).toBe(401);
    const hub = await fetch(`${server.url}${path}`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(hub.status).toBe(200);
  });
});

describe("what the listener refuses (S3)", () => {
  it("refuses a call with no token, an unknown token or an expired one", async () => {
    const access = await liveAccess(WT_A);
    const input = { worktreeId: WT_A, path: "" };
    expect((await directCall({ port: access.port }, "worktree.listFiles", input)).status).toBe(401);
    expect(
      (await directCall({ port: access.port, token: "bwd_unknown" }, "worktree.listFiles", input))
        .status,
    ).toBe(401);
    // A hub token is no credential here.
    expect(
      (await directCall({ port: access.port, token: TEST_TOKEN }, "worktree.listFiles", input))
        .status,
    ).toBe(401);
    expect((await directCall(access, "worktree.listFiles", input)).status).toBe(200);
    // `expiresAt` is on the worker's clock, which is this machine's.
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, access.expiresAt - Date.now()) + 200),
    );
    expect((await directCall(access, "worktree.listFiles", input)).status).toBe(401);
  });

  it("refuses a token for another worktree, for calls and for terminals", async () => {
    const { terminalId } = await m<{ terminalId: string }>("terminal.create", {
      worktreeId: WT_B,
    });
    // Fetched after the create, so the short-lived token is still live for every check below.
    const access = await liveAccess(WT_A);
    const res = await directCall(access, "worktree.listFiles", { worktreeId: WT_B, path: "" });
    expect(res.status).toBe(403);

    const protocols = ["band", `band-token.${access.token}`];
    const base = `ws://127.0.0.1:${access.port}/terminal?terminalId=${terminalId}`;
    // Named as B's terminal, with A's token.
    expect(await upgradeResult(`${base}&worktreeId=${encodeURIComponent(WT_B)}`, protocols)).toBe(
      403,
    );
    // B's terminal named as A's.
    expect(await upgradeResult(`${base}&worktreeId=${encodeURIComponent(WT_A)}`, protocols)).toBe(
      403,
    );
    expect(await upgradeResult(`${base}&worktreeId=${encodeURIComponent(WT_B)}`, ["band"])).toBe(
      401,
    );
  });

  it("refuses a path outside the worktree as the hub does", async () => {
    const outside = tmp("band-direct-outside-");
    writeFileSync(join(outside, "secret.txt"), "not yours\n");
    symlinkSync(join(outside, "secret.txt"), join(worktreeDir("feat-a"), "escape.txt"));

    for (const path of ["../feat-b/hello.txt", "escape.txt"]) {
      const input = { worktreeId: WT_A, path };
      const res = await directCall(await liveAccess(WT_A), "worktree.getFile", input);
      expect(res.status, path).toBe(500);
      const { error } = (await res.json()) as { error: { message: string } };
      expect(error.message).toBe(await hubError("worktree.getFile", input));
      expect(error.message).not.toContain("not yours");
    }
  });

  it("does not accept connections on any interface but loopback", async (ctx) => {
    const external = Object.values(networkInterfaces())
      .flat()
      .filter((a) => a && a.family === "IPv4" && !a.internal)
      .map((a) => a?.address as string);
    // With no external interface there is nothing to probe, and the report says so.
    if (external.length === 0) ctx.skip();
    const { port } = await liveAccess(WT_A);
    for (const address of external) {
      expect(await tcpConnect(address, port), address).not.toBe("connected");
    }
  });

  it("answers only to the desktop app's pages", async () => {
    const access = await liveAccess(WT_A);
    // A page that rebinds a DNS name to 127.0.0.1 sends its own host name.
    expect(
      (await rawCall(access.port, access.token, { host: `evil.example:${access.port}` })).status,
    ).toBe(421);
    expect(
      (await rawCall(access.port, access.token, { origin: "https://evil.example" })).status,
    ).toBe(403);
    // The bundled hub's pages never take the direct path.
    expect((await rawCall(access.port, access.token, { origin: "app://local" })).status).toBe(403);
    const desktop = await rawCall(access.port, access.token, { origin: "app://h-0123456789ab" });
    expect(desktop).toEqual({ status: 200, allowOrigin: "app://h-0123456789ab" });

    // The terminal socket checks the same, since a browser applies no CORS to a WebSocket.
    const { terminalId } = await m<{ terminalId: string }>("terminal.create", {
      worktreeId: WT_A,
    });
    const live = await liveAccess(WT_A);
    const url = `ws://127.0.0.1:${live.port}/terminal?worktreeId=${encodeURIComponent(WT_A)}&terminalId=${terminalId}`;
    const protocols = ["band", `band-token.${live.token}`];
    expect(await upgradeResult(url, protocols, { origin: "https://evil.example" })).toBe(403);
    expect(await upgradeResult(url, protocols, { host: `evil.example:${live.port}` })).toBe(421);
    expect(await upgradeResult(url, protocols, { origin: "app://local" })).toBe(403);
    expect(await upgradeResult(url, protocols, { origin: "app://h-0123456789ab" })).toBe("open");
  });
});

describe("falling back to the hub (S3)", () => {
  it("answers 401 for every moved call and route once the token expired, and the hub serves the same", async () => {
    mkdirSync(join(worktreeDir("feat-a"), "fallback"), { recursive: true });
    writeFileSync(join(worktreeDir("feat-a"), "fallback", "pic.png"), "png-bytes");
    mkdirSync(join(root, ".band-uploads", WT_A), { recursive: true });
    writeFileSync(join(root, ".band-uploads", WT_A, "fb.png"), "upload-bytes");
    mkdirSync(join(root, ".band-shared", WT_A, "chat-fb"), { recursive: true });
    writeFileSync(join(root, ".band-shared", WT_A, "chat-fb", "note.txt"), "shared-bytes");
    const sha = git(worktreeDir("feat-a"), "rev-parse", "HEAD").trim();

    const access = await liveAccess(WT_A);
    const calls: Array<{ procedure: string; kind: "query" | "mutation"; input: object }> = [
      { procedure: "worktree.getCommitHistory", kind: "query", input: { worktreeId: WT_A } },
      {
        procedure: "worktree.getCommitHistorySignature",
        kind: "query",
        input: { worktreeId: WT_A },
      },
      { procedure: "worktree.getCommitDetails", kind: "query", input: { worktreeId: WT_A, sha } },
      { procedure: "worktree.listBranches", kind: "query", input: { worktreeId: WT_A } },
      {
        procedure: "worktree.createFile",
        kind: "mutation",
        input: { worktreeId: WT_A, path: "fallback/new.txt", content: "x" },
      },
      {
        procedure: "worktree.createDirectory",
        kind: "mutation",
        input: { worktreeId: WT_A, path: "fallback/dir" },
      },
      {
        procedure: "worktree.copyPath",
        kind: "mutation",
        input: { worktreeId: WT_A, fromPath: "fallback/new.txt", toPath: "fallback/copy.txt" },
      },
      {
        procedure: "worktree.renamePath",
        kind: "mutation",
        input: { worktreeId: WT_A, fromPath: "fallback/copy.txt", toPath: "fallback/moved.txt" },
      },
      {
        procedure: "worktree.deletePath",
        kind: "mutation",
        input: { worktreeId: WT_A, path: "fallback/moved.txt" },
      },
    ];
    const routes = [
      { path: filePath(WT_A, "fallback/pic.png"), body: "png-bytes" },
      { path: `/api/uploads/${encodeURIComponent(WT_A)}/fb.png`, body: "upload-bytes" },
      { path: `/api/shared/${encodeURIComponent(WT_A)}/chat-fb/note.txt`, body: "shared-bytes" },
    ];

    // Live token: the direct listener serves the route.
    expect((await directGet(access, routes[0].path)).status).toBe(200);
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, access.expiresAt - Date.now()) + 200),
    );

    for (const { procedure, input } of calls) {
      const res = await directCall(access, procedure, input);
      expect(res.status, `${procedure} with an expired token`).toBe(401);
    }
    for (const { path } of routes) {
      expect((await directGet(access, path)).status, path).toBe(401);
    }
    // An unknown token is refused the same way.
    expect(
      (await directGet({ port: access.port, token: "bwd_revoked" }, routes[0].path)).status,
    ).toBe(401);

    // The client then asks the hub, which serves each call and route.
    for (const { procedure, kind, input } of calls) {
      await (kind === "query" ? q(procedure, input) : m(procedure, input));
    }
    for (const { path, body } of routes) {
      const res = await fetch(`${server.url}${path}`, {
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      });
      expect(res.status, path).toBe(200);
      expect(await res.text()).toBe(body);
    }
  });
});

describe("who may get a token", () => {
  it("refuses worktree.directAccess without a device token", async () => {
    for (const token of ["", "not-a-device-token"]) {
      const res = await trpcMutate(
        server.url,
        "worktree.directAccess",
        { worktreeId: WT_A, hostId },
        token,
      );
      expect(res.status, token || "no token").toBe(401);
    }
  });
});

describe("other hosts keep the hub path (S5)", () => {
  it("offers no direct path for a worktree on the hub's machine or another host", async () => {
    expect(await accessFor(toWorktreeId("proj", "main", "local"))).toBeNull();
    expect(await accessFor(WT_A, "h-000000000000")).toBeNull();
  });
});

describe("the worker restarting (S4)", () => {
  it("refuses while the worker is down, then serves the same shell with new tokens", async () => {
    const { terminalId } = await m<{ terminalId: string }>("terminal.create", {
      worktreeId: WT_A,
    });
    const before = await liveAccess(WT_A);
    const socket = await TerminalSocket.openDirect(before, { worktreeId: WT_A, terminalId });
    socket.type("echo before-$((2+3))\r");
    await socket.waitForOutput("before-5");

    const child = worker as ChildProcess;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await exited;
    // The direct socket drops with the worker. The client reconnects through the hub.
    expect(await socket.waitForClose()).not.toBe(1000);
    await expect(
      directCall(before, "worktree.listFiles", { worktreeId: WT_A, path: "" }),
    ).rejects.toThrow();
    await waitForStatus("offline");
    expect(await accessFor(WT_A)).toBeNull();

    worker = startWorker();
    await waitForStatus("online");
    // The shell outlived the worker in its terminal daemon, and both paths replay it.
    const viaHub = await TerminalSocket.open(server, {
      worktreeId: WT_A,
      terminalId,
      token: TEST_TOKEN,
    });
    await viaHub.waitForOutput("before-5");
    await viaHub.close();
    const direct = await TerminalSocket.openDirect(await liveAccess(WT_A), {
      worktreeId: WT_A,
      terminalId,
    });
    await direct.waitForOutput("before-5");
    direct.type("echo after-$((3+4))\r");
    await direct.waitForOutput("after-7");
    await direct.close();
  }, 90_000);
});
