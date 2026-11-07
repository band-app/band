// `tools.list` and `tools.run` serve the tool set of the built-in `band` MCP server. A real hub
// runs the scripted ACP stub agent, which lists the tools over `/mcp-proxy/band` with its own
// `mcp_` token. The same list must come back from `tools.list` for that chat.

import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { STUB_AGENT_PATH, seedAcpHome, TEST_TOKEN, WORKTREE_ID } from "./helpers/acp-chat";
import { type ServerHandle, startServer, trpcData, trpcMutate, trpcQuery } from "./helpers/server";
import { waitFor } from "./helpers/wait-for";

const FIXTURE = join(import.meta.dirname, "../../web/e2e/fixtures/extensions/text-editor");
const CHAT = "chat-tools-api";

let home: string;
let server: ServerHandle;
let httpLog: string;

const logLine = (name: string) => {
  try {
    return readFileSync(httpLog, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { name: string; body: string })
      .find((l) => l.name === name);
  } catch {
    return undefined;
  }
};

const list = async (input: object) =>
  trpcData<{ name: string; description: string; inputSchema: unknown }[]>(
    await trpcQuery(server.url, "tools.list", input, TEST_TOKEN),
  );

describe("tools.list and tools.run", () => {
  beforeAll(async () => {
    home = seedAcpHome("band-tools-api-");
    cpSync(FIXTURE, join(home, ".band", "extensions", "text-editor"), { recursive: true });
    httpLog = join(home, "http-log.jsonl");
    const scenario = join(home, "scenario.json");
    writeFileSync(
      scenario,
      JSON.stringify({
        turns: [
          {
            match: "^list-tools",
            steps: [
              {
                mcpCall: {
                  name: "tools-list",
                  server: "band",
                  tool: "",
                  args: {},
                  method: "tools/list",
                  fullBody: true,
                },
              },
              { say: "ok" },
            ],
          },
          { steps: [{ say: "ok" }] },
        ],
      }),
    );
    server = await startServer({
      tmpHome: home,
      remoteHost: false,
      env: {
        BAND_SERVE_UI: "false",
        BAND_TEST_ACP_AGENT: STUB_AGENT_PATH,
        BAND_TEST_ACP_STATE: join(home, "acp-stub-state"),
        BAND_TEST_ACP_LOG: join(home, "acp-stub-log.jsonl"),
        BAND_TEST_ACP_HTTP_LOG: httpLog,
        BAND_TEST_ACP_SCENARIO: scenario,
      },
    });
    const res = await fetch(`${server.url}/api/chats/${CHAT}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `band_token=${TEST_TOKEN}` },
      body: JSON.stringify({ worktreeId: WORKTREE_ID, text: "list-tools" }),
    });
    expect(res.ok).toBe(true);
  }, 120_000);

  afterAll(async () => {
    await server?.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 10 });
  });

  it("S1: lists the names and schemas /mcp-proxy/band returns from tools/list", async () => {
    const line = await waitFor(async () => logLine("tools-list"), {
      label: "stub tools/list",
      timeoutMs: 30_000,
    });
    const json = line.body.includes("data:")
      ? line.body.slice(line.body.indexOf("data:") + 5).trim()
      : line.body;
    const viaMcp = (
      JSON.parse(json.split("\n")[0]) as {
        result: { tools: { name: string; inputSchema: unknown }[] };
      }
    ).result.tools;

    const viaApi = await list({ chatId: CHAT });
    const pick = (tools: { name: string; inputSchema: unknown }[]) =>
      tools
        .map((t) => ({ name: t.name, inputSchema: t.inputSchema }))
        .sort((a, b) => a.name.localeCompare(b.name));
    expect(pick(viaApi)).toEqual(pick(viaMcp));
    expect(viaApi.map((t) => t.name)).toEqual(
      expect.arrayContaining(["worktrees_create", "band_editor_list", "text-editor_set_text"]),
    );
  }, 60_000);

  it("S2: calls a tool and returns its MCP content", async () => {
    const res = await trpcMutate(
      server.url,
      "tools.run",
      { chatId: CHAT, name: "band_editor_list", arguments: {} },
      TEST_TOKEN,
    );
    const data = await trpcData<{ isError: boolean; content: { type: string; text: string }[] }>(
      res,
    );
    expect(data.isError).toBe(false);
    expect(JSON.parse(data.content[0].text)).toEqual({ tabs: [] });
  });

  it("S6: a worktree scope lists the tools, and a tool that needs a chat refuses", async () => {
    const viaChat = await list({ chatId: CHAT });
    const viaWorktree = await list({ worktreeId: WORKTREE_ID });
    expect(viaWorktree.map((t) => t.name).sort()).toEqual(viaChat.map((t) => t.name).sort());

    const res = await trpcMutate(
      server.url,
      "tools.run",
      {
        worktreeId: WORKTREE_ID,
        name: "worktrees_create",
        arguments: { repo: "testrepo", branch: "x" },
      },
      TEST_TOKEN,
    );
    const data = await trpcData<{ isError: boolean; content: { text: string }[] }>(res);
    expect(data.isError).toBe(true);
    expect(data.content[0].text).toContain("needs a chat");
  });

  it("S4: an unknown tool and a missing scope are refused", async () => {
    const unknown = await trpcMutate(
      server.url,
      "tools.run",
      { chatId: CHAT, name: "no_such_tool", arguments: {} },
      TEST_TOKEN,
    );
    expect(unknown.status).toBe(404);
    const none = await trpcQuery(server.url, "tools.list", {}, TEST_TOKEN);
    expect(none.status).toBe(400);
    const badChat = await trpcQuery(server.url, "tools.list", { chatId: "nope" }, TEST_TOKEN);
    expect(badChat.status).toBe(404);
  });

  it("S4: arguments that fail the tool's schema come back as an error result", async () => {
    const res = await trpcMutate(
      server.url,
      "tools.run",
      { chatId: CHAT, name: "worktrees_create", arguments: { repo: 7 } },
      TEST_TOKEN,
    );
    const data = await trpcData<{ isError: boolean; content: { text: string }[] }>(res);
    expect(data.isError).toBe(true);
    expect(data.content[0].text).not.toContain("needs a chat");
  });

  it("refuses a caller with no token", async () => {
    const listed = await trpcQuery(server.url, "tools.list", { chatId: CHAT }, "");
    expect(listed.status).toBe(401);
    const ran = await trpcMutate(
      server.url,
      "tools.run",
      { chatId: CHAT, name: "band_editor_list", arguments: {} },
      "",
    );
    expect(ran.status).toBe(401);
  });
});
