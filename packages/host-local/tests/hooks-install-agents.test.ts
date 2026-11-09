import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { parse as parseToml } from "smol-toml";
import { checkHooks, installHooks, removeHooks } from "../src/agents/hooks-agents";
import { codexTrustedHash } from "../src/agents/hooks-codex";

// Real files under a temp HOME; a fake `band` on PATH stands in for the CLI.
// The Codex config below has the shape of a real ~/.codex (codex-cli 0.153.4)
// and the Gemini one of ~/.gemini/settings.json (Gemini CLI 0.61.0), each with
// the user's own hooks.

const USER_HOOK = { type: "command", command: "/usr/bin/true user-own-hook" };

describe("agent hooks install", () => {
  let home: string;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      CODEX_HOME: process.env.CODEX_HOME,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    };
    home = mkdtempSync(join(tmpdir(), "band-hooks-agents-"));
    const bin = join(home, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "band"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bin, "band"), 0o755);
    process.env.HOME = home;
    process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
    delete process.env.CODEX_HOME;
    delete process.env.XDG_CONFIG_HOME;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(home, { recursive: true, force: true });
  });

  describe("Codex", () => {
    const hooksPath = () => join(home, ".codex", "hooks.json");
    const configPath = () => join(home, ".codex", "config.toml");
    const userConfig = [
      'model = "gpt-5.6-terra"',
      "",
      '[hooks.state."/somewhere/hooks.json:stop:0:0"]',
      "enabled = true",
      'trusted_hash = "sha256:aaaa"',
      "",
      "[features]",
      "js_repl = false",
      "",
    ].join("\n");

    beforeEach(() => {
      mkdirSync(join(home, ".codex"), { recursive: true });
      writeFileSync(
        hooksPath(),
        JSON.stringify({ hooks: { Stop: [{ hooks: [USER_HOOK] }] } }, null, 2),
      );
      writeFileSync(configPath(), userConfig);
    });

    it("adds silent hooks, trusts them by hash, and keeps the user's entries", async () => {
      assert.equal((await checkHooks("codex")).installed, false);
      await installHooks("codex");

      const hooks = JSON.parse(readFileSync(hooksPath(), "utf8")).hooks;
      assert.deepEqual(Object.keys(hooks).sort(), [
        "Interrupt",
        "PermissionRequest",
        "PostToolUse",
        "PreToolUse",
        "Stop",
        "UserPromptSubmit",
      ]);
      assert.deepEqual(hooks.Stop[0], { hooks: [USER_HOOK] });
      const band = hooks.Stop[1].hooks[0];
      assert.match(band.command, /notify --agent codex >\/dev\/null 2>&1 \|\| true$/);
      assert.equal(hooks.Interrupt[0].hooks[0].timeout, 3);

      const config = parseToml(readFileSync(configPath(), "utf8")) as {
        model: string;
        hooks: { state: Record<string, { enabled: boolean; trusted_hash: string }> };
      };
      assert.equal(config.model, "gpt-5.6-terra");
      assert.equal(
        config.hooks.state["/somewhere/hooks.json:stop:0:0"].trusted_hash,
        "sha256:aaaa",
      );
      const stopKey = Object.keys(config.hooks.state).find((k) =>
        k.endsWith("hooks.json:stop:1:0"),
      );
      assert.ok(stopKey, "Band's Stop hook is the second group, so key group index 1");
      assert.equal(
        config.hooks.state[stopKey].trusted_hash,
        codexTrustedHash("stop", band.command, 5),
      );
      assert.equal(config.hooks.state[stopKey].enabled, true);

      const status = await checkHooks("codex");
      assert.equal(status.installed, true);
      assert.equal(status.other_hooks_exist, true);
    });

    it("reads as outdated when a trust entry is missing", async () => {
      await installHooks("codex");
      writeFileSync(configPath(), userConfig);
      const status = await checkHooks("codex");
      assert.equal(status.installed, false);
      assert.equal(status.outdated, true);
    });

    it("installs twice without duplicating", async () => {
      await installHooks("codex");
      await installHooks("codex");
      const hooks = JSON.parse(readFileSync(hooksPath(), "utf8")).hooks;
      assert.equal(hooks.Stop.length, 2);
      const text = readFileSync(configPath(), "utf8");
      assert.equal((text.match(/hooks\.json:stop:1:0/g) ?? []).length, 1);
    });

    it("removes only Band's hooks and trust entries", async () => {
      await installHooks("codex");
      await removeHooks("codex");
      assert.deepEqual(JSON.parse(readFileSync(hooksPath(), "utf8")), {
        hooks: { Stop: [{ hooks: [USER_HOOK] }] },
      });
      const config = parseToml(readFileSync(configPath(), "utf8")) as {
        hooks: { state: Record<string, unknown> };
      };
      assert.deepEqual(Object.keys(config.hooks.state), ["/somewhere/hooks.json:stop:0:0"]);
      assert.equal((await checkHooks("codex")).installed, false);
    });

    it("refuses a config.toml that does not parse and writes nothing", async () => {
      writeFileSync(configPath(), "model = [unterminated");
      const before = readFileSync(hooksPath(), "utf8");
      await assert.rejects(installHooks("codex"), /not valid TOML/);
      assert.equal(readFileSync(hooksPath(), "utf8"), before);
      assert.equal(readFileSync(configPath(), "utf8"), "model = [unterminated");
    });

    it("refuses a hooks.json that does not parse", async () => {
      writeFileSync(hooksPath(), "{ nope");
      await assert.rejects(installHooks("codex"), /not valid JSON/);
      assert.equal(readFileSync(hooksPath(), "utf8"), "{ nope");
    });

    it("works with no config at all", async () => {
      rmSync(join(home, ".codex"), { recursive: true });
      await installHooks("codex");
      assert.equal((await checkHooks("codex")).installed, true);
    });

    it("honours CODEX_HOME", async () => {
      process.env.CODEX_HOME = join(home, "elsewhere");
      await installHooks("codex");
      assert.equal(
        JSON.parse(readFileSync(join(home, "elsewhere", "hooks.json"), "utf8")).hooks.Stop.length,
        1,
      );
    });
  });

  describe("Gemini CLI", () => {
    const settingsPath = () => join(home, ".gemini", "settings.json");
    const userSettings = {
      security: { auth: { selectedType: "oauth-personal" } },
      hooks: { AfterAgent: [{ hooks: [USER_HOOK] }] },
    };

    beforeEach(() => {
      mkdirSync(join(home, ".gemini"), { recursive: true });
      writeFileSync(settingsPath(), JSON.stringify(userSettings, null, 2));
    });

    it("adds silent hooks with a millisecond timeout and keeps the user's entries", async () => {
      await installHooks("gemini-cli");
      const settings = JSON.parse(readFileSync(settingsPath(), "utf8"));
      assert.deepEqual(settings.security, userSettings.security);
      assert.deepEqual(Object.keys(settings.hooks).sort(), [
        "AfterAgent",
        "AfterTool",
        "BeforeAgent",
        "BeforeTool",
        "Notification",
        "SessionEnd",
      ]);
      assert.deepEqual(settings.hooks.AfterAgent[0], { hooks: [USER_HOOK] });
      const band = settings.hooks.AfterAgent[1].hooks[0];
      assert.match(band.command, /notify --agent gemini-cli >\/dev\/null 2>&1 \|\| true$/);
      assert.equal(band.timeout, 5000);
      const status = await checkHooks("gemini-cli");
      assert.equal(status.installed, true);
      assert.equal(status.other_hooks_exist, true);
    });

    it("removes only Band's entries", async () => {
      await installHooks("gemini-cli");
      await removeHooks("gemini-cli");
      assert.deepEqual(JSON.parse(readFileSync(settingsPath(), "utf8")), userSettings);
    });

    it("refuses a settings file that does not parse", async () => {
      writeFileSync(settingsPath(), "{ nope");
      await assert.rejects(installHooks("gemini-cli"), /not valid JSON/);
      assert.equal(readFileSync(settingsPath(), "utf8"), "{ nope");
    });
  });

  describe("OpenCode", () => {
    const dir = () => join(home, ".config", "opencode", "plugins");
    const pluginPath = () => join(dir(), "band-status.js");

    it("writes one plugin file, leaves the user's plugins, and removes only its own", async () => {
      mkdirSync(dir(), { recursive: true });
      writeFileSync(join(dir(), "mine.js"), "export const Mine = async () => ({});\n");
      assert.equal((await checkHooks("opencode")).installed, false);

      await installHooks("opencode");
      const text = readFileSync(pluginPath(), "utf8");
      assert.match(text, /^\/\/ band-managed-hook: opencode version=3/);
      assert.match(text, /"notify", "--agent", "opencode"/);
      const status = await checkHooks("opencode");
      assert.equal(status.installed, true);
      assert.equal(status.other_hooks_exist, true);

      await removeHooks("opencode");
      assert.equal((await checkHooks("opencode")).installed, false);
      assert.equal(
        readFileSync(join(dir(), "mine.js"), "utf8"),
        "export const Mine = async () => ({});\n",
      );
    });

    it("refuses to overwrite a file of that name that is not Band's", async () => {
      mkdirSync(dir(), { recursive: true });
      writeFileSync(pluginPath(), "// the user's own\n");
      await assert.rejects(installHooks("opencode"), /not Band's/);
      await removeHooks("opencode");
      assert.equal(readFileSync(pluginPath(), "utf8"), "// the user's own\n");
    });

    it("reads an old plugin as outdated", async () => {
      await installHooks("opencode");
      const text = readFileSync(pluginPath(), "utf8");
      writeFileSync(pluginPath(), `${text}\n// stale\n`);
      const status = await checkHooks("opencode");
      assert.equal(status.installed, false);
      assert.equal(status.outdated, true);
    });

    it("honours XDG_CONFIG_HOME", async () => {
      process.env.XDG_CONFIG_HOME = join(home, "xdg");
      await installHooks("opencode");
      assert.match(
        readFileSync(join(home, "xdg", "opencode", "plugins", "band-status.js"), "utf8"),
        /band-managed/,
      );
    });
  });
});
