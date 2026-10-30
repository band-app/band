---
title: Changes and commits
description: Review a worktree's uncommitted and committed changes, stage and discard files, read diffs and browse the commit graph.
section: using-band
order: 40
---

The Changes tab shows what differs in the active worktree. It sits in the right sidepanel next to Explorer. Each file opens as a diff tab in the center area, beside your chat and terminals.

![The Changes tab in the right sidepanel](/docs/screenshots/changes.png)

Open the tab with Shift+Cmd+G. Toggle the whole sidepanel with Option+Cmd+B. The Changes tab shows a badge with the number of changed paths.

## Sections

The tab lists files in sections. A section appears only while it has files. Click a section header to collapse it. Band remembers which sections you collapsed.

| Section | What it holds |
| --- | --- |
| Conflicts | Files left unmerged by a merge, rebase or cherry-pick. |
| Changes | Edits in the working tree that are not staged. |
| Staged Changes | What the next commit will contain. A file edited again after staging is listed here and under Changes. |
| Untracked Files | New files git does not track yet. |
| Committed on Branch | Files the branch's commits changed since it forked from the compare branch. Uncommitted work never shows up here. |

Each row shows a status letter (M modified, A added, D deleted, R renamed, C copied, U untracked) and a file name. A single click opens the diff as a preview tab that the next click replaces. A double click keeps the tab open. "View all" in a section header opens every file of the section in one tab.

## Compare branch

The header above the sections shows the current branch and the branch it is compared with. The compare branch defaults to the repo's default branch. Pick another local or remote branch from the dropdown, which has a "Search branches" box. Band remembers the pick per worktree and compares from the merge base, so you see only what your branch added.

The Committed on Branch section explains an empty list: the compare branch does not exist, the two branches share no history, or the branch has no commits yet.

## Stage, unstage and discard

Hover a file or folder row, or right-click it, to see its actions. The same actions sit in each section header and apply to every file in the section.

- Stage in Changes and Untracked Files. In Conflicts the same button reads "Mark as resolved".
- Unstage in Staged Changes.
- "Discard changes" in Changes throws away unstaged edits and keeps what is staged. In Staged Changes it returns the file to its last committed version, including unstaged edits. "Delete untracked file" in Untracked Files deletes the file from disk.

Every discard asks for confirmation first, and none can be undone. Rows in Committed on Branch have no actions. The right-click menu also copies a file's relative or absolute path.

## Read a diff

A diff tab has a toolbar:

- Unified view and Side-by-side view buttons. The side-by-side view is not offered on a phone.
- "Open file for editing" opens the file in an editor tab.
- "Revert file" appears for files in Changes, Staged Changes and Untracked Files. It asks for confirmation and does the same as Discard on that one file. Conflicted files and files from Committed on Branch have no Revert button.

## Commits graph

Below the sections, a Commits panel shows the worktree's history as a graph, with branch and tag labels on the commits that carry them. Click the header to collapse it. Drag its top edge to change its height. "Load more" fetches older commits.

Click a commit to expand its changed files. Click a file to open that file's diff for the commit in a diff tab. The refresh button reloads the list.

## Refresh

Band reloads the Changes tab every 15 seconds while the sidepanel is visible, and after each stage, unstage or discard you make in it. The Commits panel checks the current commit and branch labels every 5 seconds and reloads the history when they move. A hidden sidepanel does not poll.

## Committing

Band has no commit button, commit dialog or push button. You commit in one of two ways:

- Ask the agent in a chat, for example "commit these changes". The agent runs git in the worktree.
- Stage files in the Changes tab, then run `git commit` in a [terminal](terminals.md) tab.

The new commit shows up in the Commits panel within a few seconds. For a pull request and its checks, see [GitHub integration](github-integration.md).

On a worker that is offline, the tab shows the latest [checkpoint](checkpoints.md) read-only instead.
