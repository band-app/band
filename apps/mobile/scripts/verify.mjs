#!/usr/bin/env node
/**
 * mobile-verify: build the app, start a throwaway hub, install on a booted iOS simulator, run
 * the Maestro flows in `e2e/`, and leave screenshots and a report in `e2e/artifacts/<run>/`.
 *
 *   node scripts/verify.mjs [--skip-build] [--keep-hub] [--perf] [flow-name ...]
 *
 * Flow names are file names in `e2e/` without `.yaml` (default: every flow but the `perf-`
 * ones). `--perf` builds the app with the JS frame log (`EXPO_PUBLIC_BAND_PERF_LOG=1`) and
 * defaults to the `perf-` flows. Needs Xcode with a booted iOS simulator, Maestro, and Java 17
 * or newer for Maestro.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { expectRerun, finishBuild, startGhStub } from "./checks.mjs";
import { cleanHub, restartHub, startHub, stopHub } from "./hub.mjs";
import {
  addSubscription,
  chatSubscriptions,
  fillWorktrees,
  receivedPrompts,
  seedHub,
  sessionState,
  sharedTabs,
  startTurn,
  STREAM_LINES,
  stopTurn,
  termList,
  termOpen,
  termOutput,
  termSend,
  waitFor,
  webEditTabs,
} from "./seed.mjs";
import { explorerChange } from "./seed-explorer.mjs";
import { APP_ROOT, appPath, BUNDLE_ID, buildForSimulator, installApp, pickSimulator } from "./ios.mjs";
import { createRunTmp, maestroTmpEnv, removeOnExit, sweepStaleMaestroOutput } from "./run-tmp.ts";
import { hubIdFor } from "../src/lib/hub-store.ts";
import { buildRows, copyText } from "../src/lib/chat/rows.ts";
import { sessionPickers } from "@band-app/client/session-pickers";
import { foldEvents, INITIAL_TRANSCRIPT } from "@band-app/client/transcript";

const args = process.argv.slice(2);
const skipBuild = args.includes("--skip-build");
const keepHub = args.includes("--keep-hub");
const perf = args.includes("--perf");
const E2E = join(APP_ROOT, "e2e");
const allFlows = readdirSync(E2E)
  .filter((f) => f.endsWith(".yaml"))
  .map((f) => f.replace(/\.yaml$/, ""))
  // Sorted: the tab flows build on each other (t1 to t6), and readdir promises no order.
  .sort();
const wanted = args.filter((a) => !a.startsWith("--"));
const flows = wanted.length ? [...wanted].sort() : allFlows.filter((f) => f.startsWith("perf-") === perf);
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

/** The simulator's clipboard. */
function clipboard(udid) {
  return execFileSync("xcrun", ["simctl", "pbpaste", udid], { encoding: "utf8" });
}

/**
 * A chat as the hub has it: the events a cold subscribe replays, folded by the shared reducer.
 * Reads `/api/chats/:id/events` until `history-meta`, then hangs up.
 */
async function hubTranscript(hub, chatId) {
  const abort = new AbortController();
  const res = await fetch(`${hub.url}/api/chats/${encodeURIComponent(chatId)}/events`, {
    headers: { Authorization: `Bearer ${hub.adminToken}`, Accept: "text/event-stream" },
    signal: abort.signal,
  });
  if (!res.ok) throw new Error(`events of ${chatId}: HTTP ${res.status}`);
  const events = [];
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let end = buffer.indexOf("\n\n");
      while (end !== -1) {
        const data = buffer
          .slice(0, end)
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .join("\n");
        buffer = buffer.slice(end + 2);
        end = buffer.indexOf("\n\n");
        if (!data) continue;
        const event = JSON.parse(data);
        events.push(event);
        if (event.type === "history-meta") throw new Error("done");
      }
    }
  } catch (err) {
    if (err.message !== "done") throw err;
  } finally {
    abort.abort();
  }
  if (!events.some((e) => e.type === "history-meta")) {
    throw new Error(`events of ${chatId}: the stream ended before history-meta`);
  }
  return { events, state: foldEvents(INITIAL_TRANSCRIPT, events) };
}

/**
 * S4's check: the text the app copied from the last turn equals the hub's, and every streamed
 * line is in it exactly once, in order.
 */
async function checkTranscript(hub, chats, worktreeId, udid) {
  const { events, state } = await hubTranscript(hub, chats[worktreeId]);
  const rows = buildRows(state.messages, false);
  const expected = copyText(rows[rows.length - 1]);
  const copied = clipboard(udid);
  const chunks = events.filter(
    (e) => e.type === "update" && e.update.sessionUpdate === "agent_message_chunk",
  ).length;
  const counts = STREAM_LINES.map((line) => copied.split(line).length - 1);
  const ordered = STREAM_LINES.every((line, i) => i === 0 || copied.indexOf(line) > copied.indexOf(STREAM_LINES[i - 1]));
  const ok = copied === expected && counts.every((n) => n === 1) && ordered;
  return {
    ok,
    note: `hub: ${events.length} events, ${chunks} text chunks; app copied ${copied.length} chars, ${
      copied === expected ? "equal to" : "DIFFERENT from"
    } the hub's text; lines once each: ${counts.every((n) => n === 1)}; in order: ${ordered}`,
  };
}

/**
 * Checks the shared tab list the hub holds for a worktree against a flow's expectations:
 * `chats=<n>` chat tabs (and as many chats on the hub), `keep=<id,id>` tabs that must still be
 * listed, `has=<id,id>` and `lacks=<id,id>` chat ids, `order=<id,id>`, `active=<id>` or `active=new` (a chat
 * tab not seeded), and `label=<id>:<name>` for a chat's name on the hub.
 */
function checkTabs({ tabs, chats }, params) {
  const list = tabs?.tabs ?? [];
  const chatTabs = list.filter((t) => t.kind === "chat").map((t) => t.id);
  const problems = [];
  const want = params.get("chats");
  if (want !== null && chatTabs.length !== Number(want)) problems.push(`${chatTabs.length} chat tabs, not ${want}`);
  if (want !== null && chats.length !== Number(want)) problems.push(`${chats.length} chats on the hub, not ${want}`);
  for (const id of (params.get("keep") ?? "").split(",").filter(Boolean)) {
    if (!list.some((t) => t.id === id)) problems.push(`tab ${id} was dropped`);
  }
  for (const id of (params.get("has") ?? "").split(",").filter(Boolean)) {
    if (!chatTabs.includes(id)) problems.push(`no chat tab ${id}`);
  }
  for (const id of (params.get("lacks") ?? "").split(",").filter(Boolean)) {
    if (chatTabs.includes(id) || chats.some((c) => c.id === id)) problems.push(`chat ${id} is still there`);
  }
  // `order=<id,...>` is the exact chat tab order, with `new` for a chat not seeded as `chat_tabs_*`.
  const order = params.get("order");
  const seen = chatTabs.map((id) => (/^chat_tabs_/.test(id) ? id : "new")).join(",");
  if (order !== null && seen !== order) problems.push(`the chat tabs are in the order ${seen}, not ${order}`);
  const active = params.get("active");
  if (active === "new" && (!tabs?.active || /^chat_tabs_/.test(tabs.active) || !chatTabs.includes(tabs.active))) {
    problems.push(`the active tab is ${tabs?.active}, not a new chat`);
  } else if (active && active !== "new" && tabs?.active !== active) {
    problems.push(`the active tab is ${tabs?.active}, not ${active}`);
  }
  // `label` in ACTION, or in VALUE when the name has spaces.
  const label = params.get("label") ?? params.get("value");
  if (label) {
    const [id, name] = [label.slice(0, label.indexOf(":")), label.slice(label.indexOf(":") + 1)];
    const found = chats.find((c) => c.id === id)?.name;
    if (found !== name) problems.push(`chat ${id} is named ${found}, not ${name}`);
  }
  const note = `shared tabs ${list.map((t) => `${t.kind}:${t.id}`).join(", ")}; active ${tabs?.active}; hub chats ${chats.map((c) => `${c.id} (${c.name})`).join(", ")}`;
  return { ok: problems.length === 0, note: problems.length ? `${problems.join("; ")}. ${note}` : note };
}

/**
 * A loopback server the flows call (`e2e/scripts/hub-control.js`) to drive the hub:
 * POST /stop and /start stop and restart it, /work?wt=<id>, /ask?wt=<id> and /halt?wt=<id>
 * make the scripted agent work, ask for permission or stop (in the chat `chat=<id>` names, else
 * the worktree's first), /check-tabs?wt=<id> checks the shared tab list (`checkTabs`, retried
 * for up to 10 s), /web-tabs?wt=<id> changes it as the web would (`webEditTabs`),
 * /appearance?mode=light|dark sets the simulator's system appearance, /stream?wt=<id> streams numbered
 * lines for 45 s, /fill adds worktrees, and /sleep?ms=<n> answers after n milliseconds (a
 * flow's way to wait while the app is away). /clipboard?value=<text> fails unless the
 * simulator's clipboard holds that text, /check-transcript?wt=<id> fails unless the copied
 * last turn matches the hub's (`checkTranscript`), and /note?name=<n>&value=<v> adds a line
 * to the report (with `&max-gap=<ms>`, it fails when a frame log's longest gap is above it).
 * /explorer-change?name=<file> writes an untracked file into the delta repo's root, as an agent would.
 * /checks-finish-build completes the running job of widgets-feat-checks, and
 * /expect-rerun?run=<id>&failed=1|job=<id> fails unless the fake `gh` got that `gh run rerun`.
 * /subscribe?wt=<id> makes the worktree's chat listen for a timer, and
 * /expect-subscriptions?wt=<id>&n=<count> fails unless the hub holds that many for the chat.
 */
function startControlServer(hub, chats, udid, notes) {
  // Terminal sizes `/term-size` recorded, by tag.
  const termSizes = {};
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://control");
      const wt = url.searchParams.get("wt") ?? "";
      if (req.method !== "POST") {
        res.writeHead(404).end();
        return;
      }
      // `chat=<id>` aims /work, /ask and /halt at that chat instead of the worktree's first one.
      const chat = url.searchParams.get("chat");
      const target = chat ? { ...chats, [wt]: chat } : chats;
      if (url.pathname === "/stop") await stopHub();
      else if (url.pathname === "/start") await restartHub();
      else if (url.pathname === "/work") await startTurn(hub, target, wt, "work until I say stop");
      else if (url.pathname === "/ask") await startTurn(hub, target, wt, "ask before you run the tests");
      else if (url.pathname === "/halt") await stopTurn(hub, target, wt);
      else if (url.pathname === "/check-tabs") {
        // The phone pushes its tab list 500 ms after a change and removes a chat without waiting,
        // so the hub may not have it yet: check again until it does or 10 s pass.
        const deadline = Date.now() + 10_000;
        let result = checkTabs(await sharedTabs(hub, wt), url.searchParams);
        while (!result.ok && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 200));
          result = checkTabs(await sharedTabs(hub, wt), url.searchParams);
        }
        notes.push(`${wt}: ${result.note}`);
        if (!result.ok) throw new Error(result.note);
      }
      else if (url.pathname === "/term-open") await termOpen(hub, wt, Number(url.searchParams.get("n")));
      else if (url.pathname === "/term-send") {
        await termSend(hub, Number(url.searchParams.get("n")), url.searchParams.get("value") ?? "");
      } else if (url.pathname === "/term-expect") {
        // The shell printed `value` at least `count` times (default 1). The echo of a typed line
        // and its output count separately, so a typed `echo x` shows `x` twice.
        const n = Number(url.searchParams.get("n"));
        const want = url.searchParams.get("value") ?? "";
        const count = Number(url.searchParams.get("count") ?? 1);
        const seen = async () => (await termOutput(hub, n)).split(want).length - 1;
        await waitFor(async () => (await seen()) >= count, `${JSON.stringify(want)} x${count} in terminal ${n}`);
        notes.push(`terminal ${n}: ${JSON.stringify(want)} printed ${await seen()} times`);
      } else if (url.pathname === "/term-size") {
        // Runs `stty size` and reads "<rows> <cols>" from the output; `smaller=<tag>` needs fewer rows than that tag.
        const n = Number(url.searchParams.get("n"));
        const tag = url.searchParams.get("tag") ?? "a";
        const marker = `size-${tag}-`;
        await termSend(hub, n, `echo ${marker}$(stty size)\r`);
        let rows = 0;
        let cols = 0;
        await waitFor(async () => {
          const m = new RegExp(`${marker}(\\d+) (\\d+)`, "g");
          const all = [...(await termOutput(hub, n)).matchAll(m)];
          const last = all.at(-1);
          if (!last) return false;
          rows = Number(last[1]);
          cols = Number(last[2]);
          return true;
        }, `stty size ${tag}`);
        termSizes[tag] = { rows, cols };
        notes.push(`terminal ${n}: stty size ${tag} = ${rows} rows x ${cols} columns`);
        const than = url.searchParams.get("smaller");
        if (than && !(rows < termSizes[than].rows)) {
          throw new Error(`the shell sees ${rows} rows, not fewer than the ${termSizes[than].rows} of ${than}`);
        }
      } else if (url.pathname === "/term-count") {
        // The hub holds `n` terminals for the worktree, and the shared tab list lists the same ids.
        const want = Number(url.searchParams.get("n") ?? 0);
        const deadline = Date.now() + 10_000;
        let live = await termList(hub, wt);
        let listed = ((await sharedTabs(hub, wt)).tabs?.tabs ?? []).filter((t) => t.kind === "term");
        while ((live.length !== want || listed.length !== want) && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 200));
          live = await termList(hub, wt);
          listed = ((await sharedTabs(hub, wt)).tabs?.tabs ?? []).filter((t) => t.kind === "term");
        }
        notes.push(`${wt}: ${live.length} live terminals, ${listed.length} terminal tabs in the shared list`);
        if (live.length !== want || listed.length !== want) {
          throw new Error(`${live.length} live terminals and ${listed.length} terminal tabs, expected ${want}`);
        }
      } else if (url.pathname === "/appearance") {
        // The simulator's system appearance: light or dark.
        const mode = url.searchParams.get("mode") === "dark" ? "dark" : "light";
        execFileSync("xcrun", ["simctl", "ui", udid, "appearance", mode]);
      }
      else if (url.pathname === "/web-tabs") await webEditTabs(hub, wt);
      else if (url.pathname === "/explorer-change") explorerChange(hub, url.searchParams.get("name") ?? undefined);
      else if (url.pathname === "/subscribe") await addSubscription(hub, chats, wt);
      else if (url.pathname === "/expect-subscriptions") {
        const want = Number(url.searchParams.get("n") ?? 0);
        const subs = await chatSubscriptions(hub, chats, wt);
        notes.push(`${wt}: subscriptions.list holds ${subs.length}`);
        if (subs.length !== want) throw new Error(`the hub holds ${subs.length} subscriptions, expected ${want}`);
      }
      else if (url.pathname === "/checks-finish-build") finishBuild();
      else if (url.pathname === "/expect-rerun") {
        // `gh run rerun <run>` was called, with `--failed` (`failed=1`) or `--job <id>`.
        const want = {
          runId: Number(url.searchParams.get("run")),
          failed: url.searchParams.get("failed") === "1",
          job: url.searchParams.get("job"),
        };
        // The app's request may still be on its way: look for up to 10 s.
        const deadline = Date.now() + 10_000;
        let hit;
        for (;;) {
          try {
            hit = expectRerun(want);
            break;
          } catch (err) {
            if (Date.now() > deadline) throw err;
            await new Promise((r) => setTimeout(r, 200));
          }
        }
        notes.push(`gh run rerun ${JSON.stringify(hit)}`);
      }
      else if (url.pathname === "/stream") await startTurn(hub, chats, wt, "stream: go");
      else if (url.pathname === "/clipboard") {
        const want = url.searchParams.get("value") ?? "";
        const got = clipboard(udid);
        if (got !== want) throw new Error(`clipboard holds ${JSON.stringify(got.slice(0, 200))}`);
        notes.push(`clipboard: ${JSON.stringify(got)}`);
      } else if (url.pathname === "/clipboard-matches") {
        // The simulator's clipboard matches a regular expression (`re`).
        const re = new RegExp(url.searchParams.get("re") ?? "");
        const got = clipboard(udid);
        if (!re.test(got)) throw new Error(`clipboard holds ${JSON.stringify(got.slice(0, 200))}, not ${re}`);
        notes.push(`clipboard: ${JSON.stringify(got)}`);
      } else if (url.pathname === "/check-transcript") {
        const result = await checkTranscript(hub, chats, wt, udid);
        notes.push(`${wt}: ${result.note}`);
        if (!result.ok) throw new Error(result.note);
      } else if (url.pathname === "/note") {
        const value = url.searchParams.get("value") ?? "";
        notes.push(`${url.searchParams.get("name")}: ${value}`);
        // `max-gap=<ms>` fails the call when the frame log's longest gap is above it.
        const limit = url.searchParams.get("max-gap");
        const gap = Number(/max (\d+)ms/.exec(value)?.[1] ?? Number.NaN);
        if (limit !== null && !(gap <= Number(limit))) {
          throw new Error(`the longest JS frame gap was ${value}, over ${limit} ms`);
        }
      }
      else if (url.pathname === "/expect-prompt" || url.pathname === "/expect-no-prompt") {
        // The agent received (or never received) a prompt holding `value`. `image=1` also needs an image part.
        const want = url.searchParams.get("value") ?? "";
        const prompts = receivedPrompts(hub).filter((p) => p.text.includes(want));
        const image = url.searchParams.get("image") === "1";
        if (url.pathname === "/expect-no-prompt") {
          if (prompts.length > 0) throw new Error(`the agent received a prompt holding ${JSON.stringify(want)}`);
        } else {
          const hit = prompts.find((p) => !image || p.types.includes("image"));
          if (!hit) throw new Error(`no prompt holding ${JSON.stringify(want)}${image ? " with an image part" : ""}; got ${JSON.stringify(receivedPrompts(hub))}`);
          notes.push(`agent received ${JSON.stringify(want)}: part types ${hit.types.join(", ")}`);
        }
      } else if (url.pathname === "/expect-model") {
        // `chats.sessionState` reports the model the user picked.
        const pickers = sessionPickers(await sessionState(hub, chats, wt));
        const want = url.searchParams.get("value") ?? "";
        if (pickers.model !== want) throw new Error(`the session's model is ${pickers.model}, not ${want}`);
        notes.push(`${wt}: chats.sessionState model ${pickers.model}, mode ${pickers.mode}`);
      } else if (url.pathname === "/session-commands") {
        const names = ((await sessionState(hub, chats, wt))?.commands ?? []).map((c) => `/${c.name}`);
        notes.push(`${wt}: slash commands from the hub: ${names.join(" ")}`);
        const want = url.searchParams.get("value");
        if (want && !want.split(",").every((n) => names.includes(n))) throw new Error(`hub commands ${names}, expected ${want}`);
      } else if (url.pathname === "/fill") await fillWorktrees(hub, Number(url.searchParams.get("n") ?? 12));
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
  const swept = sweepStaleMaestroOutput();
  if (swept.removed) {
    console.log(`Removed ${swept.removed} stale Maestro output folder(s), ${(swept.bytes / 1e6).toFixed(0)} MB.`);
  }
  // Maestro's xcodebuild output (about 200 MB per flow) goes to the JVM's temp dir, so give it a dir of this run's own.
  const runTmp = createRunTmp();
  removeOnExit(runTmp);
  const env = { ...toolEnv(), ...maestroTmpEnv(runTmp.dir, process.env) };
  requireTool("xcrun", "Install Xcode and its command line tools.", env);
  requireTool("maestro", "See the one-time setup in .claude/skills/mobile-verify/SKILL.md.", env);
  requireTool("java", "brew install openjdk@17", env);

  const app = appPath();
  if (!skipBuild || !existsSync(app)) {
    buildForSimulator("Release", perf ? { EXPO_PUBLIC_BAND_PERF_LOG: "1" } : {});
  }

  const gh = await startGhStub();
  const hub = await startHub(gh.env);
  console.log(`Hub at ${hub.url} (home ${hub.home})`);
  const chats = await seedHub(hub);
  const device = pickSimulator();
  const notes = [];
  const control = await startControlServer(hub, chats, device.udid, notes);
  const controlUrl = `http://127.0.0.1:${control.address().port}`;
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
  runTmp.remove();
  await gh.stop();
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
    ...(notes.length ? ["", "Measurements and checks:", ...notes.map((n) => `- ${n}`)] : []),
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
