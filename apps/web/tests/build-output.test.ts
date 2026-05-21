import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const packageRoot = join(import.meta.dirname, "..");
const dist = join(packageRoot, "dist");

const skipSdkChecks = process.env.NPM_PUBLISH === "1";

describe("build output", () => {
  it("contains the server bundle", () => {
    expect(existsSync(join(dist, "start-server.mjs"))).toBe(true);
  });

  it("contains the OpenAPI spec", () => {
    expect(existsSync(join(dist, "openapi.json"))).toBe(true);
  });

  it("contains migrations", () => {
    const migrationsDir = join(dist, "migrations");
    expect(existsSync(migrationsDir)).toBe(true);
    expect(readdirSync(migrationsDir).length).toBeGreaterThan(0);
  });

  it("contains node-pty package.json", () => {
    expect(existsSync(join(dist, "node_modules/node-pty/package.json"))).toBe(true);
  });

  it("contains node-pty native binary on macOS", () => {
    // node-pty ships prebuilt binaries for macOS/Windows but compiles from
    // source on Linux. On CI (Linux), no native binary may be available if
    // the package manager didn't run lifecycle scripts or build tools are
    // missing. The Electron desktop app targets macOS, so this check only
    // matters there.
    if (process.platform !== "darwin") return;
    const prebuildsDir = join(dist, "node_modules/node-pty/prebuilds");
    expect(existsSync(prebuildsDir)).toBe(true);
    expect(readdirSync(prebuildsDir).length).toBeGreaterThan(0);
  });

  it("contains the @vscode/ripgrep wrapper package", () => {
    expect(existsSync(join(dist, "node_modules/@vscode/ripgrep/package.json"))).toBe(true);
    expect(existsSync(join(dist, "node_modules/@vscode/ripgrep/lib/index.js"))).toBe(true);
  });

  it("contains the host-platform ripgrep binary", () => {
    const platformPkg = `@vscode/ripgrep-${process.platform}-${process.arch}`;
    const binName = process.platform === "win32" ? "rg.exe" : "rg";
    expect(existsSync(join(dist, "node_modules", platformPkg, "bin", binName))).toBe(true);
  });

  it("contains ripgrep binaries for both archs on macOS builds", () => {
    // electron-builder emits both x64 and arm64 macOS artifacts from the same
    // `apps/web/dist`, so the off-host arch binary must also be present —
    // otherwise the off-arch DMG dies at startup with "Could not find
    // @vscode/ripgrep-darwin-x64". This regression was shipped in v0.x: the
    // build host was Apple Silicon (`runs-on: macos-latest` on Actions) and
    // the bundle only carried the arm64 ripgrep, breaking every Intel Mac
    // install. See pnpm-workspace.yaml::supportedArchitectures and
    // apps/web/scripts/build-server.sh for the matching install/copy logic.
    if (process.platform !== "darwin") return;
    if (skipSdkChecks) return; // npm publish path skips native-module copy
    for (const arch of ["x64", "arm64"]) {
      const pkg = `@vscode/ripgrep-darwin-${arch}`;
      expect(
        existsSync(join(dist, "node_modules", pkg, "bin", "rg")),
        `missing ${pkg}/bin/rg`,
      ).toBe(true);
    }
  });

  it("does NOT bundle a SQLite native module", () => {
    // SQLite is provided by Node's built-in `node:sqlite` (RC since 22.13).
    // Nothing for SQLite should ship under dist/node_modules/.
    expect(existsSync(join(dist, "node_modules/better-sqlite3"))).toBe(false);
    expect(existsSync(join(dist, "node_modules/bindings"))).toBe(false);
  });

  it.skipIf(skipSdkChecks)("does NOT bundle Claude Code SDK native binary", () => {
    // We deliberately do NOT bundle the ~206MB platform binary shipped by
    // @anthropic-ai/claude-agent-sdk-<platform>-<arch>. Band users have
    // `claude` installed already, and the SDK resolves it from PATH at
    // runtime. Keeping it out shrinks the Electron DMG by ~200MB.
    const platform = process.platform;
    const arch = process.arch;
    const candidates =
      platform === "linux"
        ? [
            `@anthropic-ai/claude-agent-sdk-linux-${arch}`,
            `@anthropic-ai/claude-agent-sdk-linux-${arch}-musl`,
          ]
        : [`@anthropic-ai/claude-agent-sdk-${platform}-${arch}`];
    const found = candidates.some((pkg) => existsSync(join(dist, "node_modules", pkg, "claude")));
    expect(found).toBe(false);
  });

  it.skipIf(skipSdkChecks)("contains Codex SDK package", () => {
    expect(existsSync(join(dist, "node_modules/@openai/codex/package.json"))).toBe(true);
  });
});

// End-to-end regression test for #475. The bug there was that
// `dist/openapi.json` was generated correctly into the build output but was
// missing from the `files` array in `package.json`, so npm stripped it from
// the published tarball. The published server then crashed silently on
// startup when start-server.ts tried to read it (the uncaughtException
// handler exited 1 before any output reached the terminal).
//
// The pre-existing `existsSync(dist/openapi.json)` check above passed all
// along while the published package was broken — checking dist/ is not
// enough. This suite goes through the same path `npx @band-app/server`
// does: pack the package, install the tarball into a fresh project, spawn
// the bin shim, and verify the server actually boots and serves the spec.
describe("published @band-app/server runs via the bin shim", () => {
  let workDir: string;
  let server: ChildProcess | undefined;
  let baseUrl: string;
  let token: string;
  let exitCode: number | null = null;
  const serverOutput: string[] = [];

  beforeAll(async () => {
    // 1. Build an isolated sandbox: a consumer project (where we'll install
    //    the tarball) and a fresh BAND_HOME (so the server doesn't touch the
    //    developer's real ~/.band).
    workDir = mkdtempSync(join(tmpdir(), "band-pack-test-"));
    const consumerDir = join(workDir, "consumer");
    const bandHome = join(workDir, "band-home");
    mkdirSync(consumerDir, { recursive: true });
    mkdirSync(bandHome, { recursive: true });

    // 2. Pre-seed a known auth token. Otherwise the server generates a random
    //    one on first boot and we'd have to race-read settings.json.
    token = `test-token-${Math.random().toString(36).slice(2)}`;
    writeFileSync(join(bandHome, "settings.json"), JSON.stringify({ tokenSecret: token }), "utf-8");

    // 3. Pack the workspace package the same way `npm publish` would. The
    //    `pretest` script already ran `pnpm build`, so dist/ is populated.
    //    Pipe (don't inherit) npm's chatty `notice` output so the test log
    //    isn't flooded; execFileSync throws with stderr attached if it fails.
    execFileSync("npm", ["pack", "--pack-destination", workDir, "--loglevel=error"], {
      cwd: packageRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const tgz = readdirSync(workDir).find((f) => f.endsWith(".tgz"));
    if (!tgz) throw new Error("npm pack did not produce a tarball");

    // 4. Install the tarball into the consumer project — exactly what `npx
    //    @band-app/server` does internally (npx unpacks the tarball into a
    //    temp prefix and runs the bin from inside node_modules).
    writeFileSync(
      join(consumerDir, "package.json"),
      JSON.stringify({ name: "consumer", private: true }),
      "utf-8",
    );
    execFileSync(
      "npm",
      [
        "install",
        "--no-audit",
        "--no-fund",
        "--prefer-offline",
        "--loglevel=error",
        join(workDir, tgz),
      ],
      { cwd: consumerDir, stdio: ["ignore", "pipe", "pipe"] },
    );

    const binPath = join(consumerDir, "node_modules/@band-app/server/bin/band-server.mjs");
    expect(existsSync(binPath), `bin shim missing at ${binPath}`).toBe(true);

    // 5. Pick a free ephemeral port (avoid clashing with the developer's
    //    dev server on 3456) and boot the bin shim.
    const port = await findFreePort();
    baseUrl = `http://127.0.0.1:${port}`;

    // Build an explicit env rather than inheriting the test runner's. NODE_OPTIONS
    // in particular can carry vitest loader flags (--import tsx/esm,
    // --experimental-vm-modules) that break the server's ESM boot in subtle ways.
    const serverEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      PORT: String(port),
      BAND_HOME: bandHome,
    };
    server = spawn(process.execPath, [binPath], {
      env: serverEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.on("exit", (code) => {
      exitCode = code;
    });

    // Capture the server's output continuously. We dump it in afterAll only
    // if a test failed, so a regression like #475 (which silently exited 1)
    // surfaces with the actual stack instead of an opaque "fetch failed".
    server.stdout?.on("data", (chunk: Buffer) => serverOutput.push(chunk.toString()));
    server.stderr?.on("data", (chunk: Buffer) => serverOutput.push(chunk.toString()));

    try {
      await waitForServer(baseUrl, 30_000);
    } catch (err) {
      process.stderr.write(
        `\n--- @band-app/server output ---\n${serverOutput.join("")}\n--- exit code: ${exitCode} ---\n`,
      );
      throw err;
    }
  }, 120_000);

  afterAll((ctx) => {
    if (ctx.tasks.some((t) => t.result?.state === "fail")) {
      process.stderr.write(
        `\n--- @band-app/server output ---\n${serverOutput.join("")}\n--- exit code: ${exitCode} ---\n`,
      );
    }
    if (server && server.exitCode === null && !server.killed) {
      server.kill("SIGTERM");
    }
    if (workDir) {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("server boots without crashing", () => {
    // Generic boot-crash invariant — not specifically a #475 guard. With
    // lazy openapi.json reading (issue #472), the #475 failure mode now
    // surfaces on the first /api/openapi.json request rather than at boot,
    // so the fetch test below is what actually locks in the packaging fix.
    expect(exitCode).toBeNull();
  });

  it("serves the OpenAPI spec via /api/openapi.json", async () => {
    // The actual #475 regression check: this fetch fails ("other side
    // closed") when start-server.mjs throws ENOENT reading the missing
    // dist/openapi.json. afterAll dumps the server output so you can see
    // why.
    const res = await fetch(`${baseUrl}/api/openapi.json`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const spec = (await res.json()) as { openapi?: string; info?: { title?: string } };
    expect(spec.openapi).toMatch(/^3\./);
    expect(spec.info?.title).toBeDefined();
  });
});

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (typeof addr === "object" && addr) {
        const { port } = addr;
        srv.close(() => resolve(port));
      } else {
        srv.close();
        reject(new Error("could not allocate free port"));
      }
    });
  });
}

async function waitForServer(baseUrl: string, deadlineMs: number): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/openapi.json`);
      // Any HTTP response (200, 401, etc.) means the server is up and
      // handling requests. We don't check the status here — auth is
      // verified by the per-test fetch below. Drain the body so undici
      // doesn't leak ~150 keep-alive sockets across the polling loop.
      if (res.status >= 100 && res.status < 600) {
        await res.body?.cancel();
        return;
      }
      await res.body?.cancel();
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server did not become ready within ${deadlineMs}ms: ${String(lastError)}`);
}
