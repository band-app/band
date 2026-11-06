/**
 * The script that carries a built-in hub update through the restart. The hub writes it to
 * `<BAND_HOME>/hub-update/supervisor.mjs` and starts it detached with the path of a plan file
 * (`plan.json` beside it). The hub itself cannot do this work, because installing and restarting
 * ends the process that would check the result.
 *
 * The script installs the target with npm, restarts the service, polls `/api/health` for the
 * target version, and on a timeout stops the service, installs the previous version, restores the
 * database backup and starts the service again. It records the outcome in the files named in the
 * plan. The admin token reaches it only through `BAND_HUB_UPDATE_TOKEN` in its environment.
 */
export const SUPERVISOR_SOURCE = `
import { spawn } from "node:child_process";
import { copyFileSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const plan = JSON.parse(readFileSync(process.argv[2], "utf8"));
const token = process.env.BAND_HUB_UPDATE_TOKEN || "";

function log(line) {
  appendFileSync(plan.logFile, line + "\\n");
}

function run(cmd, args) {
  log("$ " + [cmd, ...args].join(" "));
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: plan.env, stdio: ["ignore", "pipe", "pipe"] });
    const out = (d) => appendFileSync(plan.logFile, d);
    child.stdout.on("data", out);
    child.stderr.on("data", out);
    child.on("error", (err) => {
      log("could not start " + cmd + ": " + err.message);
      resolve(1);
    });
    child.on("exit", (code) => resolve(code === null ? 1 : code));
  });
}

function writeJson(file, value) {
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  renameSync(tmp, file);
}

function pruneBackups() {
  try {
    const files = readdirSync(plan.backupsDir)
      .filter((f) => f.endsWith(".db"))
      .map((f) => ({ f, t: statSync(join(plan.backupsDir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const old of files.slice(plan.keepBackups)) {
      if (join(plan.backupsDir, old.f) === plan.backup) continue;
      rmSync(join(plan.backupsDir, old.f), { force: true });
      log("removed old backup " + old.f);
    }
  } catch (err) {
    log("could not prune backups: " + err.message);
  }
}

function record(result, message) {
  const last = { from: plan.from, to: plan.to, at: Date.now(), result, backup: plan.backup, message };
  writeJson(plan.lastFile, last);
  if (result === "ok") rmSync(plan.runFile, { force: true });
  else writeJson(plan.runFile, { target: plan.to, from: plan.from, startedAt: plan.startedAt, builtIn: true, backup: plan.backup, failure: message });
}

function install(version) {
  return run(plan.npm, ["i", "-g", "--prefix", plan.prefix, "@band-app/server@" + version]);
}

function service(action) {
  if (plan.manager === "systemd") return run(plan.systemctl, ["--user", action, plan.unit]);
  const target = "gui/" + plan.uid + "/" + plan.label;
  // bootout unloads the job, so KeepAlive cannot respawn the hub while the database is restored.
  if (action === "stop") return run(plan.launchctl, ["bootout", target]);
  if (action === "start") return run(plan.launchctl, ["bootstrap", "gui/" + plan.uid, plan.plist]);
  return run(plan.launchctl, ["kickstart", "-k", target]);
}

async function healthVersion() {
  try {
    const res = await fetch(plan.healthUrl, {
      headers: { authorization: "Bearer " + token },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const body = await res.json();
    return typeof body.version === "string" ? body.version : null;
  } catch {
    return null;
  }
}

async function waitForVersion(version, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if ((await healthVersion()) === version) return true;
    await new Promise((r) => setTimeout(r, plan.pollMs));
  }
  return false;
}

async function rollback(reason) {
  log("rolling back to " + plan.from + ": " + reason);
  await service("stop");
  const installed = await install(plan.from);
  let restored = true;
  try {
    for (const suffix of ["-wal", "-shm"]) rmSync(plan.dbFile + suffix, { force: true });
    copyFileSync(plan.backup, plan.dbFile);
  } catch (err) {
    restored = false;
    log("could not restore the backup: " + err.message);
  }
  await service("start");
  const back = await waitForVersion(plan.from, plan.timeoutMs);
  const parts = [reason];
  parts.push(installed === 0 ? "Reinstalled " + plan.from + "." : "Reinstalling " + plan.from + " failed.");
  parts.push(restored ? "Restored the database backup." : "The database backup could not be restored.");
  parts.push(back ? plan.from + " is running again." : plan.from + " did not answer after the rollback.");
  record("rolled-back", parts.join(" "));
}

const installed = await install(plan.to);
if (installed !== 0) {
  record("failed", "npm could not install " + plan.to + " (exit " + installed + "). The hub was not restarted.");
  process.exit(0);
}
const restarted = await service("restart");
if (restarted !== 0) {
  await rollback("The service manager could not restart the hub (exit " + restarted + ").");
  process.exit(0);
}
if (await waitForVersion(plan.to, plan.timeoutMs)) {
  pruneBackups();
  record("ok", "Updated to " + plan.to + ".");
} else {
  await rollback(plan.to + " did not answer /api/health with its version within " + Math.round(plan.timeoutMs / 1000) + " s.");
}
`;
