# Band mobile

The Expo iOS app for Band. It pairs with a hub, lists repos and worktrees like the web sidebar (Pinned, then repos grouped by repo, origin or host, with agent state, PR and CI), starts an agent from a floating composer, and opens chats (transcript, composer, queue, permission requests) and terminals. A worktree's chat and terminal tabs, shared with the web, sit behind the title pill: tap it for the tab sheet, or swipe the transcript sideways. The look follows the system appearance, light or dark. iOS only.

## Requirements

- macOS with Xcode and an iOS simulator runtime (`xcrun simctl list devices available | grep iPhone` prints something).
- CocoaPods (`brew install cocoapods`).
- Node 24 (`.nvmrc`).
- pnpm 10. Run it as `npx -y pnpm@10 …` if you have another version.

## Install

From the repo root:

```bash
npx -y pnpm@10 install --frozen-lockfile
```

If pnpm refuses a freshly published package because of the release-age rule, add `--config.minimum-release-age=0`. A cold install takes about 15 to 30 minutes. If it stops with `ERR_PNPM_ENOENT` on a slow connection, run the same command again. pnpm reuses what it already downloaded.

## Run on the simulator

```bash
cd apps/mobile
npx expo run:ios
```

The first run generates `apps/mobile/ios`, installs the pods and builds the app (5 to 20 minutes, about 2.5 GB). It starts Metro for the debug build, so leave that terminal open. With more than one simulator booted, pass `--device <UDID>` (list them with `xcrun simctl list devices | grep Booted`). The app opens on the pairing screen.

## Start a throwaway hub

The throwaway hub runs the hub bundle in a temp HOME with the scripted stub agent, so it never touches `~/.band`. Build the bundle once, then start it:

```bash
npx -y pnpm@10 build:web
node apps/mobile/scripts/hub.mjs start
```

The command prints a JSON object with the hub `url`. The device token is the `deviceToken` field of `apps/mobile/build/verify/hub.json`. `hub.mjs restart` boots the same home on the same port, and `hub.mjs clean` stops it and deletes the temp home. The hub starts empty. `verify.mjs` seeds it with the sample repos and chats the Maestro flows use.

## Pair with a hub

Use any hub you have a device token for: the throwaway one above, or your real hub (Settings > Devices > Add device shows a QR code, a link and the token).

- Manual: on the pairing screen, enter the hub URL and the token.
- Camera: scan the QR code from Settings > Devices (a real iPhone only).
- Deep link: `xcrun simctl openurl <UDID> "band://pair?url=<url-encoded hub URL>&token=<token>"` (`booted` works when only one simulator is booted). iOS asks "Open in Band?", so tap Open. The app then shows "Connect to this hub?", so tap Connect. The home screen shows Connected.

The simulator reaches a hub on the same Mac at `http://localhost:<port>`. A hub on another machine must be `https`, or on the local network.

## Run on an iPhone

1. Run `npx expo prebuild --platform ios --no-install` to generate `apps/mobile/ios`, then open `apps/mobile/ios/Band.xcworkspace` in Xcode.
2. Select the Band target, then Signing & Capabilities. Pick your Team, and change the bundle identifier `app.getband.mobile` to one your team owns.
3. Connect the iPhone and run, or use `npx expo run:ios --device`.
4. Accept the local network prompt. The phone must reach the hub's URL.

## Tests

```bash
npx -y pnpm@10 --filter @band-app/mobile test        # unit tests (node:test)
npx -y pnpm@10 --filter @band-app/mobile typecheck
```

The end-to-end Maestro flows in `e2e/` run against a throwaway hub on one booted simulator. Follow `.claude/skills/mobile-verify/SKILL.md`, or run `node apps/mobile/scripts/verify.mjs`. Set `BAND_SIM_UDID` to pick the simulator. Reports and screenshots go to `apps/mobile/e2e/artifacts/` (gitignored).

## Terminals

A terminal tab draws with SwiftTerm in a local Expo module (`modules/band-terminal`). The module only shows a screen: JavaScript feeds it the hub's bytes and reads back keystrokes and the grid size. The protocol (attach with the fitted size, parse acknowledgements, resize, ping, reconnect with a replay) is `packages/client/src/terminal-client.ts`, and the key bar's bytes are `src/lib/terminal/key-bar.ts`. The scrollback is 10,000 lines.

SwiftTerm v1.20.0 is vendored under `modules/band-terminal/ios/SwiftTerm` (see `VENDORED.md` there) because it is not on CocoaPods trunk and the Swift package route needs package plugin validation and Xcode's Metal Toolchain in every build.

`tests/terminal-replay.test.ts` replays the sessions in `tests/fixtures/terminal` (recorded from real PTYs with `scripts/record-terminal.mjs`: `ls --color`, `less`, `vim` with resizes, a shell with resizes, a fast build log in a scroll region, and Claude Code's first-run screens) through SwiftTerm's headless terminal (`modules/band-terminal/replay`, a Swift package) and through xterm.js, and compares the final screens cell by cell. It needs macOS with the Swift toolchain and skips elsewhere.
