---
title: Groups
description: Sort worktrees into named, colored sections of the sidebar, and see how titles and the unread mark help you scan the list.
section: using-band
order: 25
---

A group is a named, colored section of the sidebar. Groups collect worktrees from any repo and any worker, so you can keep "Payments" work together even when it spans three repos. A worktree is in at most one group. A worktree in no group appears after the last group, with no header.

![The sidebar with groups and worktrees](/docs/screenshots/dashboard.png)

Until the first group exists, the sidebar lists worktrees under their repos.

## Create a group

- Open the filter button in the Repos header and choose **New group…**.
- Or open Settings > Groups and click **New group**.
- Or run `band groups create`.

```sh
band groups create Payments --color "#3b82f6"
band groups list
```

Creating a group on a shared hub needs an admin token, as in the UI.

## Put worktrees in a group

- Drag a worktree card onto a group header. If the worktree has worktrees started from it, a dialog asks "Move its N children too?".
- Drop a card on a top-level row, or on the strip above the first group, to take it out of its group.
- Set the group when you create the worktree. The New worktree dialog uses the group the sidebar is filtered to. Without that, the worktree joins the group of the worktree it was started from. See [Origin links](origin-links.md).
- Use the CLI.

```sh
band worktrees set-group <id> Payments
band worktrees set-group <id> Payments --with-children
band worktrees set-group <id> --none
band worktrees create atlas feat/login --group Payments
```

`--with-children` also moves every worktree started from this one. Agents can assign worktrees to groups too, but they cannot create, rename or delete groups.

## Change a group

Right-click a group header for these items:

- **Rename…**
- **Move up** and **Move down**
- **Color**
- **Delete…**

Dragging a header above or below another reorders the groups. The **+** on a header starts a new worktree in that group.

Settings > Groups does the same in a list. You can drag rows to reorder them, edit a name or a color, and delete a group. Each change saves at once. Deleting a group leaves its worktrees in place, without a group. The CLI has the same operations.

```sh
band groups rename Payments Billing
band groups remove Billing
```

## Filter by group

The filter button in the Repos header shows All or one group. The list of one group looks the same as inside All, so you do not lose your place when you switch. The shortcuts are:

- ⌘0 shows all groups.
- ⌘1 to ⌘9 show the first to ninth group, in sidebar order.

Pinned worktrees follow the filter. See [Layout and shortcuts](layout.md).

## Titles

A worktree card shows its branch name. Give it a title when the branch name is not enough, such as a ticket summary. Choose **Rename…** in the card's menu, or double-click the card. Press Enter to save. A blank title shows the name again, and a title can have up to 100 characters. Headers and dialogs show the title too, and hovering the card shows both.

```sh
band worktrees rename <id> "Fix login redirect"
band worktrees rename <id> --clear
```

## Unread mark

An unread mark is a dot you set yourself, to come back to a worktree later. Use **Mark as unread** in the card menu, or click the dot on the card. Opening the worktree clears the mark, except that a worktree you marked while it was open keeps the mark until you open another one. Every device shows the same mark.

```sh
band worktrees mark-unread <id>
band worktrees mark-read <id>
```

**Mark as read** also clears a done or failed dot. See [Agent status](agent-status.md) for the other dot states.
