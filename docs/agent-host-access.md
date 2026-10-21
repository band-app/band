# What agents can do across workers

An agent in a chat or terminal on a worker reaches the hub through the worker's relay. The relay limits what it may do (`apps/hub/src/server/services/relay-scope.ts`). This page covers the three things an agent may do beyond its own worker, and how the hub keeps its admin token out of an agent's reach.

## Trust levels

Each worker has a trust level that an admin person sets in Settings > Workers (or `band workers trust <worker> <level>`, `workers.setTrust`). The hub reads it on every relay call, so lowering it takes effect on the next call. A new static worker is `standard`, and every worker that existed before trust levels was made `standard` by the migration. A worker started by a runner is `restricted`, and so is an ephemeral worker that nobody set a level for.

| Level | Agents on that worker may |
| --- | --- |
| `restricted` | Use their own worktrees only: chats, tasks, terminals, browsers, the queue and worktree-scoped subscriptions. No `worktrees.create` or `remove`, no `repos.*` writes, no cronjobs, and `workers.forAgents` instead of `workers.list`. A refusal names the level. |
| `standard` | Everything this page describes below: the own-worker rule, and `worktrees.create` on another worker when the setting allows it. |
| `admin` | Everything `standard` allows, on any worker: list, send to and stop chats, tasks, terminals and browsers in worktrees on other workers; `worktrees.create` and `remove` on any online static worker (the setting does not apply; the repo's allowed workers still do); cronjobs on worktrees of any worker it may reach; `repos.*` writes; `settings.get` and `settings.update`; `workers.list` with full detail and `repos.list` for every worker. |

Never available to an agent, whatever the level: `tokens.*`, the vault, `workers.setTrust` and `workers.audit`. `settings.update` from an admin worker accepts only an allow-list of display and agent-behaviour keys (`agents`, `labels`, `notifications`, `defaultCodingAgent`, `theme` and a few more, `AGENT_SETTABLE_SETTINGS`). Credentials, agent commands, runners, CORS origins, the port and the tunnel need a person's token, and so do keys the list does not know. `settings.*` is refused over `/mcp`, `settings.get` over `/trpc` returns only those same keys (the full reply holds runner `env`, agent commands, CORS origins and the voice endpoint), and `repos.addFromWorker` with `addRoot` is refused at every level because widening a worker's roots needs a person's confirmation. No level reaches the hub's own machine (`local`): its chats, terminals, browsers, worktrees and cronjobs stay out of agent reach, because a shell there can read the hub's tokens and vault key. The relay token does not become a hub credential: the hub still answers a relay call as "an agent on worker X", with the wider rules for an admin worker. Every check of the own-worker rule (`UNSCOPED_KEYS`, batching, chosen ids) stays in force at every level. The call that comes from a worktree must itself be on the caller's worker.

Cross-worker calls an admin worker makes, and its admin-only calls (`settings.update`, repo writes, cronjobs on other workers), go in the audit log (`host_audit`, kept 90 days): time, calling worker, chat, procedure and target worker and worktree. Admins read it in Settings > Workers (Cross-worker activity) or with `band workers audit`.

## Starting a worktree on another worker

`band worktrees create <repo> <branch> --worker <worker>` and the `worktrees_create` MCP tool (`hostId`) accept a worker other than the one the agent runs on. Without a worker, the worktree goes where the caller runs, as before. The hub accepts an explicit worker when all of these hold, and refuses with the reason otherwise:

1. The setting "Agents may start worktrees on other workers" is on (Settings > Agents, `agents.crossHostWorktrees` in `~/.band/settings.json`). It is on by default. With it off, an agent can create worktrees on its own worker only.
2. The target is an online, static worker. A worker that is offline, lost, ephemeral, or started by a runner is refused, and so is the hub's own machine. Placement by `--labels`, `--requires` or `--isolation` is unchanged and never starts a runner machine on an agent's say-so.
3. The repo allows the worker (`band repos set --workers`, see `repo-hosts.md`).

The one branch per repo rule still applies. The new worktree records the caller's worktree and chat (or terminal) as its origin (see `origin-links.md`), and an `--origin` must be a worktree on the caller's worker. Refusals read like `worktrees.create: Worker "mac" is offline`, `<repo> is only available on <workers>` or `Agents may not start worktrees on other workers. An admin can turn this on in Settings > Agents.`

## Seeing the workers

`band workers list` and the `band_hosts_forAgents` MCP tool work for agents. The hub cuts the answer down to id, name, status, mode, OS, architecture, coding agents, capabilities (including `desktop`) and labels. Roots, home directories, tool versions, capability reports, last-seen times and runner settings are left out. `band runners list`, `band workers remove` and the other worker and runner commands stay admin only.

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
