// Integration test for the per-worker command of a coding agent. Two real `band-worker` processes
// dial a real hub. Worker A has a `claude-auto` script on its PATH and an override naming it. Worker
// B has a `claude` script and no override. The agent behind a chat is the scripted ACP stub, which
// records the binary it was handed (`CLAUDE_CODE_EXECUTABLE`). A terminal session runs the script
// itself, and each script prints its own name.

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
import { delimiter, join } from "node:path";
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

interface TestWorker {
  name: string;
  hostId: string;
  binDir: string;
  stubLog: string;
  worktreeId: string;
  child: ChildProcess;
}

let server: ServerHandle;
const workers: Record<"a" | "b", TestWorker> = {} as never;

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

interface AgentState {
  agentId: string;
  override: string | null;
  effective: string | null;
  found: boolean | null;
}
const stateOf = async (w: TestWorker): Promise<AgentState | undefined> =>
  (await q<{ hosts: { id: string; agentCommandStates: AgentState[] }[] }>("hosts.list")).hosts
    .find((h) => h.id === w.hostId)
    ?.agentCommandStates.find((s) => s.agentId === "claude-code");

const script = (path: string, name: string) => {
  writeFileSync(
    path,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.0 (Claude Code)"; exit 0; fi\nprintf 'RAN:%s\\n' "${name}"\n`,
  );
  chmodSync(path, 0o755);
};

async function startWorker(key: "a" | "b", scriptName: string): Promise<void> {
  const issued = await m<{ token: string; hostId: string }>("tokens.issueWorkerBootstrap", {
    hostName: `agent-command-${key}`,
    labels: [],
  });
  const home = tmp(`band-agent-command-${key}-home-`);
  const root = tmp(`band-agent-command-${key}-root-`);
  const repo = join(root, "proj");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "hello.txt"), "hello\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");

  const binDir = tmp(`band-agent-command-${key}-bin-`);
  script(join(binDir, scriptName), scriptName);
  const stubLog = join(home, "stub-log.jsonl");
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("BAND_")),
  );
  const child = spawn(
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
      tmp(`band-agent-command-${key}-state-`),
    ],
    {
      env: {
        ...env,
        HOME: home,
        PATH: [binDir, process.env.PATH].join(delimiter),
        BAND_HOME: join(home, ".band"),
        BAND_AGENT_BIN_DIRS: binDir,
        BAND_TEST_ACP_AGENT: STUB_AGENT_PATH,
        BAND_TEST_ACP_STATE: join(home, "acp-state"),
        BAND_TEST_ACP_LOG: stubLog,
        BAND_TEST_ACP_LOG_ENV: "CLAUDE_CODE_EXECUTABLE",
      },
      stdio: ["ignore", "ignore", "ignore"],
    },
  );
  await waitFor(
    async () => {
      const { hosts } = await q<{ hosts: { id: string; status: string }[] }>("hosts.list");
      return hosts.find((h) => h.id === issued.hostId)?.status === "online" ? true : undefined;
    },
    { label: `worker ${key} online`, timeoutMs: 30_000 },
  );
  await m("worktrees.create", {
    repo: "proj",
    branch: `cmd-${key}`,
    hostId: issued.hostId,
    hostRepoPath: repo,
  });
  workers[key] = {
    name: `agent-command-${key}`,
    hostId: issued.hostId,
    binDir,
    stubLog,
    worktreeId: toWorktreeId("proj", `cmd-${key}`, issued.hostId),
    child,
  };
}

beforeAll(async () => {
  const hubHome = createTmpHome("band-agent-command-hub-");
  scratch.push(hubHome);
  const hubRepo = join(tmp("band-agent-command-hubrepo-"), "proj");
  mkdirSync(hubRepo, { recursive: true });
  git(hubRepo, "init", "-q", "-b", "main");
  writeFileSync(join(hubRepo, "hello.txt"), "hello\n");
  git(hubRepo, "add", ".");
  git(hubRepo, "commit", "-q", "-m", "init");
  // No global command: the agent runs its default binary wherever it has no override.
  seedSettings(hubHome, {
    tokenSecret: TEST_TOKEN,
    codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
    defaultCodingAgent: "claude-code",
  });
  server = await startServer({
    tmpHome: hubHome,
    remoteHost: false,
    env: { BAND_SERVE_UI: "false" },
  });
  await m("repos.add", { path: hubRepo });
  await startWorker("a", "claude-auto");
  await startWorker("b", "claude");
}, 180_000);

afterAll(async () => {
  for (const w of Object.values(workers)) w.child?.kill("SIGKILL");
  await server?.close();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
});

const sendAndReadExecutable = async (w: TestWorker, chatId: string): Promise<string | null> => {
  await m("chats.create", { worktreeId: w.worktreeId, id: chatId });
  const res = await fetch(`${server.url}/api/chats/${chatId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `band_token=${TEST_TOKEN}` },
    body: JSON.stringify({ worktreeId: w.worktreeId, text: "hello" }),
  });
  expect(res.ok).toBe(true);
  const request = await waitFor(
    () => {
      if (!existsSync(w.stubLog)) return undefined;
      return readFileSync(w.stubLog, "utf8")
        .split("\n")
        .filter(Boolean)
        .map(
          (l) => JSON.parse(l) as { method: string; env: { NAMED: Record<string, string | null> } },
        )
        .filter((r) => r.method === "session/new")
        .at(-1);
    },
    { label: `agent on ${w.name} started`, timeoutMs: 30_000 },
  );
  return request.env.NAMED.CLAUDE_CODE_EXECUTABLE ?? null;
};

const tuiOutput = async (w: TestWorker, terminalId: string): Promise<string> => {
  await m("agentSessions.launch", { worktreeId: w.worktreeId, mode: "tui", terminalId });
  const out = await waitFor(
    async () => {
      const data = await q<{ output: string }>("terminal.output", { terminalId }).catch(
        () => undefined,
      );
      return data?.output.match(/RAN:[\w-]+/)?.[0];
    },
    { label: `terminal on ${w.name} ran the agent CLI`, timeoutMs: 30_000 },
  );
  await m("terminal.kill", { terminalId });
  return out;
};

describe("per-worker agent command", () => {
  it("runs the override on A and the default binary on B, in a chat and a terminal (S1)", async () => {
    const { a, b } = workers;
    await m("hosts.setAgentCommand", {
      hostId: a.hostId,
      agentId: "claude-code",
      command: "claude-auto",
    });
    expect(await stateOf(a)).toMatchObject({
      override: "claude-auto",
      effective: "claude-auto",
      found: true,
    });
    expect(await stateOf(b)).toMatchObject({ override: null, effective: null });

    expect(await sendAndReadExecutable(a, "cmd-chat-a")).toBe(join(a.binDir, "claude-auto"));
    expect(await sendAndReadExecutable(b, "cmd-chat-b")).toBe(join(b.binDir, "claude"));
    expect(await tuiOutput(a, "6a1f0c2e-1111-4b82-8d2e-3f4a5b6c7d8e")).toBe("RAN:claude-auto");
    expect(await tuiOutput(b, "6a1f0c2e-2222-4b82-8d2e-3f4a5b6c7d8e")).toBe("RAN:claude");
  });

  it("reports a command that is not on the worker's PATH and fails the launch naming both (S2)", async () => {
    const { a } = workers;
    await m("hosts.setAgentCommand", {
      hostId: a.hostId,
      agentId: "claude-code",
      command: "no-such-bin",
    });
    expect(await stateOf(a)).toMatchObject({ override: "no-such-bin", found: false });

    const chatId = "cmd-chat-missing";
    await m("chats.create", { worktreeId: a.worktreeId, id: chatId });
    // The launch error is a transient event that is not replayed, so the
    // stream must be open before the message is sent.
    const stream = await openStream(server.url, chatId, {
      lastEventId: 0,
      until: (e) => JSON.stringify(e).includes("no-such-bin"),
      timeoutMs: 15_000,
    });
    // Awaited below; this keeps a failed send from leaving it as an unhandled rejection.
    stream.events.catch(() => undefined);
    const res = await fetch(`${server.url}/api/chats/${chatId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `band_token=${TEST_TOKEN}` },
      body: JSON.stringify({ worktreeId: a.worktreeId, text: "hello" }),
    });
    expect(res.ok).toBe(true);
    const events = await stream.events;
    const text = JSON.stringify(events.at(-1));
    expect(text).toContain("no-such-bin");
    expect(text).toContain(a.name);
  });

  it("refuses a command with arguments, an unknown agent and a non-admin token (S3)", async () => {
    const { a } = workers;
    await expect(
      m("hosts.setAgentCommand", {
        hostId: a.hostId,
        agentId: "claude-code",
        command: "claude --yolo",
      }),
    ).rejects.toThrow(/HTTP 400/);
    await expect(
      m("hosts.setAgentCommand", { hostId: a.hostId, agentId: "nope", command: "claude" }),
    ).rejects.toThrow(/HTTP 404/);

    const { token: plain } = await m<{ token: string }>("tokens.createDevice", { label: "plain" });
    const res = await trpcMutate(
      server.url,
      "hosts.setAgentCommand",
      { hostId: a.hostId, agentId: "claude-code", command: "claude" },
      plain,
    );
    expect(res.status).toBe(403);
    const anonymous = await trpcMutate(
      server.url,
      "hosts.setAgentCommand",
      { hostId: a.hostId, agentId: "claude-code", command: "claude" },
      "not-a-token",
    );
    expect(anonymous.status).toBe(401);
    expect(await stateOf(a)).toMatchObject({ override: "no-such-bin" });
  });

  it("goes back to the global command when the override is cleared (S4)", async () => {
    const { a } = workers;
    await m("hosts.setAgentCommand", { hostId: a.hostId, agentId: "claude-code", command: null });
    expect(await stateOf(a)).toMatchObject({ override: null, effective: null, found: null });
    // A global command is what the worker runs again.
    await m("settings.update", {
      codingAgents: [
        { id: "claude-code", type: "claude-code", label: "Claude Code", command: "claude-auto" },
      ],
    });
    expect(await stateOf(a)).toMatchObject({ override: null, effective: "claude-auto" });
    expect(await sendAndReadExecutable(a, "cmd-chat-global")).toBe(join(a.binDir, "claude-auto"));
  });
});
