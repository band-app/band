---
title: Credentials
description: Store API keys, environment values and OAuth connections encrypted on the hub, and see where Band uses them.
section: access
order: 30
---

The hub keeps your secrets in an encrypted store. Other parts of Band refer to a credential by name. Worker profiles, MCP servers, the Hub GitHub token and voice dictation read from it, so a secret never sits in a repo or a settings file.

You manage credentials in Settings > Credentials. It needs an admin token (see [Devices and pairing](devices.md)).

## Kinds

| Kind | What it holds | Used by |
| --- | --- | --- |
| API key | One secret string. | [Worker profiles](worker-profiles.md), [MCP servers](mcp-servers.md), [voice dictation](voice-dictation.md), the [Hub GitHub token](#hub-github-token) and the provisioning token. |
| Environment variable | A value. The credential's name is the variable name. | Worker profiles and MCP servers that run as a process on a worker. |
| OAuth | An access and refresh token for one account. | MCP servers that use OAuth. A worker profile cannot map it. |

There is no git kind. A token for git or `gh` is an API key that a worker profile maps to `GH_TOKEN`. An item of the old git kind became an API key on upgrade and kept its value.

Each credential has a scope. `global` applies everywhere. `repo:<name>` ties it to one repo. A name is unique within its scope. Settings > Credentials creates global credentials. Use `band vault put --scope` for a repo scope.

## Add a credential

In Settings > Credentials, fill in Add a key:

1. Enter a name. For an environment variable, enter the variable name.
2. Choose the kind.
3. Paste the value and click Add credential.

Band sends the value once. After that, nothing can read it back. You can replace it or delete it. The list shows each credential's kind, scope and last use.

OAuth credentials come from the MCP page. Choose Connect with OAuth while adding a server, approve the connection in the window that opens, and the credential appears in the list. The hub refreshes the token before it expires. Deleting an OAuth credential also revokes the token at the provider, when the provider supports that.

## Give a credential to a worker

A worker receives a vault item only when its [worker profile](worker-profiles.md) maps the item to an environment variable or a file. The worker fetches the value over its authenticated link and keeps it in memory. A worker with no profile gets nothing from the hub and uses its machine's own logins. Band does not know what the value is for: `GH_TOKEN` works for `gh` and for git over HTTPS because those tools read it, not because Band handles them.

See [Runner hooks](runner-hooks.md#git-and-github-auth) for workers that a runner starts.

## Hub GitHub token

The hub runs `gh` itself for pull request polling, webhooks and the default-branch lookup. It uses the machine's `gh` login or the `GH_TOKEN` of its environment first. When neither exists, it uses the vault item named in Settings > Credentials > Hub GitHub token (the `hubGithubToken` setting). With no item either, the hub reports "No GitHub credential for gh on this hub". See [GitHub integration](github-integration.md).

The provisioning repo has its own optional token item, described in [Provision a worker](provisioning.md).

## Command line

```sh
band vault list
printf '%s' "$TOKEN" | band vault put my-api-key --kind api_key --description "Search API"
printf '%s' "$TOKEN" | band vault put github-agents
band vault put MY_VAR --kind env --scope repo:my-app
band vault delete my-api-key
```

`put --kind git` is refused. `list` shows names, kinds, scopes and last use, never values. Prefer standard input to `--value`, because an argument shows in the process list and shell history. See [band vault](/docs/cli-vault).

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
- Agents cannot read, list or change credentials, and cannot list worker profiles or read their mappings. An agent gets 403 on `vault.*` and `workerProfiles.*`. A worker can fetch only the secrets of its own profile.
- Log lines and error messages do not contain secret values.
- The hub stores only a hash of device tokens. Those are not vault items.
