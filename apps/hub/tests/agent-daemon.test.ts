// Integration tests for chat agents that survive a worker restart (docs/architecture/agent-daemon.md).
// A real hub, real `band-worker` processes and the scripted ACP stub agent. A worker is killed and
// started again mid-turn, and the chat must carry on as if nothing happened: the same agent
// process, no lost, repeated or reordered output.

import {
  appendFileSync,
  copyFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ChatEvent } from "@band-app/shared/chat-events";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentText,
  maxId,
  openStream,
  STUB_AGENT_PATH,
  TEST_TOKEN,
  turnEnded,
} from "./helpers/acp-chat";
import { startWorld, type Worker, type World } from "./helpers/checkpoint-world";
import { waitFor } from "./helpers/wait-for";

let w: World;

/** Four steps of the scripted agent, each in a turn picked by the message's first word. */
const SCENARIO = {
  turns: [
    // Streams one part, goes quiet for long enough to restart a worker, then streams the rest.
    { match: "^slow", steps: [{ say: "A1 " }, { sleep: 7000 }, { say: "A2" }] },
    {
      match: "^ask",
      steps: [
        {
          permission: {
            toolCall: { toolCallId: "run-1", title: "Run tests", kind: "execute" },
            options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
          },
          after: { allow: [{ say: "Allowed and ran." }] },
        },
      ],
    },
    // A large burst after a quiet period: written while no worker is attached.
    {
      match: "^burst",
      steps: [{ sleep: 6000 }, { say: "x".repeat(1_200_000), chunks: 24 }, { say: "END" }],
    },
    { match: "^hang", steps: [{ waitForCancel: true }] },
  ],
};

function scenarioFile(): string {
  const file = join(w.tmp("band-agent-daemon-scenario-"), "scenario.json");
  writeFileSync(file, JSON.stringify(SCENARIO));
  return file;
}

interface LogLine {
  method: string;
  pid: number;
  params: { sessionId?: string };
}

/** The requests that reattach a chat's session in a new process (the hub prefers resume when the agent can). */
const reattaches = (worker: Worker) =>
  stubLog(worker).filter((l) => l.method === "session/load" || l.method === "session/resume");

const stubLog = (worker: Worker): LogLine[] =>
  existsSync(worker.stubLog)
    ? readFileSync(worker.stubLog, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as LogLine)
    : [];

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Pids of the agent processes the stub logged, in the order they first appeared. */
const agentPids = (worker: Worker) => [...new Set(stubLog(worker).map((l) => l.pid))];

async function send(worktreeId: string, chatId: string, text: string): Promise<void> {
  const res = await fetch(`${w.server.url}/api/chats/${chatId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `band_token=${TEST_TOKEN}` },
    body: JSON.stringify({ worktreeId, text }),
  });
  if (!res.ok) throw new Error(`send failed: ${res.status} ${await res.text()}`);
}

/** Opens the chat's stream before `text` is sent, and resolves with the events once that turn ends. */
async function startTurn(worktreeId: string, chatId: string, text: string, after = 0) {
  let sawPrompt = false;
  const seen: ChatEvent[] = [];
  const stream = await openStream(w.server.url, chatId, {
    lastEventId: after,
    until: (e: ChatEvent) => {
      if (e.type === "prompt" && e.text === text) sawPrompt = true;
      return sawPrompt && turnEnded(e);
    },
    onEvent: (e) => seen.push(e),
    timeoutMs: 90_000,
  });
  await send(worktreeId, chatId, text);
  return { events: stream.events, seen };
}

/** A worker killed with SIGKILL and started again on its state dir: an update restarts it the same way. */
async function restart(worker: Worker): Promise<Worker> {
  await w.killWorker(worker, "SIGKILL", { waitForLease: false });
  return w.restartWorker(worker);
}

beforeAll(async () => {
  w = await startWorld({ repos: [{ name: "proj" }] });
}, 120_000);

afterAll(async () => {
  await w?.close();
});

describe("a turn survives a worker restart (S1)", () => {
  it("completes with the same agent process and every update exactly once", async () => {
    let worker = await w.addWorker("w-slow", ["proj"], {
      env: { BAND_TEST_ACP_SCENARIO: scenarioFile() },
    });
    const wt = await w.createWorktree(worker, "proj", "feat-slow");
    const chatId = "slow-chat";
    const turn = await startTurn(wt, chatId, "slow please");
    await waitFor(() => (agentText(turn.seen).includes("A1") ? true : undefined), {
      label: "the first part of the reply",
      timeoutMs: 30_000,
    });
    const [pid] = agentPids(worker);
    expect(pid).toBeDefined();

    worker = await restart(worker);

    const events = await turn.events;
    expect(agentText(events)).toBe("A1 A2");
    // The agent was never restarted: one process, one `initialize`, one `session/new`.
    expect(agentPids(worker)).toEqual([pid]);
    expect(stubLog(worker).filter((l) => l.method === "initialize")).toHaveLength(1);
    expect(alive(pid as number)).toBe(true);

    // And it keeps working afterwards, in the same process and session.
    const next = await startTurn(wt, chatId, "after the restart", maxId(events));
    expect(agentText(await next.events)).toContain("after the restart");
    expect(agentPids(worker)).toEqual([pid]);
    expect(reattaches(worker)).toHaveLength(0);
  }, 150_000);
});

describe("a pending request survives a worker restart (S2)", () => {
  it("delivers the answer once the worker is back", async () => {
    let worker = await w.addWorker("w-ask", ["proj"], {
      env: { BAND_TEST_ACP_SCENARIO: scenarioFile() },
    });
    const wt = await w.createWorktree(worker, "proj", "feat-ask");
    const chatId = "ask-chat";
    let requestId = "";
    const turn = await startTurn(wt, chatId, "ask first");
    // `seen` fills as events arrive; wait for the permission request.
    await waitFor(
      () => {
        const p = turn.seen.find((e) => e.type === "permission");
        if (p && "requestId" in p) requestId = String(p.requestId);
        return requestId || undefined;
      },
      { label: "the permission request", timeoutMs: 30_000 },
    );
    const [pid] = agentPids(worker);

    worker = await restart(worker);
    await w.m("chat.answer", { chatId, requestId, optionId: "allow" });

    const events = await turn.events;
    expect(events.find((e) => e.type === "request-resolved")).toMatchObject({ answer: "allow" });
    expect(agentText(events)).toContain("Allowed and ran.");
    expect(agentPids(worker)).toEqual([pid]);
  }, 150_000);
});

describe("output written while no worker is attached (S3)", () => {
  it("is held, the agent blocks, and nothing is lost", async () => {
    let worker = await w.addWorker("w-burst", ["proj"], {
      env: {
        BAND_TEST_ACP_SCENARIO: scenarioFile(),
        // A cap far below the burst, so the daemon has to stop reading the agent.
        BAND_AGENT_BUFFER_BYTES: "200000",
      },
    });
    const wt = await w.createWorktree(worker, "proj", "feat-burst");
    const chatId = "burst-chat";
    const turn = await startTurn(wt, chatId, "burst now");
    await waitFor(() => (turn.seen.some((e) => e.type === "turn-started") ? true : undefined), {
      label: "the turn to start",
      timeoutMs: 30_000,
    });
    // Down before the agent's quiet period ends and it starts writing.
    await w.killWorker(worker, "SIGKILL", { waitForLease: false });
    // The burst happens now, with nobody to read it.
    await new Promise((r) => setTimeout(r, 8000));
    worker = await w.restartWorker(worker);

    const events = await turn.events;
    const text = agentText(events);
    expect(text.length).toBe(1_200_000 + "END".length);
    expect(text.endsWith("xEND")).toBe(true);
    expect(/^x+END$/.test(text)).toBe(true);
    expect(alive(agentPids(worker)[0] as number)).toBe(true);
  }, 180_000);
});

describe("a held agent whose launch changed (S4)", () => {
  it("finishes its turn, then restarts at the next clean point and loads the session", async () => {
    // A script that runs the stub and that the test can edit, so "the adapter" differs after the restart.
    const stub = join(w.tmp("band-agent-daemon-stub-"), "stub.mjs");
    writeFileSync(stub, `import ${JSON.stringify(STUB_AGENT_PATH)};\n`);
    let worker = await w.addWorker("w-change", ["proj"], {
      env: { BAND_TEST_ACP_SCENARIO: scenarioFile(), BAND_TEST_ACP_AGENT: stub },
    });
    const wt = await w.createWorktree(worker, "proj", "feat-change");
    const chatId = "change-chat";
    const turn = await startTurn(wt, chatId, "slow change");
    await waitFor(() => (agentText(turn.seen).includes("A1") ? true : undefined), {
      label: "the first part of the reply",
      timeoutMs: 30_000,
    });
    const [oldPid] = agentPids(worker);

    await w.killWorker(worker, "SIGKILL", { waitForLease: false });
    // An update changed the adapter's files.
    appendFileSync(stub, "\n// a newer build\n");
    worker = await w.restartWorker(worker);

    // The turn that was running is not cut off.
    const events = await turn.events;
    expect(agentText(events)).toBe("A1 A2");
    expect(agentPids(worker)).toEqual([oldPid]);

    // The next turn runs on a new process that loads the session.
    const next = await startTurn(wt, chatId, "after the update", maxId(events));
    expect(agentText(await next.events)).toContain("after the update");
    const pids = agentPids(worker);
    expect(pids).toHaveLength(2);
    expect(pids[1]).not.toBe(oldPid);
    expect(reattaches(worker)).toHaveLength(1);
  }, 180_000);
});

describe("the agent daemon dies (S6)", () => {
  it("reports the agent as exited, and the next prompt loads the session in a new process", async () => {
    const worker = await w.addWorker("w-dead", ["proj"], {
      env: { BAND_TEST_ACP_SCENARIO: scenarioFile() },
    });
    const wt = await w.createWorktree(worker, "proj", "feat-dead");
    const chatId = "dead-chat";
    const first = await startTurn(wt, chatId, "hello daemon");
    const events = await first.events;
    const [pid] = agentPids(worker);

    // The daemon is a detached process; its pid record is in the worker's state dir.
    const runDir = join(worker.state, "run", "agents");
    const pidFile = readdirSync(runDir).find((n) => /^agent-daemon-v\d+\.pid$/.test(n));
    expect(pidFile).toBeDefined();
    const daemonPid = (
      JSON.parse(readFileSync(join(runDir, pidFile as string), "utf8")) as { pid: number }
    ).pid;
    process.kill(daemonPid, "SIGKILL");
    await waitFor(() => (alive(pid as number) ? undefined : true), {
      label: "the agent to die with its daemon",
      timeoutMs: 15_000,
    }).catch(() => undefined);

    const next = await startTurn(wt, chatId, "after the daemon died", maxId(events));
    expect(agentText(await next.events)).toContain("after the daemon died");
    expect(agentPids(worker).length).toBeGreaterThanOrEqual(2);
    expect(reattaches(worker)).toHaveLength(1);
  }, 150_000);
});

describe("an agent is stopped at once when correctness needs it (S5)", () => {
  it("kills a held agent when its chat is removed", async () => {
    const worker = await w.addWorker("w-stop", ["proj"], {
      env: { BAND_TEST_ACP_SCENARIO: scenarioFile() },
    });
    const wt = await w.createWorktree(worker, "proj", "feat-stop");
    const chatId = "stop-chat";
    await (await startTurn(wt, chatId, "first words")).events;
    const [pid] = agentPids(worker);
    expect(alive(pid as number)).toBe(true);

    await w.m("chats.remove", { worktreeId: wt, chatId });
    await waitFor(() => (alive(pid as number) ? undefined : true), {
      label: "the agent to stop",
      timeoutMs: 5_000,
    });
  }, 90_000);

  it("kills a held agent when the login it holds is removed", async () => {
    const worker = await w.addWorker("w-login", ["proj"], {
      env: { BAND_TEST_ACP_SCENARIO: scenarioFile() },
    });
    const wt = await w.createWorktree(worker, "proj", "feat-login");
    const { login } = await w.m<{ login: { id: string } }>("agentLogins.create", {
      agentType: "claude-code",
      kind: "setup-token",
      label: "Held token",
      secret: "sk-ant-oat01-HELD-TOKEN-aaaaaaaaaaaaaaaa",
    });
    await w.m("agentLogins.setDefault", { agentType: "claude-code", loginId: login.id });
    await (await startTurn(wt, "login-chat", "first words")).events;
    const [pid] = agentPids(worker);
    expect(alive(pid as number)).toBe(true);

    await w.m("agentLogins.remove", { id: login.id });
    await waitFor(() => (alive(pid as number) ? undefined : true), {
      label: "the agent to stop",
      timeoutMs: 5_000,
    });
  }, 90_000);

  it("kills a held agent when the worker is revoked", async () => {
    const worker = await w.addWorker("w-revoke", ["proj"], {
      env: { BAND_TEST_ACP_SCENARIO: scenarioFile() },
    });
    const wt = await w.createWorktree(worker, "proj", "feat-revoke");
    await (await startTurn(wt, "revoke-chat", "first words")).events;
    const [pid] = agentPids(worker);
    expect(alive(pid as number)).toBe(true);

    const { tokens } = await w.q<{
      tokens: Array<{ id: string; kind: string; hostId?: string; state: string }>;
    }>("tokens.list");
    const session = tokens.find(
      (t) => t.kind === "worker_session" && t.hostId === worker.hostId && t.state === "active",
    );
    expect(session).toBeDefined();
    await w.m("tokens.revoke", { tokenId: session?.id });
    expect(await worker.exited).toBe(1);
    await waitFor(() => (alive(pid as number) ? undefined : true), {
      label: "the agent to stop",
      timeoutMs: 5_000,
    });
  }, 90_000);
});

describe("what the update dialog lists (S8)", () => {
  it("leaves out agents that survive the restart", async () => {
    const worker = await w.addWorker("w-dialog", ["proj"], {
      env: { BAND_TEST_ACP_SCENARIO: scenarioFile() },
    });
    const wt = await w.createWorktree(worker, "proj", "feat-dialog");
    await (await startTurn(wt, "dialog-chat", "first words")).events;
    expect(existsSync(worker.stubLog)).toBe(true);

    const { agents } = await w.q<{ agents: unknown[] }>("workers.interruptions", {
      hostId: worker.hostId,
    });
    expect(agents).toEqual([]);
  }, 90_000);
});
