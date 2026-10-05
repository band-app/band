import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb } from "../src/server/infra/db/connection";
import { HostRegistry, hostRegistry } from "../src/server/infra/host/registry";
import { loadState, saveState } from "../src/server/services/state";
import { worktreeService } from "../src/server/services/worktree-service";

// Uses a real SQLite DB in a temp BAND_HOME, as `sync-service.test.ts` does.
describe("host registry", () => {
  let tmp = "";
  let originalBandHome: string | undefined;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "band-host-registry-")));
    originalBandHome = process.env.BAND_HOME;
    process.env.BAND_HOME = join(tmp, ".band");
  });

  afterEach(() => {
    closeDb();
    if (originalBandHome !== undefined) process.env.BAND_HOME = originalBandHome;
    else delete process.env.BAND_HOME;
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("puts every worktree and repo on the local host", () => {
    expect(hostRegistry.local.id).toBe("local");
    expect(hostRegistry.hostFor("any-worktree")).toBe(hostRegistry.local);
    expect(hostRegistry.hostForRepo("any-repo")).toBe(hostRegistry.local);
  });

  it("returns the host from worktreeService.resolve", () => {
    saveState({
      repos: [
        {
          name: "proj",
          path: join(tmp, "proj"),
          defaultBranch: "main",
          worktrees: [
            { name: "main", branch: "main", path: join(tmp, "proj"), pinned: false },
            { name: "feat", branch: "feat", path: join(tmp, "proj-feat"), pinned: false },
          ],
        },
      ],
    });

    for (const worktree of ["main", "feat"]) {
      const resolved = worktreeService.resolve(`proj-${worktree}`);
      expect(resolved).not.toBeNull();
      expect(resolved?.host).toBe(hostRegistry.local);
      expect(resolved?.worktree.name).toBe(worktree);
    }
    expect(worktreeService.resolve("proj-missing")).toBeNull();
  });

  it("resolves a worktree through its stored host_id", () => {
    saveState({
      repos: [
        {
          name: "proj",
          path: join(tmp, "proj"),
          defaultBranch: "main",
          worktrees: [
            { name: "main", branch: "main", path: join(tmp, "proj"), pinned: false },
            { name: "feat", branch: "feat", path: join(tmp, "proj-feat"), pinned: false },
          ],
        },
      ],
    });
    const remote = Object.create(hostRegistry.local, { id: { value: "remote-1" } });
    const registry = new HostRegistry(hostRegistry.local);
    registry.register(remote);
    const db = new DatabaseSync(join(tmp, ".band", "band.db"));
    db.exec("INSERT INTO hosts (id, name, created_at) VALUES ('remote-1', 'Remote', 0)");
    db.exec("UPDATE worktrees SET host_id = 'remote-1' WHERE name = 'feat'");
    db.close();

    expect(registry.hostFor("proj-feat")).toBe(remote);
    expect(registry.hostFor("proj-main")).toBe(hostRegistry.local);

    // A save from the in-memory tree keeps the stored host.
    const state = loadState();
    saveState(state);
    expect(registry.hostFor("proj-feat")).toBe(remote);
    expect(registry.hostFor("proj-main")).toBe(hostRegistry.local);
  });
});
