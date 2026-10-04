import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { runHostContract } from "@band-app/host-api/contract";
import { LocalHost } from "../src/local-host";
import { InProcessTerminalBackend } from "../src/terminals/in-process-backend";

// The scripted ACP stub the hub integration tests use stands in for the coding
// agent, instead of the real adapters.
process.env.BAND_TEST_ACP_AGENT ??= fileURLToPath(
  new URL("../../../apps/hub/tests/fixtures/acp-stub-agent.mjs", import.meta.url),
);

// Real git, real files, a real PTY and a real agent process (the scripted ACP
// stub, set in BAND_TEST_ACP_AGENT above) in a temp dir.
runHostContract("LocalHost", {
  api: { describe, it, beforeAll: before, afterAll: after },
  async create() {
    // realpath: macOS's tmpdir is a symlink, and git reports resolved paths.
    const workDir = await realpath(await mkdtemp(join(tmpdir(), "band-host-contract-")));
    const pty = new InProcessTerminalBackend();
    const host = new LocalHost({ terminalBackend: () => pty });
    return {
      host,
      workDir,
      async dispose() {
        await pty.close();
        await rm(workDir, { recursive: true, force: true });
      },
    };
  },
});
