# Opening files

Any file can open as a tab in a worktree. Inside the worktree it is a normal file tab. Outside every worktree it is an external tab, which you can edit and save.

## From a Band terminal

```sh
band open README.md
band open src/main.rs:42:5
band open /etc/hosts
```

`band open` opens the file in the worktree of the terminal or agent that runs it (`$BAND_WORKTREE_ID`). Outside Band, or with `--worktree <id>`, it uses that worktree or the one most recently focused in the dashboard.

An external tab reads and saves the file on the machine the worktree runs on. For a worktree on a remote worker that is the worker's disk, and the hub's own disk is never read for it. A person (a device token) may open any regular file the worker's user can read, and save any it can write, inside the worker's folders or not (`~/.claude/settings.json`, `~/.zshrc`). The worker's folder policy does not apply, because a device token already gets a full terminal there. The worker serves this through `fs.external.stat | readFile | writeFile`, which only the hub calls for a device-token request. They take an absolute path, refuse symbolic links and anything but a regular file, and never create a file. Saving needs an existing file.

An agent keeps to the worker's folders. `editor.openFile` from an agent's chat through the relay, the MCP endpoint or a call carrying a chat header answers "Agents can only open files inside this worker's folders" for a path outside them. The relay and the direct path do not list the external methods or `readExternalFile | saveExternalFile`.

A terminal on the worker counts as a person: its relay call names a terminal and no chat, and the terminal already gives the worker user's shell.

`band open` says why a path fails: "File not found", "Not a regular file" (a directory or device) or "Permission denied".

## Previews of external files

An external tab previews the same file types as a worktree file.

- PDF, image and video. The viewer fetches `GET /api/external-file/<worktreeId>?path=<absolute path>` with the device token in a header and shows the answer as a Blob URL, so no token goes in a URL. The hub streams the bytes through `worktree.host.external.readStream` (the worker method `fs.external.readStream`), refuses links and anything but a regular file, and answers single-range `Range` requests (206, or 416 past the end). Files above 256 MB are refused in the pane with a message, because a Blob holds the whole file in memory. A request carrying `x-band-chat-id`, `x-band-worktree-id` or `x-band-terminal-id` gets 403, and the relay lists no such route.
- HTML. The Visual button (Preview mode) loads the page in a sandboxed iframe (scripts only, no same-origin). `worktree.externalPreviewUrl` returns `/api/external-preview/<worktreeId>/<grant>/<path>`, where the grant is an HMAC (purpose string `external-preview-v1`, valid for one hour) over the worktree id and the absolute folder of the file. Relative CSS, images and scripts load from that folder and below. A path with `..`, an encoded slash, a link that resolves outside the folder, another folder's grant, another worktree's grant, or a tampered or expired grant gets 403 or 400. Preview mode is read-only. Visual editing stays for worktree files.
- Desktop files (from Finder, a drop or Cmd+O). The main process reads the bytes (`read_local_binary`, regular files, no symbolic link, 100 MB at most). For HTML, `local_preview_grant` records the file's real folder under a random token (one hour, at most 50 at a time) and the `app://` handler serves that folder at `/__local-preview/<token>/<name>` with the same limits as the hub route. Media inside a previewed page does not support seeking on this path.
- An older worker that lacks `fs.external.readStream` makes the hub answer 501, and the pane shows "This worker is too old to preview files outside the worktree. Update it." A failed preview shows an error line, never a blank pane.


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
