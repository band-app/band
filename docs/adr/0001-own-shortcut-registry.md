# 0001. Band's own shortcut registry, not react-hotkeys-hook

Status: accepted. Issue #1045.

## Context

Thirteen files in `apps/web/src` registered their own `keydown` listeners. The command palette kept a separate list of chords, so it could advertise a chord that did nothing (`⌘⇧[` and `⌘⇧]`: Shift turns `]` into `}`). The issue also asks for every shortcut to be editable, for context-menu actions to take shortcuts, and for the palette to list those actions. PR #638 used `react-hotkeys-hook` for this on the old dockview code.

## Decision

`apps/web/src/lib/shortcuts.ts` holds one table of commands (`COMMAND_DEFS`), their default chords, the user's overrides and `matchesCommand(event, id)`. Each existing listener keeps its own focus rules and asks `matchesCommand` instead of testing keys. A command with no listener of its own (the worktree menu actions) registers a handler, and the layout's single listener runs it.

We did not adopt `react-hotkeys-hook` because:

- The handlers are capture-phase window listeners with per-surface rules (a focused terminal keeps Ctrl chords, the markdown preview owns `⌘B`, a terminal's nested panes defer to the outer layout). The library's scoping does not express those, so each handler would still need its own guards.
- Rebinding needs the chord as data that the palette, the menus and Settings read. A library binds a string at hook call time, so the registry is still needed on top of it.
- Matching by physical key (`event.code`) with a fallback to `event.key` fixes the shifted-bracket chords with no dependency.

## Consequences

- Overrides are the synced client-state key `band:shortcut-overrides` (scope `all`), `{ commandId: chord | null }`, where `null` means cleared. An older client does not list the key and ignores it.
- Chords owned by the desktop app's native menu (zoom, settings, reload) are shown in Settings > Keyboard but cannot be rebound there.
- Not in the registry: `⌘1`..`⌘9` (they depend on the user's groups), `Ctrl+Tab`, editor and composer keys, popup navigation keys, and the mouse chords the issue asks for later.
