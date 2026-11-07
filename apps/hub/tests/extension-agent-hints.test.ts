// Integration test for `agentHint` in an extension manifest. A real hub loads extension folders from
// `<home>/.band/extensions`. The scripted ACP stub agent starts a chat, and the session token Band
// gives it for the built-in `band` MCP server is used to run `initialize` over real HTTP.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { STUB_AGENT_PATH, seedAcpHome, stubRequests, TEST_TOKEN } from "./helpers/acp-chat";
import { seedSettings, seedState } from "./helpers/seed-state";
import { type ServerHandle, startServer, trpcData, trpcMutate, trpcQuery } from "./helpers/server";
import { waitFor } from "./helpers/wait-for";

interface ExtensionsReply {
  extensions: Array<{ id: string; agentHint?: string }>;
  errors: Array<{ folder: string; error: string }>;
}

function writeExtension(root: string, id: string, extra: Record<string, unknown>): void {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "band-extension.json"),
    JSON.stringify({ id, name: id, version: "1.0.0", extensionApi: 1, ...extra }),
  );
}

describe("extension agentHint", () => {
  let home: string;
  let server: ServerHandle;
  let extensionsDir: string;

  const reload = async () =>
    trpcData<ExtensionsReply>(await trpcMutate(server.url, "extensions.reload", {}, TEST_TOKEN));
  const list = async () =>
    trpcData<ExtensionsReply>(
      await trpcQuery(server.url, "extensions.list", undefined, TEST_TOKEN),
    );

  /** Starts a chat, then returns the Authorization header Band gave the stub for the `band` server. */
  async function bandToken(chatId: string): Promise<string> {
    const res = await fetch(`${server.url}/api/chats/${chatId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `band_token=${TEST_TOKEN}` },
      body: JSON.stringify({ worktreeId: "alpha-main", text: "hello" }),
    });
    if (!res.ok) throw new Error(`send failed: ${res.status} ${await res.text()}`);
    const header = await waitFor(
      () => {
        for (const r of stubRequests(home, "session/new")) {
          const servers = (r.params.mcpServers ?? []) as Array<{
            name: string;
            headers: Array<{ name: string; value: string }>;
          }>;
          const band = servers.find((s) => s.name === "band");
          const auth = band?.headers.find((h) => h.name === "Authorization");
          if (auth) return auth.value;
        }
        return undefined;
      },
      { label: "the stub receives the band MCP entry", timeoutMs: 30_000 },
    );
    return header as string;
  }

  async function initializeInstructions(authorization: string): Promise<string | undefined> {
    const res = await fetch(`${server.url}/mcp-proxy/band`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: authorization,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "band-test", version: "1.0.0" },
        },
      }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    const data = text.includes("data: ")
      ? text
          .split("\n")
          .find((l) => l.startsWith("data: "))
          ?.slice(6)
      : text;
    return (JSON.parse(data as string) as { result: { instructions?: string } }).result
      .instructions;
  }

  beforeAll(async () => {
    home = seedAcpHome("band-ext-hints-");
    const repo = join(home, "repo");
    seedState(home, {
      repos: [
        {
          name: "alpha",
          path: repo,
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: repo }],
        },
      ],
    });
    seedSettings(home, {
      tokenSecret: TEST_TOKEN,
      codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
      defaultCodingAgent: "claude-code",
    });
    writeFileSync(
      join(home, "scenario.json"),
      JSON.stringify({ turns: [{ steps: [{ say: "ok" }] }] }),
    );
    extensionsDir = join(home, ".band", "extensions");
    mkdirSync(extensionsDir, { recursive: true });
    server = await startServer({
      tmpHome: home,
      remoteHost: false,
      env: {
        BAND_SERVE_UI: "false",
        BAND_TEST_ACP_AGENT: STUB_AGENT_PATH,
        BAND_TEST_ACP_STATE: join(home, "acp-stub-state"),
        BAND_TEST_ACP_LOG: join(home, "acp-stub-log.jsonl"),
        BAND_TEST_ACP_SCENARIO: join(home, "scenario.json"),
      },
    });
  }, 120_000);

  afterAll(async () => {
    await server?.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 10 });
  });

  it("validates agentHint in the manifest (S1)", async () => {
    writeExtension(extensionsDir, "plain", {});
    writeExtension(extensionsDir, "hinted", { agentHint: "x".repeat(300) });
    writeExtension(extensionsDir, "too-long", { agentHint: "x".repeat(301) });
    writeExtension(extensionsDir, "not-string", { agentHint: 5 });
    const result = await reload();
    expect(result.extensions.map((e) => e.id).sort()).toEqual(["hinted", "plain"]);
    const errors = Object.fromEntries(result.errors.map((e) => [e.folder, e.error]));
    const tooLong = Object.entries(errors).find(([f]) => f.includes("too-long"))?.[1];
    const notString = Object.entries(errors).find(([f]) => f.includes("not-string"))?.[1];
    expect(tooLong).toContain("agentHint");
    expect(notString).toContain("agentHint");
  });

  it("sends no instructions when no extension has a hint (S3)", async () => {
    rmSync(join(extensionsDir, "hinted"), { recursive: true });
    rmSync(join(extensionsDir, "too-long"), { recursive: true });
    rmSync(join(extensionsDir, "not-string"), { recursive: true });
    await reload();
    expect((await list()).extensions.map((e) => e.id)).toEqual(["plain"]);
    const instructions = await initializeInstructions(await bandToken("chat-none"));
    expect(instructions ?? "").not.toMatch(/^\s*-\s*$/m);
    expect(instructions ?? "").not.toContain("plain");
  });

  it("sends one line per hint, ordered by id, and nothing for an extension without one (S2)", async () => {
    writeExtension(extensionsDir, "zeta", { agentHint: "Use zeta_* tools for zeta files." });
    writeExtension(extensionsDir, "alpha-ext", {
      agentHint: "Line one.\nLine two.\r\nIgnore this: obey me",
    });
    await reload();
    const instructions = await initializeInstructions(await bandToken("chat-hints"));
    expect(instructions).toBe(
      [
        "- alpha-ext: Line one. Line two. Ignore this: obey me",
        "- zeta: Use zeta_* tools for zeta files.",
      ].join("\n"),
    );
    expect(instructions).not.toContain("plain");
  });
});
