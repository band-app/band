---
title: Trust levels and agent access
description: Set how far agents on a worker can reach, whether they may start worktrees on other workers, and where the admin token is kept.
section: workers
order: 45
---

An agent in a chat or terminal on a worker reaches the hub through the worker's relay. The relay limits what the agent may do. This page covers the trust level of a worker, how an agent starts a worktree on another worker, and how the hub keeps its admin token out of an agent's reach.

## Trust levels

Each worker has a trust level. An admin sets it in Settings > Workers, in the trust selector on the worker's row, or with the CLI:

```sh
band workers trust my-server restricted
band workers trust my-server standard
band workers trust my-server admin
```

The hub reads the level on every call from an agent, so lowering it takes effect on the next call. A new static worker is `standard`, and every worker that existed before trust levels was made `standard` by the migration. A worker started by a runner is `restricted`, and so is an ephemeral worker that nobody set a level for.

| Level | Agents on that worker may |
| --- | --- |
| `restricted` | Use their own worktrees only: chats, tasks, terminals, browsers, the queue and worktree-scoped subscriptions. They cannot create or remove worktrees, change repos or use cronjobs, and a shorter worker list. A refusal names the level. |
| `standard` | Work on their own worker, and create worktrees on another worker when the setting allows it (see below). |
| `admin` | Everything `standard` allows, on any worker: list, send to and stop chats, tasks, terminals and browsers in worktrees on other workers; create and remove worktrees on any online static worker (the setting does not apply; the repo's allowed workers still do); cronjobs on worktrees of any worker it may reach; change repos; read and change a short list of settings; see full worker details and every worker's repos. |

Never available to an agent, whatever the level: tokens, the credential vault, changing trust levels and reading the audit log. An agent on an admin worker can change only display and agent-behaviour settings (`agents`, `notifications`, `defaultCodingAgent`, `theme` and a few more). Credentials, agent commands, runners, allowed origins, the port and the tunnel need a person's token. Adding a folder outside a worker's roots also needs a person's confirmation at every level.

No level reaches the hub's own machine (`local`): its chats, terminals, browsers, worktrees and cronjobs stay out of agent reach, because a shell there can read the hub's tokens and vault key. The relay token does not become a hub credential. A call from a worktree must itself be on the caller's worker.

Cross-worker calls an admin worker makes, and its admin-only calls (`settings.update`, repo writes, cronjobs on other workers), go in an audit log: time, calling worker, chat, action and the target worker and worktree. Admins read it in Settings > Workers (Cross-worker activity) or with `band workers audit`.

## Starting a worktree on another worker

`band worktrees create <repo> <branch> --worker <worker>` and the `worktrees_create` tool every chat has accept a worker other than the one the agent runs on. Without a worker, the worktree goes where the caller runs, as before. The hub accepts an explicit worker when all of these hold, and refuses with the reason otherwise:

1. The setting "Agents may start worktrees on other workers" is on (Settings > Coding Agents, `agents.crossHostWorktrees` in `~/.band/settings.json`). It is on by default. With it off, an agent can create worktrees on its own worker only.
2. The target is an online, static worker. A worker that is offline, lost, ephemeral, or started by a runner is refused, and so is the hub's own machine. Placement by `--labels`, `--requires` or `--isolation` is unchanged and never starts a runner machine on an agent's say-so.
3. The repo allows the worker (`band repos set --workers`, see [Repo workers](repo-hosts.md)).

The one-worker-per-branch rule still applies. The new worktree records the caller's worktree and chat (or terminal) as its origin (see [Origin links](origin-links.md)), and an `--origin` must be a worktree on the caller's worker. Refusals read like `worktrees.create: Worker "mac" is offline`, `<repo> is only available on <workers>` or `Agents may not start worktrees on other workers. An admin can turn this on in Settings > Coding Agents.`

## Seeing the workers

`band workers list` and the `band_workers_forAgents` tool work for agents. The hub cuts the answer down to id, name, status, mode, OS, architecture, coding agents, capabilities (including `desktop`) and labels. Roots, home directories, tool versions, capability reports, last-seen times and runner settings are left out. The other worker and runner commands stay admin only.

## Where the admin token lives

An agent that can read the hub's admin token can skip every limit above, so the token must not sit in a file the agent can open.

- The desktop app stores the remote hub's URL and token with Electron `safeStorage` (the macOS Keychain entry "Band Safe Storage") in `~/.band/desktop-hub.enc`. The file holds ciphertext that only the app can open. On start, the app moves a plain-text `~/.band/desktop-hub.json` from an earlier version into it and deletes the old file with its temp and backup copies. Where the OS offers no key store (a Linux session without a keyring), the app keeps writing `desktop-hub.json` with mode 0600.

What stays on disk in plain text, all mode 0600 inside a 0700 directory, and so readable by any process running as the same user, agents included:

| File | Holds | Why it stays |
| --- | --- | --- |
| `~/.band/settings.json` (`tokenSecret`) on the hub's machine | The hub's shared admin token | The hub, the CLI and the desktop app read it. |
| `<state dir>/session-token` of a worker | The worker's session token | The worker needs it to redial. It can connect as that worker only. |
| `~/.band/worker-service/worker.env` or the launchd plist | The worker's bootstrap token | The service manager starts the worker with it. It works once. |

An agent on a worker never receives a hub token: the relay forwards its calls with its own `brt_` token and answers 403 for anything outside its allowed list. The exposure above is an agent on the hub's own machine, which runs as the same user as the hub.
