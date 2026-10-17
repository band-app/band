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
4. Maestro: `PATH="/opt/homebrew/opt/openjdk@17/bin:$PATH" maestro --version` (the script
   also looks in `~/.maestro/bin`), else
   `brew tap mobile-dev-inc/tap && brew install mobile-dev-inc/tap/maestro`. Without Java 17 on
   PATH, a bare `maestro --version` fails with "Unable to locate a Java Runtime" even when
   Maestro is installed.
5. Node 24 (`.nvmrc`): `node --version` must print v24. If it doesn't, put a Node 24 first on
   PATH for every command below (for example `~/.nvm/versions/node/v24.*/bin`).
6. The workspace installed: `pnpm install`. On a fresh worktree this is the longest step
   (about 15 minutes with a cold pnpm store).
7. Disk: a build needs about 2.5 GB in the worktree (`apps/mobile/build` about 1.9 GB, the
   generated `apps/mobile/ios` about 650 MB). Check `df -h .` first.

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
   - starts a hub (`apps/mobile/scripts/hub.mjs start`) on a free port with a temp HOME and
     `BAND_HOME` (inherited `BAND_*` variables are dropped), a random admin token and `BAND_TEST_ACP_AGENT`, and creates a device token with
     `tokens.createDevice`;
   - boots one existing iPhone simulator (a booted one first, never a new one; set
     `BAND_SIM_UDID` to pick one), installs the app;
   - runs every `apps/mobile/e2e/*.yaml` flow with `maestro test`, pairing through the deep
     link `band://pair?url=…&token=…` instead of the camera (the app asks to confirm the hub,
     and the flows tap Connect);
   - searches the app's log lines and data container for the device token and the wrong
     token `wrong-token.yaml` types, and fails when the log search found under 10 lines;
   - stops the hub and deletes its temp home.

   The first native build takes 5 to 20 minutes (on top of `pnpm install` in a fresh worktree). Later runs with no native change can skip it:
   `node apps/mobile/scripts/verify.mjs --skip-build`. A JS-only change still needs a build,
   because Release embeds the bundle.

   Run some flows only by naming them: `node apps/mobile/scripts/verify.mjs --skip-build wrong-token hub-down`.

   The `perf-` flows need the frame log, which only a perf build has:
   `node apps/mobile/scripts/verify.mjs --perf` builds with `EXPO_PUBLIC_BAND_PERF_LOG=1` and
   runs only the `perf-` flows. Without `--perf` they are skipped. Build without `--perf`
   again before the other flows, because the perf build shows the log over the chat.

3. Read the report. The script prints it and saves it with the screenshots under
   `apps/mobile/e2e/artifacts/<timestamp>/` (gitignored). Each flow has a folder with its
   screenshots and Maestro's output. The script exits non-zero when a flow fails or the token
   was found. Paste the report table and the screenshot paths into the `/am-verify` evidence.

## The flows

| File | Scenario |
| --- | --- |
| `pair-deep-link.yaml` | The deep link asks to confirm the hub, then pairs; the home screen shows Connected, and a restart keeps it. |
| `pair-deep-link-cancel.yaml` | Cancel on the deep link's confirmation saves nothing. |
| `hubs-switch-remove.yaml` | Pairs the hub under two origins, switches between them, removes both and lands on the pairing screen. |
| `pair-manual.yaml` | Manual pairing with URL and token. |
| `wrong-token.yaml` | A wrong token shows "Invalid token. The hub rejected it." and nothing is saved. |
| `hub-down.yaml` | A stopped hub shows the unreachable screen at start; Retry reconnects after the hub restarts. |
| `w1-list.yaml` | The home screen lists both seeded repos with their worktrees, branch and host, with the pinned worktree in a Pinned section; Group by switches Host, Origin and Repo; a collapsed repo stays collapsed after a restart; search narrows the list. |
| `w2-status-live.yaml` | A row shows "working" within 2 s of the agent starting a turn and "needs you" when it asks for permission. |
| `w3-foreground.yaml` | After a minute in the background the list shows what changed meanwhile. |
| `w4-open.yaml` | Tapping a worktree opens its screen with the right name and branch; Back returns to the same place in a long list. |
| `c1-transcript.yaml` | The seeded showcase chat renders every item natively: the prompt's image, thinking, markdown (heading, list, table, file links, highlighted code, a mermaid fence labelled "diagram"), the folded tool calls with a diff and a command, the plan, the turn's end. A file link opens the file viewer on that file (here an error state, because `gamma` has no `src/parser.ts`) and Back returns. |
| `c2-streaming.yaml` | A streamed turn shows each line as it arrives and the list stays at the bottom; scrolling up stops following and shows Jump to latest, which brings the list back. |
| `c4-background.yaml` | 30 s in the background mid-turn; on return the turn arrives complete. The flow long-presses the turn and `check-transcript` compares the copied text with the hub's, every streamed line exactly once. |
| `c5-copy.yaml` | A long press on a message copies its text (checked on the simulator's clipboard). |
| `c6-history.yaml` | Scrolling to the top of a 24-turn chat loads the 4 turns the hub didn't send on open, and the list keeps its place while they arrive. |
| `m1-send.yaml` | A message typed on the phone (Return adds a line, only the button sends) reaches the agent, and the reply streams in. |
| `m2-queue.yaml` | A message sent during a running turn joins the queue above the composer; one is moved up and another deleted; the kept one is delivered when the turn ends and the deleted one never reaches the agent. |
| `m3-attach.yaml` | A photo from the simulator's library (added with `addMedia`) is attached and sent; the agent receives an image part. |
| `m4-suggest.yaml` | "/" lists the commands the hub reports for the agent, "@" plus text lists matching files, and picking one fills the field. |
| `m5-session.yaml` | Stop ends a running turn; the model picked in the session sheet (the pill in the focused composer) shows in the pill and in `chats.sessionState`. |
| `m9-session-history.yaml`, `m10-session-history-empty.yaml` | The History button lists a chat's sessions newest first, switches to the older one, starts a new one, and says so on a chat with none. Uses `gamma-sessions` and `gamma-no-sessions`. |
| `m6-keyboard.yaml` | With the keyboard open, the last message and the composer are both on screen. Run it on other simulators with `BAND_SIM_UDID`. |
| `m7-draft.yaml` | An unsent draft survives leaving the screen and the app going to the background. |
| `m8-composer-expanded.yaml` | Focused, the composer expands with the attach button and the model and mode pills, and sending still works. |
| `s8-dark-theme.yaml` | Screenshots of home, a worktree chat, the tab sheet, a question card and the expanded composer in light and dark (`xcrun simctl ui <udid> appearance`, through the control server's `/appearance?mode=`), and the Hubs screen's System / Light / Dark override. The `s8-light-*` and `s8-dark-*` pairs go into the PR. |
| `t1-tabs-open.yaml` | The three chats open as tabs on the "web" (the seeded shared tab list) show in the same order in the title pill's sheet with the same active tab ("2 of 3"), and the sheet says 2 more tabs are on the desktop. |
| `t2-tabs-new-chat.yaml` | "+ Chat" in the sheet lists the agents; the picked one starts a chat that becomes the active tab ("4 of 4"), and the shared list (what the web reads) gains it with the terminal and browser tabs kept. |
| `t3-tabs-attention.yaml` | A chat in a background tab asks for permission: its dot shows needs-attention, a chip above the composer says "Tests: question", and tapping it shows that tab with the request. |
| `t4-tabs-switch.yaml` | Switching back to a tab shown a moment ago shows it at once, with no spinner, still scrolled to its first turn. |
| `t5-tabs-close.yaml` | Rename names the chat on the hub; Close tab (long press a row in the sheet) removes the chat and its tab and keeps the web's terminal and browser tabs in the shared list. |
| `t6-tabs-live.yaml` | While the worktree is open, the web starts a chat and reorders the shared list (`/web-tabs`); the phone's tabs follow without reopening the screen. |
| `t7-tabs-swipe.yaml` | A swipe left or right on the transcript moves to the next or previous tab and "N of M" follows; a drag from the left edge leaves the tab alone, for the system back swipe. |
| `perf-c3-fling.yaml` | Flings through a 1,610-event chat; no blank rows after the list settles, and the flow fails when the frame log's longest JS gap during the flings is over 100 ms (the numbers go into the report). Runs only with `--perf`. |
| `x1-explorer-tree.yaml` | Views > Explorer lists the tree; a folder opens and closes; the 3,000-file `bulk` folder expands and scrolls. |
| `x2-file-viewer.yaml` | Code with line numbers and Copy, markdown Rendered/Source, an image, and "Can't preview this file" for a binary, a file over 1 MB and a PDF. |
| `x3-search.yaml` | Name search (fuzzy) and content search; a content match opens the file at its line. |
| `x4-changes-diff.yaml` | Changes shows the web's sections with counts; a change opens its native diff. |
| `x5-refresh.yaml` | Pull to refresh picks up a file the control server's `/explorer-change` adds, and Changes re-reads on its own. |
| `perf-explorer-fling.yaml` | Flings through the open 3,000-file folder; fails when the frame log's longest JS gap is over 100 ms. Runs only with `--perf`. |

The hub is seeded after it starts (`scripts/seed.mjs`; `scripts/seed-explorer.mjs` adds the repo `delta` for the Explorer flows: a 3,000-file `bulk` folder, a 1.3 MB file, a binary, a PNG, markdown, a long-line file and one file of each change kind): repos `alpha` and `beta`, the worktrees
`alpha-main`, `alpha-feat-mobile` and `beta-main`, and one chat each. The repo `gamma` holds the
chat flows' worktrees: `gamma-main` (a finished "showcase" turn with an attached image),
`gamma-long` (a finished turn of 1,610 replayed events), `gamma-history` (24 short turns, more
than the 20 the hub sends on open), the empty `gamma-stream` and
`gamma-resume`, one empty worktree per composer flow (`gamma-compose`, `-queue`, `-attach`, `-suggest`, `-session`, `-keyboard`), and `gamma-tabs` with three named chats (Parser, Docs, Tests; Parser has 12 turns) and a shared tab list that puts a terminal and a browser tab between them, with Docs active. The tab flows build on each other (t2 adds a chat, t5 closes one, t6 adds one from the "web"), so run them in order. The stub agent's scenario (`SCENARIO` in the same file) treats a prompt starting
with `work` as a turn that runs until stopped, one starting with `ask` as a turn that waits for a
permission answer, and one starting with `stream` as 90 numbered lines over 45 s, and one starting with `slow` as a 90 s turn that ends by itself.

Flows drive the hub through a loopback control server that `verify.mjs` runs
(`e2e/scripts/hub-control.js`, `ACTION` is a path with its query): `stop` and `start` stop and
restart it (`hub-down.yaml`), `work?wt=<worktree id>`, `ask?wt=<id>` and `halt?wt=<id>` make the
agent work, ask for permission or stop, `stream?wt=<id>` starts the streamed turn,
`fill?n=12` adds worktrees to `alpha`, and `sleep?ms=<n>` answers after n ms. `clipboard` fails
unless the simulator's clipboard holds `VALUE`, `check-transcript?wt=<id>` compares the copied
last turn with the hub's, and `note?name=<n>` with `VALUE` adds a line to the report's
"Measurements and checks". The `w` flows run in number order on purpose: `w4-open.yaml` adds worktrees that push `beta` off the first screen. Shared steps live in `e2e/subflows/` (`pair-link.yaml` pairs
through the deep link), which `verify.mjs` does not run on its own. Flows get `HUB_URL`, `TOKEN`, `PAIR_LINK`,
`CONTROL_URL`, `WRONG_TOKEN`, `HUB_URL_ALT` (the same hub at `localhost`) and `HUB_ID` /
`HUB_ID_ALT` (the app's ids for the two, used in the Hubs screen's testIDs) as Maestro env
values. New flows find elements by `testID` (`id:` in Maestro),
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
