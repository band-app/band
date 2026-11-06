// Integration tests for the built-in hub updater (S1 to S4): the hub backs up its database,
// installs with npm, restarts through the service manager, checks /api/health, and rolls back.
// npm and systemctl are stub scripts that record their calls, and /api/health of the restarted
// hub is an Express stub, because the test hub cannot restart itself. A real systemd restart on a
// server is checked by hand.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { type ReleasesStub, startReleasesStub } from "./fixtures/github-releases-stub";
import { seedAcpHome, startAcpServer, TEST_TOKEN } from "./helpers/acp-chat";
import { seedSettings } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  startServer,
  trpcData,
  trpcMutate,
  trpcQuery,
} from "./helpers/server";
import { testWorktreeId } from "./helpers/test-host";
import { waitFor } from "./helpers/wait-for";

const TOKEN = "hub-update-builtin-token";

interface Status {
  hubUpdate: {
    configured: boolean;
    builtIn: boolean;
    auto: boolean;
    state: string;
    error: string | null;
    deferredSince: number | null;
    logTail: string;
    lastRun: { result: string; to: string; backup: string | null; message: string } | null;
  };
}

interface Rig {
  work: string;
  npmLog: string;
  ctlLog: string;
  env: Record<string, string>;
  close: () => Promise<void>;
}

let server: ServerHandle | undefined;
let releases: ReleasesStub | undefined;
let home: string | undefined;
let rig: Rig | undefined;

/**
 * Stub npm and systemctl in a work dir. The npm stub records its arguments and "installs" the
 * version by writing it to `installed`; a `bad` file makes the health stub answer 503 for 9.0.0.
 * The health stub answers the installed version once `systemctl restart` has run.
 */
async function startRig(opts: { bad?: boolean; launchd?: boolean } = {}): Promise<Rig> {
  const work = mkdtempSync(join(tmpdir(), "band-hub-builtin-"));
  mkdirSync(join(work, "prefix"));
  writeFileSync(join(work, "installed"), "0.50.0");
  if (opts.bad) writeFileSync(join(work, "bad"), "1");
  const npmLog = join(work, "npm.log");
  const ctlLog = join(work, "ctl.log");
  const npm = join(work, "npm");
  writeFileSync(
    npm,
    `#!/bin/sh\necho "$@" >> "${npmLog}"\nfor a in "$@"; do case "$a" in @band-app/server@*) printf %s "\${a#@band-app/server@}" > "${join(work, "installed")}";; esac; done\n`,
    { mode: 0o755 },
  );
  const ctl = join(work, "systemctl");
  writeFileSync(
    ctl,
    `#!/bin/sh\necho "$@" >> "${ctlLog}"\ncase "$*" in *restart*|*start*) touch "${join(work, "restarted")}";; esac\n`,
    { mode: 0o755 },
  );
  // A launchctl that behaves like a job with KeepAlive: `kill` is followed by a respawn, which a
  // restore of the database must never race, `bootout` unloads for good, and `bootstrap` of a job
  // that is still loaded fails.
  const launchctl = join(work, "launchctl");
  writeFileSync(join(work, "loaded"), "1");
  writeFileSync(
    launchctl,
    `#!/bin/sh
echo "$@" >> "${ctlLog}"
case "$1" in
  kickstart) touch "${join(work, "restarted")}";;
  kill) touch "${join(work, "respawned")}";;
  bootout) rm -f "${join(work, "loaded")}";;
  bootstrap) if [ -e "${join(work, "loaded")}" ]; then echo "Bootstrap failed: 5: Input/output error" >&2; exit 5; fi; touch "${join(work, "loaded")}" "${join(work, "restarted")}";;
esac
`,
    { mode: 0o755 },
  );
  const app = express();
  app.get("/api/health", (_req, res) => {
    const installed = readFileSync(join(work, "installed"), "utf8");
    if (!existsSync(join(work, "restarted"))) {
      res.json({ status: "ok", version: "0.50.0" });
    } else if (installed === "9.0.0" && existsSync(join(work, "bad"))) {
      res.status(503).json({ status: "starting" });
    } else {
      res.json({ status: "ok", version: installed });
    }
  });
  const listener: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const port = (listener.address() as { port: number }).port;
  return {
    work,
    npmLog,
    ctlLog,
    env: {
      BAND_INSTALL_METHOD: "npm",
      BAND_HUB_SERVICE_MANAGER: opts.launchd ? "launchd" : "systemd",
      BAND_LAUNCHCTL_BIN: launchctl,
      BAND_HUB_LAUNCHD_PLIST: join(work, "app.band.hub.plist"),
      BAND_HUB_INSTALL_PREFIX: join(work, "prefix"),
      BAND_NPM_BIN: npm,
      BAND_SYSTEMCTL_BIN: ctl,
      BAND_HUB_UPDATE_HEALTH_URL: `http://127.0.0.1:${port}/api/health`,
      BAND_HUB_UPDATE_HEALTH_TIMEOUT_MS: "1500",
      BAND_HUB_UPDATE_HEALTH_POLL_MS: "100",
      BAND_HUB_UPDATE_AUTO_POLL_MS: "200",
    },
    close: async () => {
      await new Promise((r) => listener.close(r));
      rmSync(work, { recursive: true, force: true });
    },
  };
}

async function boot(
  settings: Record<string, unknown>,
  opts: { bad?: boolean; launchd?: boolean; prepare?: (work: string, home: string) => void } = {},
) {
  releases = await startReleasesStub("v9.0.0");
  rig = await startRig(opts);
  home = createTmpHome("band-hub-builtin-");
  opts.prepare?.(rig.work, home);
  seedSettings(home, { tokenSecret: TOKEN, ...settings });
  server = await startServer({
    tmpHome: home,
    env: { BAND_GITHUB_API_URL: releases.url, BAND_HUB_VERSION: "0.50.0", ...rig.env },
    remoteHost: false,
  });
  await waitFor(async () => ((await updateAvailable()) ? true : undefined), {
    label: "the release check",
  });
}

async function updateAvailable(token = TOKEN): Promise<boolean> {
  const res = await trpcQuery(server?.url ?? "", "workers.updateStatus", undefined, token);
  return (await trpcData<{ updateAvailable: boolean }>(res)).updateAvailable;
}

async function status(token = TOKEN): Promise<Status> {
  return trpcData<Status>(
    await trpcQuery(server?.url ?? "", "workers.updateStatus", undefined, token),
  );
}

const mutate = (proc: string, input: unknown = {}, token = TOKEN) =>
  trpcMutate(server?.url ?? "", proc, input, token);

const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : "");

afterEach(async () => {
  await server?.close();
  await releases?.close();
  await rig?.close();
  if (home) rmSync(home, { recursive: true, force: true, maxRetries: 10 });
  server = undefined;
  releases = undefined;
  rig = undefined;
  home = undefined;
});

describe("built-in hub update", () => {
  it("backs up the database, installs with npm, restarts and records the run", async () => {
    await boot({});
    expect((await status()).hubUpdate).toMatchObject({ configured: true, builtIn: true });
    const res = await mutate("workers.updateHub");
    expect(res.status).toBe(200);

    const done = await waitFor(
      async () => {
        const s = await status();
        return s.hubUpdate.lastRun ? s : undefined;
      },
      { label: "the run" },
    );
    expect(done.hubUpdate.lastRun).toMatchObject({ result: "ok", to: "9.0.0" });
    expect(done.hubUpdate.state).toBe("idle");

    expect(read(rig?.npmLog ?? "")).toBe(
      `i -g --prefix ${join(rig?.work ?? "", "prefix")} @band-app/server@9.0.0\n`,
    );
    expect(read(rig?.ctlLog ?? "")).toBe("--user restart band-hub\n");

    const backup = done.hubUpdate.lastRun?.backup ?? "";
    expect(backup.startsWith(join(home ?? "", ".band", "backups", "0.50.0-"))).toBe(true);
    expect(backup.endsWith(".db")).toBe(true);
    const copy = new DatabaseSync(backup, { readOnly: true });
    const tables = copy.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get();
    copy.close();
    expect(Number((tables as { n: number }).n)).toBeGreaterThan(5);
    expect(done.hubUpdate.logTail).toContain("@band-app/server@9.0.0");
  });

  it("rolls back to the previous version when the new one is not healthy", async () => {
    await boot({}, { bad: true });
    await mutate("workers.updateHub");
    const failed = await waitFor(
      async () => {
        const s = await status();
        return s.hubUpdate.state === "failed" ? s : undefined;
      },
      { label: "the rollback", timeoutMs: 20_000 },
    );
    expect(failed.hubUpdate.lastRun).toMatchObject({ result: "rolled-back", to: "9.0.0" });
    expect(failed.hubUpdate.error).toContain("did not answer /api/health");
    expect(failed.hubUpdate.error).toContain("Restored the database backup");
    expect(failed.hubUpdate.error).toContain("0.50.0 is running again");
    expect(read(rig?.npmLog ?? "")).toContain("@band-app/server@9.0.0");
    expect(read(rig?.npmLog ?? "")).toContain("@band-app/server@0.50.0");
    expect(read(rig?.ctlLog ?? "")).toBe(
      "--user restart band-hub\n--user stop band-hub\n--user start band-hub\n",
    );
    expect(existsSync(failed.hubUpdate.lastRun?.backup ?? "")).toBe(true);
    await mutate("workers.dismissHubUpdate");
    expect((await status()).hubUpdate.state).toBe("idle");
  });

  it("rolls back under launchd by unloading the job, so KeepAlive cannot respawn it mid-restore", async () => {
    await boot({}, { bad: true, launchd: true });
    await mutate("workers.updateHub");
    const failed = await waitFor(
      async () => {
        const s = await status();
        return s.hubUpdate.state === "failed" ? s : undefined;
      },
      { label: "the launchd rollback", timeoutMs: 20_000 },
    );
    expect(failed.hubUpdate.lastRun).toMatchObject({ result: "rolled-back" });
    expect(failed.hubUpdate.error).toContain("0.50.0 is running again");
    const uid = process.getuid?.() ?? 0;
    const target = `gui/${uid}/app.band.hub`;
    expect(read(rig?.ctlLog ?? "")).toBe(
      `kickstart -k ${target}\nbootout ${target}\nbootstrap gui/${uid} ${join(rig?.work ?? "", "app.band.hub.plist")}\n`,
    );
    expect(existsSync(join(rig?.work ?? "", "respawned"))).toBe(false);
    expect(existsSync(join(rig?.work ?? "", "loaded"))).toBe(true);
  });

  it("keeps the newest 5 backups after a successful update, or the number in hubUpdate.keepBackups", async () => {
    const old = (work: string, home: string, count: number) => {
      void work;
      const dir = join(home, ".band", "backups");
      mkdirSync(dir, { recursive: true });
      for (let i = 0; i < count; i++) {
        const f = join(dir, `0.4${i}.0-old.db`);
        writeFileSync(f, "old");
        const t = new Date(Date.now() - (count - i) * 3_600_000);
        utimesSync(f, t, t);
      }
    };
    await boot({}, { prepare: (w, h) => old(w, h, 7) });
    await mutate("workers.updateHub");
    const done = await waitFor(
      async () => {
        const s = await status();
        return s.hubUpdate.lastRun ? s : undefined;
      },
      { label: "the run" },
    );
    const dir = join(home ?? "", ".band", "backups");
    const left = readdirSync(dir).sort();
    expect(left).toHaveLength(5);
    // The two oldest are gone and the new backup stays.
    expect(left).not.toContain("0.40.0-old.db");
    expect(left).not.toContain("0.41.0-old.db");
    expect(left).toContain("0.46.0-old.db");
    expect(left).toContain(basename(done.hubUpdate.lastRun?.backup ?? ""));
  });

  it("honours hubUpdate.keepBackups and keeps every backup after a rollback", async () => {
    await boot(
      { hubUpdate: { keepBackups: 2 } },
      {
        bad: true,
        prepare: (_w, h) => {
          const dir = join(h, ".band", "backups");
          mkdirSync(dir, { recursive: true });
          for (const n of ["a", "b", "c"]) writeFileSync(join(dir, `${n}.db`), "old");
        },
      },
    );
    await mutate("workers.updateHub");
    await waitFor(async () => ((await status()).hubUpdate.state === "failed" ? true : undefined), {
      label: "the rollback",
      timeoutMs: 20_000,
    });
    // A failed run deletes nothing: the backups are the way back.
    expect(readdirSync(join(home ?? "", ".band", "backups"))).toHaveLength(4);
  });

  it("does nothing by itself while the auto setting is off, and a command wins over the built-in path", async () => {
    await boot({});
    await new Promise((r) => setTimeout(r, 1200));
    expect(read(rig?.npmLog ?? "")).toBe("");
    expect((await status()).hubUpdate).toMatchObject({ auto: false, state: "idle" });

    const script = join(rig?.work ?? "", "custom.sh");
    writeFileSync(script, `echo custom > "${join(rig?.work ?? "", "custom.ran")}"\n`);
    await mutate("settings.update", { hubUpdate: { command: `sh ${script}` } });
    await mutate("workers.updateHub");
    await waitFor(() => (existsSync(join(rig?.work ?? "", "custom.ran")) ? true : undefined), {
      label: "the custom command",
    });
    expect(read(rig?.npmLog ?? "")).toBe("");
  });

  it("installs by itself once the auto setting is on", async () => {
    await boot({ hubUpdate: { auto: true } });
    const done = await waitFor(
      async () => {
        const s = await status();
        return s.hubUpdate.lastRun ? s : undefined;
      },
      { label: "the automatic update" },
    );
    expect(done.hubUpdate.lastRun).toMatchObject({ result: "ok", to: "9.0.0" });
    expect(done.hubUpdate.auto).toBe(true);
  });

  it("is admin only to change the auto setting and to see the log", async () => {
    await boot({});
    const device = await trpcData<{ token: string }>(
      await mutate("tokens.createDevice", { label: "viewer", admin: false }),
    );
    const set = await mutate("settings.update", { hubUpdate: { auto: true } }, device.token);
    expect(set.status).toBe(403);
    expect((await status(device.token)).hubUpdate.logTail).toBe("");
  });
});

describe("built-in hub update with a running turn", () => {
  async function bootBusy(extra: Record<string, string>, auto = true): Promise<void> {
    releases = await startReleasesStub("v9.0.0");
    rig = await startRig();
    home = seedAcpHome("band-hub-builtin-busy-");
    seedSettings(home, {
      tokenSecret: TEST_TOKEN,
      codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
      defaultCodingAgent: "claude-code",
      hubUpdate: { auto },
    });
    server = await startAcpServer({
      home,
      turns: [{ steps: [{ say: "working " }, { waitForCancel: true }] }],
      env: { BAND_GITHUB_API_URL: releases.url, BAND_HUB_VERSION: "0.50.0", ...rig.env, ...extra },
      remoteHost: false,
    });
  }

  it("waits while a turn runs and goes ahead once the deferral passes the limit", async () => {
    // 0.0006 hours is about 2.2 s.
    await bootBusy({ BAND_HUB_UPDATE_MAX_DEFER_H: "0.0006" });
    const url = server?.url ?? "";
    // Start the turn before the release check can trigger the update.
    const sent = fetch(`${url}/api/chats/builtin-busy/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `band_token=${TEST_TOKEN}` },
      body: JSON.stringify({
        worktreeId: testWorktreeId("testrepo", "main", false),
        text: "long task",
      }),
    });
    const deferred = await waitFor(
      async () => {
        const s = await trpcData<Status>(
          await trpcQuery(url, "workers.updateStatus", undefined, TEST_TOKEN),
        );
        return s.hubUpdate.deferredSince ? s : undefined;
      },
      { label: "the deferral" },
    );
    expect(deferred.hubUpdate.state).toBe("idle");
    expect(read(rig?.npmLog ?? "")).toBe("");
    await sent;

    await waitFor(() => (read(rig?.npmLog ?? "") !== "" ? true : undefined), {
      label: "the install after the limit",
      timeoutMs: 20_000,
    });
    expect(read(rig?.npmLog ?? "")).toContain("@band-app/server@9.0.0");
    // Let the supervisor finish before teardown removes the home and the health stub.
    await waitFor(
      async () => {
        const s = await trpcData<Status>(
          await trpcQuery(url, "workers.updateStatus", undefined, TEST_TOKEN),
        );
        return s.hubUpdate.lastRun ? true : undefined;
      },
      { label: "the supervisor to finish", timeoutMs: 20_000 },
    );
  });
  it("goes ahead as soon as the turn ends, well before the deferral limit", async () => {
    await bootBusy({});
    const url = server?.url ?? "";
    const worktreeId = testWorktreeId("testrepo", "main", false);
    const sent = fetch(`${url}/api/chats/builtin-busy-2/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `band_token=${TEST_TOKEN}` },
      body: JSON.stringify({ worktreeId, text: "long task" }),
    });
    await waitFor(
      async () => {
        const s = await trpcData<Status>(
          await trpcQuery(url, "workers.updateStatus", undefined, TEST_TOKEN),
        );
        return s.hubUpdate.deferredSince ? true : undefined;
      },
      { label: "the deferral" },
    );
    expect(read(rig?.npmLog ?? "")).toBe("");
    await trpcMutate(url, "tasks.abort", { worktreeId, chatId: "builtin-busy-2" }, TEST_TOKEN);
    await sent;
    await waitFor(
      async () => {
        const s = await trpcData<Status>(
          await trpcQuery(url, "workers.updateStatus", undefined, TEST_TOKEN),
        );
        return s.hubUpdate.lastRun ? s : undefined;
      },
      { label: "the update after the turn ended", timeoutMs: 20_000 },
    );
    expect(read(rig?.npmLog ?? "")).toContain("@band-app/server@9.0.0");
  });
  it("also defers while an agent is mid-turn, even when no task counts as young", async () => {
    // A task age of 0.001 minutes makes every task "old", so only the live agent can hold it.
    // The setting stays off until the agent is busy, so the update cannot start before the turn does.
    await bootBusy({ BAND_HUB_UPDATE_MAX_TASK_AGE_MIN: "0.001" }, false);
    const url = server?.url ?? "";
    const worktreeId = testWorktreeId("testrepo", "main", false);
    const sent = fetch(`${url}/api/chats/builtin-busy-3/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `band_token=${TEST_TOKEN}` },
      body: JSON.stringify({ worktreeId, text: "long task" }),
    });
    await waitFor(
      async () => {
        const res = await trpcQuery(url, "workers.hubInterruptions", undefined, TEST_TOKEN);
        const data = await trpcData<{ agents: { busy: boolean }[] }>(res);
        return data.agents.some((a) => a.busy) ? true : undefined;
      },
      { label: "the live agent" },
    );
    await trpcMutate(url, "settings.update", { hubUpdate: { auto: true } }, TEST_TOKEN);
    await waitFor(
      async () => {
        const s = await trpcData<Status>(
          await trpcQuery(url, "workers.updateStatus", undefined, TEST_TOKEN),
        );
        return s.hubUpdate.deferredSince ? true : undefined;
      },
      { label: "the deferral" },
    );
    await new Promise((r) => setTimeout(r, 800));
    expect(read(rig?.npmLog ?? "")).toBe("");
    await trpcMutate(url, "tasks.abort", { worktreeId, chatId: "builtin-busy-3" }, TEST_TOKEN);
    await sent;
    await waitFor(
      async () => {
        const s = await trpcData<Status>(
          await trpcQuery(url, "workers.updateStatus", undefined, TEST_TOKEN),
        );
        return s.hubUpdate.lastRun ? true : undefined;
      },
      { label: "the update after the agent stopped", timeoutMs: 20_000 },
    );
  });
});
