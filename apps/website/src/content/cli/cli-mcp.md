---
title: band mcp
description: Add, list and remove the MCP servers the hub proxies for agents.
section: cli
order: 115
commands: [mcp]
---

`band mcp` manages the HTTP MCP servers that the hub proxies for agents. Agents reach a server at `/mcp-proxy/<name>` on the hub, and the hub adds the credential, so the agent never holds it. See [MCP servers](mcp-servers.md) for the concepts, scopes and audit log. These commands need an admin token.

## Concepts

`add` takes a name (lowercase letters, digits, hyphens and underscores) and the server's streamable HTTP URL. The URL must be https, or http on loopback.

To authenticate, store the credential with [`band vault put`](/docs/cli-vault) and pass its id as `--vault-item`. An API key goes out as `Authorization: Bearer <key>` unless you change the header with `--header` and the text before the key with `--prefix`. An OAuth connection always uses `Authorization: Bearer`.

Filters limit what agents can do. `--allow-tools` lists the only tools agents may see and call. `--read-only` keeps tools annotated as read-only, plus any named in `--read-only-tools`. Both take comma-separated names. `--disabled` adds the server switched off.

The name `band` is reserved. Stdio servers, scopes to repos or workers, and testing a server are set up in Settings > MCP, not with this command.

## Output

`list` prints the columns NAME, URL, CREDENTIAL (`vault` or `none`), TOOLS (`all` or `N allowed`) and MODE (`read-write` or `read-only`, plus `disabled`). `add` prints `Added MCP server <name>, proxied at /mcp-proxy/<name>`. `remove` prints `Removed MCP server <name>`.

## Examples

```sh
band mcp add docs https://mcp.example.com/mcp
band mcp add tracker https://mcp.example.com/tracker --vault-item <id> --read-only
band mcp add search https://mcp.example.com/search --vault-item <id> --header X-Api-Key --prefix ""
band mcp list
band mcp remove docs
```
