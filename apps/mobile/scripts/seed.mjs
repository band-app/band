/**
 * Fills the throwaway hub from `hub.mjs` with what the worktree-list flows look at: two repos
 * (alpha, beta) and three worktrees (alpha main, alpha feat/mobile, beta main), each with one
 * chat. `startTurn` then makes the scripted ACP agent work or ask for permission in a chat, so a
 * flow sees the status stream change; `stopTurn` ends a turn that is still running.
 *
 * The agent's behaviour comes from the scenario file `hub.mjs` writes (`SCENARIO` below): a
 * prompt starting with "work" runs until stopped, one starting with "ask" waits for a permission
 * answer, and anything else answers at once.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
    { steps: [{ say: "Done." }] },
  ],
};

/** The worktree ids the flows use, as the hub names them. */
export const WORKTREES = {
  ALPHA_MAIN: "alpha-main",
  ALPHA_FEATURE: "alpha-feat-mobile",
  BETA_MAIN: "beta-main",
};

async function trpc(state, procedure, input) {
  const res = await fetch(`${state.url}/trpc/${procedure}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${state.adminToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.result) {
    throw new Error(`${procedure} failed (HTTP ${res.status}): ${body?.error?.message ?? "no body"}`);
  }
  return body.result.data;
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
  for (const name of ["alpha", "beta"]) {
    gitRepo(join(root, name));
    await trpc(state, "repos.add", { path: join(root, name) });
  }
  await trpc(state, "worktrees.create", { repo: "alpha", branch: "feat/mobile" });
  const chats = {};
  for (const id of Object.values(WORKTREES)) {
    const { chat } = await trpc(state, "chats.create", { worktreeId: id, name: "seed" });
    chats[id] = chat.id;
  }
  return chats;
}

/** Sends `text` to the worktree's chat, so the agent starts a turn the scenario scripts. */
export async function startTurn(state, chats, worktreeId, text) {
  const chatId = chats[worktreeId];
  if (!chatId) throw new Error(`No chat for ${worktreeId}`);
  const res = await fetch(`${state.url}/api/chats/${encodeURIComponent(chatId)}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${state.adminToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ worktreeId, text }),
  });
  if (!res.ok) throw new Error(`send failed: HTTP ${res.status} ${await res.text()}`);
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
