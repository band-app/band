/**
 * Integration tests for the `panelFocus.*` tRPC surface — the server-side
 * record of the last-focused panel per type (chat / terminal / browser) for a
 * workspace. This is what "Add to Chat" / "Add to Terminal" query to route a
 * pasted reference into the pane the user was last using.
 *
 * Driven end-to-end through the production server bundle (real HTTP, real auth,
 * real SQLite), asserting on both the tRPC response shape AND the on-disk
 * `panel_states` row. A final test restarts the server against the same home to
 * prove the focus record is hydrated from disk after a fresh boot — not just
 * held in the first process's memory.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedSettings, seedState } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  trpcMutate as sharedTrpcMutate,
  trpcQuery as sharedTrpcQuery,
  startServer,
  trpcData,
} from "./helpers/server";

const DEFAULT_TOKEN = "panel-focus-test-token";
const WORKSPACE_ID = "focusproject-main";

function trpcMutate(serverUrl: string, procedure: string, input?: unknown) {
  return sharedTrpcMutate(serverUrl, procedure, input, DEFAULT_TOKEN);
}

function trpcQuery(serverUrl: string, procedure: string, input?: unknown) {
  return sharedTrpcQuery(serverUrl, procedure, input, DEFAULT_TOKEN);
}

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@test.com",
};

function createGitRepo(parentDir: string, name: string): string {
  const repoPath = join(parentDir, name);
  mkdirSync(repoPath, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: repoPath, env: gitEnv });
  writeFileSync(join(repoPath, "README.md"), "# Test\n");
  execFileSync("git", ["add", "."], { cwd: repoPath, env: gitEnv });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoPath, env: gitEnv });
  return repoPath;
}

/** Read the persisted focus row straight from SQLite. Id is deterministic:
 *  `panel_focus:${workspaceId}` (see `PanelFocusService.focusRowId`). */
function readFocusRow(tmpHome: string): { state: string; panelType: string } | undefined {
  const sqlite = new DatabaseSync(join(tmpHome, ".band", "band.db"), { readOnly: true });
  try {
    return sqlite
      .prepare("SELECT state, panel_type as panelType FROM panel_states WHERE id = ?")
      .get(`panel_focus:${WORKSPACE_ID}`) as { state: string; panelType: string } | undefined;
  } finally {
    sqlite.close();
  }
}

type Focus = { chat?: string; terminal?: string; browser?: string };

describe("panelFocus — last-focused panel per type", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome("band-panel-focus-");
    const repoPath = createGitRepo(tmpHome, "focusproject");
    seedState(tmpHome, {
      projects: [
        {
          name: "focusproject",
          path: repoPath,
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: repoPath }],
        },
      ],
    });
    seedSettings(tmpHome, { tokenSecret: DEFAULT_TOKEN });
    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("rejects panelFocus.set without the band_token cookie (401)", async () => {
    // The shared helpers always send the cookie, so call fetch directly to
    // omit it — mirrors the negative-auth guard in browsers.test.ts.
    const res = await fetch(`${server.url}/trpc/panelFocus.set`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: WORKSPACE_ID, panelType: "chat", panelId: "chat_x" }),
    });
    expect(res.status).toBe(401);
  });

  it("returns an empty record before anything is focused", async () => {
    const res = await trpcQuery(server.url, "panelFocus.get", { workspaceId: WORKSPACE_ID });
    expect(res.status).toBe(200);
    const data = await trpcData<Focus>(res);
    expect(data).toEqual({});
  });

  it("records the last-focused panel per type independently", async () => {
    await trpcMutate(server.url, "panelFocus.set", {
      workspaceId: WORKSPACE_ID,
      panelType: "chat",
      panelId: "chat_alpha",
    });
    await trpcMutate(server.url, "panelFocus.set", {
      workspaceId: WORKSPACE_ID,
      panelType: "terminal",
      panelId: "term_one",
    });
    await trpcMutate(server.url, "panelFocus.set", {
      workspaceId: WORKSPACE_ID,
      panelType: "browser",
      panelId: "browser_z",
    });

    const res = await trpcQuery(server.url, "panelFocus.get", { workspaceId: WORKSPACE_ID });
    const data = await trpcData<Focus>(res);
    expect(data).toEqual({ chat: "chat_alpha", terminal: "term_one", browser: "browser_z" });

    // The record is a single row on disk under the deterministic id.
    const row = readFocusRow(tmpHome);
    expect(row).toBeDefined();
    expect(row!.panelType).toBe("panel_focus");
    expect(JSON.parse(row!.state)).toEqual({
      chat: "chat_alpha",
      terminal: "term_one",
      browser: "browser_z",
    });
  });

  it("overwrites only the named type, leaving the others intact", async () => {
    await trpcMutate(server.url, "panelFocus.set", {
      workspaceId: WORKSPACE_ID,
      panelType: "chat",
      panelId: "chat_beta",
    });

    const res = await trpcQuery(server.url, "panelFocus.get", { workspaceId: WORKSPACE_ID });
    const data = await trpcData<Focus>(res);
    expect(data).toEqual({ chat: "chat_beta", terminal: "term_one", browser: "browser_z" });
  });

  it("hydrates the persisted record after a fresh server boot", async () => {
    // Restart against the SAME home: a new process with an empty in-memory map
    // must still resolve the focus from the SQLite row written above. Reassign
    // `server` so afterAll tears down the new instance.
    await server.close();
    server = await startServer({ tmpHome });

    const res = await trpcQuery(server.url, "panelFocus.get", { workspaceId: WORKSPACE_ID });
    const data = await trpcData<Focus>(res);
    expect(data).toEqual({ chat: "chat_beta", terminal: "term_one", browser: "browser_z" });
  });
});
