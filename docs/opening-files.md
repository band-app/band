# Opening files

Any file can open as a tab in a worktree. Inside the worktree it is a normal file tab. Outside every worktree it is an external tab, which you can edit and save.

## From a Band terminal

```sh
band open README.md
band open src/main.rs:42:5
band open /etc/hosts
```

`band open` opens the file in the worktree of the terminal or agent that runs it (`$BAND_WORKTREE_ID`). Outside Band, or with `--worktree <id>`, it uses that worktree or the one most recently focused in the dashboard.

An external tab reads and saves the file on the machine the worktree runs on. For a worktree on a remote worker that is the worker's disk, through the worker's path policy (its home and roots). The hub's own disk is never read for it. A file the worker's policy refuses cannot be opened.

## From Finder (desktop app)

Band appears in Finder's Open With menu for text and source files (plain text, source code, JSON, XML, YAML, HTML, CSS, shell scripts, Markdown). Its rank is Alternate, so it never becomes the default app for any of them.

You can also drag files from Finder onto any tab strip, or onto the empty center area of a worktree. Each file opens in a new tab. A dropped folder shows a notice and opens nothing. The Open File picker (Cmd+O) follows the same rule.

Where a file opens:

- A file inside a worktree whose worker runs on this Mac opens in that worktree, as a normal tab. Band switches to the worktree if another one is open.
- Any other file opens as an external tab in the current worktree. The desktop app reads and saves it on this Mac, whichever worker the worktree uses. Open a worktree first: with none open there is nowhere to put the tab.

The desktop app reads a file with no symlink on its last path component, only regular files, up to 1 MB, and refuses binary content. A save never creates a file.

## Limits

- In a browser, dropping a file on a tab strip does nothing. A browser gives a page no path to the file. Paste an absolute path into Quick Open (Cmd+P) instead, which opens it from the worktree's machine.
- A file from Finder opens as a tab of the desktop app only. It does not sync to your other devices.
- External tabs do not reload when the file changes on disk.
- Linux and Windows file associations are not set up.
