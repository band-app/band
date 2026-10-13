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
  "| File | Change |",
  "| --- | --- |",
  "| `src/parser.ts` | parse as base 10 |",
  "| `README.md` | document it |",
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
    // A turn of about 90 s that ends by itself, so a flow can queue messages behind it.
    { match: "^slow", steps: [{ say: "Thinking it over." }, { sleep: 90000 }, { say: "Slow turn finished." }] },
    { match: "^showcase", steps: showcaseSteps() },
    { match: "^long", steps: longSteps() },
    { match: "^stream", steps: streamSteps() },
    { steps: [{ say: "Done." }] },
  ],
};

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
  GAMMA_KEYBOARD: "gamma-keyboard",
  /** More turns than the hub sends on open, so the oldest load on scroll-back (c6). */
  GAMMA_HISTORY: "gamma-history",
};

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
    headers: { Authorization: `Bearer ${state.adminToken}` },
  });
  return trpcResult(procedure, res);
}

async function trpc(state, procedure, input) {
  const res = await fetch(`${state.url}/trpc/${procedure}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${state.adminToken}`, "Content-Type": "application/json" },
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

/** Adds the repos and worktrees. Returns the chat id of each worktree. */
export async function seedHub(state) {
  const root = join(state.home, "repos");
  for (const name of ["alpha", "beta", "gamma"]) {
    gitRepo(join(root, name));
    await trpc(state, "repos.add", { path: join(root, name) });
  }
  await trpc(state, "worktrees.create", { repo: "alpha", branch: "feat/mobile" });
  for (const branch of ["long", "stream", "resume", "history", "compose", "queue", "attach", "suggest", "session", "keyboard"]) {
    await trpc(state, "worktrees.create", { repo: "gamma", branch });
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
  for (let i = 1; i <= HISTORY_TURNS; i++) {
    const n = String(i).padStart(2, "0");
    await seedTurn(state, chats, WORKTREES.GAMMA_HISTORY, `turn ${n}: say done`);
  }
  return chats;
}

/** A 96x64 PNG with a stripe, as a `data:` URL, for a prompt's attached image. */
function pngFile(filename) {
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
  return { mediaType: "image/png", filename, url: `data:image/png;base64,${png.toString("base64")}` };
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
    headers: { Authorization: `Bearer ${state.adminToken}`, "Content-Type": "application/json" },
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

export async function stopTurn(state, chats, worktreeId) {
  await trpc(state, "chats.stop", { chatId: chats[worktreeId] });
}

/** Adds `count` more worktrees to alpha (bulk-1 ...), so the list is longer than one screen. */
export async function fillWorktrees(state, count) {
  for (let i = 1; i <= count; i++) {
    await trpc(state, "worktrees.create", { repo: "alpha", branch: `bulk-${i}` });
  }
}
