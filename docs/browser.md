---
title: Browser
description: Browser tabs in the desktop app, cookie profiles, importing cookies and history from Chrome, and the band browsers commands.
section: using-band
order: 70
---

A browser tab shows a web page next to your chat and terminals, for example the dev server of the worktree you work in. Browser tabs exist only in the desktop app on macOS. The web UI in a regular browser and the iOS app have no Browser tab.

## Open and use a tab

Press Shift+Cmd+B or run "New Browser" from the command palette. Each worktree has its own tabs. A tab has back, forward, reload and stop buttons, an address bar ("Enter URL or search...") and a button that toggles the developer tools.

An agent or script can manage tabs with the CLI:

```sh
band browsers create --url http://localhost:3000 --name "dev server"
band browsers list
band browsers navigate --url http://localhost:3000/login
band browsers get
band browsers remove
```

Each command finds the worktree from the folder you run it in. Pass a worktree id to `create` and `list`, or a tab id to `navigate`, `get` and `remove`, to name one yourself. `--output json` gives machine-readable output. See [Browser commands](/docs/cli-browsers).

## Browser profiles

A browser profile is a separate cookie jar. Signing in to a site in one profile does not sign you in elsewhere. The built-in Default profile is used until you pick another.

- The profile button in a tab's toolbar shows the tab's profile and lets you switch it. Switching also makes that profile the default for new tabs in the repo.
- Settings > Repos > (a repo) > Browser > "Default profile" sets the profile that new tabs in every worktree of that repo open with.
- Settings > Browser > "Browser profiles" lists the profiles and deletes them. Deleting a profile signs you out of every site in it.

The profile menu has no "new profile" item. You create a profile by importing from Chrome, as described next.

## Import from Chrome

The profile button's menu has "Import from browser...". It opens a dialog that reads Google Chrome's data on this Mac.

1. Pick a Chrome profile under "From". The dialog lists the profiles it finds.
2. Switch on "Cookies", "Browsing history" or both.
3. Click Import.

If Chrome is running, the dialog warns "Close Google Chrome completely before importing". Band reads Chrome's files from a copy. A copy that Chrome still holds locked makes the whole import fail, so quit Chrome first.

Cookies go into a Band profile named after the Chrome profile, with "(Chrome)" appended. Importing the same Chrome profile again updates that profile instead of creating another. Sites you are signed in to in Chrome are signed in here, including in tabs that agents drive.

macOS asks you to allow access to "Chrome Safe Storage" in your Keychain. Band uses the key only to decrypt the cookies. The cookies stay on your Mac. Their values do not go to the hub or to logs.

History adds up to the 5,000 most recent http and https addresses to the browser history of the worktree you opened the dialog in. Existing entries are merged.

Not imported:

- Saved passwords. Band's browser has no password store.
- Google sign-ins. Sign in to Google again in Band.
- Anything from a browser other than Google Chrome.

## Stream tabs to web clients

Settings > Browser has a switch, "Stream desktop tabs to web (experimental)". When it is on, the desktop app opens a Chromium debugging port and lets web clients view and drive your browser tabs. Turn it off if you do not use the web UI for browsing.

## Browsers on workers

A remote worker can run a Chromium for a worktree: one browser per worktree, with its own profile folder on the worker, so cookies survive a reopen. It runs headless unless the worker has a display. The worker needs Chromium installed. Set `BAND_CHROMIUM_BIN` on the worker to name the binary, or the worker looks in the usual install paths.

The agent in a remote worktree finds the browser's debugging port in the file named by `BAND_CDP_PORT_FILE`. The hub can relay the browser's debugging connection to a client.

Not supported yet: driving this browser with `band browsers` commands, and showing it in the Browser tab.
