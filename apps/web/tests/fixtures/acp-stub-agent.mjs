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
 *   BAND_TEST_ACP_LOG       File to append one JSON line per request and
 *                           notification received ({ method, params, cwd,
 *                           env }), so a test can assert what Band sent.
 *   BAND_TEST_ACP_CAPS      JSON overriding advertised capabilities:
 *                           { "loadSession": false, "list": false,
 *                             "resume": false, "image": false }.
 *   BAND_TEST_ACP_OPTIONS   JSON overriding the session config options:
 *                           { "models": [{ value, name }], "modes": [...],
 *                             "extra": [{ id, name, options }] }. `extra`
 *                           adds select options after model and mode.
 *   BAND_TEST_ACP_FAIL_START  When set, `initialize` fails with this message.
 *   BAND_TEST_ACP_COMMANDS  JSON array of AvailableCommand replacing the
 *                           default `echo` and `review` commands, in the
 *                           order the agent advertises them.
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
 *
 * A turn without a `stop` step ends with `end_turn`. In any text,
 * `{{prompt}}` is replaced with the prompt's first line and `{{model}}` with
 * the session's model.
 */

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
if (stateDir) mkdirSync(stateDir, { recursive: true });

function logRequest(method, params) {
  if (!env.BAND_TEST_ACP_LOG) return;
  appendFileSync(
    env.BAND_TEST_ACP_LOG,
    `${JSON.stringify({
      method,
      params,
      cwd: process.cwd(),
      env: { BAND_DISPATCH: env.BAND_DISPATCH, BAND_SERVER_URL: env.BAND_SERVER_URL },
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
    ...EXTRA_OPTIONS.map((o) => ({ type: "select", currentValue: o.options[0].value, ...o })),
  ];
}

function newSessionId() {
  return `stub-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// Turns
// ---------------------------------------------------------------------------

function fill(value, vars) {
  if (typeof value === "string") {
    return value.replaceAll("{{prompt}}", vars.prompt).replaceAll("{{model}}", vars.model);
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
  .onRequest("initialize", (ctx) => {
    logRequest("initialize", ctx.params);
    if (env.BAND_TEST_ACP_FAIL_START) throw new acp.RequestError(-32000, env.BAND_TEST_ACP_FAIL_START);
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: caps.loadSession !== false,
        promptCapabilities: { image: caps.image !== false, embeddedContext: true },
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
    const s = { cwd: ctx.params.cwd, title: null, updatedAt: new Date().toISOString(), model: MODELS[0].value, mode: MODES[0].value, history: [] };
    sessions.set(sessionId, s);
    save(sessionId);
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
    const s = lookup(ctx.params.sessionId);
    if (!s) throw new acp.RequestError(-32002, `Resource not found: ${ctx.params.sessionId}`);
    for (const update of s.history) {
      await ctx.client.notify(acp.methods.client.session.update, { sessionId: ctx.params.sessionId, update });
    }
    return { configOptions: configOptions(s) };
  })
  .onRequest("session/resume", (ctx) => {
    logRequest("session/resume", ctx.params);
    const s = lookup(ctx.params.sessionId);
    if (!s) throw new acp.RequestError(-32002, `Resource not found: ${ctx.params.sessionId}`);
    return { configOptions: configOptions(s) };
  })
  .onRequest("session/list", (ctx) => {
    logRequest("session/list", ctx.params);
    return {
      sessions: allSessions()
        .filter(([, s]) => !ctx.params.cwd || s.cwd === ctx.params.cwd)
        .map(([sessionId, s]) => ({ sessionId, cwd: s.cwd, title: s.title, updatedAt: s.updatedAt })),
    };
  })
  .onRequest("session/set_config_option", (ctx) => {
    logRequest("session/set_config_option", ctx.params);
    const s = lookup(ctx.params.sessionId);
    const choices = ctx.params.configId === "model" ? MODELS : ctx.params.configId === "mode" ? MODES : null;
    if (!s || !choices?.some((c) => c.value === ctx.params.value)) {
      throw acp.RequestError.invalidParams({ configId: ctx.params.configId, value: ctx.params.value });
    }
    s[ctx.params.configId] = ctx.params.value;
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
    const steps = fill(turn?.steps ?? [{ say: 'Heard "{{prompt}}" on {{model}}.' }], {
      prompt: first,
      model: s.model,
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
