---
title: Repo config
description: Set up and tear down worktrees, copy untracked files and choose where CLI prompts go with .band/config.json.
section: configuration
order: 10
---

A repo can commit a `.band/config.json` file to tell Band how to prepare its worktrees. Everyone who clones the repo then gets the same setup. For a fuller description of the toolchain a repo needs, see [Environments](agent-environments.md).

## Where Band reads it

Band reads `<worktree>/.band/config.json` first and falls back to `<repo>/.band/config.json` in the main checkout. The fallback covers a config file that is in `.gitignore`, so new worktrees do not contain it. The file is read on the worker that owns the worktree.

```json
{
  "setup": "npm install && npm run db:migrate",
  "teardown": "docker compose down -v",
  "workspace": {
    "copyFiles": [".env", ".env.local", "config/*.local.json"],
    "defaultVia": "chat"
  }
}
```

## Keys

| Key | Type | Meaning |
| --- | --- | --- |
| `setup` | string | Shell command that runs after a worktree is created. |
| `teardown` | string | Shell command that runs before a worktree is removed. |
| `workspace.copyFiles` | list of strings | Files to copy from the main checkout into a new worktree. Globs are allowed. |
| `workspace.defaultVia` | `"chat"` or `"terminal"` | Where the CLI sends a prompt by default. |

Both commands are one string. Chain steps with `&&` or `;`.

## Setup

When a worktree is created, Band opens a terminal tab in it and runs the `setup` command there. You can watch the output, see a failure and answer a prompt the script raises. Setup runs alongside the agent's first prompt, not before it. A failed setup does not delete the worktree.

```json
{ "setup": "npm install && npm run db:migrate && cp .env.example .env" }
```

## Teardown

Before Band removes a worktree, it runs `teardown` in a terminal tab of that worktree and waits for it. A failing teardown does not stop the removal.

## Copy untracked files into new worktrees

A new worktree has only tracked files. Files such as `.env` or local credentials are missing. Band copies them from the repo's main checkout after it creates the worktree and before `setup` runs, so `setup` can read them. Two files can list what to copy.

`workspace.copyFiles` is a list of paths relative to the repo root. Globs such as `*`, `?`, `[abc]` and `{a,b}` work.

`.worktreeinclude` is a file at the repo root with `.gitignore` syntax. Band copies only files that match a pattern and are ignored by git. Tracked files are never copied again.

```text
# .worktreeinclude
.env*
config/*.local.json
.vscode/
```

If both exist, Band copies the union and copies a file declared twice once. It copies regular files, not links, so edits in the worktree do not change the main checkout. Folder structure is kept: `config/local.json` lands at `<worktree>/config/local.json`. A listed file that does not exist is skipped with a warning and does not stop worktree creation. Band caps `copyFiles` at 100 entries and 500 matched files. It copies from the main checkout only, never back, and does not rewrite the files.

## Default dispatch target

`workspace.defaultVia` sets where `band worktrees create --prompt`, `band cronjobs create` and `band agents launch` send a prompt when you do not pass a flag. The CLI reads the file in the repo of its current directory. The order for `worktrees create` and `cronjobs create` is the `--via` flag, `$BAND_DISPATCH`, `workspace.defaultVia`, `cli.defaultVia` in `~/.band/settings.json`, then terminal. `band agents launch` checks `--mode`, `$BAND_DISPATCH`, `workspace.defaultVia`, then the hub setting for programmatically created agents.

## Relation to environment.json

`.band/environment.json` can also define the setup and teardown commands. When a valid `environment.json` has `install` or `start`, it supplies the setup command. When it has `teardown`, it supplies the teardown command. Otherwise Band uses `setup` and `teardown` from `config.json`. Everything else in `config.json`, including `workspace`, stays in effect. See [Environments](agent-environments.md).
