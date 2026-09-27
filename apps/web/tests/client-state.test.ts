/**
 * Integration tests for `clientState.*`: the small UI values the dashboard
 * keeps on the server so the phone and the desktop show the same tabs,
 * drafts and panel layout.
 *
 * Driven through the production server bundle over tRPC HTTP and the
 * `/trpc` WebSocket. Covers versioned writes (a stale base version is
 * refused, never applied), per-device-type scopes, deletes as tombstones,
 * the `client-state-changed` event on the status stream, and cleanup when a
 * workspace is deleted.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { seedSettings, seedState } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  trpcMutate as sharedTrpcMutate,
  trpcQuery as sharedTrpcQuery,
  startServer,
  trpcData,
} from "./helpers/server";
import { waitFor } from "./helpers/wait-for";

const TOKEN = "client-state-test-token";
const WS_MAIN = "proj-main";
const WS_FEATURE = "proj-feature";

function trpcMutate(serverUrl: string, procedure: string, input?: unknown) {
  return sharedTrpcMutate(serverUrl, procedure, input, TOKEN);
}

function trpcQuery(serverUrl: string, procedure: string, input?: unknown) {
  return sharedTrpcQuery(serverUrl, procedure, input, TOKEN);
}

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@test.com",
};

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf-8" });
}

interface Entry {
  key: string;
  scope: "all" | "desktop" | "mobile";
  workspaceId: string | null;
  value: unknown;
  version: number;
  updatedAt: number;
}

type WriteResult = { ok: boolean; entry: Entry };

async function setEntry(
  serverUrl: string,
  input: {
    key: string;
    scope: Entry["scope"];
    value: unknown;
    baseVersion: number;
    clientId?: string;
  },
): Promise<WriteResult> {
  const res = await trpcMutate(serverUrl, "clientState.set", { clientId: "client-a", ...input });
  expect(res.status).toBe(200);
  return trpcData<WriteResult>(res);
}

async function listEntries(
  serverUrl: string,
  workspaceId: string | null,
  deviceType: "desktop" | "mobile",
): Promise<Entry[]> {
  const res = await trpcQuery(serverUrl, "clientState.list", { workspaceId, deviceType });
  expect(res.status).toBe(200);
  const { entries } = await trpcData<{ entries: Entry[] }>(res);
  return entries.sort((a, b) => `${a.key}|${a.scope}`.localeCompare(`${b.key}|${b.scope}`));
}

function countRows(tmpHome: string, workspaceId: string): number {
  const sqlite = new DatabaseSync(join(tmpHome, ".band", "band.db"), { readOnly: true });
  try {
    const row = sqlite
      .prepare("SELECT COUNT(*) AS n FROM client_state WHERE workspace_id = ?")
      .get(workspaceId) as { n: number };
    return row.n;
  } finally {
    sqlite.close();
  }
}

/** Subscribe to `status.stream` and collect `client-state-changed` events. */
function subscribeClientStateEvents(serverUrl: string): {
  events: Array<{ clientState: Entry; clientId: string }>;
  ready: Promise<void>;
  close: () => void;
} {
  const events: Array<{ clientState: Entry; clientId: string }> = [];
  const ws = new WebSocket(`${serverUrl.replace(/^http/, "ws")}/trpc`, {
    headers: { Cookie: `band_token=${TOKEN}` },
  });
  let markReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  ws.on("open", () => {
    ws.send(
      JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "subscription",
        params: { path: "status.stream", input: undefined },
      }),
    );
  });
  ws.on("message", (raw: Buffer) => {
    const msg = JSON.parse(raw.toString()) as {
      result?: { type: string; data?: { kind?: string; clientState?: Entry; clientId?: string } };
    };
    const data = msg.result?.data;
    // The server sends a snapshot as soon as the subscription is live.
    if (data?.kind === "snapshot") markReady();
    if (data?.kind === "client-state-changed" && data.clientState && data.clientId) {
      events.push({ clientState: data.clientState, clientId: data.clientId });
    }
  });
  return { events, ready, close: () => ws.close() };
}

describe("clientState", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome("band-client-state-");
    const repoPath = join(tmpHome, "proj");
    mkdirSync(repoPath, { recursive: true });
    git(repoPath, ["init", "-b", "main"]);
    writeFileSync(join(repoPath, "README.md"), "# Test\n");
    git(repoPath, ["add", "."]);
    git(repoPath, ["commit", "-m", "init"]);
    const featurePath = join(tmpHome, "proj-feature-wt");
    git(repoPath, ["worktree", "add", "-b", "feature", featurePath]);
    seedState(tmpHome, {
      projects: [
        {
          name: "proj",
          path: repoPath,
          defaultBranch: "main",
          worktrees: [
            { branch: "main", path: repoPath },
            { branch: "feature", path: featurePath },
          ],
        },
      ],
    });
    seedSettings(tmpHome, { tokenSecret: TOKEN });
    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("rejects requests without a token", async () => {
    const res = await fetch(`${server.url}/trpc/clientState.set`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key: "band-recent-workspaces",
        scope: "all",
        value: [],
        baseVersion: 0,
        clientId: "client-a",
      }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects an unknown scope", async () => {
    const res = await trpcMutate(server.url, "clientState.set", {
      key: "band:zoom-level",
      scope: "tablet",
      value: "1.1",
      baseVersion: 0,
      clientId: "client-a",
    });
    expect(res.status).toBe(400);
  });

  it("rejects a key that isn't synced, and a scope the key doesn't use", async () => {
    const unknown = await trpcMutate(server.url, "clientState.set", {
      key: "band.agent-mode",
      scope: "all",
      value: "tui",
      baseVersion: 0,
      clientId: "client-a",
    });
    expect(unknown.status).toBe(400);
    // Sidebar width is per device type, never shared.
    const wrongScope = await trpcMutate(server.url, "clientState.set", {
      key: "band:sidebar-width",
      scope: "all",
      value: "20",
      baseVersion: 0,
      clientId: "client-a",
    });
    expect(wrongScope.status).toBe(400);
  });

  it("rejects a write for a workspace that doesn't exist", async () => {
    const res = await trpcMutate(server.url, "clientState.set", {
      key: "band-draft:proj-missing",
      scope: "all",
      value: "hello",
      baseVersion: 0,
      clientId: "client-a",
    });
    expect(res.status).toBe(404);
    expect(await listEntries(server.url, "proj-missing", "desktop")).toEqual([]);
  });

  it("stores a value, then refuses a write based on a stale version", async () => {
    const key = `band:center-tabs:${WS_MAIN}`;
    const first = await setEntry(server.url, {
      key,
      scope: "all",
      value: { tabs: [{ id: "file:a.ts", kind: "file" }], active: "file:a.ts" },
      baseVersion: 0,
    });
    expect(first).toEqual({
      ok: true,
      entry: {
        key,
        scope: "all",
        workspaceId: WS_MAIN,
        value: { tabs: [{ id: "file:a.ts", kind: "file" }], active: "file:a.ts" },
        version: 1,
        updatedAt: expect.any(Number),
      },
    });

    // Another device writes on top of version 1.
    const second = await setEntry(server.url, {
      key,
      scope: "all",
      value: { tabs: [{ id: "file:b.ts", kind: "file" }], active: "file:b.ts" },
      baseVersion: 1,
      clientId: "client-b",
    });
    expect(second.ok).toBe(true);
    expect(second.entry.version).toBe(2);

    // A client that only saw version 1 (it was offline) must not win.
    const stale = await setEntry(server.url, {
      key,
      scope: "all",
      value: { tabs: [], active: null },
      baseVersion: 1,
    });
    expect(stale).toEqual({
      ok: false,
      entry: {
        key,
        scope: "all",
        workspaceId: WS_MAIN,
        value: { tabs: [{ id: "file:b.ts", kind: "file" }], active: "file:b.ts" },
        version: 2,
        updatedAt: second.entry.updatedAt,
      },
    });

    // A first write (base 0) never overwrites a value another device stored.
    const migration = await setEntry(server.url, {
      key,
      scope: "all",
      value: { tabs: [{ id: "file:old.ts", kind: "file" }], active: null },
      baseVersion: 0,
    });
    expect(migration.ok).toBe(false);
    expect(migration.entry.version).toBe(2);
  });

  it("keeps a separate value per device type and lists only the caller's", async () => {
    const key = `band:dockview-layout-v9:${WS_FEATURE}`;
    await setEntry(server.url, {
      key,
      scope: "desktop",
      value: { grid: "desktop" },
      baseVersion: 0,
    });
    await setEntry(server.url, { key, scope: "mobile", value: { grid: "mobile" }, baseVersion: 0 });
    await setEntry(server.url, {
      key: `band-draft:${WS_FEATURE}`,
      scope: "all",
      value: "half-written message",
      baseVersion: 0,
    });

    const desktop = await listEntries(server.url, WS_FEATURE, "desktop");
    expect(desktop.map((e) => [e.key, e.scope, e.workspaceId, e.value])).toEqual([
      [`band-draft:${WS_FEATURE}`, "all", WS_FEATURE, "half-written message"],
      [key, "desktop", WS_FEATURE, { grid: "desktop" }],
    ]);
    const mobile = await listEntries(server.url, WS_FEATURE, "mobile");
    expect(mobile.map((e) => [e.key, e.scope, e.workspaceId, e.value])).toEqual([
      [`band-draft:${WS_FEATURE}`, "all", WS_FEATURE, "half-written message"],
      [key, "mobile", WS_FEATURE, { grid: "mobile" }],
    ]);
  });

  it("lists global keys apart from workspace keys", async () => {
    await setEntry(server.url, {
      key: "band-recent-workspaces",
      scope: "all",
      value: [WS_FEATURE, WS_MAIN],
      baseVersion: 0,
    });
    const global = await listEntries(server.url, null, "desktop");
    expect(global.map((e) => [e.key, e.scope, e.workspaceId, e.value])).toEqual([
      ["band-recent-workspaces", "all", null, [WS_FEATURE, WS_MAIN]],
    ]);
  });

  it("deletes a key as a tombstone whose version keeps counting", async () => {
    const key = "band.projects-list.label-filter";
    const created = await setEntry(server.url, {
      key,
      scope: "all",
      value: "label-1",
      baseVersion: 0,
    });
    const res = await trpcMutate(server.url, "clientState.delete", {
      key,
      scope: "all",
      baseVersion: created.entry.version,
      clientId: "client-a",
    });
    expect(res.status).toBe(200);
    const deleted = await trpcData<WriteResult>(res);
    expect(deleted).toEqual({
      ok: true,
      entry: {
        key,
        scope: "all",
        workspaceId: null,
        value: null,
        version: created.entry.version + 1,
        updatedAt: expect.any(Number),
      },
    });

    // A client that still has the old value can't bring it back.
    const stale = await setEntry(server.url, {
      key,
      scope: "all",
      value: "label-1",
      baseVersion: created.entry.version,
    });
    expect(stale).toEqual({ ok: false, entry: deleted.entry });

    // Tombstones aren't listed.
    expect((await listEntries(server.url, null, "mobile")).map((e) => e.key)).not.toContain(key);
  });

  it("refuses a delete based on a stale version", async () => {
    const key = "band.projects-list.collapsed-labels";
    const first = await setEntry(server.url, { key, scope: "all", value: ["a"], baseVersion: 0 });
    const second = await setEntry(server.url, {
      key,
      scope: "all",
      value: ["a", "b"],
      baseVersion: first.entry.version,
      clientId: "client-b",
    });
    const res = await trpcMutate(server.url, "clientState.delete", {
      key,
      scope: "all",
      baseVersion: first.entry.version,
      clientId: "client-a",
    });
    expect(res.status).toBe(200);
    expect(await trpcData<WriteResult>(res)).toEqual({ ok: false, entry: second.entry });
  });

  it("refuses a value over the size limit", async () => {
    const res = await trpcMutate(server.url, "clientState.set", {
      key: `band-draft:${WS_MAIN}`,
      scope: "all",
      value: "x".repeat(300 * 1024),
      baseVersion: 0,
      clientId: "client-a",
    });
    expect(res.status).toBe(413);
  });

  it("pushes each accepted write to status stream subscribers, and no refused one", async () => {
    const sub = subscribeClientStateEvents(server.url);
    try {
      await sub.ready;
      const key = "band:zoom-level";
      const written = await setEntry(server.url, {
        key,
        scope: "mobile",
        value: "1.2",
        baseVersion: 0,
        clientId: "phone-page",
      });
      await setEntry(server.url, {
        key,
        scope: "mobile",
        value: "0.8",
        baseVersion: 0,
        clientId: "stale-page",
      });
      const event = await waitFor(async () => sub.events.find((e) => e.clientState.key === key), {
        label: "zoom event",
      });
      expect(event).toEqual({ clientState: written.entry, clientId: "phone-page" });
      // An event for a later write proves the refused write's (non-)event
      // would have arrived by now.
      await setEntry(server.url, {
        key: "band:sidebar-width",
        scope: "mobile",
        value: "20",
        baseVersion: 0,
      });
      await waitFor(
        async () => sub.events.find((e) => e.clientState.key === "band:sidebar-width"),
        { label: "sidebar event" },
      );
      expect(sub.events.filter((e) => e.clientState.key === key)).toHaveLength(1);
    } finally {
      sub.close();
    }
  });

  it("removes a workspace's keys when the workspace is deleted, and refuses new ones", async () => {
    const featureDraft = `band-draft:${WS_FEATURE}`;
    const featureSplit = `band:term-split:${WS_FEATURE}:leaf-1`;
    const mainBranch = `band:diff-compare-branch:${WS_MAIN}`;
    const globalKey = "band.projects-list.label-last-workspace";
    const draft = (await listEntries(server.url, WS_FEATURE, "desktop")).find(
      (e) => e.key === featureDraft,
    );
    await setEntry(server.url, {
      key: featureDraft,
      scope: "all",
      value: "draft before delete",
      baseVersion: draft?.version ?? 0,
    });
    await setEntry(server.url, {
      key: featureSplit,
      scope: "all",
      value: { panels: {} },
      baseVersion: 0,
    });
    const kept = await setEntry(server.url, {
      key: mainBranch,
      scope: "all",
      value: "develop",
      baseVersion: 0,
    });
    const global = await setEntry(server.url, {
      key: globalKey,
      scope: "all",
      value: { lbl: WS_MAIN },
      baseVersion: 0,
    });
    expect(countRows(tmpHome, WS_FEATURE)).toBeGreaterThanOrEqual(2);

    const res = await trpcMutate(server.url, "workspaces.remove", {
      project: "proj",
      name: "feature",
    });
    expect(res.status).toBe(200);
    expect(countRows(tmpHome, WS_FEATURE)).toBe(0);
    expect(await listEntries(server.url, WS_FEATURE, "desktop")).toEqual([]);

    // A device that missed the deletion can't bring the rows back.
    const late = await trpcMutate(server.url, "clientState.set", {
      key: featureDraft,
      scope: "all",
      value: "written offline",
      baseVersion: 0,
      clientId: "offline-page",
    });
    expect(late.status).toBe(404);
    expect(countRows(tmpHome, WS_FEATURE)).toBe(0);

    // Other workspaces and global keys are untouched.
    expect(
      (await listEntries(server.url, WS_MAIN, "desktop")).find((e) => e.key === mainBranch),
    ).toEqual(kept.entry);
    expect(
      (await listEntries(server.url, null, "desktop")).find((e) => e.key === globalKey),
    ).toEqual(global.entry);
  });
});
