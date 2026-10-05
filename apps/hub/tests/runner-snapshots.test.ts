// Integration tests for the snapshot and restore hooks of a runner (plan step 3.10). A real hub (the
// production bundle on a random port, temp BAND_HOME) runs a fake runner whose hooks wrap the bundled
// `local` hook: `snapshot` copies the worker's directory (its whole "disk"), `restore` puts the copy
// back and starts the real `band-worker --ephemeral` on it, `snapshot-delete` removes the copy and
// `destroy` removes the machine. Each hook appends one line to a log the tests read.
//
// An ignored file (`.gitignore`) is the proof that the disk came back: the git state that sleep
// stores anyway does not hold it, so it survives a wake only through the snapshot.

import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_TOKEN } from "./helpers/acp-chat";
import { seedSettings, seedState } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  startServer,
  trpcData,
  trpcMutate,
  trpcQuery,
} from "./helpers/server";
import { waitFor } from "./helpers/wait-for";

const TOKEN = TEST_TOKEN;
const WORKER_BIN = join(import.meta.dirname, "../../worker/bin/band-worker.mjs");
const LOCAL_HOOKS = join(import.meta.dirname, "../../../runners/local");
const IDLE_MS = 2500;

interface Workspace {
  name: string;
  path: string;
  hostId?: string;
  lifecycle?: "sleeping" | "waking";
}
interface ProjectsList {
  projects: Array<{ name: string; worktrees: Workspace[] }>;
}
interface SnapshotsList {
  snapshots: Array<{
    id: string;
    runnerId: string;
    hostId: string;
    workspaceIds: string[];
    snapshotId: string;
    sizeBytes: number | null;
    restoredAt: number | null;
  }>;
}

const scratch: string[] = [];
const tmp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
}

function makeProject(base: string, name: string): { origin: string; checkout: string } {
  const origin = join(base, `${name}-origin.git`);
  mkdirSync(origin, { recursive: true });
  git(origin, "init", "-q", "--bare", "-b", "main");
  const checkout = join(base, name);
  git(base, "clone", "-q", origin, checkout);
  git(checkout, "checkout", "-q", "-b", "main");
  writeFileSync(join(checkout, "hello.txt"), "hello\n");
  writeFileSync(join(checkout, ".gitignore"), "ignored/\n");
  git(checkout, "add", ".");
  git(checkout, "commit", "-q", "-m", "init");
  git(checkout, "push", "-q", "origin", "main");
  return { origin, checkout };
}

const SHARED = `
log() { echo "$1" >> "$FAKE_LOG"; }
base="$BAND_RUNNER_DIR/$BAND_WORKER_ID"
`;

/** The hooks of the fake runner, as shell. Each logs `<hook> key=value ...` before it acts. */
const HOOKS: Record<string, string> = {
  "spawn.sh": `${SHARED}
log "spawn worker=$BAND_WORKER_ID"
echo "BAND_MACHINE_HANDLE=m-$BAND_WORKER_ID"
exec "$LOCAL_HOOKS/spawn.sh"
`,
  "destroy.sh": `${SHARED}
log "destroy worker=$BAND_WORKER_ID handle=\${BAND_MACHINE_HANDLE:-}"
exec "$LOCAL_HOOKS/destroy.sh"
`,
  "snapshot.sh": `${SHARED}
id="snap-$BAND_WORKER_ID-$(date +%s)-$$"
log "snapshot worker=$BAND_WORKER_ID handle=\${BAND_MACHINE_HANDLE:-} workspaces=\${BAND_WORKSPACE_IDS:-} id=$id"
mkdir -p "$FAKE_SNAPDIR"
cp -R "$base" "$FAKE_SNAPDIR/$id"
echo "BAND_SNAPSHOT_ID=$id"
echo "BAND_SNAPSHOT_SIZE=1234"
`,
  "restore.sh": `${SHARED}
log "restore worker=$BAND_WORKER_ID handle=\${BAND_MACHINE_HANDLE:-} id=$BAND_SNAPSHOT_ID token=\${BAND_BOOTSTRAP_TOKEN:+yes}"
if [ -e "$FAKE_FAIL_RESTORE" ]; then echo "restore failed on purpose" >&2; exit 1; fi
snap="$FAKE_SNAPDIR/$BAND_SNAPSHOT_ID"
[ -d "$snap" ] || { echo "no snapshot $BAND_SNAPSHOT_ID" >&2; exit 1; }
rm -rf "$base"
cp -R "$snap" "$base"
# The saved session token is revoked; the worker trades the new bootstrap token instead.
rm -f "$base/state/session-token" "$base/pid"
echo "BAND_MACHINE_HANDLE=m-$BAND_WORKER_ID"
export HOME="$base/home" BAND_HOME="$base/home/.band" BAND_WORKER_STATE_DIR="$base/state"
export BAND_WORKER_ROOTS="$base/work" BAND_WORKER_LABELS="\${BAND_LABELS:-}" BAND_WORKER_EPHEMERAL=1
cd "$base"
nohup "$BAND_NODE" "$BAND_WORKER_BIN" >"$base/worker.log" 2>&1 </dev/null &
echo $! >"$base/pid"
`,
  "snapshot-delete.sh": `${SHARED}
log "snapshot-delete worker=$BAND_WORKER_ID id=$BAND_SNAPSHOT_ID"
rm -rf "$FAKE_SNAPDIR/$BAND_SNAPSHOT_ID"
`,
};

let server: ServerHandle;
let hubHome: string;
let hooksDir: string;
let fakeLog: string;
let snapDir: string;
let failRestore: string;
let a: { origin: string; checkout: string };

const q = <T>(procedure: string, input?: unknown) =>
  trpcQuery(server.url, procedure, input, TOKEN).then(async (res) => {
    if (res.status !== 200) throw new Error(`${procedure}: HTTP ${res.status} ${await res.text()}`);
    return trpcData<T>(res);
  });
const m = <T>(procedure: string, input: unknown) =>
  trpcMutate(server.url, procedure, input, TOKEN).then(async (res) => {
    if (res.status !== 200) throw new Error(`${procedure}: HTTP ${res.status} ${await res.text()}`);
    return trpcData<T>(res);
  });

const workspace = async (project: string, name: string) =>
  (await q<ProjectsList>("projects.list")).projects
    .find((p) => p.name === project)
    ?.worktrees.find((w) => w.name === name);
const snapshots = async () => (await q<SnapshotsList>("runners.snapshots")).snapshots;

const hookLines = (hook: string) =>
  (existsSync(fakeLog) ? readFileSync(fakeLog, "utf8") : "")
    .split("\n")
    .filter((l) => l.startsWith(`${hook} `));
const field = (line: string, key: string) => new RegExp(`${key}=(\\S*)`).exec(line)?.[1] ?? "";

/** Sleep stores the git state first and then takes the snapshot, so a sleeping workspace may not have one yet. */
const snapshotTaken = (hostId: string) =>
  waitFor(async () => hookLines("snapshot").find((l) => field(l, "worker") === hostId), {
    label: `snapshot of ${hostId}`,
    timeoutMs: 60_000,
    intervalMs: 250,
  });

const runnerBase = (hostId: string) => join(hubHome, ".band", "runners", "hib", hostId);

const sleeping = (project: string, name: string) =>
  waitFor(
    async () => ((await workspace(project, name))?.lifecycle === "sleeping" ? true : undefined),
    { label: `${project}-${name} sleeps`, timeoutMs: 90_000, intervalMs: 250 },
  );
const awake = (project: string, name: string) =>
  waitFor(
    async () => {
      const wt = await workspace(project, name);
      return wt && wt.lifecycle === undefined ? wt : undefined;
    },
    { label: `${project}-${name} awake`, timeoutMs: 90_000, intervalMs: 250 },
  );

async function createWorkspace(project: string, branch: string): Promise<Workspace> {
  await m("workspaces.create", { project, branch, placement: { labels: { pool: "hib" } } });
  return waitFor(
    async () => {
      const wt = await workspace(project, branch);
      return wt?.hostId ? wt : undefined;
    },
    { label: `${project}-${branch} on a worker`, timeoutMs: 90_000, intervalMs: 250 },
  );
}

/** Work that git alone would not bring back: an edit, an untracked file and an ignored file. */
function leaveWork(worktree: string, tag: string): void {
  appendFileSync(join(worktree, "hello.txt"), `edited ${tag}\n`);
  mkdirSync(join(worktree, "notes"), { recursive: true });
  writeFileSync(join(worktree, "notes", "scratch.txt"), `scratch ${tag}\n`);
  mkdirSync(join(worktree, "ignored"), { recursive: true });
  writeFileSync(join(worktree, "ignored", "deps.txt"), `installed ${tag}\n`);
}

beforeAll(async () => {
  hubHome = createTmpHome("band-snapshots-hub-");
  scratch.push(hubHome);
  const base = tmp("band-snapshots-repos-");
  a = makeProject(base, "proja");
  hooksDir = tmp("band-snapshots-hooks-");
  fakeLog = join(hooksDir, "hooks.log");
  snapDir = join(hooksDir, "snapshots");
  failRestore = join(hooksDir, "fail-restore");
  for (const [file, body] of Object.entries(HOOKS)) {
    const path = join(hooksDir, file);
    writeFileSync(path, `#!/bin/sh\nset -eu\n${body}`);
    chmodSync(path, 0o755);
  }
  seedSettings(hubHome, {
    tokenSecret: TOKEN,
    codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
    defaultCodingAgent: "claude-code",
  });
  seedState(hubHome, {
    projects: [
      {
        name: "proja",
        path: a.checkout,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: a.checkout }],
      },
    ],
  });
  server = await startServer({
    tmpHome: hubHome,
    remoteHost: false,
    env: {
      BAND_SERVE_UI: "false",
      BAND_EPHEMERAL_IDLE_TIMEOUT_MS: String(IDLE_MS),
      BAND_SNAPSHOT_SWEEP_MS: "500",
    },
  });
  await m("settings.update", {
    runners: [
      {
        id: "hib",
        spawn: join(hooksDir, "spawn.sh"),
        destroy: join(hooksDir, "destroy.sh"),
        snapshot: join(hooksDir, "snapshot.sh"),
        restore: join(hooksDir, "restore.sh"),
        snapshotDelete: join(hooksDir, "snapshot-delete.sh"),
        // One kept snapshot: the retention test relies on it.
        snapshotKeep: 1,
        labels: { pool: "hib" },
        isolation: "process",
        maxConcurrent: 3,
        timeoutSec: 90,
        env: {
          FAKE_LOG: fakeLog,
          FAKE_SNAPDIR: snapDir,
          FAKE_FAIL_RESTORE: failRestore,
          LOCAL_HOOKS,
          BAND_WORKER_BIN: WORKER_BIN,
        },
      },
    ],
  });
}, 120_000);

afterAll(async () => {
  const base = join(hubHome ?? "", ".band", "runners", "hib");
  if (existsSync(base)) {
    for (const dir of readdirSync(base)) {
      try {
        process.kill(Number(readFileSync(join(base, dir, "pid"), "utf8").trim()), "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
  await server?.close();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
});

describe("a runner with snapshot hooks", () => {
  it("snapshots on sleep and restores the machine on wake (S1)", async () => {
    const wt = await createWorkspace("proja", "snap-a");
    const hostId = wt.hostId as string;
    leaveWork(wt.path, "a");
    // `spawn` prints a handle of its own first, and the `local` hook then prints the worker's pid. The last one counts.
    const handle = readFileSync(join(runnerBase(hostId), "pid"), "utf8").trim();
    const spawns = hookLines("spawn").length;

    await sleeping("proja", "snap-a");

    // The hook got the machine handle spawn printed and the workspaces the host held.
    const taken = await snapshotTaken(hostId);
    expect(field(taken as string, "worker")).toBe(hostId);
    expect(field(taken as string, "handle")).toBe(handle);
    expect(field(taken as string, "workspaces")).toBe("proja-snap-a");
    // The hub records the snapshot once the hook has exited, which is after the hook's own log line.
    const recorded = await waitFor(
      async () => {
        const rows = await snapshots();
        return rows.length > 0 ? rows : undefined;
      },
      { label: "the snapshot is recorded", timeoutMs: 30_000 },
    );
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      runnerId: "hib",
      hostId,
      workspaceIds: ["proja-snap-a"],
      snapshotId: field(taken as string, "id"),
      sizeBytes: 1234,
      restoredAt: null,
    });
    // The machine was destroyed after the snapshot, so nothing of its disk is left to restore from.
    await waitFor(async () => (hookLines("destroy").length > 0 ? true : undefined), {
      label: "destroy runs after the snapshot",
      timeoutMs: 30_000,
    });
    // (The exiting worker may still write a log under its home after that, so the checkouts are what is checked.)
    await waitFor(async () => (!existsSync(join(runnerBase(hostId), "work")) ? true : undefined), {
      label: "the machine is gone",
      timeoutMs: 30_000,
    });
    expect(existsSync(join(snapDir, field(taken as string, "id")))).toBe(true);

    // A file read wakes the workspace. The restore hook gets the snapshot, with a new bootstrap token.
    const file = await q<{ content: string }>("workspace.getFile", {
      workspaceId: "proja-snap-a",
      path: "hello.txt",
    });
    expect(file.content).toBe("hello\nedited a\n");
    const back = await awake("proja", "snap-a");
    const [restored] = hookLines("restore");
    expect(restored).toBeDefined();
    expect(field(restored as string, "id")).toBe(field(taken as string, "id"));
    expect(field(restored as string, "handle")).toBe("");
    expect(field(restored as string, "token")).toBe("yes");
    // The wake did not start a fresh machine.
    expect(hookLines("spawn")).toHaveLength(spawns);

    // The untracked file survived, and so did the ignored one, which no git state holds.
    expect(readFileSync(join(back.path, "notes", "scratch.txt"), "utf8")).toBe("scratch a\n");
    expect(readFileSync(join(back.path, "ignored", "deps.txt"), "utf8")).toBe("installed a\n");
    expect(git(back.path, "status", "--porcelain")).toMatch(/^ M hello\.txt$/m);
    expect(git(back.path, "log", "--format=%s")).toBe("init\n");

    // The snapshot is used up: the hook deletes it and the hub forgets it.
    await waitFor(async () => ((await snapshots()).length === 0 ? true : undefined), {
      label: "the used snapshot is deleted",
      timeoutMs: 30_000,
    });
    expect(hookLines("snapshot-delete").map((l) => field(l, "id"))).toContain(
      field(taken as string, "id"),
    );
    expect(existsSync(join(snapDir, field(taken as string, "id")))).toBe(false);
  }, 240_000);

  it("falls back to a fresh machine with git and sessions when restore fails (S2)", async () => {
    const wt = await createWorkspace("proja", "snap-b");
    const hostId = wt.hostId as string;
    leaveWork(wt.path, "b");
    await sleeping("proja", "snap-b");
    const taken = [await snapshotTaken(hostId)];
    const spawns = hookLines("spawn").length;

    writeFileSync(failRestore, "");
    try {
      const file = await q<{ content: string }>("workspace.getFile", {
        workspaceId: "proja-snap-b",
        path: "hello.txt",
      });
      expect(file.content).toBe("hello\nedited b\n");
    } finally {
      rmSync(failRestore, { force: true });
    }
    const back = await awake("proja", "snap-b");

    // restore ran with the snapshot and failed, then spawn started a fresh worker with the same id.
    const attempts = hookLines("restore").filter((l) => field(l, "worker") === hostId);
    expect(attempts.map((l) => field(l, "id"))).toEqual([field(taken[0] as string, "id")]);
    const fresh = hookLines("spawn").slice(spawns);
    expect(fresh.map((l) => field(l, "worker"))).toEqual([hostId]);

    // Nothing was lost that git holds. The ignored file was only on the disk the failed restore did not bring back.
    expect(readFileSync(join(back.path, "hello.txt"), "utf8")).toBe("hello\nedited b\n");
    expect(readFileSync(join(back.path, "notes", "scratch.txt"), "utf8")).toBe("scratch b\n");
    expect(existsSync(join(back.path, "ignored", "deps.txt"))).toBe(false);
    expect(git(back.path, "status", "--porcelain")).toMatch(/^ M hello\.txt$/m);

    // The stale snapshot is deleted too.
    await waitFor(async () => ((await snapshots()).length === 0 ? true : undefined), {
      label: "the stale snapshot is deleted",
      timeoutMs: 30_000,
    });
    expect(hookLines("snapshot-delete").map((l) => field(l, "id"))).toContain(
      field(taken[0] as string, "id"),
    );
  }, 240_000);

  it("keeps the newest snapshot and deletes the older ones through the hook (S3)", async () => {
    const before = hookLines("snapshot-delete").length;
    // Each worker may sleep, and its machine be destroyed, while the next one starts.
    const one = await createWorkspace("proja", "snap-c");
    leaveWork(one.path, "c");
    const two = await createWorkspace("proja", "snap-d");
    leaveWork(two.path, "d");
    expect(one.hostId).not.toBe(two.hostId);
    await sleeping("proja", "snap-c");
    await sleeping("proja", "snap-d");

    const taken = [
      await snapshotTaken(one.hostId as string),
      await snapshotTaken(two.hostId as string),
    ];
    // Whichever took its snapshot last is the newest.
    const [older, newer] = taken.sort(
      (x, y) => hookLines("snapshot").indexOf(x) - hookLines("snapshot").indexOf(y),
    ) as [string, string];

    // snapshotKeep is 1: the older snapshot goes through the hook, the newer one stays.
    await waitFor(
      async () => {
        const rows = await snapshots();
        return rows.length === 1 && rows[0]?.snapshotId === field(newer, "id") ? true : undefined;
      },
      { label: "only the newest snapshot is kept", timeoutMs: 30_000 },
    );
    const deleted = hookLines("snapshot-delete")
      .slice(before)
      .map((l) => field(l, "id"));
    expect(deleted).toContain(field(older, "id"));
    expect(deleted).not.toContain(field(newer, "id"));
    expect(existsSync(join(snapDir, field(older, "id")))).toBe(false);
    expect(existsSync(join(snapDir, field(newer, "id")))).toBe(true);

    // The workspace whose snapshot is gone still wakes, from the git state sleep stored.
    const lost = field(older, "worker") === one.hostId ? "snap-c" : "snap-d";
    const file = await q<{ content: string }>("workspace.getFile", {
      workspaceId: `proja-${lost}`,
      path: "hello.txt",
    });
    expect(file.content).toBe(`hello\nedited ${lost === "snap-c" ? "c" : "d"}\n`);
  }, 240_000);
});
