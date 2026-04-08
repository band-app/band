#!/usr/bin/env node

/**
 * Fake agent binary that speaks the Claude Agent SDK stdin/stdout protocol.
 *
 * Reads FAKE_AGENT_SCENARIO env var pointing to a JSON file containing an
 * array of SDK messages. Outputs them as JSONL to stdout, then exits.
 *
 * Handles the SDK's bidirectional protocol:
 * - control_request from SDK (e.g. "initialize"): auto-responds with success
 * - control_response from SDK (response to our control_request): resolves
 *   any pending _wait_for_stdin waiter
 *
 * Supports a special `{ _wait_for_stdin: true }` directive that pauses output
 * until a control_response is received on stdin (used for testing interactive
 * tool callbacks like canUseTool / AskUserQuestion).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const scenarioPath = process.env.FAKE_AGENT_SCENARIO;
if (!scenarioPath) {
	console.error("FAKE_AGENT_SCENARIO env var not set");
	process.exit(1);
}

const exitCode = parseInt(process.env.FAKE_AGENT_EXIT_CODE || "0", 10);

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
process.stdin.on("data", (chunk) => {
	stdinBuffer += chunk;
	let newlineIdx;
	while ((newlineIdx = stdinBuffer.indexOf("\n")) !== -1) {
		const line = stdinBuffer.slice(0, newlineIdx).trim();
		stdinBuffer = stdinBuffer.slice(newlineIdx + 1);
		if (!line) continue;

		try {
			const msg = JSON.parse(line);

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
		// Create a file on disk (simulates what a real tool would do)
		if (msg._write_file) {
			mkdirSync(dirname(msg._write_file.path), { recursive: true });
			writeFileSync(msg._write_file.path, msg._write_file.content ?? "");
			continue;
		}
		process.stdout.write(JSON.stringify(msg) + "\n");
	}
	process.exit(exitCode);
})();
