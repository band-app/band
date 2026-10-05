#!/usr/bin/env node
/**
 * A scripted ACP agent (issue #648). Band's integration tests point every
 * coding agent at this script through `BAND_TEST_ACP_AGENT`, so a chat runs
 * end to end over the real Agent Client Protocol with no network, no login
 * and a deterministic reply.
 *
 * It speaks ACP over stdio with `@agentclientprotocol/sdk`, like the real
 * adapters. Behaviour is driven by environment variables:
 *
 *   BAND_TEST_ACP_SCENARIO  Path to a JSON scenario (see below). Without
 *                           one, every prompt gets the echo reply.
 *   BAND_TEST_ACP_STATE     Directory where sessions are saved, so a new
 *                           process can `session/list`, `session/load` and
 *                           `session/resume` them (a server restart).
 *                           Without it sessions live in memory.
 *   BAND_TEST_ACP_LIST_ALL_CWDS  When set, `session/list` ignores `cwd` and
 *                           returns every saved session, the way the Claude
 *                           adapter lists sessions from all git worktrees.
 *   BAND_TEST_ACP_LOG       File to append one JSON line per request and
 *                           notification received ({ method, params, cwd,
 *                           pid, env }), so a test can assert what Band sent.
 *   BAND_TEST_ACP_CAPS      JSON overriding advertised capabilities:
 *                           { "loadSession": false, "list": false,
 *                             "resume": false, "image": false,
 *                             "mcpHttp": false }. HTTP MCP is advertised
 *                           unless "mcpHttp" is false.
 *   BAND_TEST_ACP_OPTIONS   JSON overriding the session config options:
 *                           { "models": [{ value, name }], "modes": [...],
 *                             "extra": [{ id, name, category?, options }] }.
 *                           `extra` adds select options after model and
 *                           mode, settable through set_config_option.
 *   BAND_TEST_ACP_FAIL_START  When set, `initialize` fails with this message.
 *   BAND_TEST_ACP_START_DELAY_FILE  Path to a file. While it exists, `initialize`
 *                           waits (polling every 50 ms) and answers once the
 *                           file is removed, so a test can hold a chat's agent
 *                           start open for exactly as long as it needs.
 *   BAND_TEST_ACP_COMMANDS  JSON array of AvailableCommand replacing the
 *                           default `echo` and `review` commands, in the
 *                           order the agent advertises them.
 *   BAND_TEST_ACP_CLI_ARGS  JSON array of arguments. When set, every session
 *                           starts an idle child process whose command line
 *                           is `--session-id=<id>` followed by them, the way
 *                           the Claude adapter starts the `claude` CLI (or a
 *                           wrapper script that adds `--settings`).
 *
 * Scenario file:
 *
 *   {
 *     "turns": [
 *       { "match": "regex tested against the prompt text", "steps": [ ... ] }
 *     ]
 *   }
 *
 * The first turn whose `match` matches (or that has no `match`) runs. Steps:
 *
 *   { "say": "text", "chunks": 3 }          agent_message_chunk(s)
 *   { "think": "text" }                     agent_thought_chunk
 *   { "update": { ...SessionUpdate } }      any raw session/update
 *   { "tool": { ...ToolCall } }             tool_call
 *   { "toolUpdate": { ...ToolCallUpdate } } tool_call_update
 *   { "permission": { toolCall, options }, "after": { "<optionId>": [steps] } }
 *   { "elicitation": { message, requestedSchema }, "after": { "accept": [steps] } }
 *   { "usage": { used, size, cost? } }      usage_update
 *   { "sleep": ms }                         wait (cancellable)
 *   { "waitForCancel": true }               block until session/cancel
 *   { "stop": "end_turn" | ... , "usage": { ...PromptResponse.usage } }
 *   { "fail": "message" }                   the prompt request errors
 *   { "exit": code }                        the process exits mid-turn
 *   { "later": [steps], "afterMs": ms }     run steps `ms` after this point,
 *                                           outside any turn, the way an
 *                                           agent-started turn (a wakeup, a
 *                                           task notification) streams
 *   { "writeFile": { "path", "content" } }  write a file in this process, as
 *                                           an agent copying a file into the
 *                                           shared directory does. `{{sharedDir}}`
 *                                           is the directory the first turn's
 *                                           prompt names.
 *   { "http": { "name", "path", "method"?, "body"?, "auth"?, "headers"? } }
 *                                           call BAND_SERVER_URL the way the
 *                                           `band` CLI does (cookie
 *                                           `band_token=$BAND_TOKEN`, unless
 *                                           `auth` is "none") and append
 *                                           `{ name, status, body }` to the
 *                                           file in BAND_TEST_ACP_HTTP_LOG.
 *   { "asyncTask": { ...update } }          an AIR `async_task_*` update
 *                                           (`sessionUpdate` defaults to
 *                                           `async_task_spawned`), sent only
 *                                           when the client listed the
 *                                           `asyncTasks` capability, like
 *                                           the Claude adapter
 *
 * A turn without a `stop` step ends with `end_turn`. In any text,
 * `{{prompt}}` is replaced with the prompt's first line and `{{model}}` with
 * the session's model.
 */

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const env = process.env;
const scenario = env.BAND_TEST_ACP_SCENARIO
  ? JSON.parse(readFileSync(env.BAND_TEST_ACP_SCENARIO, "utf8"))
  : { turns: [] };
const caps = env.BAND_TEST_ACP_CAPS ? JSON.parse(env.BAND_TEST_ACP_CAPS) : {};
const stateDir = env.BAND_TEST_ACP_STATE;
/** `mcpServers` of each session's latest new, load or resume request. */
const mcpBySession = new Map();
/** Whether the client listed the AIR `asyncTasks` capability. */
let clientAsyncTasks = false;
if (stateDir) mkdirSync(stateDir, { recursive: true });

function logRequest(method, params) {
  if (!env.BAND_TEST_ACP_LOG) return;
  appendFileSync(
    env.BAND_TEST_ACP_LOG,
    `${JSON.stringify({
      method,
      params,
      cwd: process.cwd(),
      pid: process.pid,
      env: {
        BAND_DISPATCH: env.BAND_DISPATCH,
        BAND_SERVER_URL: env.BAND_SERVER_URL,
        BAND_TOKEN: env.BAND_TOKEN,
        BAND_CHAT_ID: env.BAND_CHAT_ID,
        BAND_WORKTREE_ID: env.BAND_WORKTREE_ID,
        CODEX_CONFIG: env.CODEX_CONFIG,
        PATH: env.PATH,
        LEAK: Object.values(env).some((v) => typeof v === "string" && v.includes("bws_")),
      },
    })}\n`,
  );
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

const optionOverrides = env.BAND_TEST_ACP_OPTIONS ? JSON.parse(env.BAND_TEST_ACP_OPTIONS) : {};
const MODELS = optionOverrides.models ?? [
  { value: "stub-small", name: "Stub Small" },
  { value: "stub-large", name: "Stub Large" },
];
const MODES = optionOverrides.modes ?? [
  { value: "default", name: "Default" },
  { value: "plan", name: "Plan" },
];
const EXTRA_OPTIONS = optionOverrides.extra ?? [];
const COMMANDS = env.BAND_TEST_ACP_COMMANDS
  ? JSON.parse(env.BAND_TEST_ACP_COMMANDS)
  : [
      { name: "echo", description: "Repeat the message back", input: { hint: "text to repeat" } },
      { name: "review", description: "Review the pending changes" },
    ];

/** sessionId → { cwd, title, updatedAt, model, mode, history: SessionUpdate[] } */
const sessions = new Map();
/** sessionId → AbortController of the running turn */
const turns = new Map();

function sessionFile(id) {
  return join(stateDir, `${id.replace(/[^\w-]/g, "_")}.json`);
}

function save(id) {
  const s = sessions.get(id);
  if (stateDir && s) writeFileSync(sessionFile(id), JSON.stringify(s));
}

function lookup(id) {
  if (sessions.has(id)) return sessions.get(id);
  if (stateDir && existsSync(sessionFile(id))) {
    const s = JSON.parse(readFileSync(sessionFile(id), "utf8"));
    sessions.set(id, s);
    return s;
  }
  return undefined;
}

function allSessions() {
  if (stateDir) {
    for (const f of readdirSync(stateDir)) {
      if (f.endsWith(".json")) lookup(f.slice(0, -5));
    }
  }
  return [...sessions.entries()];
}

function configOptions(s) {
  return [
    { id: "model", name: "Model", category: "model", type: "select", currentValue: s.model, options: MODELS },
    { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: s.mode, options: MODES },
    ...EXTRA_OPTIONS.map((o) => ({
      type: "select",
      ...o,
      currentValue: s.extra?.[o.id] ?? o.options[0]?.value ?? "",
    })),
  ];
}

const cliArgs = env.BAND_TEST_ACP_CLI_ARGS ? JSON.parse(env.BAND_TEST_ACP_CLI_ARGS) : null;
/** sessionIds that have a CLI child running */
const clis = new Set();

/** Starts the session's stand-in CLI process, which exits with the stub. */
function startCli(sessionId) {
  if (!cliArgs || clis.has(sessionId)) return;
  clis.add(sessionId);
  const idle = "const p = process.ppid; setInterval(() => { if (process.ppid !== p) process.exit(); }, 500);";
  spawn(process.execPath, ["-e", idle, "--", `--session-id=${sessionId}`, ...cliArgs], {
    stdio: "ignore",
  }).unref();
}

function newSessionId() {
  return `stub-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// Turns
// ---------------------------------------------------------------------------

function fill(value, vars) {
  if (typeof value === "string") {
    return value
      .replaceAll("{{prompt}}", vars.prompt)
      .replaceAll("{{model}}", vars.model)
      .replaceAll("{{sharedDir}}", vars.sharedDir ?? "");
  }
  if (Array.isArray(value)) return value.map((v) => fill(v, vars));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, vars)]));
  }
  return value;
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    });
  });
}

class Cancelled extends Error {}

async function runSteps(cx, sessionId, steps, signal, record) {
  const notify = async (update) => {
    record(update);
    await cx.notify(acp.methods.client.session.update, { sessionId, update });
  };
  for (const step of steps) {
    if (signal.aborted) throw new Cancelled();
    if (step.say !== undefined) {
      const n = Math.max(1, step.chunks ?? 1);
      const size = Math.ceil(step.say.length / n);
      const messageId = step.messageId ?? `msg-${Math.random().toString(36).slice(2, 8)}`;
      for (let i = 0; i < step.say.length; i += size) {
        await notify({
          sessionUpdate: "agent_message_chunk",
          messageId,
          content: { type: "text", text: step.say.slice(i, i + size) },
        });
        if (step.delayMs) await sleep(step.delayMs, signal);
      }
    } else if (step.think !== undefined) {
      await notify({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: step.think } });
    } else if (step.update) {
      await notify(step.update);
    } else if (step.asyncTask) {
      if (clientAsyncTasks) {
        await notify({ sessionUpdate: "async_task_spawned", ...step.asyncTask });
      }
    } else if (step.later) {
      const later = step.later;
      const t = setTimeout(() => {
        runSteps(cx, sessionId, later, new AbortController().signal, record)
          .catch((err) => process.stderr.write(`later steps failed: ${err}\n`))
          .finally(() => save(sessionId));
      }, step.afterMs ?? 0);
      t.unref?.();
    } else if (step.writeFile) {
      writeFileSync(step.writeFile.path, step.writeFile.content);
    } else if (step.http) {
      const { name, path, method = "GET", body, auth, headers: extra } = step.http;
      const headers = { "content-type": "application/json", ...extra };
      if (auth !== "none" && env.BAND_TOKEN) headers.cookie = `band_token=${env.BAND_TOKEN}`;
      let line;
      try {
        const res = await fetch(`${env.BAND_SERVER_URL}${path}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        line = { name, status: res.status, body: (await res.text()).slice(0, 20000) };
      } catch (err) {
        line = { name, status: 0, body: String(err) };
      }
      appendFileSync(env.BAND_TEST_ACP_HTTP_LOG, `${JSON.stringify(line)}\n`);
    } else if (step.mcpCall) {
      // Calls a tool through the `mcpServers` entry Band passed for the
      // session, with exactly the URL and headers it gave. One line goes to
      // the HTTP log: { name, status, body }.
      const { name, server, tool, args = {} } = step.mcpCall;
      const entry = (mcpBySession.get(sessionId) ?? []).find((e) => e.name === server);
      let line;
      if (!entry) {
        line = { name, status: -1, body: "no such mcp server in the session" };
      } else {
        const headers = {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...Object.fromEntries((entry.headers ?? []).map((h) => [h.name, h.value])),
        };
        try {
          const res = await fetch(entry.url, {
            method: "POST",
            headers,
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
          });
          line = { name, status: res.status, body: (await res.text()).slice(0, 20000) };
        } catch (err) {
          line = { name, status: 0, body: String(err) };
        }
      }
      appendFileSync(env.BAND_TEST_ACP_HTTP_LOG, `${JSON.stringify(line)}\n`);
    } else if (step.tool) {
      await notify({ sessionUpdate: "tool_call", ...step.tool });
    } else if (step.toolUpdate) {
      await notify({ sessionUpdate: "tool_call_update", ...step.toolUpdate });
    } else if (step.usage) {
      await notify({ sessionUpdate: "usage_update", ...step.usage });
    } else if (step.permission) {
      const res = await cx.request(acp.methods.client.session.requestPermission, {
        sessionId,
        ...step.permission,
      });
      if (res.outcome.outcome === "cancelled") throw new Cancelled();
      const next = step.after?.[res.outcome.optionId] ?? [];
      const out = await runSteps(cx, sessionId, next, signal, record);
      if (out) return out;
    } else if (step.elicitation) {
      const res = await cx.request(acp.methods.client.elicitation.create, {
        mode: "form",
        sessionId,
        ...step.elicitation,
      });
      if (res.action === "cancel") throw new Cancelled();
      const answer = JSON.stringify(res.content ?? {});
      const next = step.after?.[res.action] ?? [{ say: `Answer: ${answer}` }];
      const out = await runSteps(cx, sessionId, fill(next, { prompt: answer, model: "" }), signal, record);
      if (out) return out;
    } else if (step.sleep) {
      await sleep(step.sleep, signal);
    } else if (step.waitForCancel) {
      await new Promise((resolve) => signal.addEventListener("abort", resolve));
      throw new Cancelled();
    } else if (step.fail) {
      throw new acp.RequestError(-32603, step.fail);
    } else if (step.exit !== undefined) {
      process.exit(step.exit);
    } else if (step.stop) {
      return { stopReason: step.stop, ...(step.usage ? { usage: step.usage } : {}) };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

acp
  .agent({ name: "band-acp-stub" })
  .onRequest("initialize", async (ctx) => {
    logRequest("initialize", ctx.params);
    const air = ctx.params.clientCapabilities?._meta?.jetbrains?.air;
    clientAsyncTasks = air?.version >= 1 && (air.capabilities ?? []).includes("asyncTasks");
    while (env.BAND_TEST_ACP_START_DELAY_FILE && existsSync(env.BAND_TEST_ACP_START_DELAY_FILE)) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (env.BAND_TEST_ACP_FAIL_START) throw new acp.RequestError(-32000, env.BAND_TEST_ACP_FAIL_START);
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: caps.loadSession !== false,
        promptCapabilities: { image: caps.image !== false, embeddedContext: true },
        mcpCapabilities: { http: caps.mcpHttp !== false, sse: false },
        sessionCapabilities: {
          ...(caps.list === false ? {} : { list: {} }),
          ...(caps.resume === false ? {} : { resume: {} }),
          additionalDirectories: {},
        },
      },
      agentInfo: { name: "band-acp-stub", title: "Stub Agent", version: "1.0.0" },
      authMethods: [],
    };
  })
  .onRequest("session/new", async (ctx) => {
    logRequest("session/new", ctx.params);
    const sessionId = newSessionId();
    mcpBySession.set(sessionId, ctx.params.mcpServers ?? []);
    const s = { cwd: ctx.params.cwd, title: null, updatedAt: new Date().toISOString(), model: MODELS[0].value, mode: MODES[0].value, history: [] };
    sessions.set(sessionId, s);
    save(sessionId);
    startCli(sessionId);
    // Sent before the reply on purpose: a client must accept updates for a
    // session whose id it hasn't been told yet (the real adapters do this).
    await ctx.client.notify(acp.methods.client.session.update, {
      sessionId,
      update: { sessionUpdate: "available_commands_update", availableCommands: COMMANDS },
    });
    return { sessionId, configOptions: configOptions(s) };
  })
  .onRequest("session/load", async (ctx) => {
    logRequest("session/load", ctx.params);
    mcpBySession.set(ctx.params.sessionId, ctx.params.mcpServers ?? []);
    const s = lookup(ctx.params.sessionId);
    if (!s) throw new acp.RequestError(-32002, `Resource not found: ${ctx.params.sessionId}`);
    startCli(ctx.params.sessionId);
    for (const update of s.history) {
      await ctx.client.notify(acp.methods.client.session.update, { sessionId: ctx.params.sessionId, update });
    }
    return { configOptions: configOptions(s) };
  })
  .onRequest("session/resume", (ctx) => {
    logRequest("session/resume", ctx.params);
    mcpBySession.set(ctx.params.sessionId, ctx.params.mcpServers ?? []);
    const s = lookup(ctx.params.sessionId);
    if (!s) throw new acp.RequestError(-32002, `Resource not found: ${ctx.params.sessionId}`);
    startCli(ctx.params.sessionId);
    return { configOptions: configOptions(s) };
  })
  .onRequest("session/list", (ctx) => {
    logRequest("session/list", ctx.params);
    return {
      sessions: allSessions()
        .filter(([, s]) => env.BAND_TEST_ACP_LIST_ALL_CWDS || !ctx.params.cwd || s.cwd === ctx.params.cwd)
        .map(([sessionId, s]) => ({ sessionId, cwd: s.cwd, title: s.title, updatedAt: s.updatedAt })),
    };
  })
  .onRequest("session/set_config_option", (ctx) => {
    logRequest("session/set_config_option", ctx.params);
    const s = lookup(ctx.params.sessionId);
    const { configId, value } = ctx.params;
    const extra = EXTRA_OPTIONS.find((o) => o.id === configId);
    const choices = configId === "model" ? MODELS : configId === "mode" ? MODES : extra?.options;
    if (!s || !choices?.some((c) => c.value === value)) {
      throw acp.RequestError.invalidParams({ configId, value });
    }
    if (extra) s.extra = { ...s.extra, [configId]: value };
    else s[configId] = value;
    save(ctx.params.sessionId);
    return { configOptions: configOptions(s) };
  })
  .onRequest("session/prompt", async (ctx) => {
    logRequest("session/prompt", ctx.params);
    const { sessionId, prompt } = ctx.params;
    const s = lookup(sessionId);
    if (!s) throw new acp.RequestError(-32002, `Resource not found: ${sessionId}`);
    const controller = new AbortController();
    turns.set(sessionId, controller);
    const text = prompt.find((b) => b.type === "text")?.text ?? "";
    const first = text.split("\n")[0];
    s.title ??= first.slice(0, 60);
    s.updatedAt = new Date().toISOString();
    s.history.push({ sessionUpdate: "user_message_chunk", content: { type: "text", text } });
    const record = (update) => {
      if (update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
        s.history.push(update);
      }
    };
    const turn = scenario.turns.find((t) => !t.match || new RegExp(t.match).test(text));
    const allText = prompt.map((b) => (b.type === "text" ? b.text : "")).join("\n");
    const steps = fill(turn?.steps ?? [{ say: 'Heard "{{prompt}}" on {{model}}.' }], {
      prompt: first,
      model: s.model,
      sharedDir: /write or copy it to (.+?)\/ and/.exec(allText)?.[1],
    });
    try {
      const out = await runSteps(ctx.client, sessionId, steps, controller.signal, record);
      return out ?? { stopReason: "end_turn" };
    } catch (err) {
      if (err instanceof Cancelled || controller.signal.aborted) return { stopReason: "cancelled" };
      throw err;
    } finally {
      turns.delete(sessionId);
      save(sessionId);
    }
  })
  .onNotification("session/cancel", (ctx) => {
    logRequest("session/cancel", ctx.params);
    turns.get(ctx.params.sessionId)?.abort();
  })
  .connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
