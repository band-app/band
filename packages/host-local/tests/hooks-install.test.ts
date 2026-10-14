import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { checkHooks, HOOKS_VERSION, installHooks, removeHooks } from "../src/agents/hooks-install";

// Real files under a temp HOME. `~/.claude/settings.json` is the temp one, and a
// fake `band` on PATH stands in for the CLI (nothing runs it).

type Entry = { hooks: { type: string; command: string; [key: string]: unknown }[] };

const USER_HOOK: Entry = { hooks: [{ type: "command", command: "/usr/bin/true user-own-hook" }] };
const EVENTS = [
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "Stop",
  "StopFailure",
  "SubagentStart",
  "SubagentStop",
  "PostCompact",
  "SessionEnd",
];

describe("Claude Code hooks install", () => {
  let home: string;
  let settingsPath: string;
  let savedEnv: { HOME?: string; PATH?: string };

  beforeEach(() => {
    savedEnv = { HOME: process.env.HOME, PATH: process.env.PATH };
    home = mkdtempSync(join(tmpdir(), "band-hooks-install-"));
    const bin = join(home, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "band"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bin, "band"), 0o755);
    process.env.HOME = home;
    process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
    settingsPath = join(home, ".claude", "settings.json");
    mkdirSync(join(home, ".claude"), { recursive: true });
  });

  afterEach(() => {
    process.env.HOME = savedEnv.HOME;
    process.env.PATH = savedEnv.PATH;
    rmSync(home, { recursive: true, force: true });
  });

  const read = () => JSON.parse(readFileSync(settingsPath, "utf8"));
  const bandCommand = (hooks: Record<string, Entry[]>, event: string) =>
    hooks[event].flatMap((e) => e.hooks).find((h) => h.command.includes("notify"))!;

  it("registers every event with a silent, async, short-timeout command", async () => {
    await installHooks();
    const hooks = read().hooks as Record<string, Entry[]>;
    assert.deepEqual(Object.keys(hooks).sort(), [...EVENTS].sort());
    for (const event of EVENTS) {
      const hook = bandCommand(hooks, event);
      assert.match(
        hook.command,
        /^"[^"]+" notify --agent claude-code >\/dev\/null 2>&1 \|\| true$/,
      );
      assert.equal(hook.async, true);
      assert.equal(typeof hook.timeout, "number");
      assert.ok((hook.timeout as number) <= 5);
    }
    assert.deepEqual(await checkHooks(), {
      installed: true,
      outdated: false,
      other_hooks_exist: false,
      version: HOOKS_VERSION,
    });
  });

  it("leaves everything that is not Band's as it was, on install and on remove", async () => {
    const original = {
      theme: "dark",
      permissions: { allow: ["Bash(ls:*)"], deny: [] },
      env: { FOO: "bar" },
      hooks: {
        Stop: [USER_HOOK],
        Notification: [USER_HOOK],
        // A Band entry from before `--agent`, and one that shares an entry with a user hook.
        PreToolUse: [
          { hooks: [{ type: "command", command: "/usr/local/bin/band notify" }] },
          {
            hooks: [
              { type: "command", command: "/usr/bin/true keep-me" },
              { type: "command", command: "/opt/bin/band notify --agent claude-code" },
            ],
          },
        ],
      },
    };
    writeFileSync(settingsPath, `${JSON.stringify(original, null, 4)}\n`);

    await installHooks();
    const installed = read();
    assert.equal(installed.theme, "dark");
    assert.deepEqual(installed.permissions, original.permissions);
    assert.deepEqual(installed.env, original.env);
    assert.deepEqual(installed.hooks.Notification, [USER_HOOK]);
    assert.deepEqual(installed.hooks.Stop[0], USER_HOOK);
    // The old entries are replaced, the user hook beside Band's stays.
    const pre = installed.hooks.PreToolUse as Entry[];
    assert.equal(pre.filter((e) => e.hooks.some((h) => h.command.includes("notify"))).length, 1);
    assert.deepEqual(pre[0], { hooks: [{ type: "command", command: "/usr/bin/true keep-me" }] });
    // Indent and trailing newline survive.
    const text = readFileSync(settingsPath, "utf8");
    assert.match(text, /^\{\n {4}"theme"/);
    assert.ok(text.endsWith("\n"));

    await removeHooks();
    const removed = read();
    assert.deepEqual(removed, {
      ...original,
      hooks: {
        Stop: [USER_HOOK],
        Notification: [USER_HOOK],
        PreToolUse: [{ hooks: [{ type: "command", command: "/usr/bin/true keep-me" }] }],
      },
    });
    assert.deepEqual(await checkHooks(), {
      installed: false,
      outdated: false,
      other_hooks_exist: true,
      version: HOOKS_VERSION,
    });
  });

  it("drops the hooks key when Band's entries were the only ones", async () => {
    writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }));
    await installHooks();
    await removeHooks();
    assert.deepEqual(read(), { theme: "dark" });
  });

  it("reports the old hook set as outdated, and a reinstall replaces it", async () => {
    const old: Record<string, Entry[]> = {};
    for (const event of [
      "PreToolUse",
      "PermissionRequest",
      "UserPromptSubmit",
      "PostToolUse",
      "Stop",
    ]) {
      old[event] = [{ hooks: [{ type: "command", command: "/usr/local/bin/band notify" }] }];
    }
    writeFileSync(settingsPath, JSON.stringify({ hooks: old }));
    const status = await checkHooks();
    assert.equal(status.installed, false);
    assert.equal(status.outdated, true);

    await installHooks();
    assert.equal((await checkHooks()).installed, true);
    assert.equal(JSON.stringify(read()).includes('"/usr/local/bin/band notify"'), false);
  });

  it("refuses to touch a settings file it cannot parse", async () => {
    writeFileSync(settingsPath, "{ not json");
    await assert.rejects(installHooks(), /not valid JSON/);
    await assert.rejects(removeHooks(), /not valid JSON/);
    assert.equal(readFileSync(settingsPath, "utf8"), "{ not json");
    // No half-written temporary file stays behind.
    assert.deepEqual(readdirSync(join(home, ".claude")), ["settings.json"]);
  });

  it("creates the settings file when none exists, and remove leaves a missing file alone", async () => {
    rmSync(join(home, ".claude"), { recursive: true, force: true });
    await removeHooks();
    await installHooks();
    assert.equal((await checkHooks()).installed, true);
  });

  // The command runs in the agent's shell. Whatever band does, the agent sees
  // exit 0 and no output.
  describe("the installed command", () => {
    const run = (command: string) =>
      spawnSync("sh", ["-c", command], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });

    async function installedCommand(bandPath: string): Promise<string> {
      await installHooks();
      const command = bandCommand(read().hooks, "Stop").command;
      const current = /^"([^"]+)"/.exec(command)?.[1];
      assert.ok(current);
      return command.replace(current, bandPath);
    }

    it("exits 0 with no output when the band binary is missing", async () => {
      const result = run(await installedCommand(join(home, "gone", "band")));
      assert.equal(result.status, 0);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "");
    });

    it("exits 0 with no output when band prints and fails", async () => {
      const noisy = join(home, "noisy-band");
      writeFileSync(
        noisy,
        '#!/bin/sh\necho "{\\"decision\\":\\"block\\"}"\necho oops >&2\nexit 2\n',
      );
      chmodSync(noisy, 0o755);
      const result = run(await installedCommand(noisy));
      assert.equal(result.status, 0);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "");
    });
  });
});
