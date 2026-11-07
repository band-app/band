// Agent access to extension editor tabs (docs/architecture/extensions.md, Agent access). A real hub
// (the production bundle, auth on) runs the scripted ACP stub agent, which calls the `band` MCP
// server through the entry Band passed. A `FakeWindow` plays the web app: it reports activity under
// its client id, registers editor tabs, reports a selection and answers the `editor-call` and
// `editor-open` events on the status stream the way `ExtensionEditor` does.

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toWorktreeId } from "@band-app/shared/worktree-id";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { STUB_AGENT_PATH, seedAcpHome, TEST_TOKEN, WORKTREE_ID } from "./helpers/acp-chat";
import { seedState } from "./helpers/seed-state";
import { type ServerHandle, startServer, trpcData, trpcMutate, trpcQuery } from "./helpers/server";
import { waitFor } from "./helpers/wait-for";

const FIXTURE = join(import.meta.dirname, "../../web/e2e/fixtures/extensions/text-editor");
/** Short so the expiry case runs in seconds; the other cases finish well inside it. */
const SELECTION_TTL_MS = 8000;
const FILE = "doc.band-test";
const OTHER = "other.band-test";
const OTHER_WORKTREE = toWorktreeId("otherrepo", "main", "local");

interface StatusEvent {
  kind?: string;
  worktreeId?: string;
  clientId?: string;
  editorRequest?: {
    callId: string;
    file: string;
    extensionId: string;
    editorId?: string;
    message?: {
      id: string | number;
      method?: string;
      params?: { name?: string; arguments?: Record<string, unknown> };
    };
  };
}

let home: string;
let server: ServerHandle;
let httpLog: string;

const mutate = async <T>(procedure: string, input: unknown): Promise<T> => {
  const res = await trpcMutate(server.url, procedure, input, TEST_TOKEN);
  if (res.status !== 200) throw new Error(`${procedure}: HTTP ${res.status} ${await res.text()}`);
  return trpcData<T>(res);
};

/** The web app, reduced to what the hub sees of it. */
class FakeWindow {
  readonly events: StatusEvent[] = [];
  /** The document text per `<worktree>|<file>` for the tabs this window has open. */
  readonly docs = new Map<string, string>();
  /** Files this window opens when the hub asks (`editor-open`). */
  autoOpen = true;
  private ws!: WebSocket;

  constructor(readonly clientId: string) {}

  async start(): Promise<void> {
    this.ws = new WebSocket(`${server.url.replace(/^http/, "ws")}/trpc`, {
      headers: { Cookie: `band_token=${TEST_TOKEN}` },
    });
    this.ws.on("message", (raw: Buffer) => {
      const data = (JSON.parse(raw.toString()) as { result?: { data?: StatusEvent } }).result?.data;
      if (!data) return;
      this.events.push(data);
      if (data.clientId === this.clientId) void this.handle(data);
    });
    await new Promise<void>((resolve, reject) => {
      this.ws.once("error", reject);
      this.ws.on("message", (raw: Buffer) => {
        const data = (JSON.parse(raw.toString()) as { result?: { data?: StatusEvent } }).result
          ?.data;
        if (data?.kind === "snapshot") resolve();
      });
      this.ws.once("open", () =>
        this.ws.send(
          JSON.stringify({
            id: 1,
            jsonrpc: "2.0",
            method: "subscription",
            params: { path: "status.stream", input: undefined },
          }),
        ),
      );
    });
    await this.focus();
  }

  focus(): Promise<unknown> {
    return mutate("services.setActivity", { activity: "active", clientId: this.clientId });
  }

  tab(worktreeId: string, file: string) {
    return {
      clientId: this.clientId,
      worktreeId,
      file,
      extensionId: "text-editor",
      editorId: "text",
    };
  }

  open(worktreeId: string, file: string, text: string): Promise<unknown> {
    this.docs.set(`${worktreeId}|${file}`, text);
    return mutate("editors.register", this.tab(worktreeId, file));
  }

  close(worktreeId: string, file: string, reason?: "closed"): Promise<unknown> {
    this.docs.delete(`${worktreeId}|${file}`);
    return mutate("editors.unregister", { ...this.tab(worktreeId, file), reason });
  }

  select(worktreeId: string, file: string, selection: object | null): Promise<unknown> {
    return mutate("editors.setSelection", { ...this.tab(worktreeId, file), selection });
  }

  private async handle(event: StatusEvent): Promise<void> {
    const request = event.editorRequest;
    if (!request || !event.worktreeId) return;
    if (event.kind === "editor-open") {
      if (this.autoOpen) await this.open(event.worktreeId, request.file, "opened by request\n");
      return;
    }
    if (event.kind !== "editor-call" || !request.message) return;
    const key = `${event.worktreeId}|${request.file}`;
    const params = request.message.params;
    if (params?.name === "set_text") this.docs.set(key, String(params.arguments?.text ?? ""));
    await mutate("editors.result", {
      clientId: this.clientId,
      callId: request.callId,
      message: {
        jsonrpc: "2.0",
        id: request.message.id,
        result: { content: [{ type: "text", text: this.docs.get(key) ?? "" }] },
      },
    });
  }

  stop(): void {
    this.ws.close();
  }
}

const log = (): { name: string; status: number; body: string }[] => {
  try {
    return readFileSync(httpLog, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
const line = (name: string) => log().find((l) => l.name === name);
const waitLine = (name: string) =>
  waitFor(async () => line(name), { label: `stub line ${name}`, timeoutMs: 30_000 });

/** The text the `band` server answered with, from a JSON-RPC body (plain or an SSE frame). */
function textOf(body: string): string {
  const json = body.includes("data:") ? body.slice(body.indexOf("data:") + 5).trim() : body;
  const parsed = JSON.parse(json.split("\n")[0]) as {
    result?: { content?: { text?: string }[]; isError?: boolean; tools?: unknown[] };
  };
  return (parsed.result?.content ?? []).map((c) => c.text ?? "").join("\n");
}
const rpc = (body: string) => {
  const json = body.includes("data:") ? body.slice(body.indexOf("data:") + 5).trim() : body;
  return JSON.parse(json.split("\n")[0]) as {
    result?: {
      tools?: { name: string; inputSchema: { required?: string[] } }[];
      isError?: boolean;
    };
  };
};

async function send(chatId: string, text: string): Promise<void> {
  const res = await fetch(`${server.url}/api/chats/${chatId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `band_token=${TEST_TOKEN}` },
    body: JSON.stringify({ worktreeId: WORKTREE_ID, text }),
  });
  if (!res.ok) throw new Error(`send failed: ${res.status} ${await res.text()}`);
}

const call = (name: string, tool: string, args: object = {}, method = "tools/call") => ({
  mcpCall: { name, server: "band", tool, args, method, fullBody: true },
});

describe("agent access to editor tabs", () => {
  let win: FakeWindow;

  beforeAll(async () => {
    home = seedAcpHome("band-editor-agent-");
    const repo = join(home, "repo");
    writeFileSync(join(repo, FILE), "hello\n");
    const other = join(home, "repo-other");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, OTHER), "secret of the other worktree\n");
    cpSync(FIXTURE, join(home, ".band", "extensions", "text-editor"), { recursive: true });
    // `seedAcpHome` seeded `testrepo`; a second repo gives a second worktree.
    seedState(home, {
      repos: [
        {
          name: "otherrepo",
          path: other,
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: other }],
        },
      ],
    });
    httpLog = join(home, "http-log.jsonl");
    const scenario = join(home, "scenario.json");
    writeFileSync(
      scenario,
      JSON.stringify({
        turns: [
          {
            match: "^list-tools",
            steps: [call("tools-list", "", {}, "tools/list"), { say: "ok" }],
          },
          {
            match: "^selection",
            steps: [call("selection", "band_editor_selection"), { say: "ok" }],
          },
          {
            match: "^nothing-selected",
            steps: [call("selection-cleared", "band_editor_selection"), { say: "ok" }],
          },
          {
            match: "^edit-open-tab",
            steps: [
              call("edit", "text-editor_set_text", { file: FILE, text: "changed by the agent\n" }),
              call("list", "band_editor_list"),
              { say: "ok" },
            ],
          },
          {
            match: "^cross-worktree",
            steps: [call("cross", "text-editor_get_text", { file: OTHER }), { say: "ok" }],
          },
          {
            match: "^open-no-window",
            steps: [call("open-none", "band_editor_open", { file: FILE }), { say: "ok" }],
          },
          {
            match: "^open-then-call",
            steps: [
              call("open", "band_editor_open", { file: FILE }),
              call("after-open", "text-editor_get_text", { file: FILE }),
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
        BAND_EDITOR_SELECTION_TTL_MS: String(SELECTION_TTL_MS),
        BAND_SERVE_UI: "false",
        BAND_TEST_ACP_AGENT: STUB_AGENT_PATH,
        BAND_TEST_ACP_STATE: join(home, "acp-stub-state"),
        BAND_TEST_ACP_LOG: join(home, "acp-stub-log.jsonl"),
        BAND_TEST_ACP_HTTP_LOG: httpLog,
        BAND_TEST_ACP_SCENARIO: scenario,
      },
    });
    win = new FakeWindow("window-one");
  }, 120_000);

  afterAll(async () => {
    win?.stop();
    await server?.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 10 });
  });

  it("S4: with no window open, band_editor_open says so", async () => {
    await send("chat-nowin", "open-no-window");
    const res = await waitLine("open-none");
    expect(textOf(res.body)).toBe("No Band window is open. Ask the person to open Band.");
    expect(rpc(res.body).result?.isError).toBe(true);
  }, 60_000);

  it("S5: lists manifest tools with a required file, and leaves out agent:false tools", async () => {
    await win.start();
    await send("chat-list", "list-tools");
    const res = await waitLine("tools-list");
    const tools = rpc(res.body).result?.tools ?? [];
    const names = tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "band_editor_open",
        "band_editor_list",
        "band_editor_selection",
        "text-editor_get_text",
        "text-editor_set_text",
      ]),
    );
    expect(names).not.toContain("text-editor_save_text");
    const setText = tools.find((t) => t.name === "text-editor_set_text");
    expect(setText?.inputSchema.required).toEqual(["file", "text"]);
  }, 60_000);

  it("S4: band_editor_open asks the most recently focused window and the next call succeeds", async () => {
    await send("chat-open", "open-then-call");
    const opened = await waitLine("open");
    expect(textOf(opened.body)).toContain(FILE);
    const after = await waitLine("after-open");
    expect(textOf(after.body)).toBe("opened by request\n");
    const request = win.events.find((e) => e.kind === "editor-open");
    expect(request?.clientId).toBe("window-one");
    expect(request?.editorRequest).toMatchObject({ file: FILE, extensionId: "text-editor" });
  }, 60_000);

  it("S1/S2: the selection reaches editors.selection, an event, and band_editor_selection", async () => {
    await win.open(WORKTREE_ID, FILE, "hello\n");
    const before = win.events.filter((e) => e.kind === "editor-selection-changed").length;
    await win.select(WORKTREE_ID, FILE, {
      address: "chars:0-5",
      kind: "text",
      label: "chars 0-5",
      text: "hello",
    });
    await waitFor(
      async () => win.events.filter((e) => e.kind === "editor-selection-changed").length > before,
      { label: "selection event" },
    );
    const res = await trpcQuery(
      server.url,
      "editors.selection",
      { worktreeId: WORKTREE_ID },
      TEST_TOKEN,
    );
    expect(await trpcData(res)).toMatchObject({
      file: FILE,
      extensionId: "text-editor",
      editorId: "text",
      selection: { address: "chars:0-5", label: "chars 0-5", text: "hello" },
    });

    await send("chat-sel", "selection");
    const seen = JSON.parse(textOf((await waitLine("selection")).body));
    expect(seen).toMatchObject({
      file: FILE,
      editor: "text-editor/text",
      selection: { address: "chars:0-5", text: "hello" },
    });

    await win.select(WORKTREE_ID, FILE, null);
    await send("chat-sel2", "nothing-selected");
    expect(textOf((await waitLine("selection-cleared")).body)).toBe(
      "Nothing is selected in an open editor.",
    );
  }, 60_000);

  it("S1: a selection longer than 4 KB is cut", async () => {
    await win.select(WORKTREE_ID, FILE, {
      address: "chars:0-9000",
      kind: "text",
      label: "big",
      text: "x".repeat(9000),
    });
    const res = await trpcQuery(
      server.url,
      "editors.selection",
      { worktreeId: WORKTREE_ID },
      TEST_TOKEN,
    );
    const state = (await trpcData<{ selection: { text: string } }>(res)).selection;
    expect(state.text.length).toBe(4097);
    expect(state.text.endsWith("…")).toBe(true);
    await win.select(WORKTREE_ID, FILE, null);
  });

  it("S3: a tool call edits the open tab's document and nothing is written to disk", async () => {
    await send("chat-edit", "edit-open-tab");
    const edit = await waitLine("edit");
    expect(rpc(edit.body).result?.isError).toBeUndefined();
    expect(win.docs.get(`${WORKTREE_ID}|${FILE}`)).toBe("changed by the agent\n");
    const list = JSON.parse(textOf((await waitLine("list")).body)) as {
      tabs: { file: string; editor: string }[];
    };
    expect(list.tabs).toEqual([
      expect.objectContaining({ file: FILE, editor: "text-editor/text", dirty: false }),
    ]);
    expect(readFileSync(join(home, "repo", FILE), "utf8")).toBe("hello\n");
  }, 60_000);

  it("S5: a chat cannot reach a tab of another worktree", async () => {
    await win.open(OTHER_WORKTREE, OTHER, "secret of the other worktree\n");
    await send("chat-cross", "cross-worktree");
    const res = await waitLine("cross");
    expect(rpc(res.body).result?.isError).toBe(true);
    expect(textOf(res.body)).toContain("is not open");
    expect(textOf(res.body)).not.toContain("secret");
  }, 60_000);

  it("keeps the selection after its tab closes, until a new one or the time limit", async () => {
    const query = async () =>
      trpcData<{ selection: { address: string } } | null>(
        await trpcQuery(server.url, "editors.selection", { worktreeId: WORKTREE_ID }, TEST_TOKEN),
      );
    await win.select(WORKTREE_ID, FILE, { address: "a", kind: "text", label: "a", text: "a" });
    await win.close(WORKTREE_ID, FILE);
    expect((await query())?.selection.address).toBe("a");
    // A new selection replaces it, from any window.
    await win.select(WORKTREE_ID, FILE, { address: "b", kind: "text", label: "b", text: "b" });
    expect((await query())?.selection.address).toBe("b");
    // The test hub sets BAND_EDITOR_SELECTION_TTL_MS to SELECTION_TTL_MS.
    await expect.poll(query, { timeout: SELECTION_TTL_MS * 3, interval: 500 }).toBeNull();
  }, 60_000);

  it("drops the selection when the tab is closed on purpose, from another window's view too", async () => {
    const query = async () =>
      trpcData<{ selection: { address: string } } | null>(
        await trpcQuery(server.url, "editors.selection", { worktreeId: WORKTREE_ID }, TEST_TOKEN),
      );
    await win.open(WORKTREE_ID, FILE, "text\n");
    await win.select(WORKTREE_ID, FILE, { address: "c", kind: "text", label: "c", text: "c" });
    // A close of another file leaves it.
    await win.close(WORKTREE_ID, OTHER, "closed");
    expect((await query())?.selection.address).toBe("c");
    const before = win.events.filter((e) => e.kind === "editor-selection-changed").length;
    await win.close(WORKTREE_ID, FILE, "closed");
    expect(await query()).toBeNull();
    await waitFor(
      async () => win.events.filter((e) => e.kind === "editor-selection-changed").length > before,
      { label: "selection cleared event" },
    );
  }, 60_000);

  it("S5: an agent cannot call editors.* through the MCP endpoint", async () => {
    const res = await fetch(`${server.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        Cookie: `band_token=${TEST_TOKEN}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("band_editors_");
  });
});
