// DIAGNOSTIC (temporary, not for merge): measures held-key echo latency with
// the branch-status poller idle vs. running on the same server, the
// main-thread cost of a git spawn, and event-loop stalls in each process.
import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import { toWorkspaceId } from "@/dashboard";
import { execFileOffThread } from "@/server/infra/process/exec-file-worker";
import { seedSettings, seedState } from "./helpers/seed-state";
import { createTmpHome, type ServerHandle, startServer, trpcMutate } from "./helpers/server";
import { StatusStream } from "./helpers/status-stream";
import { TerminalSocket } from "./helpers/terminal-socket";
import { waitFor } from "./helpers/wait-for";

const run = process.env.BAND_ECHO_DIAG === "1";
const TOKEN = "echo-diag-token";
const PROJECT = "echoproj";
const WORKSPACE_ID = toWorkspaceId(PROJECT, "main");
const EXTRA_WORKSPACES = 72;
const REPEAT_MS = 33;
const HOLD_MS = 11_000;
const ROUNDS = Number(process.env.BAND_ECHO_DIAG_ROUNDS ?? 3);
const now = () => performance.timeOrigin + performance.now();

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@test.com",
};
function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, env: gitEnv, stdio: "ignore" });
}
function pct(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}
function summary(values: number[]) {
  return {
    n: values.length,
    p50: Math.round(pct(values, 50)),
    p95: Math.round(pct(values, 95)),
    p99: Math.round(pct(values, 99)),
    max: Math.round(Math.max(0, ...values)),
    over100: values.filter((v) => v >= 100).length,
    over150: values.filter((v) => v >= 150).length,
  };
}

/** Test-process stalls, same sampler as the probe. */
function sampleStalls(into: { end: number; lag: number }[]) {
  let last = performance.now();
  const t = setInterval(() => {
    const n = performance.now();
    const lag = n - last - 5;
    last = n;
    if (lag > 20) into.push({ end: performance.timeOrigin + n, lag: Math.round(lag) });
  }, 5);
  return () => clearInterval(t);
}

describe.runIf(run)("echo latency diagnostics", () => {
  let tmpHome: string;
  let server: ServerHandle;
  let repo: string;
  let eldFile: string;

  beforeAll(async () => {
    tmpHome = createTmpHome("band-echo-diag-");
    writeFileSync(join(tmpHome, ".zshrc"), "PROMPT='$ '\n");
    repo = join(tmpHome, PROJECT);
    mkdirSync(repo);
    git(repo, ["init", "-q", "-b", "main"]);
    writeFileSync(join(repo, "README.md"), "# echo\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-q", "-m", "init"]);
    const worktrees = [{ branch: "main", path: repo }];
    for (let i = 0; i < EXTRA_WORKSPACES; i++) {
      const path = join(tmpHome, `${PROJECT}-w${i}`);
      git(repo, ["worktree", "add", "-q", "-b", `w${i}`, path]);
      worktrees.push({ branch: `w${i}`, path });
    }
    seedState(tmpHome, {
      projects: [{ name: PROJECT, path: repo, defaultBranch: "main", worktrees }],
    });
    seedSettings(tmpHome, { tokenSecret: TOKEN });
    eldFile = join(tmpHome, "eld.ndjson");
    const probe = resolve(import.meta.dirname, "fixtures/eld-probe.mjs");
    server = await startServer({
      tmpHome,
      env: {
        BAND_DIAG_ELD_FILE: eldFile,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${probe}${process.env.BAND_DIAG_CPU_PROF ? ` --cpu-prof --cpu-prof-interval=200 --cpu-prof-dir=${process.env.BAND_DIAG_CPU_PROF}` : ""}`,
      },
    });
  }, 120_000);

  afterAll(async () => {
    await server?.close();
    rmSync(tmpHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("measures the main-thread cost of a git spawn", { timeout: 120_000 }, async () => {
    const args = ["status", "--porcelain=v2", "--branch"];
    const cwds = Array.from({ length: 100 }, (_, i) =>
      i === 0 ? repo : join(tmpHome, `${PROJECT}-w${i % EXTRA_WORKSPACES}`),
    );
    // Synchronous part of execFile on this thread (uv_spawn / posix_spawn).
    const syncMs: number[] = [];
    for (const cwd of cwds) {
      await new Promise<void>((done) => {
        const t0 = performance.now();
        const child = execFile("git", args, { cwd }, () => done());
        syncMs.push(performance.now() - t0);
        void child;
      });
    }
    // Loop stalls on this thread while 4 at a time spawn on the main thread,
    // then while the same spawns go through the exec-file worker.
    const mainStalls: { end: number; lag: number }[] = [];
    let stop = sampleStalls(mainStalls);
    let t0 = performance.now();
    let next = 0;
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        while (next < cwds.length) {
          const cwd = cwds[next++];
          await new Promise<void>((done) => execFile("git", args, { cwd }, () => done()));
        }
      }),
    );
    const mainWall = performance.now() - t0;
    stop();
    const workerStalls: { end: number; lag: number }[] = [];
    stop = sampleStalls(workerStalls);
    t0 = performance.now();
    next = 0;
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        while (next < cwds.length) {
          const cwd = cwds[next++];
          await execFileOffThread("git", args, { cwd, env: process.env, maxBuffer: 1 << 20 });
        }
      }),
    );
    const workerWall = performance.now() - t0;
    stop();
    console.log(
      "DIAG spawn",
      JSON.stringify({
        cpus: cpus().length,
        cpu: cpus()[0]?.model,
        loadavg: loadavg(),
        node: process.version,
        syncSpawnMs: {
          p50: +pct(syncMs, 50).toFixed(2),
          p95: +pct(syncMs, 95).toFixed(2),
          max: +Math.max(...syncMs).toFixed(2),
        },
        main4: {
          wallMs: Math.round(mainWall),
          stallsOver20: mainStalls.length,
          maxStall: Math.max(0, ...mainStalls.map((s) => s.lag)),
        },
        worker4: {
          wallMs: Math.round(workerWall),
          stallsOver20: workerStalls.length,
          maxStall: Math.max(0, ...workerStalls.map((s) => s.lag)),
        },
      }),
    );
  });

  it("compares echo latency with the poller idle and running", { timeout: 600_000 }, async () => {
    const terminalId = randomUUID();
    const res = await trpcMutate(
      server.url,
      "terminal.create",
      { workspaceId: WORKSPACE_ID, id: terminalId },
      TOKEN,
    );
    if (res.status !== 200) throw new Error(`terminal.create ${res.status}`);
    const socket = await TerminalSocket.open(server, {
      workspaceId: WORKSPACE_ID,
      terminalId,
      token: TOKEN,
      flow: true,
    });
    socket.onOutput((text) => socket.ack(Buffer.byteLength(text)));
    socket.type("echo READY-$((20+22)); cat\r");
    await socket.waitForOutput("READY-42", 20_000);

    console.log(
      "DIAG top cpu",
      execFileSync("ps", ["-Ao", "pcpu,rss,comm", "-r"], { encoding: "utf8" })
        .split("\n")
        .slice(0, 12)
        .join(" | "),
    );
    console.log("DIAG loadavg", JSON.stringify(loadavg()));
    const testStalls: { end: number; lag: number }[] = [];
    const stopSampling = sampleStalls(testStalls);

    const hold = async () => {
      const echoes: number[] = [];
      const sent: number[] = [];
      const stop = socket.onOutput((text) => {
        const at = now();
        for (const char of text) if (char === "a") echoes.push(at);
      });
      const start = performance.now();
      while (performance.now() - start < HOLD_MS) {
        sent.push(now());
        socket.type("a");
        const nextAt = start + sent.length * REPEAT_MS;
        await new Promise((r) => setTimeout(r, Math.max(0, nextAt - performance.now())));
      }
      await waitFor(async () => echoes.length >= sent.length || undefined, { label: "all echoed" });
      stop();
      // macOS caps a canonical tty line at 1024 bytes (MAX_CANON).
      socket.type("\r");
      await new Promise((r) => setTimeout(r, 500));
      return sent.map((at, i) => ({ at, ms: echoes[i] - at }));
    };

    const results: Record<string, { at: number; ms: number }[]> = { idle: [], poller: [] };
    const perHold: string[] = [];
    const marks: { name: string; t: number }[] = [{ name: "begin", t: now() }];
    // The poller never stops once a status stream has connected (a permanent
    // status-bus listener keeps listenerCount above 0), so the only true idle
    // baseline is before the first stream opens.
    for (let i = 0; i < 2; i++) {
      marks.push({ name: `idle${i}`, t: now() });
      const rows = await hold();
      results.idle.push(...rows);
      perHold.push(`idle${i} ${JSON.stringify(summary(rows.map((r) => r.ms)))}`);
    }
    marks.push({ name: "stream-open", t: now() });
    const stream = await StatusStream.open(server.url, TOKEN);
    if (process.env.BAND_DIAG_NO_EMIT === "1") await new Promise((r) => setTimeout(r, 6_000));
    else
      await waitFor(async () => stream.branchStatuses.size > EXTRA_WORKSPACES || undefined, {
        timeoutMs: 30_000,
        label: "first poll tick",
      });
    for (let i = 0; i < ROUNDS; i++) {
      marks.push({ name: `poller${i}`, t: now() });
      const rows = await hold();
      results.poller.push(...rows);
      perHold.push(`poller${i} ${JSON.stringify(summary(rows.map((r) => r.ms)))}`);
    }
    stream.close();
    console.log(
      `DIAG variant=${process.env.BAND_DIAG_VARIANT ?? "base"} per hold`,
      perHold.join(" | "),
    );
    stopSampling();
    socket.type("\x03");
    await socket.close();

    const stalls = existsSync(eldFile)
      ? readFileSync(eldFile, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as { tag: string; end: number; lag: number })
      : [];
    const all = [...stalls, ...testStalls.map((s) => ({ tag: "vitest", ...s }))];
    const explain = (at: number, ms: number) =>
      all
        .filter((s) => s.end >= at && s.end - s.lag <= at + ms)
        .map((s) => `${s.tag.split(":")[1] || s.tag}:${s.lag}`)
        .join(" ");
    for (const [name, rows] of Object.entries(results)) {
      const slow = rows.filter((r) => r.ms >= 100);
      console.log(
        `DIAG ${process.env.BAND_DIAG_VARIANT ?? "base"} echo ${name}`,
        JSON.stringify({
          ...summary(rows.map((r) => r.ms)),
          slow: slow.map((r) => `${Math.round(r.ms)}[${explain(r.at, r.ms)}]`),
        }),
      );
    }
    const byProc: Record<string, { count: number; max: number; over100: number }> = {};
    for (const s of all) {
      const k = s.tag.split(":")[1] || s.tag;
      byProc[k] ??= { count: 0, max: 0, over100: 0 };
      byProc[k].count++;
      byProc[k].max = Math.max(byProc[k].max, s.lag);
      if (s.lag >= 100) byProc[k].over100++;
    }
    const phaseOf = (t: number) => {
      let m = marks[0];
      for (const x of marks) if (x.t <= t) m = x;
      return `${m.name}+${Math.round(t - m.t)}ms`;
    };
    console.log(
      "DIAG server/daemon stalls",
      JSON.stringify(
        stalls
          .filter((s) => !s.tag.includes("acp"))
          .map((s) => `${s.tag.split(":")[1]}:${s.lag}@${phaseOf(s.end)}`),
      ),
    );
    console.log("DIAG stalls over 20 ms by process", JSON.stringify(byProc));
  });
});
