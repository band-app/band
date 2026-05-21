import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

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

describe("published npm tarball", () => {
  // Regression for #475. The bug there was that `dist/openapi.json` was
  // generated correctly into the build output but was missing from the
  // `files` array in `package.json`, so npm stripped it from the published
  // tarball. start-server.mjs then crashed at startup when it tried to read
  // it (silently — the uncaughtException handler exited 1 before logging to
  // the terminal). `npm pack --dry-run` exercises npm's real packing logic
  // (files array + .npmignore + always-excluded paths), which is what we
  // need to catch this class of bug. Asserting against dist/ contents alone
  // is not enough — the previous "contains the OpenAPI spec" check above
  // passed all along while the published package was broken.
  let packedPaths: string[];

  beforeAll(() => {
    const output = execFileSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: packageRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const result = JSON.parse(output) as Array<{ files: Array<{ path: string }> }>;
    packedPaths = result[0].files.map((f) => f.path);
  });

  // Files that start-server.mjs (or the bin shim) reads directly at runtime.
  // If any of these go missing the published server crashes on startup, so
  // they each get their own assertion to make the failure mode obvious.
  it.each([
    ["bin/band-server.mjs", "bin shim invoked by `npx @band-app/server`"],
    ["dist/start-server.mjs", "the server bundle the bin shim spawns"],
    ["dist/openapi.json", "read by start-server.mjs to serve /api/openapi.json (#475)"],
  ])("publishes %s — %s", (path) => {
    expect(packedPaths).toContain(path);
  });

  it("publishes at least one migration", () => {
    // dist/migrations is a directory; we just need *something* under it so
    // runMigrations() has work to do at boot.
    const migrations = packedPaths.filter((p) => p.startsWith("dist/migrations/"));
    expect(migrations.length).toBeGreaterThan(0);
  });

  it("publishes the client bundle", () => {
    const clientFiles = packedPaths.filter((p) => p.startsWith("dist/client/"));
    expect(clientFiles.length).toBeGreaterThan(0);
  });
});
