import { useHotkeys } from "react-hotkeys-hook";
import type { ShortcutSpec } from "@/lib/shortcuts";

/**
 * Thin wrapper over `useHotkeys` carrying the defaults every Band shortcut
 * needs. Four of them are load-bearing and easy to get wrong individually,
 * which is why they live here rather than at each call site:
 *
 * 1. `enableOnFormTags` / `enableOnContentEditable` — the library skips events
 *    originating in form fields by default. Band's two most common focus
 *    targets are xterm's offscreen helper `<textarea>` and the chat prompt, so
 *    the default would make every global shortcut dead exactly when the user is
 *    doing something. The hand-rolled handler this replaces had no such
 *    exclusion.
 *
 * 2. `capture: true` — the old handler bound on `window` in capture phase.
 *    xterm calls `stopPropagation()` on the keys it consumes, so a bubble-phase
 *    listener (the library's default) would never see them. Capture keeps the
 *    app's chords winning over the terminal's, which is the current behaviour.
 *
 * 3. `preventDefault: true` — every branch of the old handler called
 *    `e.preventDefault()`, suppressing the browser's own ⌘P / ⌘O / ⌘F.
 *
 * 4. `useKey` from the combo — the library matches the physical `event.code` by
 *    default, so a punctuation binding written as its character (`` ` ``, `[`,
 *    `=`) silently never fires. Carrying the choice on the spec means a call
 *    site can't get it wrong. See `ShortcutSpec.useKey`.
 *
 * NOT supplied: `stopPropagation`. The library never calls it, so a chord that
 * must not also reach xterm or an input has to call it in its own callback.
 *
 * Pass `enabled: false` to bind conditionally (desktop-only shortcuts), or
 * `ignoreEventWhen` to add a bail on top — see `useGlobalShortcut` in
 * `SharedDockviewLayout` for the terminal-focus case.
 */
export function useAppShortcut(
  spec: ShortcutSpec,
  callback: (event: KeyboardEvent) => void,
  options: Parameters<typeof useHotkeys>[2] = {},
  // Defaults to `undefined`, NOT `[]`. `useHotkeys` treats a present array like
  // `useCallback(cb, deps)`, and an empty array is still present — so defaulting
  // to `[]` would freeze every callback at its first render. Omitting the
  // argument entirely keeps the handler current, which is the safe default;
  // pass `[]` explicitly to opt into freezing.
  deps?: unknown[],
): ReturnType<typeof useHotkeys> {
  return useHotkeys(
    spec.binding,
    callback,
    {
      enableOnFormTags: true,
      enableOnContentEditable: true,
      eventListenerOptions: { capture: true },
      preventDefault: true,
      // Character- vs physical-key matching travels with the combo (see
      // `ShortcutSpec.useKey`) so a call site can't bind `Ctrl+\`` and have it
      // silently never fire. An explicit `options.useKey` still wins.
      useKey: spec.useKey ?? false,
      ...options,
    },
    deps,
  );
}

/**
 * True when the event originated inside an xterm instance.
 *
 * The shell owns most Ctrl chords (Ctrl+K is kill-to-end-of-line, Ctrl+D is
 * EOF), so shortcuts spelled with Ctrl yield to a focused terminal. Chords the
 * user reached via ⌘ do not — ⌘ isn't a shell modifier on macOS. This mirrors
 * the `terminalFocused && !e.metaKey` gate in the handler being replaced.
 *
 * Note the platform asymmetry this preserves: on Windows and Linux `mod` IS
 * Ctrl, so these shortcuts deliberately defer to the shell there.
 */
export function isTerminalOriginatedEvent(event: KeyboardEvent): boolean {
  const target = event.target as Element | null;
  return target?.closest?.(".xterm") != null;
}
