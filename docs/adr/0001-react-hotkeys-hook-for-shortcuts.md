# 1. Use react-hotkeys-hook for keyboard shortcuts

Date: 2026-07-20

## Status

Accepted

## Context

Band's keyboard shortcuts were implemented as six independent raw `keydown` listeners:
`SharedDockviewLayout` (global, window-level, capture phase), plus near-duplicate
container handlers in the chat, terminal, browser, and file-tab docks, plus the dashboard
label filter and the zoom hook. Roughly 40 shortcuts total.

Each container handler re-implemented the same two things by hand: platform branching
(`isMac ? metaKey : ctrlKey`) and scoping (`document.activeElement?.contains(...)` or
`closest(".xterm")`). The same combos (`⌘T`, `⌘W`, `⌘D`, `⌘[`/`⌘]`, `Ctrl+Tab`) mean
different things in different docks, so scoping is load-bearing, not incidental.

Two systems deliver keys through their own mechanisms and are out of scope: CodeMirror
(its own `keymap` extension) and the Electron native menu / find-in-page IPC (keys never
reach the DOM because `WebContentsView` swallows them).

## Decision

Adopt `react-hotkeys-hook` (v5) as the single shortcut mechanism for all DOM-delivered
shortcuts.

- **Dock scoping via the hook's returned ref**, not named scopes. The ref only fires while
  that element or a descendant has focus, and innermost-focused wins — the exact semantics
  the hand-rolled `contains()` checks were approximating. No provider bookkeeping and no
  focus/scope state to keep in sync.
- **Combos live in one central constants module** (action id → combo string). Handlers stay
  in their components. The command palette and UI hints read the same constants, so the
  displayed shortcut can't drift from the bound one.
- **Both modifier spellings are bound, not `mod+`.** The handler this replaces gated on
  `e.metaKey || e.ctrlKey`, so every chord fired from either modifier on every platform —
  `⌘N` and `Ctrl+N` both opened a new file on a Mac. `mod` resolves to one modifier per
  platform and would have silently dropped half of each binding, so `eitherMod()` spells
  both out. Narrowing them is a user-visible change that belongs in its own decision.
- **Character- vs physical-key matching travels with the combo** (`ShortcutSpec.useKey`).
  The library matches `KeyboardEvent.code` by default, so a punctuation binding written as
  its character (`` ` ``, `[`, `=`) silently never fires. Putting the choice on the spec
  means a call site cannot get it wrong.
- **Terminal behaviour is preserved exactly**: `enableOnFormTags` for globals plus
  `ignoreEventWhen` for the shell-owned combos that must reach xterm, and the existing
  "`Ctrl+D` only closes when more than one tab" rule.
- **The `band:*` custom-event dispatch layer stays.** Only key detection changes.

Four deliberate behaviour changes ride along with the refactor.

**`⌘B` and `⌘J` become true globals.** Both used to resolve their target by focus: a focused
inner dockview with a non-empty edge on that side won, and only otherwise did the chord fall
through to the outer layout. `⌘B` now always toggles the project sidebar and `⌘J` always
toggles the outermost layout's bottom edge. The sidebar and the bottom panel each read as a
single shared surface, and a shortcut that means different things depending on invisible
focus state is hard to trust. `⌥⌘B` (right edge) is now the only edge chord that still
resolves by focus — knowingly inconsistent, kept because nothing has argued for changing it.
Inner-dockview *left* and *bottom* edges consequently lose their keyboard toggle; if that
matters, each gets its own combo rather than a return to focus-dependence.

**`⌘0` and `Ctrl+0` no longer contend.** "Focus Projects" (`Ctrl+0`) previously beat the label
filter's "All" only because it listened in capture phase and called `stopPropagation()` ahead
of the filter's bubble-phase listener. Once both are `useHotkeys` on `document`, registration
order decides — too fragile to leave implicit — so the label filter binds `⌘0` alone and
digits 1–9 still take either modifier. Net user-facing behaviour is unchanged; it is now
explicit rather than accidental.

**`⌘⇧[` / `⌘⇧]` start working.** They were advertised in the palette but dead: Shift turns `]`
into `}`, so the character match never fired. They now match the physical key. This fixes a
pre-existing bug rather than preserving it — a single source of truth that ships a
documented-but-dead shortcut is worse than the drift it replaced.

## Consequences

- One dependency added (~5 kB, peer range `react >=16.8`; the web app is on React 19).
- Most `isMac` branching and every hand-written focus-containment check disappear.
- CodeMirror, the Electron menu, and find-in-page IPC remain separate delivery paths. A
  reader looking for "all shortcuts" must still check those three places — the central
  constants module documents them as out of scope.
- No user-rebindable shortcuts. The constants are plain literals, not an overridable map;
  adding persistence later is a contained change.
- Migration is guarded by an end-to-end shortcut matrix spec written against the current
  behaviour first and kept green throughout. Each intended difference has a case written to
  the NEW behaviour, so it fails until the change lands and pins it afterwards.
- Inner-dockview left and bottom edges are no longer reachable from the keyboard. If that turns out to
  matter, the fix is a dedicated combo rather than restoring focus-dependence on `⌘B`.
