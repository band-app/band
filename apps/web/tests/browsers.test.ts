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
} from "./helpers/server";

// Integration tests for `browsers.*` and `browserLayout.*` tRPC mutations
// migrated in Phase 5 of issue #316.
//
// Prior to this file, `apps/web/tests/cold-start.test.ts` only exercised
// `browsers.list`. The mutation surface — `browsers.create`, `browsers.update`,
// `browsers.navigate`, `browsers.remove`, and `browserLayout.get/save` —
// had no integration coverage, even though the Phase 5 refactor lifted
// layout cleanup into `BrowserService.remove()` (so the old "router does
// it as a second step" path is gone). This file closes that gap by
// driving the procedures end-to-end through the production server bundle
// and asserting on both the tRPC response shape AND the on-disk
// `panel_states` row state (i.e. that the layout is actually mutated).

const DEFAULT_TOKEN = "browsers-test-token";

// ---------------------------------------------------------------------------
// tRPC HTTP helpers — `trpcMutate` and `trpcQuery` live in
// `./helpers/server` (shared with `chat-labels.test.ts` /
// `workspace-remove-detached.test.ts`). The wrappers below bake in
// `DEFAULT_TOKEN` so call sites in this suite don't have to thread it
// through every invocation.
// ---------------------------------------------------------------------------

function trpcMutate(serverUrl: string, procedure: string, input?: unknown) {
  return sharedTrpcMutate(serverUrl, procedure, input, DEFAULT_TOKEN);
}

function trpcQuery(serverUrl: string, procedure: string, input?: unknown) {
  return sharedTrpcQuery(serverUrl, procedure, input, DEFAULT_TOKEN);
}

async function trpcData<T>(res: Response): Promise<T> {
  const body = (await res.json()) as { result: { data: T } };
  return body.result.data;
}

// ---------------------------------------------------------------------------
// Git helpers — a real git repo is required so `seedState` can register
// a `git`-kind project whose workspaces resolve cleanly.
// ---------------------------------------------------------------------------

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

function createGitRepo(parentDir: string, name: string): string {
  const repoPath = join(parentDir, name);
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, ["init", "-b", "main"]);
  writeFileSync(join(repoPath, "README.md"), "# Test\n");
  git(repoPath, ["add", "."]);
  git(repoPath, ["commit", "-m", "init"]);
  return repoPath;
}

// ---------------------------------------------------------------------------
// SQLite peek — direct `panel_states` reads so a test can prove
// `browsers.create` / `browsers.remove` actually wrote to disk and that
// `browserService.remove()` tears down the saved layout (which is what
// the Phase 5 refactor changed from "router does it" to "service does it").
// ---------------------------------------------------------------------------

function readPanelState(
  tmpHome: string,
  id: string,
): { state: string; panelType: string } | undefined {
  const sqlite = new DatabaseSync(join(tmpHome, ".band", "band.db"), { readOnly: true });
  try {
    const row = sqlite
      .prepare("SELECT state, panel_type as panelType FROM panel_states WHERE id = ?")
      .get(id) as { state: string; panelType: string } | undefined;
    return row;
  } finally {
    sqlite.close();
  }
}

function readBrowserLayoutRow(tmpHome: string, workspaceId: string): { state: string } | undefined {
  // `DockviewLayoutManager` stores the layout under `${panelType}_${workspaceId}`
  // (see `dockview-layout-manager.ts::layoutId`). Mirror that shape here
  // rather than re-deriving it through tRPC so we can prove the row is
  // physically gone after `removeAllForWorkspace`, not just hidden behind
  // a service-level cache.
  return readPanelState(tmpHome, `browser_layout_${workspaceId}`);
}

interface BrowserRecord {
  id: string;
  workspaceId: string;
  name: string;
  url: string;
  status: string;
}

// ---------------------------------------------------------------------------
// browsers.create / list / update / navigate / remove — full CRUD round-trip
// ---------------------------------------------------------------------------

describe("browsers — CRUD round-trip", () => {
  let server: ServerHandle;
  let tmpHome: string;
  const workspaceId = "myproject-main";

  beforeAll(async () => {
    tmpHome = createTmpHome("band-browsers-");
    const repoPath = createGitRepo(tmpHome, "myproject");
    seedState(tmpHome, {
      projects: [
        {
          name: "myproject",
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

  it("rejects browsers.create without the band_token cookie (401)", async () => {
    // Negative-auth check — the shared `trpcMutate` always sends the
    // cookie, so we have to call `fetch` directly to omit it. Mirrors
    // `chat-labels.test.ts`'s 401 guard.
    const res = await fetch(`${server.url}/trpc/browsers.create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId }),
    });
    expect(res.status).toBe(401);
  });

  it("browsers.create persists a tab and registers it in the saved layout", async () => {
    const res = await trpcMutate(server.url, "browsers.create", {
      workspaceId,
      name: "Docs",
      url: "https://docs.test/start",
    });
    expect(res.status).toBe(200);
    const data = await trpcData<{ browser: BrowserRecord }>(res);
    expect(data.browser.workspaceId).toBe(workspaceId);
    expect(data.browser.name).toBe("Docs");
    expect(data.browser.url).toBe("https://docs.test/start");
    expect(data.browser.status).toBe("idle");
    expect(data.browser.id).toMatch(/^browser_/);

    // The row is on disk. Mirrors the assertion shape from
    // `cold-start.test.ts::on-disk panel_states JSON blobs are flipped to idle`.
    const row = readPanelState(tmpHome, data.browser.id);
    expect(row).toBeDefined();
    expect(row!.panelType).toBe("browser");
    const parsed = JSON.parse(row!.state) as { name: string; url: string; status: string };
    expect(parsed.name).toBe("Docs");
    expect(parsed.url).toBe("https://docs.test/start");

    // `browserService.create` also registers the panel in the saved
    // dockview layout (see `BrowserService.create` comment). Without
    // this, reopening the workspace after a restart would leave a
    // ghost browser record with no tab. Prove the layout row is
    // present and references the new id.
    const layoutRow = readBrowserLayoutRow(tmpHome, workspaceId);
    expect(layoutRow).toBeDefined();
    const layout = JSON.parse(layoutRow!.state) as {
      panels: Record<string, { params?: { browserId?: string } }>;
    };
    expect(layout.panels[data.browser.id]).toBeDefined();
    expect(layout.panels[data.browser.id].params?.browserId).toBe(data.browser.id);
  });

  it("browsers.list returns every browser persisted for the workspace", async () => {
    // Seed a second browser so the assertion catches a regression that
    // accidentally returns only the most-recently-created tab.
    const second = await trpcMutate(server.url, "browsers.create", {
      workspaceId,
      name: "Issue tracker",
      url: "https://issues.test/1",
    });
    const secondData = await trpcData<{ browser: BrowserRecord }>(second);

    const listRes = await trpcQuery(server.url, "browsers.list", { workspaceId });
    expect(listRes.status).toBe(200);
    const listData = await trpcData<{ browsers: BrowserRecord[] }>(listRes);
    const names = listData.browsers.map((b) => b.name);
    expect(names).toContain("Docs");
    expect(names).toContain("Issue tracker");
    const found = listData.browsers.find((b) => b.id === secondData.browser.id);
    expect(found?.url).toBe("https://issues.test/1");
  });

  it("browsers.update changes the tab name on disk", async () => {
    const createRes = await trpcMutate(server.url, "browsers.create", {
      workspaceId,
      name: "Stale name",
      url: "https://example.test",
    });
    const { browser: created } = await trpcData<{ browser: BrowserRecord }>(createRes);

    const updateRes = await trpcMutate(server.url, "browsers.update", {
      browserId: created.id,
      name: "Fresh name",
    });
    expect(updateRes.status).toBe(200);
    const { browser: updated } = await trpcData<{ browser: BrowserRecord }>(updateRes);
    expect(updated.name).toBe("Fresh name");
    expect(updated.url).toBe("https://example.test"); // unchanged

    // Verify the rewrite hit disk, not just the in-memory registry.
    const row = readPanelState(tmpHome, created.id);
    const parsed = JSON.parse(row!.state) as { name: string };
    expect(parsed.name).toBe("Fresh name");
  });

  it("browsers.navigate updates the persisted URL", async () => {
    const createRes = await trpcMutate(server.url, "browsers.create", {
      workspaceId,
      name: "Nav target",
      url: "https://before.test",
    });
    const { browser: created } = await trpcData<{ browser: BrowserRecord }>(createRes);

    const navRes = await trpcMutate(server.url, "browsers.navigate", {
      browserId: created.id,
      url: "https://after.test/path?q=1",
    });
    expect(navRes.status).toBe(200);
    const navData = await trpcData<{ ok: boolean }>(navRes);
    expect(navData.ok).toBe(true);

    // The mutation returns `{ ok: true }` (not the row) — confirm the
    // new URL via a follow-up read through the public API.
    const getRes = await trpcQuery(server.url, "browsers.get", { browserId: created.id });
    expect(getRes.status).toBe(200);
    const { browser } = await trpcData<{ browser: BrowserRecord | null }>(getRes);
    expect(browser?.url).toBe("https://after.test/path?q=1");

    // And on disk — the navigate path goes through the same
    // `BrowserQueries.update` write as `browsers.update`, but pinning
    // the persistence guards a future refactor that splits the two
    // paths from regressing one of them.
    const row = readPanelState(tmpHome, created.id);
    const parsed = JSON.parse(row!.state) as { url: string };
    expect(parsed.url).toBe("https://after.test/path?q=1");
  });

  it("browsers.remove drops the row AND the panel from the saved layout", async () => {
    const createRes = await trpcMutate(server.url, "browsers.create", {
      workspaceId,
      name: "To be removed",
      url: "https://remove.test",
    });
    const { browser: created } = await trpcData<{ browser: BrowserRecord }>(createRes);

    // Sanity-check the precondition: layout knows about the panel.
    const beforeLayoutRow = readBrowserLayoutRow(tmpHome, workspaceId);
    const beforeLayout = JSON.parse(beforeLayoutRow!.state) as {
      panels: Record<string, unknown>;
    };
    expect(beforeLayout.panels[created.id]).toBeDefined();

    const removeRes = await trpcMutate(server.url, "browsers.remove", {
      browserId: created.id,
    });
    expect(removeRes.status).toBe(200);

    // The DB row is gone.
    expect(readPanelState(tmpHome, created.id)).toBeUndefined();

    // The saved layout no longer references the removed panel. This is
    // the Phase 5 contract: `browserService.remove()` calls
    // `removeFromLayout` so the router doesn't have to remember a
    // separate `browserLayout.save` step. Without this assertion a
    // regression that re-splits the cleanup (the same shape the pre-
    // refactor router had) would go unnoticed.
    const afterLayoutRow = readBrowserLayoutRow(tmpHome, workspaceId);
    expect(afterLayoutRow).toBeDefined();
    const afterLayout = JSON.parse(afterLayoutRow!.state) as {
      panels: Record<string, unknown>;
    };
    expect(afterLayout.panels[created.id]).toBeUndefined();

    // And `browsers.list` no longer hands it out.
    const listRes = await trpcQuery(server.url, "browsers.list", { workspaceId });
    const listData = await trpcData<{ browsers: BrowserRecord[] }>(listRes);
    expect(listData.browsers.find((b) => b.id === created.id)).toBeUndefined();
  });

  it("browsers.get returns null for an unknown id (idempotent read)", async () => {
    const res = await trpcQuery(server.url, "browsers.get", {
      browserId: "browser_does_not_exist",
    });
    expect(res.status).toBe(200);
    const data = await trpcData<{ browser: BrowserRecord | null }>(res);
    expect(data.browser).toBeNull();
  });

  it("browsers survive a server restart — rehydrate from SQLite", async () => {
    const createRes = await trpcMutate(server.url, "browsers.create", {
      workspaceId,
      name: "Restart survivor",
      url: "https://survives.test",
    });
    const { browser: created } = await trpcData<{ browser: BrowserRecord }>(createRes);

    // Restart the server (closes the SQLite handle so the next boot
    // re-reads the row through `BrowserService.loadFromDb`). Same
    // pattern as `chat-labels.test.ts`'s rehydration test.
    await server.close();
    server = await startServer({ tmpHome });

    const listRes = await trpcQuery(server.url, "browsers.list", { workspaceId });
    const listData = await trpcData<{ browsers: BrowserRecord[] }>(listRes);
    const found = listData.browsers.find((b) => b.id === created.id);
    expect(found).toBeDefined();
    expect(found?.name).toBe("Restart survivor");
    expect(found?.url).toBe("https://survives.test");
    expect(found?.status).toBe("idle");
  });
});

// ---------------------------------------------------------------------------
// browserLayout.get / browserLayout.save — explicit layout-tree CRUD
// ---------------------------------------------------------------------------

describe("browserLayout — get/save round-trip", () => {
  let server: ServerHandle;
  let tmpHome: string;
  const workspaceId = "layoutproj-main";

  beforeAll(async () => {
    tmpHome = createTmpHome("band-browser-layout-");
    const repoPath = createGitRepo(tmpHome, "layoutproj");
    seedState(tmpHome, {
      projects: [
        {
          name: "layoutproj",
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

  it("browserLayout.get returns { tree: null } when no layout has been saved", async () => {
    const res = await trpcQuery(server.url, "browserLayout.get", { workspaceId });
    expect(res.status).toBe(200);
    const data = await trpcData<{ tree: unknown }>(res);
    expect(data.tree).toBeNull();
  });

  it("browserLayout.save persists an arbitrary tree and browserLayout.get returns it", async () => {
    // The router accepts `z.unknown()` — the dashboard hands it dockview's
    // `toJSON()` output verbatim. Save a minimal shape that mirrors what
    // `DockviewLayoutManager.addPanel` emits when no layout exists yet,
    // so the assertion is grounded in the real persisted shape.
    const tree = {
      grid: {
        root: {
          type: "branch",
          data: [
            {
              type: "leaf",
              data: { id: "group_a", views: ["browser_a"], activeView: "browser_a" },
              size: 500,
            },
          ],
          size: 500,
        },
        height: 500,
        width: 500,
        orientation: "HORIZONTAL",
      },
      panels: {
        browser_a: {
          id: "browser_a",
          contentComponent: "browserTab",
          tabComponent: "browserTab",
          title: "Tab",
          params: { workspaceId, browserId: "browser_a" },
        },
      },
      activeGroup: "group_a",
    };

    const saveRes = await trpcMutate(server.url, "browserLayout.save", {
      workspaceId,
      tree,
    });
    expect(saveRes.status).toBe(200);
    const saveData = await trpcData<{ ok: boolean }>(saveRes);
    expect(saveData.ok).toBe(true);

    const getRes = await trpcQuery(server.url, "browserLayout.get", { workspaceId });
    expect(getRes.status).toBe(200);
    const getData = await trpcData<{ tree: typeof tree }>(getRes);
    expect(getData.tree).toEqual(tree);
  });
});
