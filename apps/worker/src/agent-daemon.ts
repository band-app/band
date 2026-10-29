// Entry point of the worker's agent daemon: the detached process that holds every chat agent's
// ACP process so agents survive a worker restart. Bundled to `dist/agent-daemon.mjs` by
// `scripts/build.mjs`; launched by the worker (`src/agents.ts`), never by hand.
//
//   agent-daemon.mjs --run-dir <state dir>/run/agents --build-id <id> [--supersede <dev>:<ino>]

import { runAgentDaemonMain } from "@band-app/host-local/agents/daemon/main";

await runAgentDaemonMain(import.meta.url);
