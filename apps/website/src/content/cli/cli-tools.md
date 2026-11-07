---
title: band tools
description: List and call the tools of the built-in band MCP server from a shell.
section: cli
order: 86
commands: [tools]
---

`band tools` gives a script or a terminal the tools that the built-in `band` MCP server gives a chat: `worktrees_create`, `band_editor_*`, the tools of installed editors and the tools of installed extensions. The hub builds the list, so an extension you install adds its tools with no CLI update.

## Concepts

A call runs for a chat or for a worktree. The chat comes from `--chat <id>` or `$BAND_CHAT_ID`. Without a chat, the worktree comes from `--worktree <id>` or `$BAND_WORKTREE_ID`, which a worktree terminal sets. An explicit `--worktree` wins over `$BAND_CHAT_ID`. A tool that needs a chat, such as `worktrees_create`, refuses a call that has only a worktree.

`call` applies the same checks as the MCP tool, including the origin link, the cross-worker rules and worker trust.

The command talks to the hub directly. The worker relay does not carry it yet, so inside a remote worker's terminal it fails with 403.

## Output

`list` prints the columns NAME and DESCRIPTION. With `--output json` it prints `{"tools": [{"name", "description", "inputSchema"}]}`.

`call` prints the tool's text. When the tool returns an image, the CLI writes it to a file in the system temp directory and prints the path. With `--output json` it prints the raw MCP content array. An unknown tool, invalid `--json`, arguments the tool rejects or an error result exit with code 1 and print the message on stderr.

## Examples

```sh
band tools list
band tools call band_editor_list
band tools call wordcraft_insert_text --json '{"file": "report.docx", "text": "Hello"}'
```
