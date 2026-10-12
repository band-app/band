# What agents can do across hosts

An agent in a chat or terminal on a worker reaches the hub through the worker's relay. The relay limits what it may do (`apps/hub/src/server/services/relay-scope.ts`). This page covers the three things an agent may do beyond its own host, and how the hub keeps its admin token out of an agent's reach.

## Starting a worktree on another host

`band worktrees create <repo> <branch> --host <host>` and the `worktrees_create` MCP tool (`hostId`) accept a host other than the one the agent runs on. Without a host, the worktree goes where the caller runs, as before. The hub accepts an explicit host when all of these hold, and refuses with the reason otherwise:

1. The setting "Agents may start worktrees on other hosts" is on (Settings > Agents, `agents.crossHostWorktrees` in `~/.band/settings.json`). It is on by default. With it off, an agent can create worktrees on its own worker only.
2. The target is an online, static worker. A host that is offline, lost, ephemeral, or started by a runner is refused, and so is the hub's own machine. Placement by `--labels`, `--requires` or `--isolation` is unchanged and never starts a runner machine on an agent's say-so.
3. The repo allows the host (`band repos set --hosts`, see `repo-hosts.md`).

The one branch per repo rule still applies. The new worktree records the caller's worktree and chat (or terminal) as its origin (see `origin-links.md`), and an `--origin` must be a worktree on the caller's host. Refusals read like `worktrees.create: Host "mac" is offline`, `<repo> is only available on <hosts>` or `Agents may not start worktrees on other hosts. An admin can turn this on in Settings > Agents.`

## Seeing the hosts

`band hosts list` and the `band_hosts_forAgents` MCP tool work for agents. The hub cuts the answer down to id, name, status, mode, OS, architecture, coding agents, capabilities (including `desktop`) and labels. Roots, home directories, tool versions, capability reports, last-seen times and runner settings are left out. `band runners list`, `band hosts remove` and the other host and runner commands stay admin only.

## Where the admin token lives

An agent that can read the hub's admin token can skip every limit above, so the token must not sit in a file the agent can open.

- The desktop app stores the remote hub's URL and token with Electron `safeStorage` (the macOS Keychain entry "Band Safe Storage") in `~/.band/desktop-hub.enc`. The file holds ciphertext that only the app can open. On start, the app moves a plain-text `~/.band/desktop-hub.json` from an earlier version into it and deletes the old file with its temp and backup copies. Where the OS offers no key store (a Linux session without a keyring), the app keeps writing `desktop-hub.json` with mode 0600.
- Tests set `BAND_DESKTOP_SECRET_STORE=test` to use a fixed-key stand-in, because a test run cannot unlock the Keychain.

What stays on disk in plain text, all mode 0600 inside a 0700 directory, and so readable by any process running as the same user, agents included:

| File | Holds | Why it stays |
| --- | --- | --- |
| `~/.band/settings.json` (`tokenSecret`) on the hub's machine | The hub's shared admin token | The hub, the CLI and the desktop shell read it. Moving it needs Keychain support in the Rust CLI. |
| `<state dir>/session-token` of a worker | The worker's session token | The worker needs it to redial. It can connect as that worker only. |
| `~/.band/worker-service/worker.env` or the launchd plist | The worker's bootstrap token | The service manager starts the worker with it. It works once. |

An agent on a worker never receives a hub token: the relay forwards its calls with its own `brt_` token and answers `403` for anything outside `RELAY_PROCEDURES`. The exposure above is an agent on the hub's own machine, which runs as the same user as the hub.

`apps/hub/tests/cross-host-worktrees.test.ts` scans the HOMEs of a CLI flow (connect with the admin token, mint a device token, connect with it) and of two workers for both tokens, and `apps/web/e2e-desktop/desktop-hub-picker.spec.ts` scans the desktop app's HOME for the remote hub token. The files in the table above are the only ones that hold a token in plain text.
