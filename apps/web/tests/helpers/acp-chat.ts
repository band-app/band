// Helpers for chat integration tests against the stub ACP agent (issue #648).
//
// Every chat test boots the real server bundle with `BAND_TEST_ACP_AGENT`
// pointing at `tests/fixtures/acp-stub-agent.mjs`, so each coding agent runs
// as a scripted ACP agent subprocess over the real protocol. The stub's
// scenario, state and request log live in the test's tmp `$HOME`.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChatEvent } from "../../src/shared/chat-events";
import { seedSettings, seedState } from "./seed-state";
import { createTmpHome, type ServerHandle, startServer } from "./server";

export const STUB_AGENT_PATH = join(import.meta.dirname, "..", "fixtures", "acp-stub-agent.mjs");
export const TEST_TOKEN = "acp-chat-test-token";
export const WORKSPACE_ID = "testproject-main";

/** One scripted turn of the stub agent. See the stub's header for steps. */
export interface StubTurn {
  match?: string;
  steps: object[];
}

export interface AcpServerOptions {
  /** Reuse a home (a server restart). A fresh one is created otherwise. */
  home?: string;
  turns?: StubTurn[];
  caps?: { loadSession?: boolean; list?: boolean; resume?: boolean; image?: boolean };
  env?: Record<string, string>;
}

/** Seeds a git-less project with one workspace and a claude-code agent. */
export function seedAcpHome(prefix = "band-acp-chat-"): string {
  const home = createTmpHome(prefix);
  const repo = join(home, "repo");
  mkdirSync(repo, { recursive: true });
  seedState(home, {
    projects: [
      {
        name: "testproject",
        path: repo,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: repo }],
      },
    ],
  });
  seedSettings(home, {
    tokenSecret: TEST_TOKEN,
    codingAgents: [
      { id: "claude-code", type: "claude-code", label: "Claude Code" },
      { id: "codex", type: "codex", label: "Codex" },
    ],
    defaultCodingAgent: "claude-code",
  });
  return home;
}

/** Writes the stub's scenario file into `home`. */
export function writeStubScenario(home: string, turns: StubTurn[]): string {
  const path = join(home, "acp-scenario.json");
  writeFileSync(path, JSON.stringify({ turns }));
  return path;
}

/**
 * Boots the server with every agent pointed at the stub. When the helper
 * creates the home, `close()` also removes it. A test that passes its own
 * `home` (to restart a server on it) removes it itself.
 */
export async function startAcpServer(opts: AcpServerOptions = {}): Promise<ServerHandle> {
  const ownsHome = !opts.home;
  const home = opts.home ?? seedAcpHome();
  const env: Record<string, string> = {
    BAND_TEST_ACP_AGENT: STUB_AGENT_PATH,
    BAND_TEST_ACP_STATE: join(home, "acp-stub-state"),
    BAND_TEST_ACP_LOG: join(home, "acp-stub-log.jsonl"),
    ...opts.env,
  };
  if (opts.turns) env.BAND_TEST_ACP_SCENARIO = writeStubScenario(home, opts.turns);
  if (opts.caps) env.BAND_TEST_ACP_CAPS = JSON.stringify(opts.caps);
  const server = await startServer({ tmpHome: home, env });
  if (!ownsHome) return server;
  return {
    ...server,
    close: async () => {
      await server.close();
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

export interface StubRequest {
  method: string;
  params: Record<string, unknown>;
  cwd: string;
  env: { BAND_DISPATCH?: string; BAND_SERVER_URL?: string };
}

/** Every request and notification the stub agent received, in order. */
export function stubRequests(home: string, method?: string): StubRequest[] {
  const path = join(home, "acp-stub-log.jsonl");
  if (!existsSync(path)) return [];
  const all = readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as StubRequest);
  return method ? all.filter((r) => r.method === method) : all;
}

const authHeaders = { Cookie: `band_token=${TEST_TOKEN}` };

export async function trpc<T>(
  url: string,
  procedure: string,
  input: unknown,
  kind: "query" | "mutation" = "mutation",
): Promise<T> {
  const res =
    kind === "query"
      ? await fetch(`${url}/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(input))}`, {
          headers: authHeaders,
        })
      : await fetch(`${url}/trpc/${procedure}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders },
          body: JSON.stringify(input),
        });
  const body = (await res.json()) as { result?: { data: T }; error?: { message: string } };
  if (!res.ok || !body.result) {
    throw new Error(`${procedure} failed (${res.status}): ${body.error?.message ?? "no body"}`);
  }
  return body.result.data;
}

/** POSTs a chat message the way the browser does. */
export async function sendMessage(
  url: string,
  chatId: string,
  text: string,
  extra: { files?: { mediaType: string; url: string; filename?: string }[] } = {},
): Promise<{ ok: boolean; queued: boolean }> {
  const res = await fetch(`${url}/api/chats/${encodeURIComponent(chatId)}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({ workspaceId: WORKSPACE_ID, text, ...extra }),
  });
  if (!res.ok) throw new Error(`send failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as { ok: boolean; queued: boolean };
}

export interface CollectOptions {
  lastEventId?: number;
  revision?: number;
  until: (event: ChatEvent, all: ChatEvent[]) => boolean;
  /** Runs for every event before `until`, e.g. to answer a permission. */
  onEvent?: (event: ChatEvent) => void;
  timeoutMs?: number;
}

/**
 * Opens the chat event stream and collects events until `until` matches.
 * Rejects on timeout with the events seen so far, so a failing test says
 * what did arrive.
 */
export async function collectEvents(
  url: string,
  chatId: string,
  opts: CollectOptions,
): Promise<ChatEvent[]> {
  const ac = new AbortController();
  const params = new URLSearchParams();
  if (opts.lastEventId !== undefined) params.set("lastEventId", String(opts.lastEventId));
  if (opts.revision !== undefined) params.set("revision", String(opts.revision));
  const res = await fetch(
    `${url}/api/chats/${encodeURIComponent(chatId)}/events?${params.toString()}`,
    { headers: authHeaders, signal: ac.signal },
  );
  if (res.status !== 200 || !res.body) throw new Error(`events: HTTP ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const events: ChatEvent[] = [];
  let buf = "";
  const timeoutMs = opts.timeoutMs ?? 15_000;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort();
  }, timeoutMs);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep = buf.indexOf("\n\n");
      while (sep !== -1) {
        const frame = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        sep = buf.indexOf("\n\n");
        const data = frame
          .split("\n")
          .filter((l) => l.startsWith("data: "))
          .map((l) => l.slice(6))
          .join("\n");
        if (!data) continue;
        const event = JSON.parse(data) as ChatEvent;
        events.push(event);
        opts.onEvent?.(event);
        if (opts.until(event, events)) return events;
      }
    }
  } catch (err) {
    if (!timedOut) throw err;
  } finally {
    clearTimeout(timer);
    ac.abort();
  }
  throw new Error(
    `collectEvents timed out after ${timeoutMs}ms; got: ${events.map((e) => describeEvent(e)).join(", ")}`,
  );
}

function describeEvent(e: ChatEvent): string {
  return e.type === "update" ? `update:${e.update.sessionUpdate}` : e.type;
}

/** The agent's reply text in a list of events (message chunks joined). */
export function agentText(events: ChatEvent[]): string {
  return events
    .map((e) =>
      e.type === "update" &&
      e.update.sessionUpdate === "agent_message_chunk" &&
      e.update.content.type === "text"
        ? e.update.content.text
        : "",
    )
    .join("");
}

export const turnEnded = (e: ChatEvent) => e.type === "turn-ended";

/**
 * Opens the chat event stream and waits until its `subscription-opened`
 * frame has arrived, so anything sent afterwards is seen live. `events`
 * resolves like {@link collectEvents}. (Wrapped in an object because an
 * async function can't return a bare promise without awaiting it.)
 */
export async function openStream(
  url: string,
  chatId: string,
  opts: CollectOptions,
): Promise<{ events: Promise<ChatEvent[]> }> {
  let opened!: () => void;
  const isOpen = new Promise<void>((resolve) => {
    opened = resolve;
  });
  const events = collectEvents(url, chatId, {
    ...opts,
    onEvent: (e) => {
      if (e.type === "subscription-opened") opened();
      opts.onEvent?.(e);
    },
  });
  // A stream that fails before opening rejects here instead of hanging.
  await Promise.race([isOpen, events]);
  return { events };
}

/** The highest event id in a list (0 when there are no logged events). */
export const maxId = (events: ChatEvent[]) => Math.max(0, ...events.map((e) => e.eventId));

/**
 * Sends `text` and collects the stream until that turn ends. Pass the last
 * event id already seen as `lastEventId` when the chat has earlier turns.
 * A turn that fails before the chat has a session ends with a transient
 * (negative-id) `turn-ended`, which also counts.
 */
export async function runTurn(
  url: string,
  chatId: string,
  text: string,
  lastEventId?: number,
  extra: Parameters<typeof sendMessage>[3] = {},
): Promise<ChatEvent[]> {
  const stream = await openStream(url, chatId, {
    lastEventId,
    until: (e) => turnEnded(e) && (e.eventId > (lastEventId ?? 0) || e.eventId < 0),
  });
  await sendMessage(url, chatId, text, extra);
  return stream.events;
}
