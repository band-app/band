/**
 * Integration tests for the Codex adapter.
 *
 * Run with:
 *   node --experimental-strip-types \
 *        --import ./tests/register-mock-loader.mjs \
 *        --test tests/codex-adapter.test.ts
 *
 * The custom loader in register-mock-loader.mjs redirects the
 * `import { Codex } from "@openai/codex-sdk"` inside the adapter to
 * tests/mocks/codex-sdk.mjs so the real SDK binary isn't needed.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

// The mock SDK is loaded via our custom loader.
// Import the test-control object to configure events & inspect calls.
import { _test } from "@openai/codex-sdk";

// Import the adapter (which will import @openai/codex-sdk → our mock)
import { CodexAdapter } from "../src/adapters/codex.ts";
import { codingAgentConfigSchema } from "../src/config.ts";
import { createCodingAgent } from "../src/factory.ts";

type AgentEvent = import("../src/events.ts").AgentEvent;

// ─── Helpers ────────────────────────────────────────────────────────────────

async function collectEvents(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

function makeConfig(overrides?: Record<string, unknown>) {
  return {
    type: "codex" as const,
    workspaceDir: "/tmp/test-workspace",
    maxTurns: 5,
    options: { model: "codex-mini", ...overrides },
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("CodexAdapter", () => {
  beforeEach(() => {
    _test.reset();
  });

  // ── Static properties ───────────────────────────────────────────────────

  it("has correct name", () => {
    const adapter = new CodexAdapter(makeConfig());
    assert.equal(adapter.name, "Codex");
  });

  it("supports cost tracking", () => {
    const adapter = new CodexAdapter(makeConfig());
    assert.equal(adapter.supportedFeatures.costTracking, true);
  });

  it("supports session listing", () => {
    const adapter = new CodexAdapter(makeConfig());
    assert.equal(adapter.supportedFeatures.sessionListing, true);
  });

  // ── Modes ─────────────────────────────────────────────────────────────

  it("lists edit and plan modes", () => {
    const adapter = new CodexAdapter(makeConfig());
    const modes = adapter.listModes();
    assert.equal(modes.length, 2);
    assert.equal(modes[0].id, "edit");
    assert.equal(modes[1].id, "plan");
  });

  // ── Constructor passes options to SDK ──────────────────────────────────

  it("passes model via startThread, not constructor config", async () => {
    _test.setEvents([{ type: "thread.started", thread_id: "t1" }]);
    const adapter = new CodexAdapter(makeConfig({ model: "gpt-5.5" }));
    await collectEvents(adapter.runSession("hello"));
    assert.equal(_test.constructorCalls.length, 1);
    // Model is no longer passed via constructor config (avoids double-passing)
    assert.equal(_test.constructorCalls[0].config, undefined);
    // Model is passed via startThread options instead
    assert.equal(_test.startThreadCalls[0].opts?.model, "gpt-5.5");
  });

  it("passes executablePath as codexPathOverride", async () => {
    _test.setEvents([{ type: "thread.started", thread_id: "t1" }]);
    const adapter = new CodexAdapter(
      makeConfig({ model: "codex-mini", executablePath: "/usr/local/bin/codex" }),
    );
    await collectEvents(adapter.runSession("hello"));
    assert.equal(_test.constructorCalls[0].codexPathOverride, "/usr/local/bin/codex");
  });

  it("passes env override to Codex constructor", async () => {
    _test.setEvents([{ type: "thread.started", thread_id: "t1" }]);
    const adapter = new CodexAdapter({
      type: "codex" as const,
      workspaceDir: "/tmp/test",
      maxTurns: 5,
      options: {},
    });
    await collectEvents(adapter.runSession("hello"));
    // Constructor should receive env override (clean env without Node.js internals)
    assert.ok(_test.constructorCalls[0].env, "env override should be set");
  });

  // ── Session start ─────────────────────────────────────────────────────

  it("maps thread.started to session-start", async () => {
    _test.setEvents([{ type: "thread.started", thread_id: "thread-abc" }]);
    const adapter = new CodexAdapter(makeConfig());
    const events = await collectEvents(adapter.runSession("hello"));

    assert.equal(events.length, 1);
    assert.equal(events[0].type, "session-start");
    assert.equal((events[0] as { sessionId: string }).sessionId, "thread-abc");
  });

  // ── Streaming text deltas via item.updated ────────────────────────────

  it("computes text deltas from item.updated agent_message", async () => {
    _test.setEvents([
      { type: "item.updated", item: { type: "agent_message", id: "msg-1", text: "Hello" } },
      {
        type: "item.updated",
        item: { type: "agent_message", id: "msg-1", text: "Hello, world!" },
      },
      {
        type: "item.completed",
        item: { type: "agent_message", id: "msg-1", text: "Hello, world!" },
      },
    ]);
    const adapter = new CodexAdapter(makeConfig());
    const events = await collectEvents(adapter.runSession("hello"));

    // First updated: "Hello" (5 chars, 0 previously emitted → delta: "Hello")
    // Second updated: "Hello, world!" (13 chars, 5 previously emitted → delta: ", world!")
    // Completed: "Hello, world!" (13 chars, 13 previously emitted → no delta)
    const textEvents = events.filter((e) => e.type === "text-delta") as { text: string }[];
    assert.equal(textEvents.length, 2);
    assert.equal(textEvents[0].text, "Hello");
    assert.equal(textEvents[1].text, ", world!");
  });

  it("emits remaining text on item.completed if not fully streamed", async () => {
    _test.setEvents([
      { type: "item.updated", item: { type: "agent_message", id: "msg-1", text: "Hi" } },
      {
        type: "item.completed",
        item: { type: "agent_message", id: "msg-1", text: "Hi there!" },
      },
    ]);
    const adapter = new CodexAdapter(makeConfig());
    const events = await collectEvents(adapter.runSession("hello"));

    const textEvents = events.filter((e) => e.type === "text-delta") as { text: string }[];
    assert.equal(textEvents.length, 2);
    assert.equal(textEvents[0].text, "Hi");
    assert.equal(textEvents[1].text, " there!");
  });

  // ── Command execution (Bash) ──────────────────────────────────────────

  it("maps command_execution item.started to tool-use with Bash name", async () => {
    _test.setEvents([
      {
        type: "item.started",
        item: {
          type: "command_execution",
          id: "cmd-1",
          command: "ls -la",
          aggregated_output: "",
          status: "in_progress",
        },
      },
    ]);
    const adapter = new CodexAdapter(makeConfig());
    const events = await collectEvents(adapter.runSession("list files"));

    assert.equal(events.length, 1);
    assert.equal(events[0].type, "tool-use");
    const e = events[0] as { toolCallId: string; toolName: string; input: Record<string, unknown> };
    assert.equal(e.toolName, "Bash");
    assert.deepEqual(e.input, { command: "ls -la" });
  });

  it("maps command_execution item.completed to tool-result", async () => {
    _test.setEvents([
      {
        type: "item.started",
        item: {
          type: "command_execution",
          id: "cmd-1",
          command: "echo hi",
          aggregated_output: "",
          status: "in_progress",
        },
      },
      {
        type: "item.completed",
        item: {
          type: "command_execution",
          id: "cmd-1",
          command: "echo hi",
          aggregated_output: "hi\n",
          exit_code: 0,
          status: "completed",
        },
      },
    ]);
    const adapter = new CodexAdapter(makeConfig());
    const events = await collectEvents(adapter.runSession("echo"));

    assert.equal(events[1].type, "tool-result");
    const result = events[1] as { output: string; isError: boolean; toolName: string };
    assert.equal(result.output, "hi\n");
    assert.equal(result.isError, false);
    assert.equal(result.toolName, "Bash");
  });

  it("marks command_execution with non-zero exit code as error", async () => {
    _test.setEvents([
      {
        type: "item.started",
        item: {
          type: "command_execution",
          id: "cmd-2",
          command: "false",
          aggregated_output: "",
          status: "in_progress",
        },
      },
      {
        type: "item.completed",
        item: {
          type: "command_execution",
          id: "cmd-2",
          command: "false",
          aggregated_output: "",
          exit_code: 1,
          status: "failed",
        },
      },
    ]);
    const adapter = new CodexAdapter(makeConfig());
    const events = await collectEvents(adapter.runSession("fail"));

    const result = events[1] as { isError: boolean };
    assert.equal(result.isError, true);
  });

  // ── File change ───────────────────────────────────────────────────────

  it("maps file_change item.started to tool-use with FileEdit name", async () => {
    _test.setEvents([
      {
        type: "item.started",
        item: {
          type: "file_change",
          id: "fc-1",
          changes: [{ kind: "add", path: "src/new.ts" }],
          status: "completed",
        },
      },
    ]);
    const adapter = new CodexAdapter(makeConfig());
    const events = await collectEvents(adapter.runSession("create file"));

    assert.equal(events[0].type, "tool-use");
    const e = events[0] as { toolName: string; input: Record<string, unknown> };
    assert.equal(e.toolName, "FileEdit");
    assert.deepEqual(e.input, { changes: [{ kind: "add", path: "src/new.ts" }] });
  });

  it("maps file_change item.completed to tool-result", async () => {
    _test.setEvents([
      {
        type: "item.started",
        item: { type: "file_change", id: "fc-1", changes: [], status: "completed" },
      },
      {
        type: "item.completed",
        item: { type: "file_change", id: "fc-1", changes: [], status: "completed" },
      },
    ]);
    const adapter = new CodexAdapter(makeConfig());
    const events = await collectEvents(adapter.runSession("edit"));

    assert.equal(events[1].type, "tool-result");
    const result = events[1] as { output: string; isError: boolean };
    assert.equal(result.output, "completed");
    assert.equal(result.isError, false);
  });

  // ── MCP tool call ─────────────────────────────────────────────────────

  it("maps mcp_tool_call to tool-use with server:tool name", async () => {
    _test.setEvents([
      {
        type: "item.started",
        item: {
          type: "mcp_tool_call",
          id: "mcp-1",
          server: "github",
          tool: "create_issue",
          arguments: { title: "Bug" },
          status: "in_progress",
        },
      },
    ]);
    const adapter = new CodexAdapter(makeConfig());
    const events = await collectEvents(adapter.runSession("create issue"));

    assert.equal(events[0].type, "tool-use");
    const e = events[0] as { toolName: string; input: Record<string, unknown> };
    assert.equal(e.toolName, "github:create_issue");
    assert.deepEqual(e.input, { title: "Bug" });
  });

  it("maps mcp_tool_call completed to tool-result", async () => {
    _test.setEvents([
      {
        type: "item.started",
        item: {
          type: "mcp_tool_call",
          id: "mcp-1",
          server: "s",
          tool: "t",
          arguments: {},
          status: "in_progress",
        },
      },
      {
        type: "item.completed",
        item: {
          type: "mcp_tool_call",
          id: "mcp-1",
          server: "s",
          tool: "t",
          arguments: {},
          result: { content: [], structured_content: { url: "https://gh.io/1" } },
          status: "completed",
        },
      },
    ]);
    const adapter = new CodexAdapter(makeConfig());
    const events = await collectEvents(adapter.runSession("mcp"));

    assert.equal(events[1].type, "tool-result");
    const result = events[1] as { output: string };
    assert.ok(result.output.includes("gh.io"));
  });

  it("marks failed mcp_tool_call as error", async () => {
    _test.setEvents([
      {
        type: "item.completed",
        item: {
          type: "mcp_tool_call",
          id: "mcp-2",
          server: "s",
          tool: "t",
          arguments: {},
          status: "failed",
          error: { message: "auth error" },
        },
      },
    ]);
    const adapter = new CodexAdapter(makeConfig());
    const events = await collectEvents(adapter.runSession("mcp fail"));

    const result = events[0] as { isError: boolean; output: string };
    assert.equal(result.isError, true);
    assert.equal(result.output, "auth error");
  });

  // ── Todo list (maps to TodoWrite) ─────────────────────────────────────

  it("maps todo_list item.started to TodoWrite tool-use", async () => {
    _test.setEvents([
      {
        type: "item.started",
        item: {
          type: "todo_list",
          id: "todo-1",
          items: [
            { text: "Read the file", completed: false },
            { text: "Fix the bug", completed: true },
          ],
        },
      },
    ]);
    const adapter = new CodexAdapter(makeConfig());
    const events = await collectEvents(adapter.runSession("plan"));

    assert.equal(events.length, 1);
    assert.equal(events[0].type, "tool-use");
    const e = events[0] as { toolName: string; input: Record<string, unknown> };
    assert.equal(e.toolName, "TodoWrite");
    assert.deepEqual(e.input, {
      todos: [
        { content: "Read the file", status: "in_progress" },
        { content: "Fix the bug", status: "completed" },
      ],
    });
  });

  it("maps todo_list item.completed to TodoWrite tool-use + tool-result", async () => {
    _test.setEvents([
      {
        type: "item.completed",
        item: {
          type: "todo_list",
          id: "todo-2",
          items: [
            { text: "Step 1", completed: true },
            { text: "Step 2", completed: false },
          ],
        },
      },
    ]);
    const adapter = new CodexAdapter(makeConfig());
    const events = await collectEvents(adapter.runSession("work"));

    assert.equal(events.length, 2);
    assert.equal(events[0].type, "tool-use");
    assert.equal((events[0] as { toolName: string }).toolName, "TodoWrite");
    assert.equal(events[1].type, "tool-result");
    assert.equal((events[1] as { isError: boolean }).isError, false);
  });

  // ── Web search ────────────────────────────────────────────────────────

  it("maps web_search item.started to tool-use", async () => {
    _test.setEvents([
      {
        type: "item.started",
        item: { type: "web_search", id: "ws-1", query: "node.js streams" },
      },
    ]);
    const adapter = new CodexAdapter(makeConfig());
    const events = await collectEvents(adapter.runSession("search"));

    assert.equal(events[0].type, "tool-use");
    const e = events[0] as { toolName: string; input: Record<string, unknown> };
    assert.equal(e.toolName, "WebSearch");
    assert.deepEqual(e.input, { query: "node.js streams" });
  });

  // ── Turn lifecycle ────────────────────────────────────────────────────

  it("maps turn.completed to session-result", async () => {
    _test.setEvents([
      { type: "thread.started", thread_id: "t1" },
      { type: "turn.started" },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 1000,
          cached_input_tokens: 200,
          output_tokens: 500,
          reasoning_output_tokens: 50,
        },
      },
    ]);
    const adapter = new CodexAdapter(makeConfig());
    const events = await collectEvents(adapter.runSession("plan"));

    const usage = events.find((e) => e.type === "usage") as
      | {
          contextTokens: number;
          totalProcessedTokens?: number;
          reasoningOutputTokens?: number;
        }
      | undefined;
    assert.ok(usage);
    assert.equal(usage.contextTokens, 1550);
    assert.equal(usage.totalProcessedTokens, 1550);
    assert.equal(usage.reasoningOutputTokens, 50);

    const result = events.find((e) => e.type === "session-result") as {
      success: boolean;
      numTurns: number;
    };
    assert.ok(result);
    assert.equal(result.success, true);
    assert.equal(result.numTurns, 1);
  });

  it("maps turn.failed to session-result with error", async () => {
    _test.setEvents([
      { type: "thread.started", thread_id: "t2" },
      { type: "turn.started" },
      {
        type: "turn.failed",
        error: { message: "Rate limit exceeded" },
      },
    ]);
    const adapter = new CodexAdapter(makeConfig());
    const events = await collectEvents(adapter.runSession("fail"));

    const result = events.find((e) => e.type === "session-result") as {
      success: boolean;
      errors: string[];
    };
    assert.ok(result);
    assert.equal(result.success, false);
    assert.deepEqual(result.errors, ["Rate limit exceeded"]);
  });

  // ── Error events ──────────────────────────────────────────────────────

  it("maps error event to error", async () => {
    _test.setEvents([{ type: "error", message: "Connection failed" }]);
    const adapter = new CodexAdapter(makeConfig());
    const events = await collectEvents(adapter.runSession("err"));

    assert.equal(events.length, 1);
    assert.equal(events[0].type, "error");
    assert.equal((events[0] as { message: string }).message, "Connection failed");
  });

  // ── Mode mapping to sandbox ───────────────────────────────────────────

  it("uses workspace-write sandbox for edit mode", async () => {
    _test.setEvents([{ type: "thread.started", thread_id: "t1" }]);
    const adapter = new CodexAdapter(makeConfig());
    await collectEvents(adapter.runSession("hello", undefined, { mode: "edit" }));

    assert.equal(_test.startThreadCalls.length, 1);
    assert.equal(_test.startThreadCalls[0].opts?.sandboxMode, "workspace-write");
  });

  it("uses read-only sandbox for plan mode", async () => {
    _test.setEvents([{ type: "thread.started", thread_id: "t1" }]);
    const adapter = new CodexAdapter(makeConfig());
    await collectEvents(adapter.runSession("plan this", undefined, { mode: "plan" }));

    assert.equal(_test.startThreadCalls.length, 1);
    assert.equal(_test.startThreadCalls[0].opts?.sandboxMode, "read-only");
  });

  it("defaults to edit mode (workspace-write sandbox)", async () => {
    _test.setEvents([{ type: "thread.started", thread_id: "t1" }]);
    const adapter = new CodexAdapter(makeConfig());
    await collectEvents(adapter.runSession("hello"));

    assert.equal(_test.startThreadCalls[0].opts?.sandboxMode, "workspace-write");
  });

  // ── Session resume ────────────────────────────────────────────────────

  it("resumes existing session when sessionId is provided", async () => {
    _test.setEvents([{ type: "thread.started", thread_id: "existing-session" }]);
    const adapter = new CodexAdapter(makeConfig());
    await collectEvents(adapter.runSession("continue", "existing-session"));

    assert.equal(_test.resumeThreadCalls.length, 1);
    assert.equal(_test.resumeThreadCalls[0].id, "existing-session");
    assert.equal(_test.startThreadCalls.length, 0);
  });

  it("starts new thread when no sessionId", async () => {
    _test.setEvents([{ type: "thread.started", thread_id: "new" }]);
    const adapter = new CodexAdapter(makeConfig());
    await collectEvents(adapter.runSession("hello"));

    assert.equal(_test.startThreadCalls.length, 1);
    assert.equal(_test.resumeThreadCalls.length, 0);
  });

  // ── Abort ─────────────────────────────────────────────────────────────

  it("abort() can be called safely when no session is active", () => {
    const adapter = new CodexAdapter(makeConfig());
    // Should not throw
    adapter.abort();
  });

  // ── Error item ────────────────────────────────────────────────────────

  it("maps error item.started to error event", async () => {
    _test.setEvents([
      {
        type: "item.started",
        item: { type: "error", id: "err-1", message: "Something went wrong" },
      },
    ]);
    const adapter = new CodexAdapter(makeConfig());
    const events = await collectEvents(adapter.runSession("err"));

    assert.equal(events.length, 1);
    assert.equal(events[0].type, "error");
    assert.equal((events[0] as { message: string }).message, "Something went wrong");
  });

  // ── runStreamed failure ────────────────────────────────────────────

  it("yields error + session-result when runStreamed throws", async () => {
    _test.setRunStreamedError(
      new Error("Codex Exec exited with code 1: Reading prompt from stdin..."),
    );
    const adapter = new CodexAdapter(makeConfig());
    const events = await collectEvents(adapter.runSession("fail"));

    assert.equal(events.length, 2);
    assert.equal(events[0].type, "error");
    assert.ok((events[0] as { message: string }).message.includes("Codex Exec exited with code 1"));
    assert.equal(events[1].type, "session-result");
    assert.equal((events[1] as { success: boolean }).success, false);
    assert.ok(
      (events[1] as { errors: string[] }).errors[0].includes("Codex Exec exited with code 1"),
    );
  });

  // ── Complete event sequence ───────────────────────────────────────────

  it("handles a realistic full session flow", async () => {
    _test.setEvents([
      { type: "thread.started", thread_id: "session-123" },
      {
        type: "item.updated",
        item: { type: "agent_message", id: "msg-1", text: "I'll read the file for you." },
      },
      {
        type: "item.completed",
        item: { type: "agent_message", id: "msg-1", text: "I'll read the file for you." },
      },
      {
        type: "item.started",
        item: {
          type: "command_execution",
          id: "cmd-1",
          command: "cat README.md",
          aggregated_output: "",
          status: "in_progress",
        },
      },
      {
        type: "item.completed",
        item: {
          type: "command_execution",
          id: "cmd-1",
          command: "cat README.md",
          aggregated_output: "# My Project\nHello world",
          exit_code: 0,
          status: "completed",
        },
      },
      {
        type: "item.updated",
        item: { type: "agent_message", id: "msg-2", text: "Here's the content." },
      },
      {
        type: "item.completed",
        item: { type: "agent_message", id: "msg-2", text: "Here's the content." },
      },
      { type: "turn.started" },
      {
        type: "turn.completed",
        usage: { input_tokens: 500, cached_input_tokens: 0, output_tokens: 200 },
      },
    ]);

    const adapter = new CodexAdapter(makeConfig());
    const events = await collectEvents(adapter.runSession("read README.md"));

    const types = events.map((e) => e.type);
    assert.deepEqual(types, [
      "session-start",
      "text-delta",
      // item.completed for agent_message emits no delta (already fully streamed)
      "tool-use",
      "tool-result",
      "text-delta",
      // item.completed for agent_message emits no delta (already fully streamed)
      "usage",
      "session-result",
    ]);

    // Verify session-start
    assert.equal((events[0] as { sessionId: string }).sessionId, "session-123");

    // Verify tool-use
    const toolUse = events[2] as { toolName: string };
    assert.equal(toolUse.toolName, "Bash");

    // Verify tool-result
    const toolResult = events[3] as { output: string };
    assert.equal(toolResult.output, "# My Project\nHello world");

    // Verify usage carries context size
    const usageEvent = events[5] as {
      inputTokens: number;
      contextTokens?: number;
      totalProcessedTokens?: number;
    };
    assert.equal(usageEvent.inputTokens, 500);
    assert.equal(usageEvent.contextTokens, 700);
    assert.equal(usageEvent.totalProcessedTokens, 700);

    // Verify session-result
    const sessionResult = events[6] as {
      success: boolean;
      numTurns: number;
    };
    assert.equal(sessionResult.success, true);
    assert.equal(sessionResult.numTurns, 1);
  });
});

// ─── Config schema tests ──────────────────────────────────────────────────

describe("codex config schema", () => {
  it("parses minimal codex config with defaults", () => {
    const result = codingAgentConfigSchema.parse({
      type: "codex",
    });
    assert.equal(result.type, "codex");
    assert.equal(result.maxTurns, 3);
    assert.deepEqual(result.options, {});
  });

  it("parses codex config with model and executablePath", () => {
    const result = codingAgentConfigSchema.parse({
      type: "codex",
      maxTurns: 10,
      options: {
        model: "gpt-5-codex",
        executablePath: "/opt/codex/bin/codex",
      },
    });
    assert.equal(result.type, "codex");
    assert.equal(result.maxTurns, 10);
    assert.equal((result.options as { model: string }).model, "gpt-5-codex");
    assert.equal(
      (result.options as { executablePath: string }).executablePath,
      "/opt/codex/bin/codex",
    );
  });

  it("rejects invalid codex config options", () => {
    assert.throws(() => {
      codingAgentConfigSchema.parse({
        type: "codex",
        maxTurns: -1,
      });
    });
  });
});

// ─── Factory tests ────────────────────────────────────────────────────────

describe("createCodingAgent with codex type", () => {
  it("creates a CodexAdapter", async () => {
    const agent = await createCodingAgent({
      type: "codex",
      workspaceDir: "/tmp/test",
      maxTurns: 3,
      options: {},
    });
    assert.equal(agent.name, "Codex");
    assert.equal(agent.supportedFeatures.costTracking, true);
    assert.equal(agent.supportedFeatures.sessionListing, true);
  });

  it("factory-created agent has listModes", async () => {
    const agent = await createCodingAgent({
      type: "codex",
      workspaceDir: "/tmp/test",
      maxTurns: 3,
      options: {},
    });
    const modes = agent.listModes!();
    assert.equal(modes.length, 2);
    assert.equal(modes[0].id, "edit");
    assert.equal(modes[1].id, "plan");
  });
});
