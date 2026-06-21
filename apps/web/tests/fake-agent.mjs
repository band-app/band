#!/usr/bin/env node

/**
 * Fake agent binary that speaks the Claude Agent SDK stdin/stdout protocol.
 *
 * Reads FAKE_AGENT_SCENARIO env var pointing to a JSON file containing an
 * array of SDK messages. Outputs them as JSONL to stdout, then waits for the
 * SDK to close our stdin before exiting.
 *
 * Handles the SDK's bidirectional protocol:
 * - control_request from SDK (e.g. "initialize", "get_context_usage"):
 *   auto-responds with success and an empty payload
 * - control_response from SDK (response to our control_request): resolves
 *   any pending _wait_for_stdin waiter
 *
 * Supports a special `{ _wait_for_stdin: true }` directive that pauses output
 * until a control_response is received on stdin (used for testing interactive
 * tool callbacks like canUseTool / AskUserQuestion).
 *
 * IMPORTANT: we don't exit immediately after emitting the scenario. Real
 * adapters may send `control_request`s *after* the terminal `result` event
 * (e.g. claude-code's `getContextUsage()` call). Exiting early would make
 * those requests hang because there's no agent left to reply. Instead, we
 * keep the process alive and exit when stdin EOFs, which the SDK does on
 * shutdown.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const scenarioPath = process.env.FAKE_AGENT_SCENARIO;
if (!scenarioPath) {
	console.error("FAKE_AGENT_SCENARIO env var not set");
	process.exit(1);
}

const exitCode = parseInt(process.env.FAKE_AGENT_EXIT_CODE || "0", 10);

// Optional: when FAKE_AGENT_STDIN_LOG is set, every parsed stdin message
// is appended (one JSON object per line) to that file. Tests that need to
// assert the exact prompt the SDK transmitted to the agent process —
// e.g. that a queue-drained message carries the
// `I'm sharing these files with you:\n- <path>` preamble — read this log
// after the task completes. Without it the prompt is black-box.
const stdinLogPath = process.env.FAKE_AGENT_STDIN_LOG;

// Optional: when FAKE_AGENT_ENV_LOG is set, append (one JSON object per
// line) the subset of this process's environment that controls how a
// NESTED `band` CLI call would dispatch — `BAND_DISPATCH` (chat vs
// terminal) and `BAND_SERVER_URL` (which server to reach). Tests that
// assert a chat-hosted agent's nested `band workspaces create --prompt`
// would resolve to `via: chat` read this back: the Rust CLI's
// `resolve_dispatch_target` consults exactly these env vars, so recording
// what the spawned agent received proves the server injected them
// correctly. Append (not overwrite) because the server may spawn this
// stub more than once per boot — e.g. the model-refresh probe runs with
// the SDK's default env (no BAND_DISPATCH) alongside the task spawn that
// carries BAND_DISPATCH=chat — and the test looks for the task spawn's
// record rather than racing the two writers. Best-effort, at startup.
const envLogPath = process.env.FAKE_AGENT_ENV_LOG;
if (envLogPath) {
	try {
		mkdirSync(dirname(envLogPath), { recursive: true });
		appendFileSync(
			envLogPath,
			JSON.stringify({
				BAND_DISPATCH: process.env.BAND_DISPATCH ?? null,
				BAND_SERVER_URL: process.env.BAND_SERVER_URL ?? null,
			}) + "\n",
		);
	} catch {
		// best effort
	}
}

if (stdinLogPath) {
	try {
		mkdirSync(dirname(stdinLogPath), { recursive: true });
		// Record argv as well — depending on the SDK's transport, the
		// prompt may travel via stdin OR via a `--print <prompt>` argv
		// flag. Logging both keeps tests insulated from SDK changes.
		appendFileSync(
			stdinLogPath,
			JSON.stringify({ _fake_agent_argv: process.argv.slice(2) }) + "\n",
		);
	} catch {
		// best effort
	}
}

let messages;
try {
	messages = JSON.parse(readFileSync(scenarioPath, "utf-8"));
} catch (err) {
	console.error(`Failed to read scenario file: ${err.message}`);
	process.exit(1);
}

// ---------------------------------------------------------------------------
// Stdin handler: parse JSONL from the SDK
// ---------------------------------------------------------------------------
let stdinWaiter = null;
let stdinBuffer = "";

process.stdin.resume();
process.stdin.setEncoding("utf-8");
// Exit when the SDK closes our stdin. Until then we stay alive so we can
// answer late control_requests like `get_context_usage`.
process.stdin.on("end", () => process.exit(exitCode));
process.stdin.on("data", (chunk) => {
	stdinBuffer += chunk;
	let newlineIdx;
	while ((newlineIdx = stdinBuffer.indexOf("\n")) !== -1) {
		const line = stdinBuffer.slice(0, newlineIdx).trim();
		stdinBuffer = stdinBuffer.slice(newlineIdx + 1);
		if (!line) continue;

		try {
			const msg = JSON.parse(line);

			// Tee every parsed stdin message to disk if a log path was
			// configured. Append-only so two scenarios sharing a tmpHome
			// (the fake-agent spawns once per task) both end up in the log.
			if (stdinLogPath) {
				try {
					mkdirSync(dirname(stdinLogPath), { recursive: true });
					appendFileSync(stdinLogPath, JSON.stringify(msg) + "\n");
				} catch {
					// best effort
				}
			}

			if (msg.type === "control_request") {
				// SDK is sending us a control_request (e.g. initialize).
				// Respond with a success control_response so the SDK handshake
				// completes, but do NOT resolve any _wait_for_stdin waiter.
				const response = {
					type: "control_response",
					response: {
						subtype: "success",
						request_id: msg.request_id,
						response: {},
					},
				};
				process.stdout.write(JSON.stringify(response) + "\n");
			} else if (msg.type === "control_response") {
				// SDK responded to one of our control_requests (e.g. the
				// canUseTool response). Resolve the pending waiter so the
				// scenario can continue outputting messages.
				if (stdinWaiter) {
					const resolve = stdinWaiter;
					stdinWaiter = null;
					resolve();
				}
			}
		} catch {
			// Not valid JSON — ignore
		}
	}
});

// ---------------------------------------------------------------------------
// Main: output scenario messages
// ---------------------------------------------------------------------------
(async () => {
	for (const msg of messages) {
		if (msg._wait_for_stdin) {
			await new Promise((resolve) => {
				stdinWaiter = resolve;
			});
			continue;
		}
		// Pause for `_sleep_ms` before the next message — used by tests to
		// simulate long-running tasks so they can probe reconnect endpoints
		// while the task is in the "running" state.
		if (typeof msg._sleep_ms === "number") {
			await new Promise((resolve) => setTimeout(resolve, msg._sleep_ms));
			continue;
		}
		// Create a file on disk (simulates what a real tool would do)
		if (msg._write_file) {
			mkdirSync(dirname(msg._write_file.path), { recursive: true });
			writeFileSync(msg._write_file.path, msg._write_file.content ?? "");
			continue;
		}
		process.stdout.write(JSON.stringify(msg) + "\n");
	}
	if (exitCode !== 0) {
		// Crash simulation — tests that pin FAKE_AGENT_EXIT_CODE to a
		// non-zero value want the agent to die now (e.g. simulating a
		// binary segfault). Don't keep the process alive in that case.
		process.exit(exitCode);
	}
	// Otherwise keep the process alive. The SDK may still send
	// control_requests (e.g. a `getContextUsage()` triggered by the terminal
	// `result` event); exiting before responding would hang the SDK promise.
	// The stdin 'end' listener handles shutdown when the SDK is done with us.
})();
