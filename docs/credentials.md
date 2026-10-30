---
title: Credentials
description: Store API keys, environment values, OAuth connections and git tokens encrypted on the hub, and see where Band uses them.
section: access
order: 30
---

The hub keeps your secrets in an encrypted store. Other parts of Band refer to a credential by name. Git on a worker, MCP servers, agent logins and voice dictation all read from it, so a secret never sits in a repo, a settings file or an agent's environment.

You manage credentials in Settings > Credentials. It needs an admin token (see [Devices and pairing](devices.md)).

## Kinds

| Kind | What it holds | Used by |
| --- | --- | --- |
| API key | One secret string. | [MCP servers](mcp-servers.md), [agent logins](agent-logins.md), [voice dictation](voice-dictation.md). |
| Environment variable | A value. The credential's name is the variable name. | MCP servers that run as a process on a worker. |
| OAuth | An access and refresh token for one account. | MCP servers that use OAuth. |
| Git credential | An access token for a git host. | Git on workers, and `gh` on workers. |

Each credential has a scope. `global` applies everywhere. `repo:<name>` ties it to one repo. A name is unique within its scope. Settings > Credentials creates global credentials. Use `band vault put --scope` for a repo scope.

## Add a credential

In Settings > Credentials, fill in Add a key:

1. Enter a name. For an environment variable, enter the variable name.
2. Choose the kind.
3. For a git credential, enter the Host, such as `github.com`, and the Repositories pattern.
4. Paste the value and click Add credential.

Band sends the value once. After that, nothing can read it back. You can replace it or delete it. The list shows each credential's kind, scope and last use.

OAuth credentials come from the MCP page. Choose Connect with OAuth while adding a server, approve the connection in the window that opens, and the credential appears in the list. The hub refreshes the token before it expires. Deleting an OAuth credential also revokes the token at the provider, when the provider supports that.

## Git credentials for workers

A git credential lets a worker clone, fetch and push private repositories without a key on the worker's disk.

- The Host is the git server, for example `github.com`.
- The Repositories pattern matches `owner/repo`. `*` matches within one segment and `**` matches across segments. `owner/*` covers every repo of one owner.
- The username defaults to `x-access-token`, which GitHub accepts for a personal access token. Change it for hosts that need another name.

```sh
band vault put github-work --kind git --host github.com --path 'owner/*'
```

The command reads the token from standard input. Pipe it in or paste it, then press Ctrl-D.

How it works: git on every worker runs a helper that asks the hub for a token when it needs one. The hub answers only for a repo that is placed on that worker. The token goes in that one reply and is not written to the worker's disk, environment or logs. On a long-lived worker, the machine's own git credential helpers answer first and the hub is the fallback. A [runner](runner-hooks.md)-started worker, or one started with `--hub-git-credentials-only`, asks only the hub.

When a runner starts a worker for a repo that has a matching git credential, the hub clones the repo through the worker, so the runner needs no git access of its own.

### GitHub CLI on workers

The `gh` command on a worker gets a `GH_TOKEN` from the broadest git credential for `github.com`. The hub passes it to each agent and terminal when it starts, and keeps it out of files and logs. Workers started by a runner get it automatically. For other workers, set `BAND_WORKER_GH_TOKEN=hub` in the worker's environment. The hub's own `gh` calls use the same credential when the hub's machine has no `gh` login.

See [Runner hooks](runner-hooks.md#git-and-github-auth) for the runner side.

## Command line

```sh
band vault list
printf '%s' "$TOKEN" | band vault put my-api-key --kind api_key --description "Search API"
band vault put MY_VAR --kind env --scope repo:my-app
band vault delete my-api-key
```

`list` shows names, kinds, scopes and last use, never values. Prefer standard input to `--value`, because an argument shows in the process list and shell history. See [band vault](/docs/cli-vault).

## Where the key lives

The hub encrypts each credential with AES-256-GCM. Each write uses a new random nonce, and the credential's id is bound into the ciphertext, so a copied blob does not decrypt on another row.

The key is one of:

- `BAND_VAULT_KEY`, as 32 bytes in base64 or 64 hex characters.
- A file `vault.key` in the hub's data directory (`~/.band` by default), created with mode 0600 on first use.

Back up the key with the database. Without it the credentials cannot be decrypted.

To change the key of a key-file install, run:

```sh
band vault rotate-key
```

It re-encrypts every credential in one transaction and then replaces the file. If the key comes from `BAND_VAULT_KEY`, change it in the environment instead. The command refuses to run.

## What Band never exposes

- No API returns a secret. The list holds metadata only.
- Agents cannot read, list or change credentials. A worker's agent gets 403 on every credential call.
- Log lines and error messages do not contain secret values.
- The hub stores only a hash of device tokens. Those are not vault items.
