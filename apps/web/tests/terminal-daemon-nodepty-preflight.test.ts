import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { toWorkspaceId } from "@/dashboard";
import { launchDaemon } from "@/server/infra/terminals/daemon/launch";
import { daemonPaths } from "@/server/infra/terminals/daemon/protocol";
import { seedSettings, seedState } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  startServer,
  trpcData,
  trpcMutate,
} from "./helpers/server";
import { stopTerminalDaemon } from "./helpers/terminal-daemon";

// A daemon that fails to load node-pty must exit fast instead of staying up
// to serve spawn requests that would all fail the same way (Node's ESM
// loader caches a failed CommonJS evaluation for the life of the process).
//
// The daemon bundle (`dist/terminal-daemon.mjs`) is fully self-contained
// except `node-pty`, which stays external and resolves at runtime from
// whatever `node_modules` an ancestor of the entry file provides (see
// `scripts/build-server.sh`). Copying the real bundle into an isolated tmp
// directory with no such ancestor reproduces a genuine "node-pty cannot be
// found" failure through real Node module resolution — the same shape of
// failure as a broken/missing prebuild, no mocking involved.

const TOKEN = "terminal-daemon-nodepty-token";
const PROJECT = "noptyproj";
const WORKSPACE_ID = toWorkspaceId(PROJECT, "main");
const DAEMON_ENTRY = resolve(import.meta.dirname, "../dist/terminal-daemon.mjs");

describe("terminal daemon — node-pty fails to load", () => {
  let tmpHome: string;
  let server: ServerHandle | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
    await stopTerminalDaemon(tmpHome);
    rmSync(tmpHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("exits fast with a clear log line, and a fresh launch on the same paths recovers", async () => {
    tmpHome = createTmpHome("band-td-nopty-");
    const bandHome = `${tmpHome}/.band`;
    const paths = daemonPaths(`${bandHome}/run`);

    // No `node_modules` reachable from an ancestor of this copy, so its
    // `import("node-pty")` genuinely cannot resolve.
    const brokenEntry = `${tmpHome}/terminal-daemon.mjs`;
    copyFileSync(DAEMON_ENTRY, brokenEntry);

    await expect(
      launchDaemon({ entry: brokenEntry, paths, cwd: bandHome, buildId: "nopty-test" }),
    ).rejects.toThrow(/could not load its native module \(node-pty\)/);

    // The broken daemon exited before publishing anything: a fresh launch on
    // the exact same paths, from a working entry, is a completely normal
    // "nothing is running yet" launch, not a recovery from a stuck daemon.
    const outcome = await launchDaemon({
      entry: DAEMON_ENTRY,
      paths,
      cwd: bandHome,
      buildId: "nopty-test",
    });
    expect(outcome).toBe("launched");
  });

  it("the server's next spawn recovers after a daemon with the same run dir failed to load node-pty", async () => {
    tmpHome = createTmpHome("band-td-nopty-server-");
    const worktree = `${tmpHome}/${PROJECT}`;
    mkdirSync(worktree, { recursive: true });
    seedState(tmpHome, {
      projects: [
        {
          name: PROJECT,
          path: worktree,
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: worktree }],
        },
      ],
    });
    seedSettings(tmpHome, { tokenSecret: TOKEN });

    const bandHome = `${tmpHome}/.band`;
    const paths = daemonPaths(`${bandHome}/run`);
    const brokenEntry = `${tmpHome}/terminal-daemon.mjs`;
    copyFileSync(DAEMON_ENTRY, brokenEntry);
    await expect(
      launchDaemon({ entry: brokenEntry, paths, cwd: bandHome, buildId: "nopty-server-test" }),
    ).rejects.toThrow(/could not load its native module \(node-pty\)/);

    // Nothing published the endpoint, so the server's first spawn sees no
    // daemon at all and launches its own (working) one, same as if no
    // daemon had ever run here.
    server = await startServer({ tmpHome });
    const res = await trpcMutate(
      server.url,
      "terminal.create",
      { workspaceId: WORKSPACE_ID, id: randomUUID() },
      TOKEN,
    );
    expect(res.status).toBe(200);
    const created = await trpcData<{ terminalId: string; pid: number }>(res);
    expect(created.pid).toBeGreaterThan(0);
  });
});
