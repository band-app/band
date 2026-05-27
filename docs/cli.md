# Band CLI

The CLI is split into four domain-specific skills, each with its own command reference:

- [`apps/cli/skills/band.md`](../apps/cli/skills/band.md) — workspaces, projects, cronjobs, tunnel, settings, schema, notify, generate-skills.
- [`apps/cli/skills/band-chat.md`](../apps/cli/skills/band-chat.md) — chat panes (`band chats ...`), including label management.
- [`apps/cli/skills/band-terminal.md`](../apps/cli/skills/band-terminal.md) — terminal sessions (`band terminals ...`).
- [`apps/cli/skills/band-browser.md`](../apps/cli/skills/band-browser.md) — browser tabs (`band browsers ...`).

Run `band schema` for live introspection of every command, or `band <command> --help` for inline help.

## Chat labels (#520)

Chat panes carry a free-form `Record<string, string>` of labels alongside their name/agent/model/mode. Labels are visible in `band chats list` (a `LABELS` column rendered as `k=v,k=v` with sorted keys, empty cell when unset) and in the JSON output of every `chats.*` route.

There are two reasons to use them:

1. **Organize your own chats.** Tag a chat with `phase=plan` / `phase=implement` / `phase=review`, or by feature area, owner, or anything else. Filter the list client-side with `band chats list --output json | jq '.chats[] | select(.labels.phase == "plan")'`.
2. **Let the cronjob scheduler claim its own chat.** Each cronjob owns a dedicated chat in the target workspace, identified by the reserved `band:cronId` label. On the first fire the scheduler creates a chat tagged with `band:cronId=<jobId>`; subsequent fires reuse the same chat by looking it up via `findChatByLabels`. The user can delete the chat at any time — the next fire will recreate it (intentional soft reset). This replaces the older "dispatch to whichever chat happens to be active" behaviour, so cron output no longer interleaves with the user's interactive conversation.

The `band:` key prefix is reserved for server-internal labels. Writes through the CLI or any user-facing tRPC route are rejected; only server code (e.g. `cronjob-scheduler.ts`) can set them, and it does so by passing `allowReservedLabels: true` to `createChat`. Other validation rules at the write boundary: at most 20 keys per chat, keys match `^[a-zA-Z0-9_:-]{1,64}$` (colons allowed for namespacing), values are non-empty printable ASCII up to 256 chars.

### CLI commands

```sh
# Seed at creation
band chats create --label phase=plan --label owner=alice

# Additive merge — other labels preserved; later wins on duplicate keys
band chats label chat_abc phase=implement priority=high

# Remove by key — other labels preserved; unknown keys ignored
band chats unlabel chat_abc priority

# Read
band chats list                                  # text table with LABELS column
band chats list --output json | jq '.chats[].labels'
```

**Concurrency note.** `band chats label` and `band chats unlabel` implement
read–modify–write client-side: they call `chats.get`, merge or strip the keys
locally, then call `chats.update` with the full intended set. Two callers
mutating the same chat within the read–write window can overwrite each other
(classic TOCTOU race). The CLI is intended for single-user workflows where
this is acceptable; if you need concurrent labelling from automation, drive
`chats.update` directly with the desired full set or serialize the callers
upstream.

See [`apps/cli/skills/band-chat.md`](../apps/cli/skills/band-chat.md) for the full per-command reference and more workflows.
