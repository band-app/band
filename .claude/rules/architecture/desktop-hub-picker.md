---
paths:
  - "**/HubSettings.tsx"
  - "**/hub-unreachable.ts"
  - "**/index.ts"
  - "**/ipc/hub.ts"
  - "**/ipc/sender-guard.ts"
  - "**/navigation-guard.ts"
  - "**/window.ts"
  - "apps/desktop/src/main/app-protocol.ts"
  - "apps/hub/**"
  - "apps/desktop/src/main/services/hub-choice.ts"
  - "apps/desktop/src/main/services/ui-paths.ts"
  - "apps/web/e2e-desktop/**"
  - "apps/web/public/manifest.webmanifest"
  - "apps/web/src/lib/hub-config.ts"
---

# Architecture: desktop hub picker

The desktop window loads the bundled UI from `app://<host>/` (`apps/desktop/src/main/app-protocol.ts`, a standard, secure, `supportFetchAPI` scheme; a path with no extension and no file gets `_shell.html`, so reloads and deep links keep their route). The UI build comes from `resources/web/dist/client` when packaged and `apps/web/dist/client` in a repo build (`services/ui-paths.ts`); with no build the window falls back to loading the hub's own URL. With `BAND_DEV_WEB_URL` set in an unpackaged run, local mode still loads the dev server.

- The hub is `local` (default: Electron spawns `apps/hub`) or `remote` (a URL and token, nothing spawned). The choice lives in `~/.band/desktop-hub.json` (mode 0600, `services/hub-choice.ts`). A remote `http:` URL is accepted only for loopback, because the secure `app://` page can't make plain `http:`/`ws:` requests to other hosts.
- Each hub has its own host, so its own origin and localStorage (drafts, tabs, last worktree): `app://local` for the bundled hub, `app://h-<12 hex of sha256(hub origin)>` for a remote one. The handler serves only the host the window is loaded under.
- Every `app://` response carries a CSP (`buildCsp`): `connect-src` is `'self'` plus the current hub's http and ws origins, `frame-src` and `media-src` allow the hub, `object-src 'none'`. Inline scripts are allowed because the SPA shell has inline bootstrap scripts. A new origin the UI must reach (another API host) needs adding there.
- The main window can't leave its `app://` host: `will-navigate` and `will-redirect` open web links in the browser and drop everything else, and `window.open` never creates a window (`navigation-guard.ts`). A hub switch loads programmatically, so it is unaffected.
- The preload reads `{ url, token }` with a synchronous IPC (`band_hub_config`, answered only to the bundled UI's frames, `ipc/hub.ts`) and exposes it as `window.__BAND_HUB__`, which `apps/web/src/lib/hub-config.ts` already reads. The renderer never gets the saved remote token back: `hub_get_choice` returns only `hasToken`. The hub IPC handlers also require the main window's top frame on a trusted origin.
- The hub's CORS allows only `app://local`, `app://h-<12 hex>` and the configured origins (`corsAllowedOrigins`, `BAND_CORS_ORIGINS`). Other `app://` hosts and `file://` are refused. `Origin: null` is allowed only when `null` is in the configured list.
- `registerIpc` wraps every channel with the sender check (`ipc/sender-guard.ts`): the main window's top frame on a bundled `app://` origin, never a `<webview>` or subframe. A new channel registered through its `handle` gets the check automatically.
- With a saved remote hub that does not answer at launch, the window shows a Retry / Use local page (`hub-unreachable.ts`, a `data:` URL whose links are `band-action://` URLs handled in `window.ts`). Use local runs the bundled hub for that run and keeps the saved remote choice. A hub switch started while another runs is refused with an error in the picker.
- Settings > Hub (`HubSettings.tsx`, desktop only) calls `hub_set_choice`. The main process checks the remote hub with `GET /api/health` and the Bearer token, then `switchHub` in `index.ts` stops or starts the local hub and reloads the window.
- The PWA manifest is `apps/web/public/manifest.webmanifest`. The hub still answers it before auth, for iOS.
- `apps/web/e2e-desktop/` drives the real unpackaged Electron app with Playwright's `_electron` (`pnpm --filter @band-app/web test:e2e:desktop`, CI job `desktop-macos`). It needs `pnpm build:web` and `pnpm --filter @band-app/desktop build` first, and runs against a throwaway HOME with a random `webServerPort`: the app kills whatever listens on that port, so never point it at 3456. With `BAND_DESKTOP_EXECUTABLE` set to a packaged `Band` binary (`pnpm --filter @band-app/desktop package:dir --mac --arm64`, output in `apps/desktop/dist-builder/mac-arm64/Band.app/Contents/MacOS/Band`) the same specs run against the electron-builder output, in the CI job `desktop-packaged-macos`. A packaged run has no scripted ACP agent, because the hub starts it as `process.execPath <script>`, which in a packaged app launches a second Band that frees the hub's port. The chat-reply step skips there. The folder picker is tested by stubbing `dialog.showOpenDialog` in the main process and calling the `pick_folder` IPC; the native sheet itself stays untested.
- The desktop e2e suite is isolated and safe to run while the real Band.app is open. `launchDesktop` refuses a HOME outside the OS temp dir, passes `BAND_DESKTOP_USER_DATA_DIR=<home>/electron-profile`, and after launch, before any hub connection, asserts that `userData`, `sessionData` and the partitions dir resolve under the temp home, killing the app otherwise. The app takes no single-instance lock and registers no protocol client or login item. `global-setup.ts` and `global-teardown.ts` list the real `~/Library/Application Support/Band` (read-only, ignoring Chromium caches and lock files) and fail the run if a file was removed or shrunk to under half (the live app rewrites its own caches and storage, so additions and growth are ignored). The side-effect list is in the header of `apps/web/e2e-desktop/helpers/desktop-app.ts`.
