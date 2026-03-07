#!/usr/bin/env node

/**
 * Fake agent binary that speaks the Claude Agent SDK stdin/stdout protocol.
 *
 * Reads FAKE_AGENT_SCENARIO env var pointing to a JSON file containing an
 * array of SDK messages. Outputs them as JSONL to stdout, then exits.
 *
 * Consumes stdin to avoid EPIPE errors but does not use the data.
 */

import { readFileSync } from "node:fs";

// Drain stdin so the parent process doesn't get EPIPE
process.stdin.resume();
process.stdin.on("data", () => {});

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

for (const msg of messages) {
	process.stdout.write(JSON.stringify(msg) + "\n");
}

process.exit(exitCode);
