---
title: Worker profiles
description: Named bundles that fix how a worker is provisioned and which vault items it receives as environment variables or files.
section: workers
order: 26
---

A worker profile fixes how a worker is provisioned and which secrets it receives from the hub. An admin defines profiles in Settings > Workers > Profiles, picks one when creating a provisioning command, or attaches one to a worker that already exists. The hub enforces the profile. A worker, or an agent on it, cannot choose or change its profile.

A profile maps [vault](credentials.md) items to environment variables or files, much like a Kubernetes pod spec maps secrets. Band does not know what a secret is for. It has no git, `gh`, `glab` or Claude logic: a token works because the tool reads the variable or the file.

A worker with no profile gets nothing from the hub and uses its machine's own logins (`gh auth login`, the keychain, `claude auth login`).

## What a profile holds

```json
{
  "name": "agent-user",
  "provisioning": { "repoUrl": "https://github.com/owner/agent-env.git", "branch": "main", "command": "band/provision.sh", "tokenItem": "github-agents" },
  "labels": ["gui=1"],
  "trust": "standard",
  "env": { "BAND_WORKER_OWN_CHATS": "1" },
  "ownChats": true,
  "secrets": [
    { "item": "github-agents", "env": "GH_TOKEN" },
    { "item": "claude-token", "env": "CLAUDE_CODE_OAUTH_TOKEN" },
    { "item": "deploy-key", "file": "~/.ssh/id_deploy", "mode": "0600" }
  ]
}
```

Profiles live in the `workerProfiles` array of `~/.band/settings.json` and are edited in Settings. Every key except `name` is optional.

- `provisioning` replaces the hub-wide provisioning repo for commands made with this profile. The repo follows the rules in [Provision a worker](provisioning.md). `tokenItem` is a vault item whose token clones the repo over HTTPS.
- `labels` are added to the worker's labels. Labels given for one command are added to these.
- `trust` is the worker's [trust level](agent-host-access.md#trust-levels). It is set when the worker is created from a command, and when an admin attaches the profile to a worker. The trust selector in the worker's drawer still works afterwards, and the last change wins.
- `env` sets worker settings. Only names that start with `BAND_WORKER_` are accepted, and values use letters, digits, spaces and `_ . , : = @ / + -`. `install-service` writes them into the LaunchAgent or systemd unit with `--env KEY=VALUE`. The provisioning repo's start command also gets them as exported variables. `BAND_WORKER_TOKEN` and `BAND_WORKER_ID` are set by the hub and cannot be listed.
- `ownChats` installs the worker with `--own-chats`.
- `secrets` maps vault items to the worker, described next.

## Secrets

Each entry names a global vault item (an API key or an environment item, never an OAuth connection) and one destination.

| Destination | Rules |
| --- | --- |
| `env` | A variable name matching `^[A-Z_][A-Z0-9_]*$`. `PATH`, `HOME`, `USER`, `SHELL` and names starting with `BAND_` are refused. |
| `file` | A path starting with `~/`, under the worker user's home, with no `..`. `mode` is an octal string, at most `0700`, default `0600`. |

Two entries cannot use the same variable or the same file. The hub refuses a profile with a bad entry and names the field.

The worker fetches its secrets over its authenticated link (`secrets.fetch`), never from the service file. A worker can fetch only its own profile's secrets.

Environment values stay in memory. The worker fetches them for every process it starts: agents, terminals, worker-owned chats, the git, `gh` and exec commands the hub requests, and clones through the worker. A vault item you rotate reaches the next process with no restart. Processes that already run keep the old value.

Files are written under the home and kept in sync when the worker connects and when the hub pushes `secrets.changed` (the profile or a mapped item changed). A write goes to a temp file created with the final mode and is renamed into place.

### Examples

Give agents and terminals a GitHub token. `gh` reads `GH_TOKEN`, and git over HTTPS uses it when the credential helper is `!gh auth git-credential`:

```json
{ "item": "github-agents", "env": "GH_TOKEN" }
```

Give Claude Code a token from `claude setup-token`, or an Anthropic key:

```json
{ "item": "claude-token", "env": "CLAUDE_CODE_OAUTH_TOKEN" }
{ "item": "anthropic-key", "env": "ANTHROPIC_API_KEY" }
```

Put an ssh key on disk:

```json
{ "item": "deploy-key", "file": "~/.ssh/id_deploy", "mode": "0600" }
```

Store the whole private key in an API key item, with a final newline.

### What the worker refuses

- The worker records the files it created in `<state dir>/secret-files.json`. It never overwrites or deletes a file it did not create. A mapping onto such a file is refused, reported to the hub and shown in the worker's drawer.
- It refuses a symlink that leaves the home directory.
- It deletes a file when its mapping is removed, when the profile is set to `none`, and when the service is uninstalled (`band-worker uninstall-service`).

## Tool setup that is not a secret

Band does not configure tools. Put the non-secret part in the provisioning repo: a git credential helper (`git config --global credential.helper '!gh auth git-credential'`), `known_hosts`, `ssh_config`. The profile supplies only the secret.

## The local worker

The hub's built-in `local` worker runs inside the hub process and takes no profile secrets. It uses the hub machine's own logins. To give an agent a secret on the hub's machine, run a separate worker on it.

## Create and edit profiles

Settings > Workers > Profiles lists the profiles with the number of workers using each. New profile and Edit open the editor, where you add secrets by choosing a vault item and a variable or a file. The hub refuses a bad value and names the field: an unknown trust level, an env name outside `BAND_WORKER_*`, a vault item that does not exist or is an OAuth item, a bad destination, a duplicate, or a bad repo URL. A profile that a worker uses cannot be deleted. An entry that fails the same checks in a hand-edited `settings.json` is shown as not applied.

## Use a profile

When you create a provisioning command, pick the profile next to the worker name (`band workers provision --profile <name>`). The worker joins with the profile's trust and labels from its first call, and the script installs its service with the profile's env.

For a worker that exists, open its drawer in Settings > Workers and pick a profile, or run:

```sh
band workers set-profile <worker> <profile>
band workers set-profile <worker> none
```

Attaching applies the profile's trust and secrets from the next call. Its env and provisioning repo apply only at the next provisioning, because Band does not rewrite a worker's service. `none` removes the profile, deletes the files the worker wrote for it and returns the worker to its machine's own logins.

A [runner](runner-hooks.md#git-and-github-auth) config can name a `profile`. Workers it starts get that profile's trust and secrets.

## Command line

```sh
band workers profiles
band workers provision --profile agent-user --name build-box --labels zone=a
band workers provision --wait 0b1c2d3e
band workers set-profile build-box agent-user
band workers set-profile build-box none
```

`--hub-url` sets the address the new machine reaches the hub at (default: `BAND_PUBLIC_URL`, else the hub this CLI talks to). `provision` prints the one-line command and its id. `--wait <id>` follows the command until the worker is online and exits non-zero when the run fails or expires. `band workers profiles` prints each profile's trust, the number of secrets and the number of workers.

## An older worker

A hub 0.67.0 or newer refuses a worker older than 0.67.0 with the "too old" message. A `band-worker` that predates `--env` fails the run when the profile has env, with a message to install a newer worker. The profile's env is never dropped silently.

## Access

Profiles and their assignment need an admin device token. Agents cannot list profiles, read mappings or fetch secrets through the relay or `/mcp`, at any trust level. `settings.get` returns `workerProfiles` only to an admin token.

## Not covered

Profiles do not mount tmpfs or in-memory files, run an ssh-agent, inject tokens at the network, change the `secrets` key of `.band/environment.json`, re-provision a worker, or cover MCP server credentials. There are no tool-specific adapters: Band maps a value to a variable or a file and nothing more. Removed with this design: agent logins, the worker's git credential helper that asked the hub, and the profile `credentials` key.
