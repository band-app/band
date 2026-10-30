---
title: band chats
description: Send messages to a worktree's agent, follow its events as JSON, and manage and label chats.
section: cli
order: 50
commands: [chats]
---

A chat is one conversation with a coding agent inside a worktree. A worktree can have several chats, each with its own agent, model and history. `band chats send` is the usual way to drive an agent from a script or from another agent. See [Coding agents](/docs/coding-agents).

Commands that take a worktree use the worktree containing the current directory when you leave it out. Commands that take a chat id use the worktree's first chat when you leave it out. Pass ids when you run outside the worktree.

## Listing and creating chats

```sh
band chats list
band chats create --name planning --agent claude-code --mode plan
```

```text
ID             NAME      AGENT        STATUS  LABELS
chat-7f3a91c2  planning  claude-code  idle    role=planner,ticket=ABC-12
```

`STATUS` is one of `running`, `idle`, `stopped` or `error`. `LABELS` are `key=value` pairs sorted by key. `create` prints the new chat's id.

JSON output is `{"chats": [...]}` for `list` and `{"chat": {...}}` for `create`.

## Sending a message

```sh
band chats send --message "Add tests for the parser"
band chats send chat-7f3a91c2 --message "Now run them" --worktree my-app-feat-login
```

`--message` is required. `--agent`, `--model` and `--mode` override the chat's choices for this message. When the worktree has no chat yet, Band creates one.

If the agent is still working, the message is queued behind the current turn and runs when it ends. The two outcomes print differently:

```text
b3e1c7d0-0f4a-4c1a-9a40-2d6a4f0c9e11
queued q-91ac
```

The first line is the id of the task that started. The second means the message was queued, and it prints the queued message id. JSON output has `id`, `queued`, `worktreeId` and `chatId`, plus `queuedMessageId` when queued.

`send` returns as soon as the hub accepts the message. It does not wait for the agent. Use `watch` to follow the answer.

## Following a chat

`band chats watch` opens the chat's event stream and prints one JSON object per line. It ignores `--output`. The stream stays open like `tail -f`: it prints the recent history first, then new events as they happen, and ends when you press Ctrl+C.

Each line is one event with a `type`:

| `type` | Meaning |
| --- | --- |
| `prompt` | A message sent to the agent. |
| `turn-started`, `turn-ended` | A turn began or ended. `turn-ended` has a `stopReason` and an `error` when it failed. |
| `update` | An update from the agent, in the Agent Client Protocol's format. The payload is in `update`. |
| `permission`, `elicitation`, `request-resolved` | The agent asked for permission or input, and the answer. |
| `notice` | A message from Band itself, with a `level`. |
| `session-attached`, `file`, `queue-updated`, `session-state`, `history-meta`, `subscription-opened` | Session and housekeeping events. |

Streamed text arrives as `update` events whose `update.sessionUpdate` is `agent_message_chunk`:

```json
{"type":"update","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"I added three tests"}},"eventId":412}
```

To print only the agent's text, filter with `jq`:

```text
band chats watch chat-7f3a91c2 | jq -rj 'select(.type == "update" and .update.sessionUpdate == "agent_message_chunk") | .update.content.text // empty'
```

To wait for the end of the next turn and see why it ended:

```text
band chats watch chat-7f3a91c2 | jq -c 'select(.type == "turn-ended") | {stopReason, error}'
```

The watch command does not exit when a turn ends. Stop it from your script once you have the line you need.

## Stopping and removing

`stop` stops the chat's running work. `remove` deletes the chat.

```sh
band chats stop chat-7f3a91c2
band chats remove chat-7f3a91c2
```

## Labels

Labels are `key=value` pairs on a chat. Scripts use them to find the chats they created. Keys that start with `band:` are reserved and rejected.

`label` adds or overwrites labels and keeps the others. `unlabel` removes labels by key and ignores keys that are not there. Both print the final labels as `key=value,key=value`.

```sh
band chats create --name review --label role=reviewer --label ticket=ABC-12
band chats label chat-7f3a91c2 status=blocked
band chats unlabel chat-7f3a91c2 status
```
