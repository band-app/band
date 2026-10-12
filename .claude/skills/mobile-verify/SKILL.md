---
name: mobile-verify
description: Verify a change to the Band iOS app (apps/mobile) end to end against a real hub. Starts a throwaway hub with a temp HOME and the ACP stub agent, builds the app for the iOS simulator, installs it on one booted iPhone simulator, runs the Maestro flows in apps/mobile/e2e and saves screenshots and a report into the worktree for /am-verify evidence. Use for any change under apps/mobile, or when asked to "verify the mobile app", "run the Maestro flows", "test the iOS app", "mobile-verify", or to screenshot the mobile app.
---

# mobile-verify

Runs the mobile app's acceptance flows on the iOS simulator against a real Band hub, from a
worktree, without touching the real `~/.band`, the user's running hub or the desktop app.

Everything below runs from the worktree root unless a step says otherwise.

## One-time setup on a Mac

Check each tool first and install only what is missing. All of it is user space (Homebrew).

1. Xcode with an iOS simulator runtime: `xcodebuild -version` and
   `xcrun simctl list devices available | grep iPhone` must both print something. Installing
   Xcode is a manual step; stop and tell the user if it is missing.
2. CocoaPods: `pod --version`, else `brew install cocoapods`.
3. Java 17 for Maestro: `/opt/homebrew/opt/openjdk@17/bin/java -version`, else
   `brew install openjdk@17`. The verify script puts it on PATH itself, so no shell profile
   change is needed.
4. Maestro: `maestro --version` (the script also looks in `~/.maestro/bin`), else
   `brew tap mobile-dev-inc/tap && brew install mobile-dev-inc/tap/maestro`.
5. Node 24 (`.nvmrc`) and the workspace installed: `pnpm install`.

## Every run

1. Build the hub bundle once per worktree (the throwaway hub runs it):

   ```bash
   pnpm build:web
   ```

   Skip this when `apps/hub/dist/start-server.mjs` already exists and the change touches only
   `apps/mobile`.

2. Run the flows:

   ```bash
   node apps/mobile/scripts/verify.mjs
   ```

   It does, in order:
   - `expo prebuild` and `pod install` when `apps/mobile/ios/` is missing, then `xcodebuild`
     (Release, JS bundle embedded, so no Metro) with DerivedData in `apps/mobile/build/`;
   - starts a hub (`apps/mobile/scripts/hub.mjs start`) on a free port with a temp HOME, a
     random admin token and `BAND_TEST_ACP_AGENT`, and creates a device token with
     `tokens.createDevice`;
   - boots one existing iPhone simulator (a booted one first, never a new one; set
     `BAND_SIM_UDID` to pick one), installs the app;
   - runs every `apps/mobile/e2e/*.yaml` flow with `maestro test`, pairing through the deep
     link `band://pair?url=…&token=…` instead of the camera;
   - searches the app's log lines and data container for the device token;
   - stops the hub and deletes its temp home.

   The first build takes 10 to 20 minutes. Later runs with no native change can skip it:
   `node apps/mobile/scripts/verify.mjs --skip-build`. A JS-only change still needs a build,
   because Release embeds the bundle.

   Run some flows only by naming them: `node apps/mobile/scripts/verify.mjs --skip-build wrong-token hub-down`.

3. Read the report. The script prints it and saves it with the screenshots under
   `apps/mobile/e2e/artifacts/<timestamp>/` (gitignored). Each flow has a folder with its
   screenshots and Maestro's output. The script exits non-zero when a flow fails or the token
   was found. Paste the report table and the screenshot paths into the `/am-verify` evidence.

## The flows

| File | Scenario |
| --- | --- |
| `pair-deep-link.yaml` | The deep link pairs, the home screen shows Connected, and a restart keeps it. |
| `pair-manual.yaml` | Manual pairing with URL and token. |
| `wrong-token.yaml` | A wrong token shows "Invalid token. The hub rejected it." and nothing is saved. |
| `hub-down.yaml` | A stopped hub shows the unreachable screen at start; Retry reconnects after the hub restarts. |

`hub-down.yaml` stops and restarts the hub through a loopback control server that `verify.mjs`
runs (`e2e/scripts/hub-control.js`). Flows get `HUB_URL`, `TOKEN`, `PAIR_LINK` and
`CONTROL_URL` as Maestro env values. New flows find elements by `testID` (`id:` in Maestro),
named `<screen>__<element>`.

## Driving the hub by hand

```bash
node apps/mobile/scripts/hub.mjs start     # prints the URL; the token is in apps/mobile/build/verify/hub.json
node apps/mobile/scripts/hub.mjs restart   # same home and port
node apps/mobile/scripts/hub.mjs clean     # stop and delete the temp home
```

To pair a running simulator with it:
`xcrun simctl openurl booted "band://pair?url=<url-encoded hub URL>&token=<token>"`.

## When something fails

- `No hub build`: run `pnpm build:web`.
- `xcodebuild` fails after a native dependency or `app.json` change: delete `apps/mobile/ios`
  and run again, so prebuild regenerates it.
- Maestro cannot connect to the simulator: open Simulator.app once (`open -a Simulator`) and
  run again.
- A flow fails: the flow's folder in the artifacts holds Maestro's screenshot of the failure.
- The app shows "Band could not read its saved hubs from the Keychain … A required entitlement
  isn't present": the app was built without a signature. `scripts/ios.mjs` signs ad hoc
  (`CODE_SIGN_IDENTITY=-`); keep that if you change the build command.
- A flow stops at its first step behind an "Open in "Band"?" prompt: iOS asks before a deep
  link opens the app. The flows tap Open after `openLink` and Cancel on a leftover prompt at
  start; copy both steps into a new flow that opens a link.
- Disk: DerivedData lives in `apps/mobile/build/` and goes with the worktree. Never create
  more simulators.
