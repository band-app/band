---
title: MCP servers
description: Give agents tools through MCP servers that the hub proxies, with credentials kept on the hub and per-server limits on which tools agents can call.
section: access
order: 40
---

An MCP server gives a coding agent extra tools, such as a ticket tracker or a database. Band runs these servers through the hub. The agent talks to the hub, and the hub adds the credential and checks each call. The agent never holds the key.

You manage servers in Settings > MCP. It needs an admin token (see [Devices and pairing](devices.md)).

## Add a server

Click Add a server and fill in the form.

For an HTTP server:

1. Enter a name in lowercase letters, digits, hyphens and underscores. Agents see the server under this name. `band` is reserved.
2. Choose HTTP server and enter the URL of its streamable HTTP endpoint. It must be `https`, or `http` on loopback. Do not put credentials in the URL.
3. Pick a credential from the vault, or none. An API key goes out in a header, `Authorization: Bearer <key>` by default. Change the header name and prefix if the server expects another form. For OAuth, choose Connect with OAuth. See [Credentials](credentials.md).
4. Click Test connection. Band connects and lists the server's tools.

For a process on a worker (stdio), choose Process on a worker, pick the worker, and enter the executable, its arguments and an optional working directory inside the worker's roots. The command is an executable, not a shell line. Each environment variable is either a value or a vault credential. The hub reads the secret when it starts the process and sends it to the worker. Nothing is logged or written to disk.

You can also add an HTTP server from the command line:

```sh
band mcp add search https://mcp.example.com/mcp --vault-item <id> --read-only
band mcp list
band mcp remove search
```

See [band mcp](/docs/cli-mcp). Stdio servers are set up in Settings > MCP only.

## Limit what agents can do

- Allow every tool is on by default. Turn it off and tick the tools agents may see and call. Test the connection first, so the list is filled.
- Read-only keeps only the tools marked read-only. A tool counts as read-only when the server marks it so (the `readOnlyHint` annotation). On the command line, `--read-only-tools` names more. A call to any other tool is refused by the hub and never reaches the server.
- Enabled switches a server off without deleting it.

Hidden tools are removed from the server's tool list, and the hub answers a call to one with an error.

## Scope

A server reaches an agent only when its scope allows it. The Scope setting offers All worktrees, Selected repos and Selected workers.

## How agents get the servers

When a chat starts, the hub gives the agent every server that is enabled and in scope. Each entry points to the hub, not to the server, and carries a short-lived token that names only those servers. The token lasts an hour by default, and the hub revokes it when the agent process ends or the chat is removed. A server that is removed, disabled or out of scope stops working at once.

An agent on a worker calls the hub through the worker's relay, so the worker needs no direct path to the hub. This works only if the agent supports HTTP MCP servers. If it does not, it gets none, and the hub logs that.

The hub sends the server only the credential it adds. The agent's own headers and tokens stay on the hub.

## The built-in band server

Every chat also gets a server called `band`. It has one tool, `worktrees_create`, which starts a new worktree from the chat. A chat on a worker creates worktrees on that worker only. See [Origin links](origin-links.md).

## Audit log

The server's row in Settings > MCP has an audit log. The hub records one entry for each tool call: the server, the tool, the session, whether it succeeded, and the error class if not. It keeps entries for 30 days. It never stores arguments or results.

## Details

- If the upstream answers 401 on an OAuth server, the hub refreshes the token and retries once. A second failure returns 502 to the agent, so it is not mistaken for a bad proxy token.
- The hub refuses redirects from the upstream.
- Requests are capped at 4 MiB. A stdio call that runs longer than 10 minutes answers 504.
- A stdio process stops after 15 idle minutes (`BAND_MCP_STDIO_IDLE_MS`), when its session token is revoked, or when the server's settings change.
- Legacy SSE transport is not proxied.
