---
paths:
  - "**/ChromeImportDialog.tsx"
  - "**/guest-policy.ts"
  - "**/snapshot.ts"
  - "apps/desktop/src/browser/chrome-import/**"
  - "apps/desktop/src/browser/profiles.ts"
  - "apps/web/src/lib/browser-webview.ts"
---

# Architecture: browser profiles

A browser profile is a separate cookie jar for browser-pane tabs: one Electron session partition per profile (`persist:band-browser-profile-<id>`, see `apps/desktop/src/browser/profiles.ts`). The built-in Default profile is `null` everywhere and keeps the original `persist:band-browser` partition.

- The web server stores only metadata: the `browser_profiles` table, each repo's default profile (`repo_browser_profiles`), and each tab's `profileId` in its `panel_states` blob. `browsers.create` without a `profileId` uses the repo default. `browsers.setProfile` switches a tab and makes that profile the repo default.
- Chrome import reads Chrome data only in the desktop app (`apps/desktop/src/browser/chrome-import/`). The import dialog (`ChromeImportDialog.tsx`, "Import from browser…" in the pane's profile menu) lists Chrome's profile names from `Local State` and shows a "close Chrome" hint while Chrome's `SingletonLock` points at a live process. The user toggles cookies and browsing history and clicks Import. The desktop then reads every selected DB from a private copy (`snapshot.ts`) before writing anything; a copy that SQLite reports as busy, locked or malformed fails the whole import with `ChromeDataLockedError`. Cookies are decrypted with the "Chrome Safe Storage" key (`security find-generic-password`, the macOS Keychain prompt) and written into the Band profile's partition; their values never cross IPC, reach the web server, or get logged. History entries (the most recent 5,000 http(s) URLs) go back to the renderer, which stores them in the tab's worktree history with `history.import`, merging with rows already there. Saved passwords aren't imported, because Band's browser has no password store or autofill. Importing a Chrome profile again re-imports its cookies into the Band profile with the same name (`<Chrome name> (Chrome)`) instead of creating another one, and `browserProfiles.create` refuses a name that is already taken, ignoring case (409).
- A pane's `<webview>` sets its `partition` from the tab's profile (`partitionForProfile` in `apps/web/src/lib/browser-webview.ts`, mirrored in `apps/desktop/src/browser/profiles.ts`). `guest-policy.ts` admits only the Default and profile partitions, and the guest manager prepares each session (`band-action://` handler, no `file:`) when its first guest attaches.
