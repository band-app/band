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
    expect(
      existsSync(join(dist, "node_modules/node-pty/package.json"))
    ).toBe(true);
  });

  it("contains node-pty prebuilds", () => {
    const prebuildsDir = join(dist, "node_modules/node-pty/prebuilds");
    expect(existsSync(prebuildsDir)).toBe(true);
    const platforms = readdirSync(prebuildsDir);
    expect(platforms.length).toBeGreaterThan(0);
  });

  it("contains better-sqlite3 native binary", () => {
    expect(
      existsSync(
        join(
          dist,
          "node_modules/better-sqlite3/build/Release/better_sqlite3.node"
        )
      )
    ).toBe(true);
  });

  it.skipIf(skipSdkChecks)("contains Claude Code SDK cli.js", () => {
    expect(existsSync(join(dist, "cli.js"))).toBe(true);
  });

  it.skipIf(skipSdkChecks)("contains Codex SDK package", () => {
    expect(
      existsSync(join(dist, "node_modules/@openai/codex/package.json"))
    ).toBe(true);
  });
});
