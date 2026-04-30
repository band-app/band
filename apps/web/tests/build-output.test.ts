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
    // missing. The Tauri desktop app targets macOS, so this check only
    // matters there.
    if (process.platform !== "darwin") return;
    const prebuildsDir = join(dist, "node_modules/node-pty/prebuilds");
    expect(existsSync(prebuildsDir)).toBe(true);
    expect(readdirSync(prebuildsDir).length).toBeGreaterThan(0);
  });

  it("contains better-sqlite3 native binary", () => {
    expect(
      existsSync(join(dist, "node_modules/better-sqlite3/build/Release/better_sqlite3.node")),
    ).toBe(true);
  });

  it.skipIf(skipSdkChecks)("contains Claude Code SDK native binary", () => {
    // SDK 0.2.x ships a native `claude` binary per platform under
    // @anthropic-ai/claude-agent-sdk-<platform>-<arch>. Build copies the
    // matching package into dist/node_modules. Linux has both glibc and
    // musl variants — accept either.
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
    expect(found).toBe(true);
  });

  it.skipIf(skipSdkChecks)("contains Codex SDK package", () => {
    expect(existsSync(join(dist, "node_modules/@openai/codex/package.json"))).toBe(true);
  });
});
