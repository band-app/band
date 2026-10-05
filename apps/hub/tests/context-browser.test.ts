// Integration tests for the context browser API (plan step 5.5). The real production server runs
// on a random port with auth on, against a temp BAND_HOME. Files are pushed with the real `git`
// binary over the hub's git endpoint, the way an agent's worker would, and read back through
// `context.*`.

import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedSettings, seedState } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  startServer,
  trpcData,
  trpcMutate,
  trpcQuery,
} from "./helpers/server";

const ADMIN = "context-browser-admin-secret";

let home: string;
let server: ServerHandle;
const scratch: string[] = [];

const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "agent",
  GIT_AUTHOR_EMAIL: "agent@example.com",
  GIT_COMMITTER_NAME: "agent",
  GIT_COMMITTER_EMAIL: "agent@example.com",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv });
}

const call = async (kind: "m" | "q", proc: string, input: unknown) => {
  const res =
    kind === "m"
      ? await trpcMutate(server.url, proc, input, ADMIN)
      : await trpcQuery(server.url, proc, input, ADMIN);
  const text = await res.clone().text();
  return { status: res.status, text, data: res.status === 200 ? trpcData<any>(res) : null };
};
const m = async <T = any>(proc: string, input: unknown) => {
  const r = await call("m", proc, input);
  expect(r.status, `${proc}: ${r.text}`).toBe(200);
  return r.data as T;
};
const q = async <T = any>(proc: string, input: unknown) => {
  const r = await call("q", proc, input);
  expect(r.status, `${proc}: ${r.text}`).toBe(200);
  return r.data as T;
};

/** Clones the context over the git endpoint, adds files, pushes, and returns nothing. */
function pushFiles(name: string, files: Record<string, string>, message: string) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ctx-browser-clone-")));
  scratch.push(dir);
  const url = `${server.url}/git/context/${name}.git`;
  const auth = ["-c", `http.extraHeader=Authorization: Bearer ${ADMIN}`];
  git(dir, ...auth, "clone", "-q", url, "wc");
  const wc = join(dir, "wc");
  for (const [path, content] of Object.entries(files)) {
    execFileSync("mkdir", ["-p", join(wc, path, "..")]);
    writeFileSync(join(wc, path), content);
  }
  git(wc, "add", "-A");
  git(wc, "commit", "-q", "-m", message);
  git(wc, ...auth, "push", "-q", "origin", "HEAD:main");
}

beforeAll(async () => {
  home = createTmpHome("band-context-browser-");
  scratch.push(home);
  seedState(home, { repos: [] });
  seedSettings(home, { tokenSecret: ADMIN });
  server = await startServer({ remoteHost: false, tmpHome: home, env: { BAND_SERVE_UI: "false" } });
  await m("context.create", { name: "user" });
  await m("context.create", { name: "atlas" });
}, 90_000);

afterAll(async () => {
  await server?.close();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

describe("context browser API", () => {
  it("lists the scaffold files and reads one", async () => {
    const tree = await q("context.tree", { name: "atlas" });
    expect(tree.entries.map((e: { path: string }) => e.path)).toContain("notes.md");
    const file = await q("context.file", { name: "atlas", path: "notes.md" });
    expect(file.binary).toBe(false);
    expect(file.content).toContain("# Notes");
    expect(file.commit).toBe(tree.head);
  });

  it("rejects paths that leave the context and a missing file", async () => {
    for (const path of ["../x", "/etc/passwd", "a/../b", ".git/config", ":(top)notes.md", "a\nb"]) {
      const r = await call("q", "context.file", { name: "atlas", path });
      expect(r.status, path).toBe(400);
    }
    expect((await call("q", "context.file", { name: "atlas", path: "nope.md" })).status).toBe(400);
    expect((await call("q", "context.tree", { name: "ghost" })).status).toBe(404);
  });

  it("saves a file as one commit that shows in the file history with its diff", async () => {
    const before = await q("context.file", { name: "atlas", path: "notes.md" });
    const saved = await m("context.write", {
      name: "atlas",
      path: "notes.md",
      content: "# Notes\n\nThe plan changed.\n",
      message: "Update the plan",
      base: before.commit,
    });
    expect(saved.changed).toBe(true);
    const { commits } = await q("context.log", { name: "atlas", path: "notes.md" });
    expect(commits[0].subject).toBe("Update the plan");
    expect(commits[0].sha).toBe(saved.commit);
    const { diff, files } = await q("context.diff", {
      name: "atlas",
      sha: saved.commit,
      path: "notes.md",
    });
    expect(diff).toContain("+The plan changed.");
    expect(files).toEqual([{ status: "M", path: "notes.md" }]);
    // Saving the same text again makes no commit.
    const again = await m("context.write", {
      name: "atlas",
      path: "notes.md",
      content: "# Notes\n\nThe plan changed.\n",
      message: "Same again",
    });
    expect(again.changed).toBe(false);
  });

  it("creates a file in a new folder, and the git endpoint sees the commit", async () => {
    await m("context.write", {
      name: "atlas",
      path: "docs/design/overview.md",
      content: "hello\n",
      message: "Add overview",
    });
    const tree = await q("context.tree", { name: "atlas" });
    expect(tree.entries.map((e: { path: string }) => e.path)).toContain("docs/design/overview.md");
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "ctx-browser-verify-")));
    scratch.push(dir);
    git(
      dir,
      "-c",
      `http.extraHeader=Authorization: Bearer ${ADMIN}`,
      "clone",
      "-q",
      `${server.url}/git/context/atlas.git`,
      "wc",
    );
    expect(git(join(dir, "wc"), "log", "--format=%s", "-1").trim()).toBe("Add overview");
  });

  it("refuses a save over a newer version and a save that holds a credential", async () => {
    const opened = await q("context.file", { name: "atlas", path: "notes.md" });
    await m("context.write", {
      name: "atlas",
      path: "notes.md",
      content: "# Notes\n\nSomeone else edited.\n",
      message: "Other edit",
    });
    const stale = await call("m", "context.write", {
      name: "atlas",
      path: "notes.md",
      content: "# Notes\n\nMine.\n",
      message: "Mine",
      base: opened.commit,
    });
    expect(stale.status).toBe(409);
    const secret = await call("m", "context.write", {
      name: "atlas",
      path: "notes.md",
      content: "token: ghp_abcdefghijklmnopqrstuvwxyz0123456789\n",
      message: "Oops",
    });
    expect(secret.status).toBe(400);
    expect(secret.text).toContain("GitHub token");
    expect(secret.text).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");
    const now = await q("context.file", { name: "atlas", path: "notes.md" });
    expect(now.content).toContain("Someone else edited.");
  });

  it("lists learnings and handoffs, newest first, and drops deleted ones", async () => {
    pushFiles("atlas", { "learnings/2026-10-01-a.md": "one\n" }, "Learning one");
    pushFiles("atlas", { "handoffs/2026-10-02-b.md": "two\n" }, "Handoff two");
    const { entries } = await q("context.recent", { name: "atlas" });
    expect(entries.map((e: { path: string }) => e.path)).toEqual([
      "handoffs/2026-10-02-b.md",
      "learnings/2026-10-01-a.md",
    ]);
    expect(entries[0].kind).toBe("handoffs");
  });

  it("marks conflict copies and resolves them either way in one commit", async () => {
    pushFiles(
      "atlas",
      {
        "plan.md": "original plan\n",
        "plan.conflict-x7k2.md": "conflicting plan\n",
        "todo.md": "original todo\n",
        "todo.conflict-q9.md": "other todo\n",
      },
      "Keep both",
    );
    const tree = await q("context.tree", { name: "atlas" });
    const copies = tree.entries.filter((e: { conflictOf: string | null }) => e.conflictOf);
    expect(copies.map((e: { path: string; conflictOf: string }) => [e.path, e.conflictOf])).toEqual(
      [
        ["plan.conflict-x7k2.md", "plan.md"],
        ["todo.conflict-q9.md", "todo.md"],
      ],
    );

    const keepCopy = await m("context.resolveConflict", {
      name: "atlas",
      path: "plan.conflict-x7k2.md",
      keep: "conflict",
    });
    expect(keepCopy.path).toBe("plan.md");
    expect((await q("context.file", { name: "atlas", path: "plan.md" })).content).toBe(
      "conflicting plan\n",
    );
    const keepOriginal = await m("context.resolveConflict", {
      name: "atlas",
      path: "todo.conflict-q9.md",
      keep: "original",
    });
    expect(keepOriginal.path).toBe("todo.md");
    expect((await q("context.file", { name: "atlas", path: "todo.md" })).content).toBe(
      "original todo\n",
    );
    const after = await q("context.tree", { name: "atlas" });
    expect(after.entries.filter((e: { conflictOf: string | null }) => e.conflictOf)).toEqual([]);
    const { files } = await q("context.diff", { name: "atlas", sha: keepCopy.commit });
    expect(files.map((f: { status: string }) => f.status).sort()).toEqual(["D", "M"]);
    expect(
      (
        await call("m", "context.resolveConflict", {
          name: "atlas",
          path: "plan.md",
          keep: "original",
        })
      ).status,
    ).toBe(400);
  });

  it("refuses a credential in a commit message", async () => {
    const r = await call("m", "context.write", {
      name: "atlas",
      path: "notes.md",
      content: "fine\n",
      message: "key ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    });
    expect(r.status).toBe(400);
    expect(r.text).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
  });

  it("refuses to keep the original of a copy whose original does not exist", async () => {
    pushFiles("atlas", { "lonely.conflict-zz9.md": "only copy\n" }, "Add a lone copy");
    const r = await call("m", "context.resolveConflict", {
      name: "atlas",
      path: "lonely.conflict-zz9.md",
      keep: "original",
    });
    expect(r.status).toBe(400);
    const tree = await q("context.tree", { name: "atlas" });
    expect(tree.entries.map((e: { path: string }) => e.path)).toContain("lonely.conflict-zz9.md");
  });

  it("answers 401 without a token and 403 to a token that is not an admin", async () => {
    expect((await trpcQuery(server.url, "context.tree", { name: "atlas" })).status).toBe(401);
    expect((await trpcQuery(server.url, "context.tree", { name: "atlas" }, "wrong")).status).toBe(
      401,
    );
    const made = await m<{ token: string }>("tokens.createDevice", { label: "viewer" });
    const res = await trpcQuery(server.url, "context.tree", { name: "atlas" }, made.token);
    expect(res.status).toBe(403);
    const write = await trpcMutate(
      server.url,
      "context.write",
      { name: "atlas", path: "x.md", content: "x\n", message: "x" },
      made.token,
    );
    expect(write.status).toBe(403);
    const resolve = await trpcMutate(
      server.url,
      "context.resolveConflict",
      { name: "atlas", path: "plan.conflict-x7k2.md", keep: "original" },
      made.token,
    );
    expect(resolve.status).toBe(403);
  });
});
