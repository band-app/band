/**
 * Slash commands and modes a chat offers (issue #648).
 *
 * Over ACP an agent announces its slash commands with an
 * `available_commands_update` and its modes as a session config option.
 * Band learns both from the boot-time probe (a scratch session per agent)
 * and from every chat session, and hands them to the chat pane in the
 * `session-state` event of `GET /api/chats/:id/events`:
 *
 *   - a chat with no session yet gets the probe's catalog (`cached`),
 *   - a chat whose agent runs gets the live session's (`live`),
 *   - a chat whose agent stopped gets them back from Band's log (`log`).
 *
 * `modes.list` (the Tasks page's new-task dialog) reads the same catalog.
 *
 * The coding agent is the scripted stub ACP agent, which announces the
 * commands `echo` and `review` and the modes `default` and `plan`.
 *
 * (Before ACP, slash commands were Band's own `skills.list`, which read
 * SKILL.md files from disk. That router is gone: the agent now reports
 * its own commands, skills included.)
 */

import { afterEach, describe, expect, it } from "vitest";
import type { ChatEvent, SessionState } from "../src/shared/chat-events";
import {
  collectEvents,
  seedAcpHome,
  sendMessage,
  startAcpServer,
  TEST_TOKEN,
  trpc,
  turnEnded,
} from "./helpers/acp-chat";
import type { ServerHandle } from "./helpers/server";

const STUB_COMMANDS = [
  { name: "echo", description: "Repeat the message back", input: { hint: "text to repeat" } },
  { name: "review", description: "Review the pending changes" },
];

let servers: ServerHandle[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()));
  servers = [];
});

async function boot(home?: string): Promise<ServerHandle> {
  const server = await startAcpServer({ home });
  servers.push(server);
  return server;
}

let seq = 0;
const newChatId = () => `slash-chat-${Date.now()}-${seq++}`;

/** Subscribes to the chat and returns the `session-state` it opens with. */
async function sessionState(url: string, chatId: string): Promise<SessionState> {
  const events = await collectEvents(url, chatId, { until: (e) => e.type === "session-state" });
  const state = events.find(
    (e): e is Extract<ChatEvent, { type: "session-state" }> => e.type === "session-state",
  );
  if (!state) throw new Error("no session-state event");
  return state.state;
}

async function createChat(url: string): Promise<string> {
  const chatId = newChatId();
  await trpc(url, "chats.create", { workspaceId: "testproject-main", id: chatId });
  return chatId;
}

describe("slash commands in the chat's session-state", () => {
  it("a chat with no session offers the commands the boot probe learned", async () => {
    const server = await boot();
    const chatId = await createChat(server.url);

    // The probe runs in the background after boot; poll until it lands.
    await expect
      .poll(async () => (await sessionState(server.url, chatId)).commands, { timeout: 15_000 })
      .toEqual(STUB_COMMANDS);
    const state = await sessionState(server.url, chatId);
    expect(state.source).toBe("cached");
  });

  it("a chat whose agent runs offers the live session's commands", async () => {
    const server = await boot();
    const chatId = newChatId();
    const done = collectEvents(server.url, chatId, { until: turnEnded });
    await new Promise((r) => setTimeout(r, 50));
    await sendMessage(server.url, chatId, "hello");
    const events = await done;

    // The agent announced its commands on the session, and Band logged it.
    const announced = events.find(
      (e) => e.type === "update" && e.update.sessionUpdate === "available_commands_update",
    );
    expect(announced).toMatchObject({
      update: { sessionUpdate: "available_commands_update", availableCommands: STUB_COMMANDS },
    });

    const state = await sessionState(server.url, chatId);
    expect(state.source).toBe("live");
    expect(state.commands).toEqual(STUB_COMMANDS);
  });

  it("after a restart, the chat's commands come back from Band's log", async () => {
    const home = seedAcpHome();
    const first = await boot(home);
    const chatId = newChatId();
    const done = collectEvents(first.url, chatId, { until: turnEnded });
    await new Promise((r) => setTimeout(r, 50));
    await sendMessage(first.url, chatId, "hello");
    await done;
    await first.close();
    servers = servers.filter((s) => s !== first);

    const second = await boot(home);
    const state = await sessionState(second.url, chatId);
    expect(state.source).toBe("log");
    expect(state.commands).toEqual(STUB_COMMANDS);
  });

  it("rejects the event stream without the band_token cookie (401)", async () => {
    const server = await boot();
    const res = await fetch(`${server.url}/api/chats/any/events`);
    expect(res.status).toBe(401);
    await res.body?.cancel();
  });
});

describe("modes.list", () => {
  it("returns the modes the agent offers, from the boot probe", async () => {
    const server = await boot();
    await expect
      .poll(
        async () =>
          (
            await trpc<{ modes: { id: string; name: string }[] }>(
              server.url,
              "modes.list",
              { agentId: "claude-code" },
              "query",
            )
          ).modes,
        { timeout: 15_000 },
      )
      .toEqual([
        { id: "default", name: "Default" },
        { id: "plan", name: "Plan" },
      ]);
  });

  it("rejects modes.list without the band_token cookie (401)", async () => {
    const server = await boot();
    const res = await fetch(
      `${server.url}/trpc/modes.list?input=${encodeURIComponent(JSON.stringify({}))}`,
    );
    expect(res.status).toBe(401);
    // A real token passes the same route.
    const ok = await fetch(
      `${server.url}/trpc/modes.list?input=${encodeURIComponent(JSON.stringify({}))}`,
      { headers: { Cookie: `band_token=${TEST_TOKEN}` } },
    );
    expect(ok.status).toBe(200);
  });
});
