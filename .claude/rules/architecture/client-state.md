---
paths:
  - "**/__root.tsx"
  - "**/lib/center-tabs.ts"
  - "**/lib/client-state.ts"
  - "**/lib/last-worktree.ts"
  - "packages/shared/src/client-state-keys.ts"
  - "apps/desktop/src/main/services/window-state.ts"
  - "apps/hub/src/server/services/client-state-service.ts"
---

# Architecture: client state

Small UI state (center tabs, drafts, panel widths, collapsed repos) lives on the web server so the phone and the desktop show the same thing. localStorage stays the synchronous read cache.

- The server keeps rows in `client_state`, keyed by `(key, scope)`. It accepts only the keys listed in `shared/client-state-keys.ts`, takes a key's worktree from the key, and refuses writes for a worktree that no longer exists. Scope `all` is one value for every device; `desktop` and `mobile` hold one value per device type (viewport of at least 1024 px, or the desktop app, counts as desktop). `services/client-state-service.ts` and the `clientState.*` router own them. A write names the version it was based on, and a stale one is refused and answered with the current row. A delete leaves a tombstone, which `list` doesn't return. Accepted writes go out as `client-state-changed` on the status stream. Deleting a worktree removes its rows.
- The dashboard writes through `clientStorage` (`lib/client-state.ts`), which writes localStorage and pushes the key 500 ms later. `shared/client-state-keys.ts` lists the synced keys and their scope; any other key stays on the device (for example `band.agent-mode`, per device on purpose). A synced key can split into several entries: `band-tab-state:<ws>` shares view mode and language and keeps scroll per device type.
- Unsaved file edits and untitled buffers are shared too, one key per file (`band-unsaved:<ws>:<path>`). Last save wins. When another device's copy of a file arrives while this device has edits of its own, the file leaf shows a banner offering to load theirs or keep its own; with no local edits the leaf just loads the new copy. Untitled numbers start above every `untitled:N` in the shared tab list, so two devices don't share a buffer by accident.
- Hydration runs before first read: `ClientStateGate` in `__root.tsx` waits for the global keys, and the center layout's data query waits for its worktree's keys (both give up after 1.5 s so an offline load still renders). A local value the server doesn't have is uploaded, which migrates existing localStorage.
- The center layout shares only which tabs are open, their order and the active tab (`band:center-tabs:<ws>`, `lib/center-tabs.ts`). Its full layout, with splits and sizes, is per device type. While a worktree is on screen, another device's change only opens and closes tabs; order and active tab apply the next time it is shown.
- A load on `/` (every desktop launch, a phone's home-screen icon) reopens the worktree this device type last showed (`band:last-worktree`, `lib/last-worktree.ts`). `ClientStateGate` picks it after hydration and before the shell renders, skips a worktree that no longer exists, and prefers the selected group's last worktree when the two disagree. The desktop window's bounds and maximized / full-screen state live in `~/.band/desktop-window.json` (`apps/desktop/src/main/services/window-state.ts`).
- e2e specs whose tests share one server call `resetClientState(tmpHome)` in `beforeEach`, because UI state no longer resets with each new browser context.
