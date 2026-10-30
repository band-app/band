---
title: Layout and shortcuts
description: Where the sidebar, tabs and side panel are, and the keyboard shortcuts that move between them.
section: using-band
order: 10
---

Band has three areas. The Repos sidebar is on the left, the tabs of the open worktree are in the middle, and a side panel is on the right.

![The Band dashboard with the sidebar, a chat open in the center and the side panel](/docs/screenshots/dashboard.png)

## Repos sidebar

The sidebar lists your repos and their worktrees, sorted into [groups](groups.md). Each worktree is a card with its [status](agent-status.md). The header has these controls:

- **+** adds a repo (admin only). See [Repos](repos.md).
- The filter button shows one group or all of them.
- The last button collapses or expands every section.

Toggle the sidebar with ⌘B. ⌃0 shows it and moves focus into the list, where the arrow keys move between cards.

## Center tabs

The middle area holds the tabs of the open worktree. A tab is one of:

- A chat with a coding agent.
- A terminal. A terminal splits into panes of its own.
- A browser. Browser tabs exist in the desktop app only.
- A file in the editor.
- A diff.

Open a new tab from the new-tab menu or with a shortcut. Drag a tab to reorder it or to move it to another group of tabs, and drag it to an edge to split the area. Chat and browser tabs split into sibling groups. Maximize one group with ⇧⌘M.

Band saves the layout per worktree. The saved layout has its own copy for desktop-sized screens and for phone-sized screens, but the set of open tabs, their order and the active tab are shared between your devices.

## Right side panel

The right panel has an Explorer tab for the worktree's files and a Changes tab for its uncommitted changes and diffs. Plugins can add tabs after those two. The GitHub plugin adds Checks, which shows the pull request and its CI checks. See [Changes](changes.md) and [GitHub integration](github-integration.md).

Toggle the panel with ⌥⌘B. ⇧⌘E opens Explorer and ⇧⌘G opens Changes.

## Phones and narrow windows

A narrow window gets a different layout instead of a squeezed copy of the desktop one. The home page is the full-screen repo list. Inside a worktree, a menu button opens the repo list from the left, and Explorer, Changes and the plugin tabs open as sheets from the bottom. The native [iOS app](ios-app.md) is a separate app with its own interface.

## Command palette and quick open

- ⇧⌘P opens the command palette. It lists the commands below that have a palette entry, plus a few without a shortcut, such as Change Language Mode.
- ⌘P opens Quick Open for files in the worktree.
- ⌘K switches to another worktree.

## Shortcuts

Shortcuts use ⌘ on macOS. On other systems the same shortcut uses Ctrl, with the exceptions listed in the notes below the tables.

### Navigation

| Shortcut | Action |
| --- | --- |
| ⌘K | Switch worktree |
| ⌥⌘← and ⌥⌘→ | Previous and next worktree in your history |
| ⌘B | Show or hide the sidebar |
| ⌥⌘B | Show or hide the right panel |
| ⌃0 | Focus the repo list |
| ⌘0 | Show all groups |
| ⌘1 to ⌘9 | Show the first to ninth group |
| ⇧⌘P | Command palette |
| ⌘P | Quick Open |
| ⇧⌘F | Search in files |

### Tabs and panes

| Shortcut | Action |
| --- | --- |
| ⌘T | New terminal |
| ⌥⌘T or ⇧⌘N | New chat with the default agent |
| ⇧⌘B | New browser tab (desktop app) |
| ⌘N | New untitled file |
| ⌘W | Close the tab, or the pane in a split terminal |
| ⇧⌘] and ⇧⌘[ | Next and previous tab |
| ⌃Tab | Switch tabs by most recent use (desktop app) |
| ⌘] and ⌘[ | Next and previous pane |
| ⌘D and ⇧⌘D | Split right and split down |
| ⇧⌘M | Maximize or restore the active group |
| ⌃⌘I | Show the chat tab |
| ⌃\` | Show the terminal tab |
| ⇧⌘E | Show Explorer |
| ⇧⌘G | Show Changes |

### Editor and window

| Shortcut | Action |
| --- | --- |
| ⌘F | Find in the open file |
| ⌘O | Open the file in your external editor |
| ⇧⌥F | Format the current file |
| ⌘= and ⌘- | Zoom in and out |
| ⇧⌘0 | Reset zoom |
| ⌘, | Open settings (desktop app) |
| ⌘R | Reload (desktop app) |

Notes for other systems:

- Off macOS, ⌥⌘T does not exist. Use Ctrl+Shift+N for a new chat.
- Split right is Ctrl+Shift+D and split down is Alt+Shift+D, because Ctrl+D ends a shell.
- Show chat is Ctrl+Alt+I.
- A terminal with focus keeps Ctrl chords for the shell. The ones that still work there are Ctrl+Shift+N, Ctrl+Shift+B, Ctrl+Shift+P, Ctrl+Shift+M and Ctrl+Alt+I.
- In a terminal pane, ⌘D, ⌘W and ⌘[ and ⌘] act on the split panes of that terminal first.
