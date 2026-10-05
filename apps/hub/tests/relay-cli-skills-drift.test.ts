/**
 * Fails when a band skill tells an agent to run a `band` command that the
 * relay test neither runs nor lists as refused, so a command added to a skill
 * is looked at before it reaches agents on a worker.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REFUSED_CLI_COMMANDS, RELAY_CLI_COMMANDS } from "./helpers/relay-cli-commands";

const SKILLS_DIR = join(import.meta.dirname, "..", "..", "cli", "skills");
const GROUPS = [
  "agents",
  "browsers",
  "chats",
  "cronjobs",
  "hosts",
  "repos",
  "skills",
  "subscriptions",
  "terminals",
  "tokens",
  "tunnel",
  "worktrees",
];
const TOP_LEVEL = ["notify", "open", "schema", "settings"];

function commandsInSkills(): Map<string, string> {
  const found = new Map<string, string>();
  const grouped = new RegExp(`\\bband (${GROUPS.join("|")}) ([a-z][a-z-]*)`, "g");
  const single = new RegExp(`\\bband (${TOP_LEVEL.join("|")})\\b`, "g");
  for (const dir of readdirSync(SKILLS_DIR)) {
    const file = join(dir, "SKILL.md");
    const text = readFileSync(join(SKILLS_DIR, file), "utf8");
    for (const m of text.matchAll(grouped)) found.set(`${m[1]} ${m[2]}`, file);
    for (const m of text.matchAll(single)) found.set(m[1], file);
  }
  return found;
}

describe("band skill commands and the worker relay", () => {
  it("accounts for every command a skill names", () => {
    const known = new Set([...RELAY_CLI_COMMANDS, ...Object.keys(REFUSED_CLI_COMMANDS)]);
    const missing = [...commandsInSkills()]
      .filter(([command]) => !known.has(command))
      .map(([command, file]) => `band ${command} (${file})`);
    expect(
      missing,
      "Add each to RELAY_CLI_COMMANDS and the relay test, or to REFUSED_CLI_COMMANDS with a reason",
    ).toEqual([]);
  });

  it("lists no command twice, and none that the skills no longer name", () => {
    const named = commandsInSkills();
    for (const command of RELAY_CLI_COMMANDS) {
      expect(Object.keys(REFUSED_CLI_COMMANDS)).not.toContain(command);
      expect([...named.keys()], `${command} is no longer in a skill`).toContain(command);
    }
  });
});
