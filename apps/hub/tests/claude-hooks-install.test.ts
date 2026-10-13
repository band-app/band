// The Claude Code hooks Band writes into `~/.claude/settings.json`, per host.
//
// Nothing installs by itself: a boot, a login or opening the dashboard leaves
// the file alone. A person installs or removes Band's hooks on a host from the
// banner or Settings (`hooks.install` / `hooks.remove`), and each host's file is
// its own. A fake `band` on PATH stands in for the CLI; nothing runs it.

import { type ChildProcess, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedSettings } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  startServer,
  trpcData,
  trpcMutate,
  trpcQuery,
} from "./helpers/server";
import { waitFor } from "./helpers/wait-for";

const TOKEN = "claude-hooks-install-token";
const WORKER_BIN = join(import.meta.dirname, "../../worker/bin/band-worker.mjs");
const USER_HOOK = { type: "command", command: "/usr/bin/true user-own-hook" };

type HookEntry = { hooks: { type: string; command: string }[] };
interface HostHooks {
  hostId: string;
  name: string;
  online: boolean;
  status: { installed: boolean; outdated: boolean; other_hooks_exist: boolean } | null;
}

function settingsPath(home: string): string {
  return join(home, ".claude", "settings.json");
}

function readSettings(home: string): { hooks?: Record<string, HookEntry[]> } | undefined {
  try {
    return JSON.parse(readFileSync(settingsPath(home), "utf-8"));
  } catch {
    return undefined;
  }
}

const bandEntries = (home: string) =>
  Object.values(readSettings(home)?.hooks ?? {})
    .flat()
    .filter((e) => e.hooks.some((h) => h.command.includes("notify")));

function fakeBand(home: string): string {
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "band"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "band"), 0o755);
  return bin;
}

describe("Claude Code hooks per host", () => {
  const scratch: string[] = [];
  const tmp = (prefix: string) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    scratch.push(dir);
    return dir;
  };

  let server: ServerHandle;
  let hubHome: string;
  let workerHome: string;
  let worker: ChildProcess;
  let workerId: string;
  const untouched = JSON.stringify({ hooks: { Stop: [{ hooks: [USER_HOOK] }] } });

  const query = async <T>(procedure: string, input?: unknown) => {
    const res = await trpcQuery(server.url, procedure, input, TOKEN);
    if (res.status !== 200) throw new Error(`${procedure}: HTTP ${res.status}`);
    return trpcData<T>(res);
  };
  const mutate = async (procedure: string, input?: unknown) => {
    const res = await trpcMutate(server.url, procedure, input, TOKEN);
    if (res.status !== 200) throw new Error(`${procedure}: HTTP ${res.status} ${await res.text()}`);
  };
  const hosts = async () => (await query<{ hosts: HostHooks[] }>("hooks.hosts")).hosts;
  const hostHooks = async (id: string) => (await hosts()).find((h) => h.hostId === id);

  beforeAll(async () => {
    hubHome = createTmpHome("band-claude-hooks-");
    scratch.push(hubHome);
    seedSettings(hubHome, { tokenSecret: TOKEN });
    const hubBin = fakeBand(hubHome);

    // The hub's settings hold a user hook and Band's old entry from before this
    // version. A boot must leave them exactly as they are.
    mkdirSync(join(hubHome, ".claude"), { recursive: true });
    writeFileSync(settingsPath(hubHome), untouched);

    server = await startServer({
      tmpHome: hubHome,
      env: { PATH: `${hubBin}:${process.env.PATH ?? ""}` },
    });

    // A worker with its own HOME, and so its own settings file.
    workerHome = tmp("band-hooks-worker-home-");
    const workerBin = fakeBand(workerHome);
    const issued = await trpcMutate(
      server.url,
      "tokens.issueWorkerBootstrap",
      { hostName: "Hooks worker", labels: ["test"] },
      TOKEN,
    ).then((r) => trpcData<{ token: string; hostId: string }>(r));
    workerId = issued.hostId;
    worker = spawn(
      process.execPath,
      [
        WORKER_BIN,
        "--hub",
        server.url,
        "--token",
        issued.token,
        "--worker-id",
        issued.hostId,
        "--root",
        tmp("band-hooks-worker-root-"),
        "--state-dir",
        tmp("band-hooks-worker-state-"),
      ],
      {
        env: {
          ...process.env,
          HOME: workerHome,
          BAND_HOME: join(workerHome, ".band"),
          PATH: `${workerBin}:${process.env.PATH ?? ""}`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let workerOutput = "";
    worker.stdout?.on("data", (d) => {
      workerOutput += d;
    });
    worker.stderr?.on("data", (d) => {
      workerOutput += d;
    });
    await waitFor(async () => ((await hostHooks(workerId))?.online ? true : undefined), {
      label: "worker online",
      timeoutMs: 30_000,
    }).catch((err) => {
      throw new Error(`${err.message}\n${workerOutput}`);
    });
  }, 120_000);

  afterAll(async () => {
    worker?.kill("SIGKILL");
    await server?.close();
    for (const dir of scratch) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
  });

  it("a boot installs nothing and leaves the settings file as it was", async () => {
    // Boot's setup is done once the status check answers.
    await query("hooks.check");
    expect(readFileSync(settingsPath(hubHome), "utf-8")).toBe(untouched);
  });

  it("lists every host with its own status", async () => {
    const all = await hosts();
    // The remote-loopback CI job adds its own worker next to these two.
    expect(all.map((h) => h.hostId)).toEqual(expect.arrayContaining(["local", workerId]));
    for (const host of all) {
      expect(host.online).toBe(true);
      expect(host.status).toMatchObject({ installed: false, outdated: false });
    }
    expect((await hostHooks("local"))?.status?.other_hooks_exist).toBe(true);
  });

  it("installs on the worker only, in the worker's own settings file", async () => {
    await mutate("hooks.install", { hostId: workerId });

    expect(bandEntries(workerHome).length).toBeGreaterThan(0);
    expect(readFileSync(settingsPath(hubHome), "utf-8")).toBe(untouched);
    expect((await hostHooks(workerId))?.status?.installed).toBe(true);
    expect((await hostHooks("local"))?.status?.installed).toBe(false);
  });

  it("installs on the hub's own machine without touching the user's hook, then removes Band's entries only", async () => {
    await mutate("hooks.install", { hostId: "local" });
    const installed = readSettings(hubHome)!;
    expect(installed.hooks?.Stop?.[0]).toEqual({ hooks: [USER_HOOK] });
    expect(bandEntries(hubHome).length).toBeGreaterThan(0);
    expect((await hostHooks("local"))?.status?.installed).toBe(true);

    await mutate("hooks.remove", { hostId: "local" });
    expect(JSON.parse(readFileSync(settingsPath(hubHome), "utf-8"))).toEqual(JSON.parse(untouched));
    expect((await hostHooks("local"))?.status?.installed).toBe(false);

    // Removing from the worker leaves the file without Band's entries too.
    await mutate("hooks.remove", { hostId: workerId });
    expect(bandEntries(workerHome)).toEqual([]);
    expect(existsSync(settingsPath(workerHome))).toBe(true);
  });

  it("rejects hooks calls without the band_token cookie (401)", async () => {
    for (const procedure of ["hooks.install", "hooks.remove"]) {
      const res = await fetch(`${server.url}/trpc/${procedure}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      expect(res.status).toBe(401);
    }
  });

  it("refuses a host that is not known", async () => {
    const res = await trpcMutate(server.url, "hooks.install", { hostId: "h-nobody" }, TOKEN);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
