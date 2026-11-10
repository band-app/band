// Agent sessions made from hook events (the agent-sessions-from-hooks work).
//
// Every agent that reports through hooks in a Band terminal is an agent
// session with its terminal and its own provider session id, whether Band
// launched it or the user typed it. The hook is the real `band notify`, run
// with the environment a Band terminal gives its agent. Payloads have the
// shape Claude Code pipes to hooks (`session_id`, `transcript_path`, `cwd`,
// `hook_event_name`, ...). The payloads are written by hand, not recorded
// from a live Claude Code run.

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { findCliBinary } from "@band-app/host-local/process/cli-binary";
import type { AgentSessionRecord } from "@band-app/shared/agent-sessions";
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
import { stopTerminalDaemon } from "./helpers/terminal-daemon";
import { TerminalSocket } from "./helpers/terminal-socket";
import { waitFor } from "./helpers/wait-for";

const TOKEN = "agent-sessions-from-hooks-token";
const WT_A = "hookrepo-main";
const WT_B = "hookrepo2-main";

const cli = findCliBinary();

let home: string;
let server: ServerHandle;
let dirA: string;
let dirB: string;
let toolHome: string;

const mutate = async <T>(procedure: string, input: unknown) => {
  const res = await trpcMutate(server.url, procedure, input, TOKEN);
  if (res.status !== 200) throw new Error(`${procedure}: ${res.status} ${await res.text()}`);
  return trpcData<T>(res);
};

const listSessions = async (worktreeId?: string): Promise<AgentSessionRecord[]> => {
  const res = await trpcQuery(
    server.url,
    "agentSessions.list",
    worktreeId ? { worktreeId } : {},
    TOKEN,
  );
  expect(res.status).toBe(200);
  return (await trpcData<{ agentSessions: AgentSessionRecord[] }>(res)).agentSessions;
};

function cliEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: toolHome,
    BAND_SERVER_URL: server.url,
    BAND_TOKEN: TOKEN,
    ...extra,
  };
}

/** A Claude Code hook payload, as Claude Code pipes it to `band notify`. */
function claudePayload(cwd: string, sessionId: string, event: Record<string, unknown>) {
  return {
    session_id: sessionId,
    transcript_path: join(toolHome, ".claude", "projects", "-hookrepo", `${sessionId}.jsonl`),
    cwd,
    ...event,
  };
}

/** Runs the real `band notify --agent claude-code` the way Claude Code's hook does. */
function hook(
  terminalId: string,
  cwd: string,
  sessionId: string,
  event: Record<string, unknown>,
  env: Record<string, string> = {},
  agent = "claude-code",
): void {
  const result = spawnSync(cli as string, ["notify", "--agent", agent], {
    input: JSON.stringify(claudePayload(cwd, sessionId, event)),
    env: cliEnv({ BAND_DISPATCH: "terminal", BAND_TERMINAL_ID: terminalId, ...env }),
    timeout: 10_000,
  });
  expect(result.status).toBe(0);
}

async function createTerminal(worktreeId: string, extra: Record<string, unknown> = {}) {
  const id = randomUUID();
  await mutate("terminal.create", { worktreeId, id, ...extra });
  return id;
}

function readSessionRows(): Array<Record<string, unknown>> {
  const db = new DatabaseSync(join(home, ".band", "band.db"));
  try {
    return db.prepare("SELECT * FROM agent_sessions").all() as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

describe.skipIf(!cli)("agent sessions from hook events", () => {
  beforeAll(async () => {
    home = createTmpHome("band-hook-sessions-");
    toolHome = join(home, "tool-home");
    mkdirSync(toolHome, { recursive: true });
    dirA = join(home, "hookrepo");
    dirB = join(home, "hookrepo-other");
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });
    // The launched agent is a stub that prints the token its PTY env holds.
    const stub = join(home, "stub-claude.sh");
    writeFileSync(stub, `#!/bin/sh\necho "LAUNCH_TOKEN:$BAND_AGENT_LAUNCH_TOKEN"\nsleep 60\n`);
    chmodSync(stub, 0o755);
    seedState(home, {
      repos: [
        {
          name: "hookrepo",
          path: dirA,
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: dirA }],
        },
        {
          name: "hookrepo2",
          path: dirB,
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: dirB }],
        },
      ],
    });
    seedSettings(home, {
      tokenSecret: TOKEN,
      codingAgents: [
        { id: "claude-code", type: "claude-code", label: "Claude Code", command: stub },
      ],
      defaultCodingAgent: "claude-code",
    });
    server = await startServer({ remoteHost: false, tmpHome: home });
  });

  afterAll(async () => {
    await server?.close();
    await stopTerminalDaemon(home);
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("S1: a hand-typed agent's hooks create one tui session for the terminal", async () => {
    const terminalId = await createTerminal(WT_A);
    const sessionId = randomUUID();
    for (const event of [
      { hook_event_name: "UserPromptSubmit", prompt: "fix it" },
      { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: {} },
      { hook_event_name: "Stop" },
    ]) {
      hook(terminalId, dirA, sessionId, event);
    }
    // The last event (Stop) sets the status to done, so every event has landed by then.
    const sessions = await waitFor(
      async () => {
        const open = (await listSessions(WT_A)).filter((s) => s.terminalId === terminalId);
        return open.length > 0 && open[0]?.status === "done" ? open : undefined;
      },
      { label: "tui session created by a hook and finished by Stop" },
    );
    const after = (await listSessions(WT_A)).filter((s) => s.terminalId === terminalId);
    expect(sessions).toHaveLength(1);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({
      mode: "tui",
      agentDefinitionId: "claude-code",
      providerSessionId: sessionId,
      worktreeId: WT_A,
      terminalId,
      state: "running",
    });
    // `band agents list` shows it too.
    const listed = spawnSync(cli as string, ["agents", "list", WT_A, "--output", "json"], {
      env: cliEnv(),
      encoding: "utf8",
    });
    expect(
      (JSON.parse(listed.stdout).agentSessions as AgentSessionRecord[]).map(
        (s) => s.providerSessionId,
      ),
    ).toContain(sessionId);
  });

  it("a SessionStart hook opens an idle session before any prompt, and a resume keeps it", async () => {
    const terminalId = await createTerminal(WT_A);
    const sessionId = randomUUID();
    hook(terminalId, dirA, sessionId, { hook_event_name: "SessionStart", source: "startup" });
    const session = await waitFor(
      async () => (await listSessions(WT_A)).find((s) => s.terminalId === terminalId),
      { label: "session created by SessionStart" },
    );
    expect(session).toMatchObject({
      mode: "tui",
      agentDefinitionId: "claude-code",
      providerSessionId: sessionId,
      status: "idle",
    });
    hook(terminalId, dirA, sessionId, { hook_event_name: "SessionStart", source: "resume" });
    hook(terminalId, dirA, sessionId, { hook_event_name: "UserPromptSubmit" });
    await waitFor(
      async () => {
        const open = (await listSessions(WT_A)).filter((s) => s.terminalId === terminalId);
        return open[0]?.status === "working" ? open : undefined;
      },
      { label: "prompt after resume marks the same session working" },
    );
    expect((await listSessions(WT_A)).filter((s) => s.terminalId === terminalId)).toHaveLength(1);
  });

  it("S2: SessionEnd, a killed terminal or a new session id end or replace the session", async () => {
    const terminalId = await createTerminal(WT_A);
    const first = randomUUID();
    hook(terminalId, dirA, first, { hook_event_name: "UserPromptSubmit" });
    await waitFor(
      async () => (await listSessions(WT_A)).find((s) => s.providerSessionId === first),
      {
        label: "first session",
      },
    );

    hook(terminalId, dirA, first, { hook_event_name: "SessionEnd", reason: "exit" });
    await waitFor(
      async () =>
        (await listSessions(WT_A)).some((s) => s.providerSessionId === first) ? undefined : true,
      { label: "session ended by SessionEnd" },
    );

    // A different session id from the same terminal replaces the open one.
    const second = randomUUID();
    const third = randomUUID();
    hook(terminalId, dirA, second, { hook_event_name: "UserPromptSubmit" });
    await waitFor(
      async () => (await listSessions(WT_A)).find((s) => s.providerSessionId === second),
      {
        label: "second session",
      },
    );
    hook(terminalId, dirA, third, { hook_event_name: "UserPromptSubmit" });
    await waitFor(
      async () => (await listSessions(WT_A)).find((s) => s.providerSessionId === third),
      {
        label: "third session",
      },
    );
    const open = (await listSessions(WT_A)).filter((s) => s.terminalId === terminalId);
    expect(open.map((s) => s.providerSessionId)).toEqual([third]);
    const rows = readSessionRows().filter((r) => r.terminal_id === terminalId);
    expect(rows.find((r) => r.provider_session_id === second)).toMatchObject({
      state: "ended",
      end_reason: "replaced",
    });
    expect(rows.find((r) => r.provider_session_id === first)).toMatchObject({
      state: "ended",
      end_reason: "session-end",
    });

    // Killing the terminal ends the open session.
    await mutate("terminal.kill", { terminalId });
    await waitFor(
      async () =>
        (await listSessions(WT_A)).some((s) => s.terminalId === terminalId) ? undefined : true,
      { label: "session ended by a killed terminal" },
    );
  });

  it("S3: a launched agent's hooks attach to its row, by launch token", async () => {
    const launched = await mutate<{ agentSession: AgentSessionRecord; terminalId: string }>(
      "agentSessions.launch",
      { worktreeId: WT_A, mode: "tui" },
    );
    const { terminalId } = launched;
    expect(launched.agentSession.providerSessionId).toBeNull();

    const socket = await TerminalSocket.open(server, {
      worktreeId: WT_A,
      terminalId,
      token: TOKEN,
    });
    let token = "";
    try {
      await socket.waitForOutput("LAUNCH_TOKEN:");
      token = /LAUNCH_TOKEN:([0-9a-f]{48})/.exec(socket.output)?.[1] ?? "";
    } finally {
      await socket.close();
    }
    expect(token).toHaveLength(48);

    // An event without the token never claims the launched row's identity,
    // and opens no second row.
    const stray = randomUUID();
    hook(terminalId, dirA, stray, { hook_event_name: "UserPromptSubmit" });
    // The stray prompt still sets the status, which shows the hub processed it.
    await waitFor(
      async () =>
        (await listSessions(WT_A)).some(
          (s) => s.terminalId === terminalId && s.status === "working",
        )
          ? true
          : undefined,
      { label: "stray event applied" },
    );
    let mine = (await listSessions(WT_A)).filter((s) => s.terminalId === terminalId);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.providerSessionId).toBeNull();

    const real = randomUUID();
    hook(
      terminalId,
      dirA,
      real,
      { hook_event_name: "UserPromptSubmit" },
      { BAND_AGENT_LAUNCH_TOKEN: token },
    );
    mine = await waitFor(
      async () => {
        const rows = (await listSessions(WT_A)).filter((s) => s.terminalId === terminalId);
        return rows[0]?.providerSessionId ? rows : undefined;
      },
      { label: "launched row filled in by its hook" },
    );
    expect(mine).toHaveLength(1);
    expect(mine[0]?.id).toBe(launched.agentSession.id);
    expect(mine[0]?.providerSessionId).toBe(real);

    // Only the hash is stored.
    const row = readSessionRows().find((r) => r.id === launched.agentSession.id);
    expect(row?.launch_token_hash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(JSON.stringify(row)).not.toContain(token);
    expect(JSON.stringify(mine)).not.toContain("launch_token");
    await mutate("terminal.kill", { terminalId });
  });

  it("hooks of Codex, Gemini CLI and OpenCode create sessions too", async () => {
    for (const agent of ["codex", "gemini-cli", "opencode"]) {
      const terminalId = await createTerminal(WT_A);
      const sessionId = randomUUID();
      const event = agent === "opencode" ? "SessionBusy" : "UserPromptSubmit";
      hook(terminalId, dirA, sessionId, { hook_event_name: event }, {}, agent);
      const session = await waitFor(
        async () => (await listSessions(WT_A)).find((s) => s.providerSessionId === sessionId),
        { label: `${agent} session created` },
      );
      expect(session).toMatchObject({ mode: "tui", agentDefinitionId: agent, terminalId });
      expect(session.status).toBe("working");
      await mutate("terminal.kill", { terminalId });
    }
  });

  it("S4: --all lists every worktree's open sessions", async () => {
    const termA = await createTerminal(WT_A);
    const termB = await createTerminal(WT_B);
    const idA = randomUUID();
    const idB = randomUUID();
    hook(termA, dirA, idA, { hook_event_name: "UserPromptSubmit" });
    hook(termB, dirB, idB, { hook_event_name: "UserPromptSubmit" });
    const all = await waitFor(
      async () => {
        const rows = await listSessions();
        return rows.some((s) => s.providerSessionId === idA) &&
          rows.some((s) => s.providerSessionId === idB)
          ? rows
          : undefined;
      },
      { label: "sessions of both worktrees listed" },
    );
    expect(all.find((s) => s.providerSessionId === idA)?.worktreeId).toBe(WT_A);
    expect(all.find((s) => s.providerSessionId === idB)?.worktreeId).toBe(WT_B);

    const viaCli = spawnSync(cli as string, ["agents", "list", "--all", "--output", "json"], {
      env: cliEnv(),
      encoding: "utf8",
    });
    const cliRows = JSON.parse(viaCli.stdout).agentSessions as AgentSessionRecord[];
    expect(cliRows.find((s) => s.providerSessionId === idB)?.worktreeId).toBe(WT_B);

    // With a worktree it lists only that worktree's sessions.
    const onlyB = await listSessions(WT_B);
    expect(onlyB.every((s) => s.worktreeId === WT_B)).toBe(true);
    expect(onlyB.some((s) => s.providerSessionId === idA)).toBe(false);
  });
});
