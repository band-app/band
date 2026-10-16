#!/usr/bin/env node
// Records real PTY output for the native terminal's replay test:
//   node scripts/record-terminal.mjs [name...]
// Each recording is a JSON-lines file in tests/fixtures/terminal/: a header line with the starting
// size, then {"o": <base64 output>} and {"r": [cols, rows]} (a resize) in the order they happened.
// Needs node-pty, which the repo only installs for the hub, so it is resolved from there.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "tests/fixtures/terminal");
const require = createRequire(join(ROOT, "../../packages/host-local/package.json"));
const pty = require("node-pty");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Runs `file args` in a PTY and plays `steps` against it: strings are input, numbers are waits, arrays resize. */
async function record(name, { file, args = [], cols = 80, rows = 24, env = {}, cwd, steps }) {
  const lines = [JSON.stringify({ name, cols, rows })];
  const term = pty.spawn(file, args, {
    name: "xterm-256color",
    cols,
    rows,
    cwd,
    env: {
      PATH: process.env.PATH,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      LANG: "en_US.UTF-8",
      ...env,
    },
  });
  term.onData((d) => lines.push(JSON.stringify({ o: Buffer.from(d, "utf8").toString("base64") })));
  for (const step of steps) {
    if (typeof step === "number") await sleep(step);
    else if (Array.isArray(step)) {
      lines.push(JSON.stringify({ r: step }));
      term.resize(step[0], step[1]);
    } else term.write(step);
  }
  await sleep(300);
  try {
    term.kill();
  } catch {}
  writeFileSync(join(OUT, `${name}.jsonl`), `${lines.join("\n")}\n`);
  console.log(`${name}: ${lines.length - 1} events`);
}

const bash = { file: "/bin/bash", args: ["--norc", "--noprofile"], env: { PS1: "$ ", BASH_SILENCE_DEPRECATION_WARNING: "1" } };

function tmpWork() {
  const dir = mkdtempSync(join(tmpdir(), "band-rec-"));
  writeFileSync(join(dir, "notes.txt"), "plain\n");
  writeFileSync(join(dir, "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "archive.tar.gz"), "x");
  return dir;
}

const recipes = {
  "ls-color": async () => {
    const cwd = tmpWork();
    await record("ls-color", {
      ...bash,
      cwd,
      env: { ...bash.env, CLICOLOR_FORCE: "1", LSCOLORS: "ExFxCxDxBxegedabagacad" },
      steps: [
        300,
        "ls -G; ls -1G\r",
        400,
        "printf '\\033[1mbold\\033[0m \\033[3mitalic\\033[0m \\033[4munder\\033[0m \\033[7mreverse\\033[0m \\033[38;5;208morange\\033[0m \\033[38;2;10;200;120mtruecolor\\033[0m \\033[48;5;19m bg \\033[0m\\n'\r",
        200,
        "printf '日本語 漢字 \\360\\237\\230\\200 e\\314\\201 wide\\n'\r",
        300,
      ],
    });
    rmSync(cwd, { recursive: true, force: true });
  },
  "less-alt": async () => {
    await record("less-alt", {
      ...bash,
      steps: [
        300,
        "seq 1 300 | sed 's/^/line /' | less\r",
        500,
        " ",
        200,
        " ",
        200,
        "j",
        "j",
        300,
      ],
    });
  },
  "vim-resize": async () => {
    const cwd = tmpWork();
    await record("vim-resize", {
      ...bash,
      cwd,
      steps: [
        300,
        "vim -u NONE -N notes.txt\r",
        600,
        "ihello from vim\r\u001b[1;32mnot an escape here\u001b\r",
        "\u001b",
        200,
        ":set number\r",
        200,
        [60, 20],
        400,
        [100, 30],
        400,
        "ggOtop line\u001b",
        400,
      ],
    });
    rmSync(cwd, { recursive: true, force: true });
  },
  "shell-resize": async () => {
    await record("shell-resize", {
      ...bash,
      steps: [
        300,
        "for i in 1 2 3 4 5 6 7 8 9 10; do echo \"row $i: the quick brown fox jumps over the lazy dog\"; done\r",
        400,
        [40, 12],
        300,
        "echo after narrow resize\r",
        300,
        [90, 30],
        300,
        "echo and wide again\r",
        300,
      ],
    });
  },
  "claude-tui": async () => {
    // A fresh HOME shows Claude Code's first-run screens: boxed layout, colors, an in-place menu.
    const home = mkdtempSync(join(tmpdir(), "band-rec-home-"));
    await record("claude-tui", {
      file: process.env.CLAUDE_BIN ?? "claude",
      cols: 100,
      rows: 32,
      cwd: home,
      env: { HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1" },
      steps: [4000, [80, 28], 1500, "\u001b[B", 600, "\u001b[A", 800, [100, 32], 1200],
    });
    rmSync(home, { recursive: true, force: true });
  },
  "build-log": async () => {
    // A fast log with a fixed footer in a scroll region, repainted inside synchronized-output
    // frames: the shape of a TUI redrawing while a build streams.
    const script = [
      "printf '\\033[2J\\033[H\\033[1;22r'",
      "for i in $(seq 1 120); do",
      "  printf '\\033[?2026h\\033[22;1H\\n\\033[32mok\\033[0m step %03d \\033[2mtook %dms\\033[0m' $i $((i*7%90))",
      "  printf '\\033[23;1H\\033[7m building %d/120 \\033[0m\\033[K\\033[?2026l' $i",
      "done",
      "printf '\\033[r\\033[24;1H\\n'",
    ].join("\n");
    await record("build-log", { ...bash, steps: [300, `${script}\r`, 1500] });
  },
};

const wanted = process.argv.slice(2);
mkdirSync(OUT, { recursive: true });
for (const [name, run] of Object.entries(recipes)) {
  if (wanted.length === 0 || wanted.includes(name)) await run();
}
process.exit(0);
