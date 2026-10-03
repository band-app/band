import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb } from "../src/server/infra/db/connection";
import { hostRegistry } from "../src/server/infra/host/registry";
import { saveState } from "../src/server/services/state";
import { workspaceService } from "../src/server/services/workspace-service";

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

  it("puts every workspace and project on the local host", () => {
    expect(hostRegistry.local.id).toBe("local");
    expect(hostRegistry.hostFor("any-workspace")).toBe(hostRegistry.local);
    expect(hostRegistry.hostForProject("any-project")).toBe(hostRegistry.local);
  });

  it("returns the host from workspaceService.resolve", () => {
    saveState({
      projects: [
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
      const resolved = workspaceService.resolve(`proj-${worktree}`);
      expect(resolved).not.toBeNull();
      expect(resolved?.host).toBe(hostRegistry.local);
      expect(resolved?.worktree.name).toBe(worktree);
    }
    expect(workspaceService.resolve("proj-missing")).toBeNull();
  });
});
