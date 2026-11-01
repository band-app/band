// Integration test for the login-shell PATH lookup of a worker. A real `band-worker` dials a real hub
// with SHELL pointing at a stub shell that fails its first run and prints a PATH holding the agent's
// command afterwards. The agent behind the chat is the scripted ACP stub, which records the binary it
// was handed (`CLAUDE_CODE_EXECUTABLE`). The worker retries a failed lookup after 30 s, so the test
// waits that long once.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toWorktreeId } from "@band-app/shared/worktree-id";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openStream, STUB_AGENT_PATH, TEST_TOKEN } from "./helpers/acp-chat";
import { seedSettings } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  startServer,
  trpcData,
  trpcMutate,
  trpcQuery,
} from "./helpers/server";
import { waitFor } from "./helpers/wait-for";

import { WORKER_BIN } from "./helpers/worker-bin";

const scratch: string[] = [];
const tmp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
};

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
}

let server: ServerHandle;

const m = <T>(procedure: string, input: unknown) =>
  trpcMutate(server.url, procedure, input, TEST_TOKEN).then(async (res) => {
    if (res.status !== 200) throw new Error(`${procedure}: HTTP ${res.status} ${await res.text()}`);
    return trpcData<T>(res);
  });
const q = <T>(procedure: string, input?: unknown) =>
  trpcQuery(server.url, procedure, input, TEST_TOKEN).then(async (res) => {
    if (res.status !== 200) throw new Error(`${procedure}: HTTP ${res.status} ${await res.text()}`);
    return trpcData<T>(res);
  });

const COMMAND = "fake-claude";
let hostId = "";
let worktreeId = "";
let stubLog = "";
let workerLog = "";
let shellRuns = "";
let commandDir = "";
let worker: ChildProcess | undefined;

beforeAll(async () => {
  const hubHome = createTmpHome("band-shell-path-hub-");
  scratch.push(hubHome);
  const hubRepo = join(tmp("band-shell-path-hubrepo-"), "proj");
  mkdirSync(hubRepo, { recursive: true });
  git(hubRepo, "init", "-q", "-b", "main");
  writeFileSync(join(hubRepo, "hello.txt"), "hello\n");
  git(hubRepo, "add", ".");
  git(hubRepo, "commit", "-q", "-m", "init");
  seedSettings(hubHome, {
    tokenSecret: TEST_TOKEN,
    codingAgents: [
      { id: "claude-code", type: "claude-code", label: "Claude Code", command: COMMAND },
    ],
    defaultCodingAgent: "claude-code",
  });
  server = await startServer({
    tmpHome: hubHome,
    remoteHost: false,
    env: { BAND_SERVE_UI: "false" },
  });
  await m("repos.add", { path: hubRepo });

  const issued = await m<{ token: string; hostId: string }>("tokens.issueWorkerBootstrap", {
    hostName: "shell-path",
    labels: [],
  });
  hostId = issued.hostId;
  const home = tmp("band-shell-path-home-");
  const root = tmp("band-shell-path-root-");
  const repo = join(root, "proj");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "hello.txt"), "hello\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");

  // The command exists only on the PATH the stub shell prints.
  commandDir = tmp("band-shell-path-bin-");
  writeFileSync(join(commandDir, COMMAND), "#!/bin/sh\nexit 0\n");
  chmodSync(join(commandDir, COMMAND), 0o755);
  shellRuns = join(home, "shell-runs.log");
  const stubShell = join(home, "stub-shell.sh");
  writeFileSync(
    stubShell,
    `#!/bin/sh
if [ ! -s "${shellRuns}" ]; then echo failed >> "${shellRuns}"; echo "rc file blocked" >&2; exit 1; fi
echo ok >> "${shellRuns}"
echo "${commandDir}:/usr/bin:/bin"
`,
  );
  chmodSync(stubShell, 0o755);

  stubLog = join(home, "stub-log.jsonl");
  workerLog = join(home, "worker.log");
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("BAND_")),
  );
  const out = openSync(workerLog, "a");
  worker = spawn(
    process.execPath,
    [
      WORKER_BIN,
      "--hub",
      server.url,
      "--token",
      issued.token,
      "--root",
      root,
      "--state-dir",
      tmp("band-shell-path-state-"),
    ],
    {
      env: {
        ...env,
        HOME: home,
        SHELL: stubShell,
        BAND_HOME: join(home, ".band"),
        BAND_TEST_ACP_AGENT: STUB_AGENT_PATH,
        BAND_TEST_ACP_STATE: join(home, "acp-state"),
        BAND_TEST_ACP_LOG: stubLog,
        BAND_TEST_ACP_LOG_ENV: "CLAUDE_CODE_EXECUTABLE",
      },
      stdio: ["ignore", out, out],
    },
  );
  await waitFor(
    async () => {
      const { hosts } = await q<{ hosts: { id: string; status: string }[] }>("hosts.list");
      return hosts.find((h) => h.id === hostId)?.status === "online" ? true : undefined;
    },
    { label: "worker online", timeoutMs: 30_000 },
  );
  await m("worktrees.create", { repo: "proj", branch: "path", hostId, hostRepoPath: repo });
  worktreeId = toWorktreeId("proj", "path", hostId);
}, 180_000);

afterAll(async () => {
  worker?.kill("SIGKILL");
  await server?.close();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
});

const send = async (chatId: string) => {
  await m("chats.create", { worktreeId, id: chatId });
  const res = await fetch(`${server.url}/api/chats/${chatId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `band_token=${TEST_TOKEN}` },
    body: JSON.stringify({ worktreeId, text: "hello" }),
  });
  expect(res.ok).toBe(true);
};

describe("login-shell PATH lookup", () => {
  it("names the searched PATH and logs one warning when the lookup fails (S2, S3)", async () => {
    const chatId = "shell-path-failed";
    await m("chats.create", { worktreeId, id: chatId });
    // The launch error is a transient event that is not replayed, so the stream opens first.
    const stream = await openStream(server.url, chatId, {
      lastEventId: 0,
      until: (e) => JSON.stringify(e).includes("Searched PATH"),
      timeoutMs: 15_000,
    });
    stream.events.catch(() => undefined);
    const res = await fetch(`${server.url}/api/chats/${chatId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `band_token=${TEST_TOKEN}` },
      body: JSON.stringify({ worktreeId, text: "hello" }),
    });
    expect(res.ok).toBe(true);
    const text = JSON.stringify((await stream.events).at(-1));
    expect(text).toContain("was not found or is not executable");
    expect(text).toContain("/usr/bin");
    expect(text).not.toContain(commandDir);

    const log = readFileSync(workerLog, "utf8");
    expect(log.match(/Could not read PATH from login shell/g)).toHaveLength(1);
    expect(log).toContain("stub-shell.sh");
    // Every launch inside the window shared the one failed run.
    expect(readFileSync(shellRuns, "utf8").trim().split("\n")).toEqual(["failed"]);
  });

  it("finds the command from the login shell's PATH after the retry, with no restart (S1)", async () => {
    let n = 0;
    await waitFor(
      async () => {
        await send(`shell-path-retried-${n++}`);
        if (!existsSync(stubLog)) return undefined;
        const last = readFileSync(stubLog, "utf8")
          .split("\n")
          .filter(Boolean)
          .map(
            (l) =>
              JSON.parse(l) as { method: string; env: { NAMED: Record<string, string | null> } },
          )
          .filter((r) => r.method === "session/new")
          .at(-1);
        return last?.env.NAMED.CLAUDE_CODE_EXECUTABLE === join(commandDir, COMMAND)
          ? true
          : undefined;
      },
      { label: "agent found after the retry", timeoutMs: 60_000, intervalMs: 5_000 },
    );
    expect(readFileSync(shellRuns, "utf8").trim().split("\n")).toEqual(["failed", "ok"]);
  }, 90_000);
});
