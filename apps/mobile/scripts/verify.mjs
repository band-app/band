#!/usr/bin/env node
/**
 * mobile-verify: build the app, start a throwaway hub, install on a booted iOS simulator, run
 * the Maestro flows in `e2e/`, and leave screenshots and a report in `e2e/artifacts/<run>/`.
 *
 *   node scripts/verify.mjs [--skip-build] [--keep-hub] [flow-name ...]
 *
 * Flow names are file names in `e2e/` without `.yaml` (default: all of them). Needs Xcode with
 * a booted iOS simulator, Maestro, and Java 17 or newer for Maestro.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { cleanHub, restartHub, startHub, stopHub } from "./hub.mjs";
import { fillWorktrees, seedHub, startTurn, stopTurn } from "./seed.mjs";
import { APP_ROOT, appPath, BUNDLE_ID, buildForSimulator, installApp, pickSimulator } from "./ios.mjs";
import { hubIdFor } from "../src/lib/hub-store.ts";

const args = process.argv.slice(2);
const skipBuild = args.includes("--skip-build");
const keepHub = args.includes("--keep-hub");
const E2E = join(APP_ROOT, "e2e");
const allFlows = readdirSync(E2E)
  .filter((f) => f.endsWith(".yaml"))
  .map((f) => f.replace(/\.yaml$/, ""));
const wanted = args.filter((a) => !a.startsWith("--"));
const flows = wanted.length ? wanted : allFlows;
for (const f of flows) {
  if (!allFlows.includes(f)) throw new Error(`No flow e2e/${f}.yaml (have: ${allFlows.join(", ")})`);
}

/** Maestro needs Java 17+. Homebrew's openjdk@17 is keg-only, so put it on PATH here. */
function toolEnv() {
  const env = { ...process.env, MAESTRO_CLI_NO_ANALYTICS: "1", MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED: "true" };
  const jdk = "/opt/homebrew/opt/openjdk@17";
  if (!env.JAVA_HOME && existsSync(jdk)) {
    env.JAVA_HOME = `${jdk}/libexec/openjdk.jdk/Contents/Home`;
    env.PATH = `${jdk}/bin:${env.PATH}`;
  }
  env.PATH = `${process.env.HOME}/.maestro/bin:/opt/homebrew/bin:${env.PATH}`;
  return env;
}

function requireTool(cmd, hint, env) {
  if (spawnSync("sh", ["-c", `command -v ${cmd}`], { env }).status !== 0) {
    throw new Error(`${cmd} is not installed. ${hint}`);
  }
}

/**
 * A loopback server the flows call (`e2e/scripts/hub-control.js`) to drive the hub:
 * POST /stop and /start stop and restart it, /work?wt=<id>, /ask?wt=<id> and /halt?wt=<id>
 * make the scripted agent work, ask for permission or stop, /fill adds worktrees, and
 * /sleep?ms=<n> answers after n milliseconds (a flow's way to wait while the app is away).
 */
function startControlServer(hub, chats) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://control");
      const wt = url.searchParams.get("wt") ?? "";
      if (req.method !== "POST") {
        res.writeHead(404).end();
        return;
      }
      if (url.pathname === "/stop") await stopHub();
      else if (url.pathname === "/start") await restartHub();
      else if (url.pathname === "/work") await startTurn(hub, chats, wt, "work until I say stop");
      else if (url.pathname === "/ask") await startTurn(hub, chats, wt, "ask before you run the tests");
      else if (url.pathname === "/halt") await stopTurn(hub, chats, wt);
      else if (url.pathname === "/fill") await fillWorktrees(hub, Number(url.searchParams.get("n") ?? 12));
      else if (url.pathname === "/sleep") {
        await new Promise((r) => setTimeout(r, Number(url.searchParams.get("ms") ?? 1000)));
      } else {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200).end("ok");
    } catch (err) {
      res.writeHead(500).end(String(err.message));
    }
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

/**
 * Files in the app's data container that hold the token. Each flow starts with `clearState`,
 * which empties the container, so this runs after every flow.
 */
function tokenInFiles(udid, token) {
  let container = "";
  try {
    container = execFileSync("xcrun", ["simctl", "get_app_container", udid, BUNDLE_ID, "data"], {
      encoding: "utf8",
    }).trim();
  } catch {
    return [];
  }
  const grep = spawnSync("grep", ["-rl", "--", token, container], { encoding: "utf8" });
  return grep.stdout.trim() ? grep.stdout.trim().split("\n") : [];
}

/** Whether the app's log lines since `since` hold any of the tokens, and how many lines were searched. */
function tokenInLog(udid, tokens, since) {
  const log = execFileSync(
    "xcrun",
    ["simctl", "spawn", udid, "log", "show", "--style", "compact", "--start", since, "--predicate", 'process == "Band"'],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  return { found: tokens.some((t) => log.includes(t)), lines: log.split("\n").length };
}

function run(cmd, cmdArgs, opts) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, cmdArgs, opts);
    child.on("error", reject);
    child.on("exit", (code) => resolve(code));
  });
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

async function main() {
  const env = toolEnv();
  requireTool("xcrun", "Install Xcode and its command line tools.", env);
  requireTool("maestro", "See the one-time setup in .claude/skills/mobile-verify/SKILL.md.", env);
  requireTool("java", "brew install openjdk@17", env);

  const app = appPath();
  if (!skipBuild || !existsSync(app)) buildForSimulator();

  const hub = await startHub();
  console.log(`Hub at ${hub.url} (home ${hub.home})`);
  const chats = await seedHub(hub);
  const control = await startControlServer(hub, chats);
  const controlUrl = `http://127.0.0.1:${control.address().port}`;

  const device = pickSimulator();
  installApp(device.udid, app);

  const out = join(E2E, "artifacts", stamp());
  mkdirSync(out, { recursive: true });
  // `log show --start` reads the time as local time; sv-SE formats it as YYYY-MM-DD HH:MM:SS.
  const since = new Date(Date.now() - 1000).toLocaleString("sv-SE");
  // The token wrong-token.yaml types; the app must not keep it anywhere either.
  const wrongToken = "bdt_this_token_does_not_exist";
  const tokens = [hub.deviceToken, wrongToken];
  // The same hub under a second origin, so a flow can pair two hubs.
  const altUrl = hub.url.replace("127.0.0.1", "localhost");
  const pairLink = `band://pair?url=${encodeURIComponent(hub.url)}&token=${encodeURIComponent(hub.deviceToken)}`;

  const results = [];
  for (const flow of flows) {
    console.log(`\n=== ${flow} ===`);
    const flowOut = join(out, flow);
    mkdirSync(flowOut, { recursive: true });
    // Async on purpose: the control server above must keep answering while Maestro runs.
    const status = await run(
      "maestro",
      [
        "--device",
        device.udid,
        "test",
        join(E2E, `${flow}.yaml`),
        "--test-output-dir",
        flowOut,
        "-e",
        `HUB_URL=${hub.url}`,
        "-e",
        `TOKEN=${hub.deviceToken}`,
        "-e",
        `PAIR_LINK=${pairLink}`,
        "-e",
        `CONTROL_URL=${controlUrl}`,
        "-e",
        `WRONG_TOKEN=${wrongToken}`,
        "-e",
        `HUB_URL_ALT=${altUrl}`,
        "-e",
        `HUB_ID=${hubIdFor(hub.url)}`,
        "-e",
        `HUB_ID_ALT=${hubIdFor(altUrl)}`,
      ],
      { cwd: flowOut, env, stdio: "inherit" },
    );

    const leakedFiles = tokens.flatMap((t) => tokenInFiles(device.udid, t));
    results.push({ flow, ok: status === 0, leakedFiles });
  }

  const log = tokenInLog(device.udid, tokens, since);
  // A search that found almost no lines searched the wrong window, which proves nothing.
  const logSearched = log.lines >= 10;
  const leaks = [...(log.found ? ["the app's log"] : []), ...results.flatMap((r) => r.leakedFiles)];
  control.close();
  if (!keepHub) await cleanHub();

  const screenshots = readdirSync(out, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith(".png"));
  const report = [
    `# mobile-verify ${new Date().toISOString()}`,
    "",
    `Simulator: ${device.name} (${device.udid}), app: ${app}`,
    "",
    "| Flow | Result |",
    "| --- | --- |",
    ...results.map((r) => `| ${r.flow} | ${r.ok ? "pass" : "FAIL"} |`),
    "",
    `Token in logs or app files: ${leaks.length ? `FOUND in ${leaks.join(", ")}` : `none (searched ${log.lines} log lines, and the app's data container after each flow)`}`,
    ...(logSearched ? [] : [`Log search: FAILED, only ${log.lines} lines of the app's log since ${since}`]),
    "",
    "Screenshots:",
    ...screenshots.map((s) => `- e2e/artifacts/${out.split("/").pop()}/${s}`),
    "",
  ].join("\n");
  writeFileSync(join(out, "report.md"), report);
  console.log(`\n${report}`);
  console.log(`Report: ${join(out, "report.md")}`);
  if (results.some((r) => !r.ok) || leaks.length || !logSearched) process.exit(1);
}

main().catch(async (err) => {
  console.error(err.message);
  if (!keepHub) await cleanHub().catch(() => {});
  process.exit(1);
});
