---
title: Provision a worker
description: Turn a blank Linux or macOS machine into a Band worker by pasting one command, with an optional repo of your own setup steps.
section: workers
order: 25
---

An admin turns a blank Linux or macOS machine into an online Band worker by pasting one line. Settings > Workers > Add a worker > Get provisioning command shows:

```sh
curl -fsSL https://hub.example.com/api/provision/<code>/script | sh
```

The line works once and expires after an hour (see [Details](#details)). Run it as the normal user, not as root. Steps that need root use `sudo -n` and are skipped, with a message in the log, when passwordless `sudo` is not available.

The hub URL must be https. Plain http is accepted only for loopback, as for any worker. To add a worker by hand instead, see [Add a worker](adding-workers.md).

## What the script does

The script holds no secret. The code in its URL is useless once spent, so fetching the script twice, or a chat app previewing the link, spends nothing.

1. It checks the OS (Linux or macOS) and architecture (x86_64 or arm64), and fails with a message on anything else.
2. It sends the code to the hub. The hub spends the code, creates the worker and answers with a worker bootstrap token and a run token. A used, expired or unknown code gets one generic 401 error.
3. It runs the install steps (below) and uploads their output to the hub as they print. The hub removes anything shaped like a Band token before it stores a line.
4. It tells the hub the exit code. A non-zero code marks the worker failed.

The bootstrap token and the run token reach the install steps in memory and in environment variables. Neither is on a command line. The run token authorizes the repo download and the log upload, and the hub stores only its hash.

## The built-in install

With no provisioning repo, the script:

1. Uses Node 24 or later if `node` is on the PATH. Otherwise it installs mise and Node 24 through it.
2. Installs `@band-app/worker` pinned to the hub's version into `~/.band/npm` (the latest version when the hub runs from source).
3. Runs `band-worker install-service --worker-id <worker id>` with the token in `BAND_WORKER_TOKEN`. That is what the npm service tab of the Add worker dialog's Manual install does.
4. On Linux, enables lingering with `sudo -n loginctl enable-linger`, then runs each `fix:` line that `band-worker doctor` prints (swap, inotify limit) with `sudo`.

Two environment variables on the machine change this: `BAND_WORKER_CMD` and `BAND_PROVISION_ROOT_STEPS=off`, which skips step 4 (see [Details](#details)).

## A provisioning repo

Settings > Workers > Add a worker > Provisioning repo names a git repo, a branch and a start command inside it (default `band/provision.sh`). The hub fetches the repo when it creates the command, with the `tokenItem` vault item as an HTTPS token (username `x-access-token`), so a private repo needs no credential on the new machine. The profile's `provisioning.tokenItem` is used for a profile's repo and `settings.provisioning.tokenItem` for the default repo. With no item, the clone is plain git with the hub machine's own auth. It records the commit it resolved and serves that commit's files, without `.git`, as a tarball. A push to the repo after the command was created does not change what the command runs.

The script downloads the tarball, unpacks it under `~/.band/provision/repo`, and runs the start command from that directory. It sets these variables, and passes none of them on a command line:

| Variable | Value |
| --- | --- |
| `BAND_HUB_URL` | The hub's URL. |
| `BAND_BOOTSTRAP_TOKEN` | The one-time worker bootstrap token. |
| `BAND_WORKER_ID` | The worker id the hub reserved. |
| `BAND_WORKER_LABELS` | The labels given when the command was created, as `k=v,k=v`. |
| `BAND_PROVISION_DIR` | The unpacked repo. |
| `BAND_WORKER_VERSION` | The worker version Band installs afterwards (the hub's version). Empty when the hub runs from source. |

The start command installs what the machine needs. It must not install or start the worker. When it exits 0, Band installs `@band-app/worker` at the hub's version, runs `band-worker install-service` with the worker id, name and labels, and does the root steps, as in the built-in install. A non-zero exit marks the worker failed, and Band's worker steps do not run.

A start command that still runs `band-worker install-service` itself keeps working. If the service file names this worker id and `band-worker status` reports it running when the start command exits, Band skips its own install and service steps and writes that to the log. It still runs the root steps (lingering and the `doctor` fixes), so the worker survives logout. A service for another worker id does not count.

### Example layout with mise and chezmoi

```
my-provisioning/
  band/provision.sh
  dot_config/mise/config.toml
  run_onchange_after_install-tools.sh.tmpl
```

`band/provision.sh`:

```sh
#!/bin/sh
set -eu
export PATH="$HOME/.local/bin:$PATH"

# Dotfiles and tools: chezmoi applies this repo, and its run_onchange script installs mise
# and runs `mise install` whenever the mise config changes.
if ! command -v chezmoi >/dev/null 2>&1; then
  sh -c "$(curl -fsLS get.chezmoi.io)" -- -b "$HOME/.local/bin"
fi
chezmoi init --apply --source "$BAND_PROVISION_DIR"
```

`run_onchange_after_install-tools.sh.tmpl`:

```sh
#!/bin/sh
# Runs again whenever the mise config changes: {{ include "dot_config/mise/config.toml" | sha256sum }}
set -eu
export PATH="$HOME/.local/bin:$PATH"
command -v mise >/dev/null 2>&1 || curl -fsSL https://mise.run | sh
mise install --yes
```

Keep credentials out of the repo. Secrets such as an agent token come from Band's vault through a [worker profile](worker-profiles.md).

## Worker profiles

Pick a [worker profile](worker-profiles.md) next to the worker name, or run `band workers provision --profile <name>`. The profile's provisioning repo, if it has one, replaces the repo above for that command. The worker joins with the profile's trust and labels, the service gets the profile's `BAND_WORKER_*` env through `install-service --env`, and the start command gets the same variables exported. With no profile, the hub-wide repo applies.

## Progress and logs

Settings > Workers shows the command's state under the line: waiting for the command to run, provisioning, online (the worker said hello), failed (with the exit code) or expired. The log is readable after the run. A run whose worker has not said hello 30 minutes after the exchange is marked failed, whether the script is still running or exited 0, and its log gets a last line saying why. 

## Over ssh

The "Over ssh" tab of Add worker installs a worker on a machine you can ssh into. Band runs `ssh` on a worker, not on the hub. In the desktop app that is the worker of the computer you are on, so it uses your `~/.ssh/config`, keys and ssh-agent. In a browser, or when this computer has no worker, the tab shows a picker of online workers.

- The tab lists the hosts of that worker's `~/.ssh/config` (no wildcard entries, `Include` files followed), with `user@hostname` where the config gives them. You can also type a target such as `user@host`. A target that starts with `-` or holds spaces or shell characters is refused before anything runs.
- ssh runs with `BatchMode=yes`, so it never asks for input. If it needs a passphrase or a password, the install fails and the error icon shows ssh's message with a hint: load the key into ssh-agent, set up key login, or use the one-line command. The sudo steps need passwordless sudo, as in the one-line command.
- A host that is not in known_hosts shows its key fingerprint first. Nothing runs until you click "Trust and install", which adds the key to that worker's known_hosts. A host whose key differs from known_hosts is refused.
- After that the install is the one-line command run over ssh: the same status, log, expiry and new worker row. The hub must be reachable from the target at the address the page uses.

Environment variables `BAND_SSH_BIN`, `BAND_SSH_KEYSCAN_BIN` and `BAND_SSH_KEYGEN_BIN` on the hub replace `ssh`, `ssh-keyscan` and `ssh-keygen`.

## Copy as cloud-init

"Copy as cloud-init" wraps the same line in a `#cloud-config` `runcmd`, for pasting as user data when you create a VM. cloud-init runs it as root, so use `runcmd` with `su` or `sudo -u <user>` in your own config when you want the worker to run as a normal user.

## Access

Creating a command, installing over ssh and changing the provisioning settings need an admin device token. Agents cannot reach them.

## Limits

Not supported yet: Windows, a Re-provision button for workers that already joined, creating the VM, provisioning on ephemeral runners, passing vault secrets to the start command, and the mobile app.

## Details

Environment variables on the hub:

- `BAND_PROVISION_TTL_MS` changes the one-hour life of a command.
- `BAND_PROVISION_TIMEOUT_MS` changes the 30 minutes a run may take to say hello.

Environment variables on the new machine:

- `BAND_WORKER_CMD` replaces the installed `band-worker` with a command of your own.
- `BAND_PROVISION_ROOT_STEPS=off` skips the root steps.
- `BAND_PROVISION_HOME` moves the unpack directory from `~/.band/provision`.
