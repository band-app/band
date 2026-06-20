/**
 * Shared resolver for the path to the fake-agent stub binary used by
 * chat-related e2e specs.
 *
 * The fake-agent lives at `apps/web/tests/fake-agent.mjs` — it speaks
 * the Claude Agent SDK stdio protocol but replays a deterministic
 * scenario file instead of contacting a real LLM. Specs that
 * configure a `claude-code` agent (`chat-cancel`, `chat-send-optimistic`,
 * `chat-tool-output-routing`, `chat-virtualization`, …) all point the
 * `command` setting at the same file; resolving that path in one
 * place avoids the "if the file moves, two specs break" trap a
 * reviewer flagged on PR #562.
 */

import { join } from "node:path";

/** Absolute path to `apps/web/tests/fake-agent.mjs`. The caller's
 *  module typically passes `import.meta.dirname` to keep the
 *  computation co-located with its own file, but every caller agrees
 *  on the same target. */
export function fakeAgentPath(): string {
  // This helper itself lives at `apps/web/e2e/helpers/fake-agent.ts`.
  // `../../tests/fake-agent.mjs` is `apps/web/tests/fake-agent.mjs`.
  return join(import.meta.dirname, "..", "..", "tests", "fake-agent.mjs");
}
