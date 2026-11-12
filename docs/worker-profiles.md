---
title: Worker profiles
description: Named bundles that fix how a worker is provisioned and which vault credentials it may receive.
section: workers
order: 26
---

A worker profile fixes how a worker is provisioned and what it may receive from the hub. An admin defines profiles in Settings > Workers > Profiles, picks one when creating a provisioning command, or attaches one to a worker that already exists. The hub enforces the profile. A worker, or an agent on it, cannot choose or change its profile.

Without profiles, everything works as before: the hub-wide provisioning repo, git credentials for any repo placed on a worker, a `gh` token for runner-started workers and for any worker that sets `BAND_WORKER_GH_TOKEN=hub`, and agent logins on every worker.

## What a profile holds

```json
{
  "name": "agent-user",
  "provisioning": { "repoUrl": "https://github.com/owner/agent-env.git", "branch": "main", "command": "band/provision.sh" },
  "labels": ["gui=1"],
  "trust": "standard",
  "env": { "BAND_WORKER_HUB_GIT_CREDENTIALS_ONLY": "1" },
  "ownChats": true,
  "credentials": { "git": ["github-agents"], "gh": "github-agents", "agentLogins": ["claude-agents"] }
}
```

Profiles live in the `workerProfiles` array of `~/.band/settings.json` and are edited in Settings. Every key except `name` is optional.

- `provisioning` replaces the hub-wide provisioning repo for commands made with this profile. The repo follows the rules in [Provision a worker](provisioning.md).
- `labels` are added to the worker's labels. Labels given for one command are added to these.
- `trust` is the worker's [trust level](agent-host-access.md#trust-levels). It is set when the worker is created from a command, and when an admin attaches the profile to a worker. The trust selector in the worker's drawer still works afterwards, and the last change wins.
- `env` sets worker settings. Only names that start with `BAND_WORKER_` are accepted, and values use letters, digits, spaces and `_ . , : = @ / + -`. `install-service` writes them into the LaunchAgent or systemd unit with `--env KEY=VALUE`. The provisioning repo's start command also gets them as exported variables. `BAND_WORKER_TOKEN` and `BAND_WORKER_ID` are set by the hub and cannot be listed.
- `ownChats` installs the worker with `--own-chats`.
- `credentials` limits what the worker may receive from the [vault](credentials.md). Profiles store vault item names and login labels, never secret values.

## Credential policy

An omitted `credentials` object means today's behaviour. When `credentials` is present, an omitted key means nothing of that kind.

| Key | Effect |
| --- | --- |
| `git` | The vault git items the worker may receive. An item not listed is refused for git, even when it matches the repo. Among the listed items that match, the usual order applies (repo scope, then the most specific path pattern). |
| `gh` | The one git item whose token `gh` gets in an agent or terminal. The worker needs no `BAND_WORKER_GH_TOKEN`. With no `gh` key, the worker gets no `gh` token, even when it sends the opt-in. |
| `agentLogins` | The [agent logins](agent-logins.md) that agents on the worker may use, by login label or id. A login that is not listed is skipped, and resolution continues down the chain: the chat's pick, the repo's override, the agent's default, then the machine's own login. |

The hub reads the profile on every request, so a change applies from the worker's next call. A worker whose profile no longer resolves (the entry was removed or broken in `settings.json`) receives nothing until an admin fixes it.

## Create and edit profiles

Settings > Workers > Profiles lists the profiles with the number of workers using each. New profile and Edit open the editor. "Restrict credentials" turns the credential policy on, and the editor then offers the vault git items and the agent logins to tick, plus a choice for the `gh` item. The hub refuses a bad value and names the field: an unknown trust level, an env name outside `BAND_WORKER_*`, a vault item or login that does not exist, or a bad repo URL. A profile that a worker uses cannot be deleted. An entry that fails the same checks in a hand-edited `settings.json` is shown as not applied.

## Use a profile

When you create a provisioning command, pick the profile next to the worker name (`band workers provision --profile <name>`). The worker joins with the profile's trust and labels from its first call, and the script installs its service with the profile's env.

For a worker that exists, open its drawer in Settings > Workers and pick a profile, or run:

```sh
band workers set-profile <worker> <profile>
band workers set-profile <worker> none
```

Attaching applies the profile's trust and credential policy from the next call. Its env and provisioning repo apply only at the next provisioning, because Band does not rewrite a worker's service. `none` removes the profile and brings back today's rules.

## Command line

```sh
band workers profiles
band workers provision --profile agent-user --name build-box --labels zone=a
band workers provision --wait 0b1c2d3e
band workers set-profile build-box agent-user
band workers set-profile build-box none
```

`--hub-url` sets the address the new machine reaches the hub at (default: `BAND_PUBLIC_URL`, else the hub this CLI talks to). `provision` prints the one-line command and its id. `--wait <id>` follows the command until the worker is online and exits non-zero when the run fails or expires.

## An older worker

A `band-worker` that predates `--env` fails the run when the profile has env, with a message to install a newer worker. The profile's env is never dropped silently.

## Access

Profiles and their assignment need an admin device token. Agents cannot read or change them through the relay or `/mcp`, at any trust level. `settings.get` returns `workerProfiles` only to an admin token.

## Not covered

Profiles do not inject tokens at the network, change the `secrets` key of `.band/environment.json`, apply to runner-started workers, re-provision a worker, or cover MCP server credentials.
