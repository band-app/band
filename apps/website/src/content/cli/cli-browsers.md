---
title: band browsers
description: Open, navigate, inspect and close browser tabs in a worktree from the command line.
section: cli
order: 60
commands: [browsers]
---

A browser tab is a page in a worktree's browser pane. `band browsers` lets a script or an agent open a page next to the code, for example a dev server it just started. Browser tabs need the desktop app. See [Browser](/docs/browser).

Commands that list or create take a worktree id. Leave it out and the CLI uses the worktree that contains the current directory. Commands that act on one tab take a browser id, and without it they use the worktree's first tab.

## Listing tabs

```sh
band browsers list
```

```text
ID            NAME   URL                     STATUS
browser-2c9d  app    http://localhost:5173/  idle
```

The columns are the tab id, its display name, its current URL and its status, which is `idle`, `loading` or `error`. JSON output is `{"browsers": [...]}`.

## Creating, navigating and removing

`create` prints the new tab's id. `--url` sets the first page and `--name` the tab's label.

```sh
band browsers create --url http://localhost:5173 --name app
band browsers navigate --url http://localhost:5173/settings
band browsers navigate browser-2c9d --url https://example.com
band browsers remove browser-2c9d
```

`navigate` prints `Navigated <id> to <url>`. `remove` prints `Browser <id> removed`.

## Reading a tab's state

`get` prints one tab as labeled lines:

```sh
band browsers get browser-2c9d
```

```text
ID:     browser-2c9d
Name:   app
URL:    http://localhost:5173/settings
Status: idle
```

With `--output json` it prints `{"browser": {...}}`.
