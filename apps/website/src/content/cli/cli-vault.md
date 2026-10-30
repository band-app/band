---
title: band vault
description: Store, list and delete the credentials the hub keeps encrypted.
section: cli
order: 110
commands: [vault]
---

`band vault` manages the credentials the hub stores encrypted. For the concepts and the UI, see [Credentials](credentials.md). These commands need an admin token.

## Concepts

A credential has a name, a kind and a scope.

- `api_key` (the default) is a secret for an API, for example one used by an MCP server or an agent login.
- `env` is a value exposed as an environment variable. The name is the variable name.
- `git` is an access token for fetching and pushing private repos. It also needs `--host` (such as `github.com`) and `--path`, a pattern over `owner/repo` such as `owner/*`. `--username` sets the username git sends (default `x-access-token`).

The scope is `global` (the default) or `repo:<name>`. A name is unique within its scope.

`put` reads the value from stdin, so it does not show in the process list or your shell history. `--value` exists, but avoid it for real secrets. A trailing newline is removed, and an empty value is refused.

No command prints a stored value. OAuth connections are added in the UI. `delete` revokes an OAuth connection at its server before it removes it.

## Output

`list` prints the columns ID, NAME, KIND, SCOPE and LAST USED. `put` prints `Stored <name> (<kind>, <scope>) as <id>`. `delete` prints `Deleted <id>`. `rotate-key` re-encrypts every credential under a new key and prints how many. It works only when the key is stored in a file, not when `BAND_VAULT_KEY` supplies it.

## Examples

Pipe a value in, or redirect a file. These lines use shell syntax, so they are not parsed as CLI examples.

```text
echo "$OPENAI_API_KEY" | band vault put openai --description "Shared key"
band vault put DEPLOY_TOKEN --kind env --scope repo:my-app < token.txt
band vault put github-token --kind git --host github.com --path "my-org/*" < token.txt
```

Listing, deleting and rotating the key need no input.

```sh
band vault list
band vault delete <id>
band vault rotate-key
```
