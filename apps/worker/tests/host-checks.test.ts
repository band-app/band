import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { formatHostWarnings, hostWarnings, readLinuxHostSettings } from "../src/host-checks.ts";
import { cleanup, tmpDir } from "./helpers.ts";

const dirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = tmpDir(prefix);
  dirs.push(dir);
  return dir;
}

/** A fake /proc with the files the checks read. */
function fakeProc(opts: { memKb: number; swapKb: number; watches?: number }): string {
  const proc = tempDir("band-fake-proc-");
  writeFileSync(
    join(proc, "meminfo"),
    `MemTotal:        ${opts.memKb} kB\nMemFree:         1024 kB\nSwapCached:            0 kB\nSwapTotal:       ${opts.swapKb} kB\nSwapFree:        ${opts.swapKb} kB\n`,
  );
  if (opts.watches !== undefined) {
    mkdirSync(join(proc, "sys", "fs", "inotify"), { recursive: true });
    writeFileSync(join(proc, "sys", "fs", "inotify", "max_user_watches"), `${opts.watches}\n`);
  }
  return proc;
}

const doctorLines = (proc: string) => formatHostWarnings(hostWarnings(readLinuxHostSettings(proc)));

describe("doctor host checks", () => {
  after(() => cleanup(...dirs));

  it("warns about no swap and a low inotify limit, with the fix commands", () => {
    // The Contabo worker: 7.8 GiB, no swap, Ubuntu's default watch limit.
    const out = doctorLines(fakeProc({ memKb: 8_176_000, swapKb: 0, watches: 61_656 }));
    assert.equal(
      out,
      [
        "WARN host         no swap and 7.8 GiB of memory: builds that agents run at once can be killed for running out of memory",
        "       fix: sudo fallocate -l 8G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile",
        "       fix: grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab",
        "WARN host         fs.inotify.max_user_watches is 61656: agents that watch files fail with ENOSPC",
        "       fix: echo 'fs.inotify.max_user_watches=524288' | sudo tee /etc/sysctl.d/60-band-inotify.conf",
        "       fix: sudo sysctl --system",
        "",
      ].join("\n"),
    );
  });

  it("is quiet when the host has swap and a high enough watch limit", () => {
    assert.equal(
      doctorLines(fakeProc({ memKb: 8_176_000, swapKb: 8_388_604, watches: 524_288 })),
      "",
    );
  });

  it("does not ask for swap on a host with 16 GiB or more", () => {
    assert.equal(
      doctorLines(fakeProc({ memKb: 16 * 1024 * 1024, swapKb: 0, watches: 262_144 })),
      "",
    );
  });

  it("warns about the watch limit alone when only it is low", () => {
    const out = doctorLines(fakeProc({ memKb: 8_176_000, swapKb: 2_097_148, watches: 262_143 }));
    assert.doesNotMatch(out, /swap/);
    assert.match(out, /max_user_watches is 262143/);
  });

  it("warns about nothing it cannot read", () => {
    assert.equal(doctorLines(tempDir("band-empty-proc-")), "");
    // No max_user_watches file.
    assert.equal(doctorLines(fakeProc({ memKb: 8_176_000, swapKb: 4 })), "");
    // A meminfo with no SwapTotal line.
    const proc = fakeProc({ memKb: 8_176_000, swapKb: 0, watches: 524_288 });
    writeFileSync(join(proc, "meminfo"), "MemTotal:        8176000 kB\n");
    assert.equal(doctorLines(proc), "");
  });

  it("still warns about the watch limit when it cannot read the memory", () => {
    const proc = tempDir("band-no-meminfo-proc-");
    mkdirSync(join(proc, "sys", "fs", "inotify"), { recursive: true });
    writeFileSync(join(proc, "sys", "fs", "inotify", "max_user_watches"), "61656\n");
    const out = doctorLines(proc);
    assert.doesNotMatch(out, /swap/);
    assert.match(out, /max_user_watches is 61656/);
  });
});
