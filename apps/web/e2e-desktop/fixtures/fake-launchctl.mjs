#!/usr/bin/env node
// A stand-in for `launchctl` that tests point `BAND_LAUNCHCTL_BIN` at, so no spec touches the
// real launchd. It behaves like launchd for one label: `bootstrap` reads the plist and starts
// its ProgramArguments with only the plist's environment (plus HOME and PATH), `bootout` and
// `kickstart -k` stop or restart that process, and `print` succeeds while it runs.
// State lives in $BAND_FAKE_LAUNCHD_DIR: <label>.pid and <label>.plist.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.BAND_FAKE_LAUNCHD_DIR;
if (!dir) {
  console.error("BAND_FAKE_LAUNCHD_DIR is not set");
  process.exit(2);
}
mkdirSync(dir, { recursive: true });
const [command, ...rest] = process.argv.slice(2);

const labelOf = (target) => target.split("/").pop();
const unxml = (t) => t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function pidOf(label) {
  const file = join(dir, `${label}.pid`);
  if (!existsSync(file)) return null;
  const pid = Number(readFileSync(file, "utf8"));
  return alive(pid) ? pid : null;
}

function stop(label) {
  const pid = pidOf(label);
  rmSync(join(dir, `${label}.pid`), { force: true });
  if (pid === null) return false;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // already gone
  }
  return true;
}

function start(label, plistFile) {
  const text = readFileSync(plistFile, "utf8");
  const section = (key) => new RegExp(`<key>${key}</key>\\s*<(?:array|dict)>([\\s\\S]*?)</(?:array|dict)>`).exec(text)?.[1] ?? "";
  const program = [...section("ProgramArguments").matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) => unxml(m[1]));
  const env = { HOME: process.env.HOME, PATH: process.env.PATH };
  for (const m of section("EnvironmentVariables").matchAll(/<key>([\s\S]*?)<\/key>\s*<string>([\s\S]*?)<\/string>/g)) {
    env[unxml(m[1])] = unxml(m[2]);
  }
  const log = openSync(join(dir, `${label}.log`), "a");
  const child = spawn(program[0], program.slice(1), { env, detached: true, stdio: ["ignore", log, log] });
  child.unref();
  writeFileSync(join(dir, `${label}.pid`), String(child.pid));
  writeFileSync(join(dir, `${label}.plist`), plistFile);
}

switch (command) {
  case "bootstrap": {
    const [, plistFile] = rest;
    const label = /<key>Label<\/key>\s*<string>([^<]*)<\/string>/.exec(readFileSync(plistFile, "utf8"))?.[1];
    if (!label) process.exit(1);
    if (pidOf(label) !== null) {
      console.error("Bootstrap failed: 5: Input/output error");
      process.exit(5);
    }
    start(label, plistFile);
    break;
  }
  case "bootout":
    if (!stop(labelOf(rest[0]))) {
      console.error("Boot-out failed: 3: No such process");
      process.exit(3);
    }
    break;
  case "kickstart": {
    const label = labelOf(rest.at(-1));
    const plistFile = existsSync(join(dir, `${label}.plist`)) ? readFileSync(join(dir, `${label}.plist`), "utf8") : null;
    if (!plistFile) process.exit(113);
    stop(label);
    start(label, plistFile);
    break;
  }
  case "print":
    process.exit(pidOf(labelOf(rest[0])) === null ? 113 : 0);
    break;
  default:
    console.error(`fake launchctl: unsupported command ${command}`);
    process.exit(64);
}
