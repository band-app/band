// Keystroke-to-echo latency benchmark for the terminal pipeline.
//
// Boots the production server (`dist/start-server.mjs`, so run
// `pnpm --filter @band-app/server build` first) against a temp home, opens
// one idle "typing" terminal plus N "flood" terminals over the real
// `/terminal` WebSocket, and measures how long each typed character takes
// to come back as echo while the flood terminals stream output.
//
// This covers the server half of the path: WebSocket in, terminal daemon (or
// the in-process pool), PTY, and back. Browser-side costs (xterm parse and
// render) are not included.
//
//   pnpm --filter @band-app/server exec tsx scripts/terminal-typing-bench.ts
//
// Env:
//   BENCH_FLOODS     comma-separated flood counts to run (default "0,1,3")
//   BENCH_FLOOD      "saturate" (unbounded output) or "tui" (60 fps
//                    full-screen redraws, ~400 KB/s) (default "saturate")
//   BENCH_KEYS       keystrokes per scenario (default 150)
//   BAND_TERMINAL_DAEMON=0  measure the in-process backend instead

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import WebSocket from "ws";
import { toWorkspaceId } from "../src/dashboard";
import { seedSettings, seedState } from "../tests/helpers/seed-state";
import { createTmpHome, type ServerHandle, startServer } from "../tests/helpers/server";

const TOKEN = "terminal-typing-bench-token";
const PROJECT = "benchproj";
const WORKSPACE_ID = toWorkspaceId(PROJECT, "main");

const FLOOD_COUNTS = (process.env.BENCH_FLOODS ?? "0,1,3").split(",").map(Number);
const FLOOD_KIND = process.env.BENCH_FLOOD ?? "saturate";
const KEYS = Number(process.env.BENCH_KEYS ?? 150);
/** Gap between keystrokes, roughly a fast typist. */
const KEY_INTERVAL_MS = 40;
const ECHO_TIMEOUT_MS = 5_000;

const FLOOD_COMMANDS: Record<string, string> = {
  saturate: `perl -e '$|=1; my $l = "\\e[32m" . ("x" x 150) . "\\e[0m\\n"; print $l while 1'`,
  tui: `perl -e '$|=1; my $i=0; while(1){ my $f="\\e[H"; for my $r (1..40){ $f .= "\\e[3" . (($r+$i)%7+1) . "m" . ("=" x 150) . "\\e[0m\\e[K\\n" } print $f; $i++; select(undef,undef,undef,0.016) }'`,
};

class BenchSocket {
  private listeners = new Set<(chunk: string) => void>();
  bytes = 0;
  private constructor(private readonly ws: WebSocket) {
    ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (!isBinary) return;
      this.bytes += data.length;
      const text = data.toString("utf8");
      for (const listener of this.listeners) listener(text);
    });
  }

  static async open(server: ServerHandle, terminalId: string): Promise<BenchSocket> {
    const url = new URL(server.url);
    const ws = new WebSocket(
      `ws://${url.host}/terminal?workspaceId=${encodeURIComponent(WORKSPACE_ID)}&terminalId=${terminalId}`,
      { headers: { Cookie: `band_token=${TOKEN}` } },
    );
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    const socket = new BenchSocket(ws);
    ws.send(JSON.stringify({ type: "attach", cols: 160, rows: 45 }));
    return socket;
  }

  send(data: string): void {
    this.ws.send(data);
  }

  /** Resolves with the time the first chunk containing `text` arrived. */
  waitFor(text: string, timeoutMs = ECHO_TIMEOUT_MS): Promise<number> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(listener);
        reject(new Error(`timed out waiting for ${JSON.stringify(text)}`));
      }, timeoutMs);
      const listener = (chunk: string) => {
        if (!chunk.includes(text)) return;
        clearTimeout(timer);
        this.listeners.delete(listener);
        resolve(performance.now());
      };
      this.listeners.add(listener);
    });
  }

  close(): void {
    this.ws.close();
  }
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function runScenario(server: ServerHandle, floods: number): Promise<void> {
  const typing = await BenchSocket.open(server, randomUUID());
  // Wait for a prompt, then make sure the shell is idle.
  typing.send("echo READY_$((20+22))\r");
  await typing.waitFor("READY_42", 15_000);
  await sleep(300);

  const flooders: BenchSocket[] = [];
  for (let i = 0; i < floods; i++) {
    const flood = await BenchSocket.open(server, randomUUID());
    flood.send(`${FLOOD_COMMANDS[FLOOD_KIND]}\r`);
    flooders.push(flood);
  }
  // Let the floods reach steady state.
  if (floods > 0) await sleep(1_500);
  const floodBytesBefore = flooders.reduce((sum, f) => sum + f.bytes, 0);
  const started = performance.now();

  const samples: number[] = [];
  let timeouts = 0;
  const alphabet = "abcdefghijklmnopqrstuvwxyz";
  for (let i = 0; i < KEYS; i++) {
    const key = alphabet[i % alphabet.length];
    const echoed = typing.waitFor(key);
    const sentAt = performance.now();
    typing.send(key);
    try {
      samples.push((await echoed) - sentAt);
    } catch {
      timeouts++;
    }
    // Keep the line short: clear it every 40 keys.
    if (i % 40 === 39) {
      typing.send("\x15");
      await sleep(50);
    }
    await sleep(KEY_INTERVAL_MS);
  }
  const elapsed = (performance.now() - started) / 1000;
  const floodBytes = flooders.reduce((sum, f) => sum + f.bytes, 0) - floodBytesBefore;

  for (const flood of flooders) {
    flood.send("\x03");
    flood.close();
  }
  typing.close();

  samples.sort((a, b) => a - b);
  const fmt = (n: number) => n.toFixed(1).padStart(7);
  console.log(
    `floods=${floods} kind=${FLOOD_KIND} n=${samples.length} timeouts=${timeouts}` +
      `  p50=${fmt(percentile(samples, 50))}ms p90=${fmt(percentile(samples, 90))}ms` +
      ` p99=${fmt(percentile(samples, 99))}ms max=${fmt(samples[samples.length - 1] ?? 0)}ms` +
      `  flood=${(floodBytes / 1024 / 1024 / elapsed).toFixed(1)} MB/s`,
  );
}

async function main(): Promise<void> {
  const tmpHome = createTmpHome("band-typing-bench-");
  const worktree = join(tmpHome, PROJECT);
  mkdirSync(worktree, { recursive: true });
  // No rc files: keep zsh from running its new-user wizard.
  writeFileSync(join(tmpHome, ".zshrc"), "PROMPT='$ '\n");
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
  const server = await startServer({ tmpHome });
  const backend = process.env.BAND_TERMINAL_DAEMON === "0" ? "in-process" : "daemon";
  console.log(`backend=${backend}`);
  try {
    for (const floods of FLOOD_COUNTS) await runScenario(server, floods);
  } finally {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
