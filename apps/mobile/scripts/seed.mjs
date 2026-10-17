/**
 * Fills the throwaway hub from `hub.mjs` with what the flows look at: two repos (alpha, beta)
 * and three worktrees (alpha main, alpha feat/mobile, beta main) for the worktree-list flows,
 * and a third repo, gamma, whose worktrees hold the chats the transcript flows open. Each
 * worktree has one chat. `startTurn` then makes the scripted ACP agent work or ask for
 * permission in a chat, so a flow sees the status stream change; `stopTurn` ends a turn that is
 * still running.
 *
 * The agent's behaviour comes from the scenario file `hub.mjs` writes (`SCENARIO` below): a
 * prompt starting with "work" runs until stopped, one starting with "ask" waits for a permission
 * answer, "showcase" answers with every kind of item the chat renders, "long" produces a turn
 * of over 1,500 events, "stream" streams numbered lines for 45 s, and anything else answers at
 * once.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { seedExplorer } from "./seed-explorer.mjs";
import { CHECKS_BRANCHES, CHECKS_REPO } from "./checks.mjs";

/** The showcase turn's reply: every markdown construct the chat renders natively. */
export const SHOWCASE_MARKDOWN = [
  "## Plan for the parser fix",
  "",
  "The bug is in `src/parser.ts`, around src/parser.ts:12. Steps:",
  "",
  "1. Read the **config**",
  "2. Patch the _parser_",
  "3. Run the tests",
  "",
  "| File | Change | Why it matters for every caller that reads a leading zero as octal |",
  "| --- | --- | --- |",
  "| `src/parser.ts` | parse as base 10 | Callers get the same number on every runtime |",
  "| `README.md` | document it | Readers learn the radix is always ten |",
  "",
  "```ts",
  "export function parse(input: string): number {",
  '  // Always base 10, so "08" parses',
  "  return Number.parseInt(input, 10);",
  "}",
  "```",
  "",
  "```mermaid",
  "graph TD",
  "  Read --> Patch --> Test",
  "```",
  "",
  "More in [the docs](https://example.com/docs).",
].join("\n");

const PARSER_OLD = "export function parse(input) {\n  return parseInt(input);\n}\n";
const PARSER_NEW =
  "export function parse(input: string): number {\n  return Number.parseInt(input, 10);\n}\n";

/** The lines the "stream" turn sends, one every 500 ms. */
export const STREAM_LINES = Array.from(
  { length: 90 },
  (_, i) => `Line ${String(i + 1).padStart(2, "0")} of the stream.`,
);

function showcaseSteps() {
  return [
    { think: "The parser drops the radix. Read it, patch it, run the tests." },
    { say: SHOWCASE_MARKDOWN, chunks: 6, delayMs: 50 },
    {
      tool: {
        toolCallId: "read-1",
        title: "Read src/parser.ts",
        kind: "read",
        status: "completed",
        locations: [{ path: "src/parser.ts" }],
      },
    },
    {
      tool: {
        toolCallId: "edit-1",
        title: "Edit src/parser.ts",
        kind: "edit",
        status: "pending",
        locations: [{ path: "src/parser.ts" }],
      },
    },
    {
      toolUpdate: {
        toolCallId: "edit-1",
        status: "completed",
        content: [{ type: "diff", path: "src/parser.ts", oldText: PARSER_OLD, newText: PARSER_NEW }],
      },
    },
    {
      tool: {
        toolCallId: "run-1",
        title: "pnpm test",
        kind: "execute",
        status: "pending",
        rawInput: { command: "pnpm test", description: "Run the tests" },
      },
    },
    {
      toolUpdate: {
        toolCallId: "run-1",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "```\n✓ parser (3 tests)\n```" } }],
      },
    },
    {
      update: {
        sessionUpdate: "plan",
        entries: [
          { content: "Read the parser", priority: "high", status: "completed" },
          { content: "Patch the radix", priority: "high", status: "completed" },
          { content: "Update the README", priority: "medium", status: "in_progress" },
        ],
      },
    },
    { say: "Done. The tests pass; the README is next." },
  ];
}

/**
 * Over 1,500 events in one turn: text, tool calls with updates and thoughts. The hub merges a
 * run of text chunks into one event when it replays, so each step's text is one event.
 */
function longSteps() {
  const steps = [];
  for (let i = 1; i <= 400; i++) {
    const id = `long-${i}`;
    const path = `src/module-${i}.ts`;
    steps.push(
      { say: `Step ${i}: checking \`${path}\` for the old radix call.` },
      { tool: { toolCallId: id, title: `Read ${path}`, kind: "read", status: "pending", locations: [{ path }] } },
      { toolUpdate: { toolCallId: id, status: "completed" } },
      { think: `Module ${i} is fine.` },
    );
  }
  steps.push({ say: "All 400 modules checked." });
  return steps;
}

/** One message streamed line by line, as an agent writing a long answer does. */
function streamSteps() {
  const messageId = "stream-reply";
  return [
    ...STREAM_LINES.flatMap((line) => [{ say: `${line}\n\n`, messageId }, { sleep: 500 }]),
    { say: "END of the stream.", messageId },
  ];
}
/** What the "permit" turn asks: the three kinds of option the web shows. */
const PERMIT_OPTIONS = [
  { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
  { optionId: "allow_always", name: "Always allow", kind: "allow_always" },
  { optionId: "reject_once", name: "Reject", kind: "reject_once" },
];

/** A form with each field type the web supports: choice with a free-text box, multi, boolean, integer, text. */
const FORM_SCHEMA = {
  type: "object",
  properties: {
    color: {
      type: "string",
      description: "Which color?",
      oneOf: [
        { const: "red", title: "Red" },
        { const: "blue", title: "Blue", description: "The cool one" },
      ],
    },
    color_other: {
      type: "string",
      _meta: { _askUserQuestionCustomAnswer: { questionId: "color" } },
    },
    tags: {
      type: "array",
      description: "Which tags?",
      items: { anyOf: [{ const: "ui", title: "UI" }, { const: "api", title: "API" }] },
    },
    agree: { type: "boolean", title: "Run the tests too", description: "Run the tests?" },
    count: { type: "integer", description: "How many retries (1 to 5)?", minimum: 1, maximum: 5 },
    name: { type: "string", description: "Name the change" },
  },
  required: ["count"],
};

/** The plan the "plan" turn walks through, 20 s apart, so a flow can watch the widget change. */
function planSteps() {
  const entries = (done) =>
    ["Read the parser", "Patch the radix", "Run the tests"].map((content, i) => ({
      content,
      priority: "high",
      status: i < done ? "completed" : i === done ? "in_progress" : "pending",
    }));
  return [
    { update: { sessionUpdate: "plan", entries: entries(0) } },
    { sleep: 20000 },
    { update: { sessionUpdate: "plan", entries: entries(1) } },
    { sleep: 20000 },
    { update: { sessionUpdate: "plan", entries: entries(2) } },
    { sleep: 20000 },
    { update: { sessionUpdate: "plan", entries: entries(3) } },
    { say: "Plan finished." },
  ];
}

export const SCENARIO = {
  turns: [
    { match: "^work", steps: [{ say: "Working on it." }, { waitForCancel: true }] },
    {
      match: "^ask",
      steps: [
        {
          permission: {
            toolCall: { toolCallId: "tool-1", title: "Run the test suite", kind: "execute", status: "pending" },
            options: [
              { optionId: "allow", name: "Allow", kind: "allow_once" },
              { optionId: "deny", name: "Deny", kind: "reject_once" },
            ],
          },
          after: { allow: [{ say: "Done." }], deny: [{ say: "Skipped." }] },
        },
      ],
    },
    {
      match: "^permit",
      steps: [
        {
          permission: {
            toolCall: {
              toolCallId: "tool-2",
              title: "Run the test suite",
              kind: "execute",
              status: "pending",
              rawInput: { command: "pnpm test", description: "Run the tests" },
            },
            options: PERMIT_OPTIONS,
          },
          after: {
            allow_once: [{ say: "Permission granted. Tests ran." }],
            allow_always: [{ say: "Always allowed. Tests ran." }],
            reject_once: [{ say: "Stopped by user." }],
          },
        },
      ],
    },
    {
      match: "^form",
      steps: [
        { elicitation: { message: "A few questions about the change.", requestedSchema: FORM_SCHEMA } },
      ],
    },
    { match: "^plan", steps: planSteps() },
    // A turn of about 90 s that ends by itself, so a flow can queue messages behind it.
    { match: "^slow", steps: [{ say: "Thinking it over." }, { sleep: 90000 }, { say: "Slow turn finished." }] },
    { match: "^showcase", steps: showcaseSteps() },
    { match: "^long", steps: longSteps() },
    { match: "^stream", steps: streamSteps() },
    { steps: [{ say: "Done." }] },
  ],
};

export const SESSION_ONE_PROMPT = "first session: alpha";
export const SESSION_TWO_PROMPT = "second session: beta";

/** The worktree ids the flows use, as the hub names them. */
export const WORKTREES = {
  ALPHA_MAIN: "alpha-main",
  ALPHA_FEATURE: "alpha-feat-mobile",
  BETA_MAIN: "beta-main",
  /** The showcase chat (S1): text, a tool call with a file edit, a plan, a code block, an image. */
  GAMMA_MAIN: "gamma-main",
  /** A chat of over 1,500 events (S3). */
  GAMMA_LONG: "gamma-long",
  /** Empty chats a flow streams a turn into (S2, S4). */
  GAMMA_STREAM: "gamma-stream",
  GAMMA_RESUME: "gamma-resume",
  /** Empty chats for the composer flows: send, queue, attach, suggestions, model and keyboard. */
  GAMMA_COMPOSE: "gamma-compose",
  GAMMA_QUEUE: "gamma-queue",
  GAMMA_ATTACH: "gamma-attach",
  GAMMA_SUGGEST: "gamma-suggest",
  GAMMA_SESSION: "gamma-session",
  /** A chat that has had two agent sessions, for the Sessions sheet (m9). */
  GAMMA_SESSIONS: "gamma-sessions",
  /** An empty chat that never ran a session (m10). */
  GAMMA_NO_SESSIONS: "gamma-no-sessions",
  GAMMA_KEYBOARD: "gamma-keyboard",
  /** Empty chats for the interaction flows: permission allow and reject, the form, the plan, the listening pill. */
  GAMMA_PERMIT_ALLOW: "gamma-permit-allow",
  GAMMA_PERMIT_REJECT: "gamma-permit-reject",
  GAMMA_FORM: "gamma-form",
  GAMMA_PLAN: "gamma-plan",
  GAMMA_LISTEN: "gamma-listen",
  /** More turns than the hub sends on open, so the oldest load on scroll-back (c6). */
  GAMMA_HISTORY: "gamma-history",
  /** The files, search and changes flows: a repo with a big folder and a dirty working tree (`seed-explorer.mjs`). */
  DELTA_MAIN: "delta-main",
  /** Three chats open as tabs on the "web", with a terminal and a browser tab between them (t1-t4). */
  GAMMA_TABS: "gamma-tabs",
  /** Terminal flows: open and type (S2, S4), new and close (S3), background (S5), scroll and copy (S6). */
  GAMMA_TERM: "gamma-term",
  GAMMA_TERM_NEW: "gamma-term-new",
  GAMMA_TERM_BG: "gamma-term-bg",
  GAMMA_TERM_SCROLL: "gamma-term-scroll",
  /** acme/widgets, a repo with a GitHub origin: PR checks to read, re-run and fix (k1-k5). */
  WIDGETS_CHECKS: "widgets-feat-checks",
  WIDGETS_RERUN: "widgets-feat-rerun",
  WIDGETS_NO_CHECKS: "widgets-feat-nochecks",
  WIDGETS_NO_PR: "widgets-feat-nopr",
};

/** The chats of `gamma-tabs`, in the shared tab order; the second is the active tab. */
export const TAB_CHATS = [
  { id: "chat_tabs_1", name: "Parser" },
  { id: "chat_tabs_2", name: "Docs" },
  { id: "chat_tabs_3", name: "Tests" },
];
/** The tabs of other kinds in `gamma-tabs`' shared list, which the phone must keep. */
export const TAB_OTHERS = [
  { id: "3f0c6a52-6a1e-4b5e-9d2a-1c1f0e7a9b10", kind: "term" },
  { id: "browser_tabs_1", kind: "browser" },
];
/** Turns in the first tab's chat, more than one screen, so a flow can scroll it (t4). */
const TAB_TURNS = 12;

/** Turns in the history chat; the hub's first page holds `HISTORY_PAGE_SIZE` (20). */
export const HISTORY_TURNS = 24;

async function trpcResult(procedure, res) {
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.result) {
    throw new Error(`${procedure} failed (HTTP ${res.status}): ${body?.error?.message ?? "no body"}`);
  }
  return body.result.data;
}

async function trpcQuery(state, procedure, input) {
  const query = encodeURIComponent(JSON.stringify(input));
  const res = await fetch(`${state.url}/trpc/${procedure}?input=${query}`, {
    headers: { Authorization: `Bearer ${state.adminToken}`, Connection: "close" },
  });
  return trpcResult(procedure, res);
}

async function trpc(state, procedure, input) {
  const res = await fetch(`${state.url}/trpc/${procedure}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${state.adminToken}`, "Content-Type": "application/json", Connection: "close" },
    body: JSON.stringify(input),
  });
  return trpcResult(procedure, res);
}

function gitRepo(dir) {
  mkdirSync(dir, { recursive: true });
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: dir,
      stdio: "ignore",
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    });
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "# seed\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
}

/**
 * `widgets`, a repo whose `origin` is github.com/acme/widgets, so the hub's GitHub plugin asks
 * the fake `gh` (`checks.mjs`) for each branch's pull request and checks. The worktrees are made
 * with git, because `worktrees.create` would fetch from the fake origin.
 */
async function seedChecks(state) {
  const dir = join(state.home, "repos", CHECKS_REPO);
  gitRepo(dir);
  execFileSync("git", ["remote", "add", "origin", `https://github.com/acme/${CHECKS_REPO}.git`], {
    cwd: dir,
  });
  for (const branch of Object.values(CHECKS_BRANCHES)) {
    execFileSync("git", ["worktree", "add", "-q", "-b", branch, join(state.home, "wt", branch.replace("/", "-"))], {
      cwd: dir,
    });
  }
  await trpc(state, "repos.add", { path: dir });
}

/** Adds the repos and worktrees. Returns the chat id of each worktree. */
export async function seedHub(state) {
  const root = join(state.home, "repos");
  for (const name of ["alpha", "beta", "gamma"]) {
    gitRepo(join(root, name));
    await trpc(state, "repos.add", { path: join(root, name) });
  }
  await seedChecks(state);
  await trpc(state, "worktrees.create", { repo: "alpha", branch: "feat/mobile" });
  // The home screen's Pinned section (w1).
  await trpc(state, "worktrees.setPinned", { repo: "alpha", name: "feat/mobile", pinned: true });
  for (const branch of ["long", "stream", "resume", "history", "compose", "queue", "attach", "suggest", "session", "keyboard", "tabs", "permit-allow", "permit-reject", "form", "plan", "listen", "term", "term-new", "term-bg", "term-scroll"]) {
    await trpc(state, "worktrees.create", { repo: "gamma", branch });
  }
  // gamma-tabs: the chat `worktrees.create` opened makes way for three named ones.
  for (const chat of (await trpcQuery(state, "chats.list", { worktreeId: WORKTREES.GAMMA_TABS })).chats) {
    await trpc(state, "chats.remove", { chatId: chat.id });
  }
  for (const chat of TAB_CHATS) {
    await trpc(state, "chats.create", { worktreeId: WORKTREES.GAMMA_TABS, ...chat });
  }
  const chats = {};
  for (const id of Object.values(WORKTREES)) {
    // `worktrees.create` opens a chat already; the app shows a worktree's first chat.
    const { chats: existing } = await trpcQuery(state, "chats.list", { worktreeId: id });
    chats[id] =
      existing[0]?.id ??
      (await trpc(state, "chats.create", { worktreeId: id, name: "seed" })).chat.id;
  }
  await seedTurn(state, chats, WORKTREES.GAMMA_MAIN, "showcase: fix the parser radix", [
    pngFile("screenshot.png"),
  ]);
  await seedTurn(state, chats, WORKTREES.GAMMA_LONG, "long: check every module");
  // Two sessions: a turn, then "new session" (no active session), then a turn that starts another.
  await seedTurn(state, chats, WORKTREES.GAMMA_SESSIONS, SESSION_ONE_PROMPT);
  await trpc(state, "chats.setActiveSession", {
    worktreeId: WORKTREES.GAMMA_SESSIONS,
    chatId: chats[WORKTREES.GAMMA_SESSIONS],
  });
  await seedTurn(state, chats, WORKTREES.GAMMA_SESSIONS, SESSION_TWO_PROMPT);
  for (let i = 1; i <= HISTORY_TURNS; i++) {
    const n = String(i).padStart(2, "0");
    await seedTurn(state, chats, WORKTREES.GAMMA_HISTORY, `turn ${n}: say done`);
  }
  for (let i = 1; i <= TAB_TURNS; i++) {
    await seedTurn(state, chats, WORKTREES.GAMMA_TABS, `parser turn ${String(i).padStart(2, "0")}`);
  }
  await seedTabs(state);
  await seedExplorer(state, root, { trpc, png: pngBytes() });
  return chats;
}

/** The shared tab list of `gamma-tabs`, written as the web writes it (`clientState.set`). */
async function seedTabs(state) {
  const [first, second, third] = TAB_CHATS.map((c) => ({ id: c.id, kind: "chat" }));
  await trpc(state, "clientState.set", {
    key: `band:center-tabs:${WORKTREES.GAMMA_TABS}`,
    scope: "all",
    baseVersion: 0,
    clientId: "seed-web",
    value: { tabs: [first, TAB_OTHERS[0], second, TAB_OTHERS[1], third], active: second.id },
  });
}

/** The chat `webEditTabs` starts, as the web would. */
const WEB_CHAT = { id: "chat_tabs_web", name: "From web" };

/**
 * Changes a worktree's shared tab list the way the web would while the phone shows it: starts
 * `WEB_CHAT`, then moves the last chat tab to the front and adds the new chat at the end. The
 * active tab and the tabs of other kinds stay as they are.
 */
export async function webEditTabs(state, worktreeId) {
  await trpc(state, "chats.create", { worktreeId, ...WEB_CHAT });
  const key = `band:center-tabs:${worktreeId}`;
  const { entries } = await trpcQuery(state, "clientState.list", { worktreeId, deviceType: "desktop" });
  let entry = entries.find((e) => e.key === key);
  // A write the phone made in between makes the version stale: rebase on it, as the web does.
  for (let attempt = 0; attempt < 3; attempt++) {
    const tabs = (entry?.value?.tabs ?? []).filter((t) => t.id !== WEB_CHAT.id);
    const lastChat = tabs.findLast((t) => t.kind === "chat");
    const rest = tabs.filter((t) => t !== lastChat);
    const result = await trpc(state, "clientState.set", {
      key,
      scope: "all",
      baseVersion: entry?.version ?? 0,
      clientId: "seed-web",
      value: {
        tabs: [...(lastChat ? [lastChat] : []), ...rest, { id: WEB_CHAT.id, kind: "chat" }],
        active: entry?.value?.active ?? null,
      },
    });
    if (result.ok) return;
    entry = result.entry;
  }
  throw new Error(`clientState.set was refused three times: version ${entry?.version}`);
}

/** The shared tab list of a worktree as the hub holds it, and the chats the hub has there. */
export async function sharedTabs(state, worktreeId) {
  const { entries } = await trpcQuery(state, "clientState.list", { worktreeId, deviceType: "desktop" });
  const entry = entries.find((e) => e.key === `band:center-tabs:${worktreeId}`);
  const { chats } = await trpcQuery(state, "chats.list", { worktreeId });
  return { tabs: entry?.value ?? null, chats: chats.map((c) => ({ id: c.id, name: c.name })) };
}

/** A 96x64 PNG with a stripe, as a `data:` URL, for a prompt's attached image. */
function pngFile(filename) {
  return { mediaType: "image/png", filename, url: `data:image/png;base64,${pngBytes().toString("base64")}` };
}

/** The bytes of a 96x64 PNG with a stripe. */
export function pngBytes() {
  const width = 96;
  const height = 64;
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) {
      const stripe = y > 24 && y < 40;
      row.set(stripe ? [96, 165, 250] : [38, 38, 38], 1 + x * 3);
    }
    rows.push(row);
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return png;
}

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

/** Runs a turn to its end and clears the worktree's "needs attention", so the list flows see it idle. */
async function seedTurn(state, chats, worktreeId, text, files) {
  await startTurn(state, chats, worktreeId, text, files);
  const deadline = Date.now() + 60_000;
  for (;;) {
    await new Promise((r) => setTimeout(r, 250));
    const { running } = await trpcQuery(state, "tasks.isRunning", {
      worktreeId,
      chatId: chats[worktreeId],
    });
    if (!running) break;
    if (Date.now() > deadline) throw new Error(`The seeded turn in ${worktreeId} did not end`);
  }
  await trpc(state, "statuses.clearNeedsAttention", { worktreeId });
}

/** Sends `text` to the worktree's chat, so the agent starts a turn the scenario scripts. */
export async function startTurn(state, chats, worktreeId, text, files) {
  const chatId = chats[worktreeId];
  if (!chatId) throw new Error(`No chat for ${worktreeId}`);
  const res = await fetch(`${state.url}/api/chats/${encodeURIComponent(chatId)}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${state.adminToken}`, "Content-Type": "application/json", Connection: "close" },
    body: JSON.stringify({ worktreeId, text, ...(files && { files }) }),
  });
  if (!res.ok) throw new Error(`send failed: HTTP ${res.status} ${await res.text()}`);
}

/** The ACP requests the stub agent logged (`BAND_TEST_ACP_LOG`), one parsed object per line. */
export function acpRequests(state) {
  const file = join(state.home, "acp-requests.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** The prompts the agent received: `{ text, types }` for each `session/prompt`. */
export function receivedPrompts(state) {
  return acpRequests(state)
    .filter((r) => r.method === "session/prompt")
    .map((r) => {
      const parts = r.params?.prompt ?? [];
      return {
        text: parts.filter((p) => p.type === "text").map((p) => p.text).join("\n"),
        types: parts.map((p) => p.type),
      };
    });
}

/** The session settings the hub reports for a worktree's chat (`chats.sessionState`). */
export async function sessionState(state, chats, worktreeId) {
  const { state: session } = await trpcQuery(state, "chats.sessionState", {
    chatId: chats[worktreeId],
  });
  return session;
}

/** Makes the chat listen for a timer an hour away, as an agent's `band subscriptions create` would. */
export async function addSubscription(state, chats, worktreeId) {
  await trpc(state, "subscriptions.create", {
    source: "timer",
    chatId: chats[worktreeId],
    worktreeId,
    at: Date.now() + 3_600_000,
    createdBy: "agent",
  });
}

/** The subscriptions the hub holds for a worktree's chat. */
export async function chatSubscriptions(state, chats, worktreeId) {
  return trpcQuery(state, "subscriptions.list", { chatId: chats[worktreeId] });
}

export async function stopTurn(state, chats, worktreeId) {
  await trpc(state, "chats.stop", { chatId: chats[worktreeId] });
}

/** Adds `count` more worktrees to alpha (bulk-1 ...), so the list is longer than one screen. */
export async function fillWorktrees(state, count) {
  for (let i = 1; i <= count; i++) {
    await trpc(state, "worktrees.create", { repo: "alpha", branch: `bulk-${i}` });
  }
}

/** The id of the terminal a flow starts on the hub, per number, so the flow can name it. */
export const termId = (n) => `7e57a1e1-0000-4000-8000-00000000000${n}`;

/** Starts terminal `n` in a worktree, as the web's "New terminal" does. */
export async function termOpen(state, worktreeId, n) {
  await trpc(state, "terminal.create", { worktreeId, id: termId(n) });
  // A shell prints its prompt shortly after it starts.
  await waitFor(async () => (await termOutput(state, n)).length > 0, "the shell to print a prompt");
}

export async function termSend(state, n, data) {
  await trpc(state, "terminal.send", { terminalId: termId(n), data });
}

/** Everything terminal `n` has printed (the hub's scrollback). */
export async function termOutput(state, n) {
  return (await trpcQuery(state, "terminal.output", { terminalId: termId(n) })).output;
}

/** The terminals the hub holds for a worktree. */
export async function termList(state, worktreeId) {
  return (await trpcQuery(state, "terminal.list", { worktreeId })).terminals;
}

/** Waits up to `timeoutMs` for `check` to be true. */
export async function waitFor(check, what, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${what}`);
}
