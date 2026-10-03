import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHostContract } from "@band-app/host-api/contract";
import { afterAll, beforeAll, describe, it } from "vitest";
import { LocalHost } from "../src/server/infra/host/local-host";
import { InProcessTerminalBackend } from "../src/server/infra/terminals/in-process-backend";

// Real git, real files, a real PTY and a real agent process (the scripted ACP
// stub, which `vitest.config.ts` sets in BAND_TEST_ACP_AGENT) in a temp dir.
runHostContract("LocalHost", {
  api: { describe, it, beforeAll, afterAll },
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
