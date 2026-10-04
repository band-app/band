/**
 * Which `band` commands the skills name, and what the worker relay does with
 * each. `remote-relay.test.ts` runs every entry of `RELAY_CLI_COMMANDS` with the
 * built CLI through a real worker, and `relay-cli-skills-drift.test.ts` fails
 * when a skill names a command that is in neither list.
 */

/** Commands that must succeed through the relay. Written as `<group> <command>`, or the bare name for a top-level command. */
export const RELAY_CLI_COMMANDS: readonly string[] = [
  "agents launch",
  "agents list",
  "browsers create",
  "browsers get",
  "browsers list",
  "browsers navigate",
  "browsers remove",
  "chats create",
  "chats label",
  "chats list",
  "chats remove",
  "chats send",
  "chats stop",
  "chats unlabel",
  "chats watch",
  "cronjobs create",
  "cronjobs delete",
  "cronjobs list",
  "cronjobs trigger",
  "cronjobs update",
  "notify",
  "open",
  "projects list",
  "subscriptions create",
  "subscriptions list",
  "subscriptions remove",
  "terminals create",
  "terminals kill",
  "terminals list",
  "terminals output",
  "terminals send",
  "workspaces create",
  "workspaces list",
  "workspaces remove",
];

/** Commands the relay refuses or cannot carry, each with the reason. */
export const REFUSED_CLI_COMMANDS: Readonly<Record<string, string>> = {
  "projects add": "adds a repository on the hub's machine, not a worker action",
  "projects remove": "removes a project for every host",
  settings: "reads the hub's settings, which hold credentials",
  "tunnel start": "controls the hub's tunnel",
  "tunnel status": "reads the hub's tunnel",
  "tunnel stop": "controls the hub's tunnel",
  "tokens list": "token management is admin only",
  "tokens revoke": "token management is admin only",
  "tokens create-device": "token management is admin only",
  "hosts list": "lists every host, which a worker has no need to see",
  "hosts remove": "admin only, removes a host",
  "terminals restart-daemon": "ends every terminal on the hub's machine",
  "terminals attach":
    "streams over a WebSocket, which the relay does not carry yet (follow-up in the PR)",
  "skills install": "local to the machine, calls no hub procedure",
  schema: "prints the CLI's own schema, calls no hub procedure",
};
