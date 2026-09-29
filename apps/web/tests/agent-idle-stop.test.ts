/**
 * The idle stop of a chat's agent process.
 *
 * Band stops an agent process that has been idle for a while (15 minutes;
 * `BAND_AGENT_IDLE_TIMEOUT_MS` shortens it here). Work the agent runs on
 * its own lives in that process: a background command, a Monitor, a
 * `ScheduleWakeup` (Claude Code's `/loop`), a cron job. Stopping it early
 * kills that work, so the loop's wakeup never fires. These tests boot the
 * real server against the stub ACP agent, which reports that work the way
 * the Claude adapter does and then streams an agent-started turn after a
 * delay longer than the idle timeout. They assert through the chat event
 * stream and the process table: the out-of-turn update arrives, and the
 * process is stopped once the work is done and the timeout has passed.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { ChatEvent } from "../src/shared/chat-events";
import {
  agentText,
  collectEvents,
  maxId,
  runTurn,
  type StubTurn,
  startAcpServer,
  stubRequests,
} from "./helpers/acp-chat";
import type { ServerHandle } from "./helpers/server";

const IDLE_TIMEOUT_MS = 2_000;
/** Longer than the idle timeout, so an early stop loses the update. */
const WORK_MS = 5_000;

let servers: ServerHandle[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()));
  servers = [];
});

async function boot(turns: StubTurn[]): Promise<ServerHandle> {
  const server = await startAcpServer({
    turns,
    env: { BAND_AGENT_IDLE_TIMEOUT_MS: String(IDLE_TIMEOUT_MS) },
  });
  servers.push(server);
  return server;
}

let seq = 0;
const newChatId = () => `idle-stop-${Date.now()}-${seq++}`;

/** The pid of the stub process that ran the chat's turn. (The boot-time
 *  model probe starts stub processes too, but never prompts them.) */
function chatAgentPid(home: string): number {
  const [prompt] = stubRequests(home, "session/prompt");
  if (!prompt) throw new Error("the agent was never prompted");
  return prompt.pid;
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Waits for the agent text after the turn, streamed with no turn running. */
async function outOfTurnText(
  server: ServerHandle,
  chatId: string,
  turn: ChatEvent[],
  text: string,
): Promise<ChatEvent[]> {
  return collectEvents(server.url, chatId, {
    lastEventId: maxId(turn),
    until: (_e, all) => agentText(all).includes(text),
    timeoutMs: WORK_MS + 10_000,
  });
}

describe("agent idle stop", () => {
  it("stops an agent with no pending work after the idle timeout", async () => {
    const server = await boot([{ steps: [{ say: "Done." }] }]);
    const chatId = newChatId();

    const turn = await runTurn(server.url, chatId, "quick question");
    expect(agentText(turn)).toBe("Done.");
    const pid = chatAgentPid(server.home);

    await expect.poll(() => isRunning(pid), { timeout: 15_000 }).toBe(false);
  });

  it("keeps the agent alive until its background task ends, then stops it", async () => {
    const server = await boot([
      {
        steps: [
          {
            tool: {
              toolCallId: "bg-build",
              title: "npm run build",
              kind: "execute",
              status: "pending",
              rawInput: { command: "npm run build", run_in_background: true },
              _meta: { claudeCode: { toolName: "Bash" } },
            },
          },
          { toolUpdate: { toolCallId: "bg-build", status: "completed" } },
          {
            asyncTask: {
              asyncTaskId: "task-build",
              name: "npm run build",
              taskType: "shell",
              description: "npm run build",
              showInTranscript: false,
              canStop: true,
              toolCallId: "bg-build",
            },
          },
          { say: "Started the build in the background." },
          {
            afterMs: WORK_MS,
            later: [
              {
                asyncTask: {
                  sessionUpdate: "async_task_state_update",
                  asyncTaskId: "task-build",
                  state: "completed",
                  toolCallId: "bg-build",
                },
              },
              { say: "The build finished." },
            ],
          },
        ],
      },
    ]);
    const chatId = newChatId();

    const turn = await runTurn(server.url, chatId, "build it in the background");
    expect(agentText(turn)).toBe("Started the build in the background.");
    // The adapter reports background tasks only to a client that lists
    // the AIR `asyncTasks` capability.
    const [init] = stubRequests(server.home, "initialize");
    expect(init.params.clientCapabilities).toMatchObject({
      _meta: { jetbrains: { air: { version: 1, capabilities: ["asyncTasks"] } } },
    });
    const pid = chatAgentPid(server.home);

    const later = await outOfTurnText(server, chatId, turn, "The build finished.");
    expect(agentText(later)).toBe("The build finished.");
    // The task updates themselves aren't ACP and never reach the chat.
    expect(
      later.some((e) => e.type === "update" && e.update.sessionUpdate.startsWith("async")),
    ).toBe(false);

    await expect.poll(() => isRunning(pid), { timeout: 15_000 }).toBe(false);
  });

  it("keeps the agent alive until a scheduled wakeup fires, then stops it", async () => {
    const server = await boot([
      {
        steps: [
          {
            tool: {
              toolCallId: "wakeup-1",
              title: "ScheduleWakeup",
              kind: "other",
              status: "pending",
              rawInput: { delaySeconds: WORK_MS / 1000, prompt: "/loop check CI", reason: "CI" },
              _meta: { claudeCode: { toolName: "ScheduleWakeup" } },
            },
          },
          { toolUpdate: { toolCallId: "wakeup-1", status: "completed" } },
          { say: "Checking again in a bit." },
          { afterMs: WORK_MS, later: [{ say: "Woke up: CI is green." }] },
        ],
      },
    ]);
    const chatId = newChatId();

    const turn = await runTurn(server.url, chatId, "/loop check CI");
    const pid = chatAgentPid(server.home);

    const later = await outOfTurnText(server, chatId, turn, "Woke up: CI is green.");
    expect(agentText(later)).toBe("Woke up: CI is green.");

    await expect.poll(() => isRunning(pid), { timeout: 15_000 }).toBe(false);
  });

  it("does not hold for a wakeup whose tool call failed", async () => {
    const server = await boot([
      {
        steps: [
          {
            tool: {
              toolCallId: "wakeup-failed",
              title: "ScheduleWakeup",
              kind: "other",
              status: "pending",
              rawInput: { delaySeconds: 60, prompt: "/loop check CI", reason: "CI" },
              _meta: { claudeCode: { toolName: "ScheduleWakeup" } },
            },
          },
          { toolUpdate: { toolCallId: "wakeup-failed", status: "failed" } },
          { say: "Could not schedule." },
        ],
      },
    ]);
    const chatId = newChatId();

    const turn = await runTurn(server.url, chatId, "/loop check CI");
    expect(agentText(turn)).toBe("Could not schedule.");
    const pid = chatAgentPid(server.home);

    // Stopped after the idle timeout, well before the 60 s wakeup.
    await expect.poll(() => isRunning(pid), { timeout: 15_000 }).toBe(false);
  });

  it("restarts the idle countdown on every update of an agent-started turn", async () => {
    const gap = IDLE_TIMEOUT_MS * 0.6;
    // Four updates, each `gap` after the last: the stream runs past the idle
    // timeout, but no gap reaches it.
    let chain: object[] = [];
    for (const word of ["four", "three", "two", "one"]) {
      chain = [{ afterMs: gap, later: [{ say: `${word} ` }, ...chain] }];
    }
    const server = await boot([{ steps: [{ say: "Starting." }, ...chain] }]);
    const chatId = newChatId();

    const turn = await runTurn(server.url, chatId, "work on your own");
    const pid = chatAgentPid(server.home);

    const later = await outOfTurnText(server, chatId, turn, "four ");
    expect(agentText(later)).toBe("one two three four ");

    await expect.poll(() => isRunning(pid), { timeout: 15_000 }).toBe(false);
  });
});
