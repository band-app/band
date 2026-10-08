import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A directory with a stub `claude` CLI that prints a version and answers `auth status` with
 * `loggedIn`. Give it to a worker as `BAND_AGENT_BIN_DIRS` and the worker reports claude-code as
 * installed and (not) logged in, whatever the machine running the test has installed.
 */
export function stubClaudeDir(loggedIn = true): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "band-stub-claude-")));
  const file = join(dir, "claude");
  writeFileSync(
    file,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "claude 2.0.0"; exit 0; fi\nif [ "$*" = "auth status" ]; then exit ${loggedIn ? 0 : 1}; fi\nexit 0\n`,
  );
  chmodSync(file, 0o755);
  return dir;
}

/** The environment entries that make a worker report the stub claude. */
export function stubClaudeEnv(dir: string): Record<string, string> {
  return { BAND_AGENT_BIN_DIRS: dir, ANTHROPIC_API_KEY: "", CLAUDE_CODE_OAUTH_TOKEN: "" };
}
