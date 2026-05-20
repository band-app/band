import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const dist = join(import.meta.dirname, "../dist");

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
