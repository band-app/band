---
title: Overview
description: How the band command finds the hub, what its output looks like, and where each command group is documented.
section: cli
order: 10
commands: []
---

The `band` command is a client for the hub. It sends every request to the hub's API, so the hub must be running. The desktop app starts one, and a hub on a server works the same way.

Each page in this section covers one command group. Under the prose, a Commands section lists every subcommand and flag. Those tables come from `band schema`, so they always match the binary you have installed.

## How the CLI finds the hub

The CLI needs a hub URL and a token.

- **URL.** `BAND_SERVER_URL` if set. Otherwise `http://127.0.0.1:<port>`, where the port is `webServerPort` in `~/.band/settings.json`, or 3456 when that key is missing.
- **Token.** `BAND_TOKEN` if set. Otherwise `tokenSecret` from the same settings file. The CLI sends it as the `band_token` cookie.

The settings file lives in `~/.band`. Set `BAND_HOME` to use another folder.

To talk to a hub on another machine, set both variables:

```sh
BAND_SERVER_URL=https://hub.example.com BAND_TOKEN=<token> band repos list
```

Create a token for this with `band tokens create-device`. Some commands need an admin token, for example `groups create`.

Agents that Band starts on a worker already have `BAND_SERVER_URL` and `BAND_TOKEN` set. They point at a local relay on the worker, which passes only the calls an agent may make. A refused call prints the hub's error message.

## Environment variables

| Variable | Effect |
| --- | --- |
| `BAND_SERVER_URL` | Hub URL. Replaces the URL built from `webServerPort`. |
| `BAND_TOKEN` | Token to send. Replaces `tokenSecret` from the settings file. |
| `BAND_HOME` | Folder that holds `settings.json`. Default `~/.band`. |
| `BAND_OUTPUT` | Same as `--output`. Set it to `json` to get JSON from every command. |
| `BAND_DISPATCH` | `chat` or `terminal`. Where `worktrees create --prompt` sends the prompt. Also read by `agents launch`, which accepts `gui` and `tui` as well. |
| `BAND_WORKTREE_ID` | Set inside a Band terminal or agent. `worktrees create` records it as the new worktree's origin. `subscriptions` uses it as the default worktree. |
| `BAND_CHAT_ID` | Set inside an agent chat. `subscriptions` uses it as the default chat. |

## Output

Every command takes the global `--output text|json` flag. It can go anywhere on the line.

```sh
band --output json repos list
band worktrees list --output json
```

Text output is a table with a header row. Columns are separated by two spaces. A table with no rows prints nothing, so a script can test for empty output.

JSON output is one line of compact JSON. Each page shows the shape for its commands. Field names are the hub's, so they use `camelCase` and still say `hostId` where the text says worker.

`chats watch` ignores `--output` and always prints raw NDJSON. `terminals output --follow` and `terminals attach` stream until you stop them.

## Choosing a worktree

Commands that act on a worktree, chat, terminal or browser tab take an optional id. When you leave it out, the CLI runs `git rev-parse --show-toplevel` in the current directory and picks the registered worktree at that path. For a chat, terminal or browser tab it then uses the first one in that worktree.

Outside a worktree, pass the id. Worktree ids look like `<repo>-<branch>`, with slashes in the branch turned into dashes. A worktree on a worker other than `local` ends with `@<worker-id>`.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | The command worked. |
| 1 | The hub refused the call, could not be reached, or the arguments failed a check the CLI makes itself. `env validate` and `env build` also exit 1 when they find a problem or a build fails. |
| 2 | The command line did not parse: an unknown flag or a missing argument. |

On exit 1, text mode prints `error: <message>` to stderr. JSON mode prints `{"error": "<message>"}` to stderr instead.

`band notify` is the exception. Agent hooks call it, so it prints nothing and always exits 0.

## Command schema

`band schema` prints the schema of every command as JSON, and `band schema <command>` prints one group. The docs tables are built from it, and scripts can use it to discover flags. See [Other commands](/docs/cli-misc).

```sh
band schema
band schema worktrees
```

## Command groups

- [Repos](/docs/cli-repos): register and configure repos.
- [Worktrees](/docs/cli-worktrees): create, move, group and remove worktrees.
- [Groups](/docs/cli-groups): sidebar groups.
- [Agents](/docs/cli-agents): start an agent and list sessions.
- [Chats](/docs/cli-chats): send messages, watch events, label chats.
- [Browsers](/docs/cli-browsers): browser tabs.
- [Terminals](/docs/cli-terminals): terminal sessions and the terminal daemon.
- [Cronjobs](/docs/cli-cronjobs)
- [Subscriptions](/docs/cli-subscriptions)
- [Workers](/docs/cli-workers)
- [Runners](/docs/cli-runners)
- [Environments](/docs/cli-env)
- [Tokens](/docs/cli-tokens)
- [Vault](/docs/cli-vault)
- [MCP servers](/docs/cli-mcp)
- [Tunnel](/docs/cli-tunnel)
- [Settings](/docs/cli-settings)
- [Other commands](/docs/cli-misc): `schema`, `version`, `open`, `notify`, `skills`.
