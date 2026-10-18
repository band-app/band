// Integration test for agent logins on a worker. A real `band-worker` dials a real hub. The worker's
// machine has no Claude login (a fake `claude` that is installed and reports "not logged in") and its
// agent is the scripted ACP stub, which records the credential variables in its environment.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toWorktreeId } from "@band-app/shared/worktree-id";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { STUB_AGENT_PATH, TEST_TOKEN } from "./helpers/acp-chat";
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

const WORKER_BIN = join(import.meta.dirname, "../../worker/bin/band-worker.mjs");
const SETUP_TOKEN = "sk-ant-oat01-WORKER-SETUPTOKEN-plaintext-7777";
const WORKER_AUTH_TOKEN = "worker-machine-anthropic-auth-token";

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
let workerChild: ChildProcess;
let workerOutput = "";
let workerHome: string;
let stubLogFile: string;
let hostId: string;
let worktreeId: string;

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

const workerAgents = async () =>
  (await q<{ hosts: { id: string; agents?: string[] }[] }>("hosts.list")).hosts.find(
    (h) => h.id === hostId,
  )?.agents ?? [];

beforeAll(async () => {
  const hubHome = createTmpHome("band-agent-logins-hub-");
  scratch.push(hubHome);
  const hubRepo = join(tmp("band-agent-logins-hubrepo-"), "proj");
  mkdirSync(hubRepo, { recursive: true });
  git(hubRepo, "init", "-q", "-b", "main");
  writeFileSync(join(hubRepo, "hello.txt"), "hello\n");
  git(hubRepo, "add", ".");
  git(hubRepo, "commit", "-q", "-m", "init");
  // A shell script as the agent's CLI in a terminal: it prints the two Claude credential variables.
  const envCli = join(hubHome, "env-cli.sh");
  writeFileSync(
    envCli,
    `#!/bin/sh\nprintf 'LOGIN:%s|%s|%s|\\n' "\${CLAUDE_CODE_OAUTH_TOKEN-unset}" "\${ANTHROPIC_API_KEY-unset}" "\${ANTHROPIC_AUTH_TOKEN-unset}"\n`,
  );
  chmodSync(envCli, 0o755);
  seedSettings(hubHome, {
    tokenSecret: TEST_TOKEN,
    codingAgents: [
      { id: "claude-code", type: "claude-code", label: "Claude Code", command: envCli },
    ],
    defaultCodingAgent: "claude-code",
  });
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
    env: { BAND_SERVE_UI: "false" },
  });

  const issued = await m<{ token: string; hostId: string }>("tokens.issueWorkerBootstrap", {
    hostName: "login-worker",
    labels: [],
  });
  hostId = issued.hostId;

  workerHome = tmp("band-agent-logins-home-");
  const root = tmp("band-agent-logins-root-");
  const workerRepo = join(root, "proj");
  mkdirSync(workerRepo, { recursive: true });
  git(workerRepo, "init", "-q", "-b", "main");
  writeFileSync(join(workerRepo, "hello.txt"), "hello from the repo\n");
  git(workerRepo, "add", ".");
  git(workerRepo, "commit", "-q", "-m", "init");

  // Installed, but `claude auth status` fails: the machine has no Claude login.
  const binDir = tmp("band-agent-logins-bin-");
  const fakeClaude = join(binDir, "claude");
  writeFileSync(
    fakeClaude,
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.0 (Claude Code)"; exit 0; fi\nexit 1\n',
  );
  chmodSync(fakeClaude, 0o755);

  stubLogFile = join(workerHome, "stub-log.jsonl");
  const workerEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) =>
        !k.startsWith("BAND_") &&
        !["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"].includes(k),
    ),
  );
  workerChild = spawn(
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
      tmp("band-agent-logins-state-"),
    ],
    {
      env: {
        ...workerEnv,
        HOME: workerHome,
        BAND_HOME: join(workerHome, ".band"),
        BAND_AGENT_BIN_DIRS: binDir,
        // Not a login to the probe, but a competitor of the setup token that Band must remove.
        ANTHROPIC_AUTH_TOKEN: WORKER_AUTH_TOKEN,
        BAND_TEST_ACP_AGENT: STUB_AGENT_PATH,
        BAND_TEST_ACP_STATE: join(workerHome, "acp-state"),
        BAND_TEST_ACP_LOG: stubLogFile,
        BAND_TEST_ACP_LOG_ENV: "CLAUDE_CODE_OAUTH_TOKEN,ANTHROPIC_API_KEY,ANTHROPIC_AUTH_TOKEN",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  workerChild.stdout?.on("data", (c: Buffer) => {
    workerOutput += c.toString();
  });
  workerChild.stderr?.on("data", (c: Buffer) => {
    workerOutput += c.toString();
  });
  await waitFor(
    async () => {
      const { hosts } = await q<{ hosts: { id: string; status: string }[] }>("hosts.list");
      return hosts.find((h) => h.id === hostId)?.status === "online" ? true : undefined;
    },
    { label: "worker online", timeoutMs: 20_000 },
  );
  await m("worktrees.create", {
    repo: "proj",
    branch: "login",
    hostId,
    hostRepoPath: workerRepo,
  });
  worktreeId = toWorktreeId("proj", "login", hostId);
}, 120_000);

afterAll(async () => {
  workerChild?.kill("SIGKILL");
  await server?.close();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
});

describe("agent logins on a worker", () => {
  it("does not count Claude Code usable on a worker with no login of its own (S9, before)", async () => {
    expect(await workerAgents()).not.toContain("claude-code");
  });

  it("counts the worker able to start Claude Code once a Band login exists (S9)", async () => {
    const { login } = await m<{ login: { id: string } }>("agentLogins.create", {
      agentType: "claude-code",
      kind: "setup-token",
      label: "Worker token",
      secret: SETUP_TOKEN,
    });
    await m("agentLogins.setDefault", { agentType: "claude-code", loginId: login.id });
    await waitFor(async () => ((await workerAgents()).includes("claude-code") ? true : undefined), {
      label: "claude-code usable on the worker",
    });
    const availability = await q<{
      agents: { agentId: string; hosts: { hostId: string; available: boolean }[] }[];
    }>("models.availability");
    const entry = availability.agents.find((a) => a.agentId === "claude-code");
    expect(entry?.hosts.find((h) => h.hostId === hostId)?.available).toBe(true);
  });

  it("gives the agent on the worker the login, without the competing variable (S3)", async () => {
    const chatId = "login-worker-chat";
    await m("chats.create", { worktreeId, id: chatId });
    const res = await fetch(`${server.url}/api/chats/${chatId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `band_token=${TEST_TOKEN}` },
      body: JSON.stringify({ worktreeId, text: "hello" }),
    });
    expect(res.ok).toBe(true);
    const request = await waitFor(
      () => {
        if (!existsSync(stubLogFile)) return undefined;
        return readFileSync(stubLogFile, "utf8")
          .split("\n")
          .filter(Boolean)
          .map(
            (l) =>
              JSON.parse(l) as { method: string; env: { NAMED: Record<string, string | null> } },
          )
          .find((r) => r.method === "session/new");
      },
      { label: "agent on the worker started", timeoutMs: 30_000 },
    );
    expect(request.env.NAMED).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: SETUP_TOKEN,
      ANTHROPIC_API_KEY: null,
      ANTHROPIC_AUTH_TOKEN: null,
    });
  });

  it("gives a terminal agent on the worker the login too (pty.spawn)", async () => {
    const terminalId = "8e3b6c9d-4f50-4b82-8d2e-3f4a5b6c7d8e";
    await m("agentSessions.launch", { worktreeId, mode: "tui", terminalId });
    const output = await waitFor(
      async () => {
        const data = await q<{ output: string }>("terminal.output", { terminalId }).catch(
          () => undefined,
        );
        return data?.output.match(/LOGIN:.*\|.*\|.*\|/)?.[0];
      },
      { label: "agent CLI on the worker printed its login", timeoutMs: 30_000 },
    );
    expect(output).toBe(`LOGIN:${SETUP_TOKEN}|unset|unset|`);
    await m("terminal.kill", { terminalId });
  });

  it("keeps the secret out of the worker's and the hub's output", () => {
    expect(workerOutput).not.toContain(SETUP_TOKEN);
    expect(server.output()).not.toContain(SETUP_TOKEN);
  });
});
