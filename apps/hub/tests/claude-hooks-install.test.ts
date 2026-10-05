// The Claude Code hooks Band writes into `~/.claude/settings.json`.
//
// Each hook runs `band notify --agent claude-code`, so the server reads the
// payload with Claude Code's rules whatever agent the worktree is set to,
// and `SessionEnd` is among the events, so a session's status goes away when
// Claude Code exits. Boot upgrades hooks installed before either existed.
// A fake `band` on PATH stands in for the CLI; nothing runs it.

import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedSettings } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  startServer,
  trpcData,
  trpcMutate,
  trpcQuery,
} from "./helpers/server";

const TOKEN = "claude-hooks-install-token";
const USER_HOOK = { type: "command", command: "/usr/bin/true user-own-hook" };
const EVENTS = [
  "PreToolUse",
  "PermissionRequest",
  "UserPromptSubmit",
  "PostToolUse",
  "Stop",
  "SessionEnd",
];

type HookEntry = { hooks: { type: string; command: string }[] };

function claudeSettingsPath(home: string): string {
  return join(home, ".claude", "settings.json");
}

function readHooks(home: string): Record<string, HookEntry[]> | undefined {
  try {
    return JSON.parse(readFileSync(claudeSettingsPath(home), "utf-8")).hooks;
  } catch {
    return undefined;
  }
}

/** The `band` path Band wrote into the hook commands. */
function installedBandPath(hooks: Record<string, HookEntry[]>): string {
  const command = hooks.SessionEnd.at(-1)?.hooks[0]?.command ?? "";
  return command.replace(/ notify --agent claude-code$/, "");
}

describe("Claude Code hooks", () => {
  let server: ServerHandle;
  let home: string;

  beforeAll(async () => {
    home = createTmpHome("band-claude-hooks-");
    seedSettings(home, { tokenSecret: TOKEN });
    const bin = join(home, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "band"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bin, "band"), 0o755);

    // Hooks as Band installed them before `--agent` and `SessionEnd`, next
    // to a hook of the user's own.
    const old: Record<string, HookEntry[]> = {};
    for (const event of EVENTS.slice(0, 5)) {
      old[event] = [{ hooks: [{ type: "command", command: "/usr/local/bin/band notify" }] }];
    }
    old.Stop.unshift({ hooks: [USER_HOOK] });
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(claudeSettingsPath(home), JSON.stringify({ hooks: old }));

    server = await startServer({
      tmpHome: home,
      env: { PATH: `${bin}:${process.env.PATH ?? ""}` },
    });
  });

  afterAll(async () => {
    await server?.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  function expectedHooks(bandPath: string): Record<string, HookEntry[]> {
    const band: HookEntry = {
      hooks: [{ type: "command", command: `${bandPath} notify --agent claude-code` }],
    };
    const expected: Record<string, HookEntry[]> = {};
    for (const event of EVENTS) expected[event] = [band];
    expected.Stop = [{ hooks: [USER_HOOK] }, band];
    return expected;
  }

  it("boot upgrades hooks installed without --agent and SessionEnd", async () => {
    await expect.poll(() => readHooks(home)?.SessionEnd, { timeout: 15_000 }).toBeDefined();
    const hooks = readHooks(home)!;
    const bandPath = installedBandPath(hooks);
    expect(bandPath).toMatch(/\/band$/);
    expect(hooks).toEqual(expectedHooks(bandPath));

    const res = await trpcQuery(server.url, "hooks.check", undefined, TOKEN);
    expect(await trpcData(res)).toEqual({ installed: true, other_hooks_exist: true });
  });

  it("hooks.check reports hooks without SessionEnd as not installed", async () => {
    const old = readHooks(home)!;
    delete old.SessionEnd;
    writeFileSync(claudeSettingsPath(home), JSON.stringify({ hooks: old }));

    const res = await trpcQuery(server.url, "hooks.check", undefined, TOKEN);
    expect(await trpcData(res)).toEqual({ installed: false, other_hooks_exist: true });
  });

  it("hooks.install writes every event with --agent claude-code", async () => {
    const res = await trpcMutate(server.url, "hooks.install", undefined, TOKEN);
    expect(res.status).toBe(200);

    const hooks = readHooks(home)!;
    expect(hooks).toEqual(expectedHooks(installedBandPath(hooks)));
  });

  it("rejects hooks.install without the band_token cookie (401)", async () => {
    const res = await fetch(`${server.url}/trpc/hooks.install`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });
});
