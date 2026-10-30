#!/usr/bin/env node
// macOS has no `timeout`. Usage: node scripts/with-timeout.mjs <seconds> <command> [args...]
// Runs the command in its own process group and, when the limit passes, sends
// SIGTERM to that group (SIGKILL 5 s later). Exits 124 on a timeout, like GNU timeout.
import { spawn } from "node:child_process";

const [seconds, cmd, ...args] = process.argv.slice(2);
const limit = Number(seconds);
if (!Number.isFinite(limit) || limit <= 0 || !cmd) {
  console.error("usage: with-timeout.mjs <seconds> <command> [args...]");
  process.exit(2);
}

const child = spawn(cmd, args, { stdio: "inherit", detached: true });
let timedOut = false;
const signalGroup = (signal) => {
  try {
    process.kill(-child.pid, signal);
  } catch {
    // group already gone
  }
};
const timer = setTimeout(() => {
  timedOut = true;
  console.error(`with-timeout: ${cmd} still running after ${limit}s, stopping it`);
  signalGroup("SIGTERM");
  setTimeout(() => signalGroup("SIGKILL"), 5000).unref();
}, limit * 1000);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => signalGroup(sig));
child.on("error", (err) => {
  console.error(`with-timeout: ${err.message}`);
  process.exit(127);
});
child.on("exit", (code, signal) => {
  clearTimeout(timer);
  if (timedOut) process.exit(124);
  process.exit(code ?? (signal ? 128 : 1));
});
