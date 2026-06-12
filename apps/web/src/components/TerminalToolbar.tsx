import type { Terminal } from "@xterm/xterm";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ClipboardCopy,
  ClipboardPaste,
  CornerDownLeft,
  Slash,
  TextCursorInput,
  X,
} from "lucide-react";
import { useCallback, useMemo } from "react";
import { useVirtualKeyboardToolbar } from "../hooks/useVirtualKeyboardToolbar";
import { readClipboardText, writeClipboardText } from "../lib/clipboard";
import type { ArrowDirection } from "../lib/terminal-selection";

/**
 * Floating accessory toolbar rendered above the iOS virtual keyboard inside the
 * terminal panel. Has two layouts that swap based on `selectionMode`:
 *
 * - **Idle** (`selectionMode === false`): Paste · Select All · Esc · Tab ·
 *   Slash · Ctrl · ← ↑ ↓ → (arrows send ANSI escape sequences to the PTY,
 *   identical to a hardware arrow press). No Copy in idle mode — there's
 *   no way to make a selection from idle without entering selection mode
 *   (long-press, or Select All which delegates to the parent's
 *   `onSelectAll` callback to flip into selection mode immediately).
 *
 * - **Selecting** (`selectionMode === true`): Copy · Done · ← → ↑ ↓ (arrows
 *   extend the highlighted selection one cell at a time; the parent owns the
 *   anchor/head state and updates xterm via `terminal.select()`).
 *
 * Selection mode is entered by long-pressing inside the terminal — that flow
 * lives in TerminalPanel.tsx, which calls back here through the `selectionMode`
 * prop and the `onExtendSelection` / `onExitSelection` callbacks.
 *
 * Design notes that apply to both layouts:
 * - We render only on touch-only devices via {@link useVirtualKeyboardToolbar}.
 *   Desktops never paint this — there's no virtual keyboard to float above.
 * - All actions fire on `onPointerDown` rather than `onClick`. iOS Safari
 *   treats `pointerdown` as part of the user-gesture chain that enables
 *   `navigator.clipboard.readText()`; a separate `click` event fires too late
 *   in some installable-PWA contexts. We also `preventDefault()` so the tap
 *   never blurs the terminal's hidden textarea — keeping the soft keyboard
 *   up between actions.
 * - "Ctrl" (idle only) is sticky: tapping it sets a pending flag that the
 *   next regular keystroke from the iOS keyboard consumes (mapped to a
 *   control character by the parent's xterm key handler). Matches Termius /
 *   Blink behavior on iOS.
 */
export interface TerminalToolbarProps {
  /** Live xterm.js instance. Required for copy / hasSelection / selectAll. */
  terminal: Terminal;
  /** Send raw bytes to the PTY (typically `ws.send(data)`). */
  sendInput: (data: string) => void;
  /** Whether Ctrl is armed; the next key tap should be a control char. */
  pendingCtrl: boolean;
  /** Toggle the pending-Ctrl state. */
  onToggleCtrl: () => void;
  /** True after a long-press has armed a selection. Swaps the layout. */
  selectionMode: boolean;
  /** Called when an arrow is tapped while `selectionMode` is true. */
  onExtendSelection: (direction: ArrowDirection) => void;
  /** Called when the user dismisses selection mode (Done, or Copy). */
  onExitSelection: () => void;
  /** Called when the idle-mode "Select All" button is tapped. The parent
   *  highlights every cell in the buffer and flips into selection mode, so
   *  the user can immediately Copy via the selection-mode toolbar. */
  onSelectAll: () => void;
}

// ANSI / CSI escape sequences for the keys the iOS soft keyboard omits.
// These are the same sequences xterm.js itself generates internally for these
// keys on a desktop browser — sending them as raw input mirrors that path.
const SEQ_ESC = "\x1b";
const SEQ_TAB = "\t";
const SEQ_ENTER = "\r";
// Plain "/" — a literal keystroke, not an escape. Lives on the toolbar so the
// agent slash-command menu is one tap away on a phone (the iOS soft keyboard
// buries "/" behind the number/symbol layer).
const SEQ_SLASH = "/";
const SEQ_ARROW_UP = "\x1b[A";
const SEQ_ARROW_DOWN = "\x1b[B";
const SEQ_ARROW_RIGHT = "\x1b[C";
const SEQ_ARROW_LEFT = "\x1b[D";

// Common pointerdown wrapper: prevent the default so the tap doesn't blur
// the xterm helper textarea (which would dismiss the iOS keyboard) and
// returns a handler that invokes `fn`. Module-scoped so each render doesn't
// rebuild a fresh closure for every button.
const tap =
  (fn: () => void | Promise<void>) =>
  (e: React.PointerEvent<HTMLButtonElement>): void => {
    e.preventDefault();
    void fn();
  };

export function TerminalToolbar({
  terminal,
  sendInput,
  pendingCtrl,
  onToggleCtrl,
  selectionMode,
  onExtendSelection,
  onExitSelection,
  onSelectAll,
}: TerminalToolbarProps) {
  const { enabled, bottomOffset } = useVirtualKeyboardToolbar();

  const handleCopy = useCallback(async () => {
    if (!terminal.hasSelection()) return;
    const text = terminal.getSelection();
    if (!text) return;
    // `writeClipboardText` falls back to `document.execCommand('copy')` in
    // non-secure contexts (the common case for iOS on a dev server reached
    // over the LAN — `navigator.clipboard` is `undefined` there).
    const ok = await writeClipboardText(text);
    if (!ok) console.warn("[TerminalToolbar] clipboard write failed");
  }, [terminal]);

  // Copy *and* exit selection mode in one tap. The only Copy button lives
  // in the selection-mode layout; idle mode has no Copy (there's no way to
  // make a selection without first entering selection mode anyway).
  const handleCopyAndExit = useCallback(async () => {
    await handleCopy();
    onExitSelection();
  }, [handleCopy, onExitSelection]);

  const handlePaste = useCallback(async () => {
    // `readClipboardText` returns "" if the API is unavailable (non-secure
    // context) or if iOS denies the permission prompt. There's no legacy
    // fallback for read — modern browsers blocked `execCommand('paste')`
    // years ago. If you're hitting this on iOS over HTTP, switch to HTTPS
    // (e.g. via the tunnel feature) for paste to work.
    const text = await readClipboardText();
    if (text) sendInput(text);
  }, [sendInput]);

  // Memoized button lists so identities are stable across re-renders.
  const idleKeyButtons = useMemo(
    () => [
      { label: "Esc", seq: SEQ_ESC, ariaLabel: "Send Escape" },
      { label: "Tab", seq: SEQ_TAB, ariaLabel: "Send Tab" },
    ],
    [],
  );

  // Arrow order: ← ↑ ↓ →. Horizontal extremes bookend the vertical pair so a
  // thumb can rock left/right at the edges and nudge up/down in the middle —
  // the layout requested for the mobile toolbar.
  const idleArrows = useMemo(
    () => [
      { Icon: ArrowLeft, seq: SEQ_ARROW_LEFT, ariaLabel: "Arrow Left" },
      { Icon: ArrowUp, seq: SEQ_ARROW_UP, ariaLabel: "Arrow Up" },
      { Icon: ArrowDown, seq: SEQ_ARROW_DOWN, ariaLabel: "Arrow Down" },
      { Icon: ArrowRight, seq: SEQ_ARROW_RIGHT, ariaLabel: "Arrow Right" },
    ],
    [],
  );

  const selectionArrows = useMemo(
    () =>
      [
        { Icon: ArrowLeft, dir: "left", ariaLabel: "Extend selection left" },
        { Icon: ArrowUp, dir: "up", ariaLabel: "Extend selection up" },
        { Icon: ArrowDown, dir: "down", ariaLabel: "Extend selection down" },
        { Icon: ArrowRight, dir: "right", ariaLabel: "Extend selection right" },
      ] as const,
    [],
  );

  if (!enabled) return null;

  // Wrapper that visually distinguishes selection mode — a primary-tinted
  // strip across the top of the bar makes it immediately obvious that
  // arrows mean something different right now.
  return (
    <div
      data-testid="terminal-toolbar"
      data-mode={selectionMode ? "selection" : "idle"}
      role="toolbar"
      aria-label={selectionMode ? "Terminal selection controls" : "Terminal accessory keys"}
      style={{ bottom: bottomOffset }}
      className="fixed inset-x-0 z-50 flex justify-center border-t border-border bg-background/95 shadow-lg backdrop-blur-md"
    >
      <div className="flex w-full max-w-3xl items-center gap-1 px-2 py-1.5">
        {/* Scrolling key row. Enter is pulled out of this container (below) so
         *  it stays pinned to the right edge while the rest of the keys scroll
         *  horizontally behind it — Enter is the highest-frequency key and must
         *  never be scrolled off-screen on a narrow phone. */}
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {selectionMode ? (
            <>
              <ToolbarButton
                ariaLabel="Copy selection and exit"
                title="Copy"
                onPointerDown={tap(handleCopyAndExit)}
                variant="primary"
              >
                <ClipboardCopy className="size-4" />
                <span className="text-xs">Copy</span>
              </ToolbarButton>
              <ToolbarButton
                ariaLabel="Exit selection mode"
                title="Done"
                onPointerDown={tap(onExitSelection)}
              >
                <X className="size-4" />
                <span className="text-xs">Done</span>
              </ToolbarButton>

              <div className="mx-1 h-6 w-px shrink-0 bg-border" aria-hidden="true" />

              <span
                className="mr-1 shrink-0 select-none text-xs font-medium uppercase tracking-wide text-muted-foreground"
                aria-hidden="true"
              >
                Extend
              </span>

              {selectionArrows.map(({ Icon, dir, ariaLabel }) => (
                <ToolbarButton
                  key={dir}
                  ariaLabel={ariaLabel}
                  title={ariaLabel}
                  onPointerDown={tap(() => onExtendSelection(dir))}
                >
                  <Icon className="size-4" />
                </ToolbarButton>
              ))}
            </>
          ) : (
            <>
              {/* No idle-mode Copy: there's no way to make a selection without
               *  entering selection mode (long-press or Select All), so an
               *  idle Copy button is always either disabled or stale (the
               *  toolbar doesn't re-render on xterm selection changes). Copy
               *  lives in the selection-mode layout where it's reachable
               *  immediately after creating a selection. */}
              <ToolbarButton
                ariaLabel="Paste from clipboard"
                title="Paste"
                onPointerDown={tap(handlePaste)}
              >
                <ClipboardPaste className="size-4" />
                <span className="text-xs">Paste</span>
              </ToolbarButton>
              <ToolbarButton
                ariaLabel="Select all"
                title="Select all"
                // Delegates to the parent so the highlight is paired with a
                // mode flip into selection-mode — otherwise the user would
                // see a selection but have no UI to copy it.
                onPointerDown={tap(onSelectAll)}
              >
                <TextCursorInput className="size-4" />
                <span className="text-xs">All</span>
              </ToolbarButton>

              <div className="mx-1 h-6 w-px shrink-0 bg-border" aria-hidden="true" />

              {idleKeyButtons.map(({ label, seq, ariaLabel }) => (
                <ToolbarButton
                  key={label}
                  ariaLabel={ariaLabel}
                  title={label}
                  onPointerDown={tap(() => sendInput(seq))}
                >
                  <span className="text-xs font-medium">{label}</span>
                </ToolbarButton>
              ))}
              {/* Slash — one-tap entry into an agent's slash-command menu. */}
              <ToolbarButton
                ariaLabel="Send slash"
                title="Slash command"
                onPointerDown={tap(() => sendInput(SEQ_SLASH))}
              >
                <Slash className="size-4" />
              </ToolbarButton>
              <ToolbarButton
                ariaLabel={pendingCtrl ? "Cancel pending Ctrl" : "Arm Ctrl modifier"}
                title="Ctrl (sticky — taps the next key as Ctrl+key)"
                onPointerDown={tap(onToggleCtrl)}
                active={pendingCtrl}
              >
                <span className="text-xs font-medium">Ctrl</span>
              </ToolbarButton>

              <div className="mx-1 h-6 w-px shrink-0 bg-border" aria-hidden="true" />

              {idleArrows.map(({ Icon, seq, ariaLabel }) => (
                <ToolbarButton
                  key={ariaLabel}
                  ariaLabel={ariaLabel}
                  title={ariaLabel}
                  onPointerDown={tap(() => sendInput(seq))}
                >
                  <Icon className="size-4" />
                </ToolbarButton>
              ))}
            </>
          )}
        </div>

        {/* Enter — pinned to the right edge, outside the scroll container, so
         *  it's always reachable. Tinted like a CTA since it's the primary
         *  action. Sends a carriage return (\r), the same byte a hardware
         *  Return key produces. */}
        <div className="h-6 w-px shrink-0 bg-border" aria-hidden="true" />
        <ToolbarButton
          ariaLabel="Send Enter"
          title="Enter"
          onPointerDown={tap(() => sendInput(SEQ_ENTER))}
          variant="primary"
        >
          <CornerDownLeft className="size-4" />
        </ToolbarButton>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ToolbarButton — minimal local component to keep the markup readable.
// Not exported from the package's `<Button>` because we want pointerdown
// semantics, larger touch targets, and the active/primary-state styling for
// sticky Ctrl + the selection-mode Copy button; the shared component is built
// for click semantics.
// ---------------------------------------------------------------------------

interface ToolbarButtonProps {
  ariaLabel: string;
  title: string;
  onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => void;
  active?: boolean;
  /** "primary" tints the button like a CTA — used for the prominent Copy in
   *  selection mode. "default" is the neutral background used elsewhere. */
  variant?: "default" | "primary";
  disabled?: boolean;
  children: React.ReactNode;
}

function ToolbarButton({
  ariaLabel,
  title,
  onPointerDown,
  active,
  variant = "default",
  disabled,
  children,
}: ToolbarButtonProps) {
  const palette = active
    ? "bg-primary text-primary-foreground"
    : variant === "primary"
      ? "bg-primary text-primary-foreground hover:bg-primary/90"
      : "bg-muted/60 hover:bg-muted active:bg-muted";
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      // Toggle buttons (sticky Ctrl) explicitly pass a boolean so screen
      // readers announce the toggle state — `false` renders as
      // `aria-pressed="false"` not absent, per WAI-ARIA. Plain buttons
      // pass `active` undefined to omit the attribute entirely.
      aria-pressed={active}
      title={title}
      onPointerDown={onPointerDown}
      disabled={disabled}
      // 44×N min-height matches iOS HIG touch target; gap-1 keeps the button
      // pill compact so the whole row fits on a 320px-wide iPhone SE without
      // wrapping (the parent uses `overflow-x-auto` as a final safety net).
      className={[
        "inline-flex h-9 min-w-9 shrink-0 items-center justify-center gap-1 rounded-md px-2",
        "text-foreground transition-colors",
        palette,
        "disabled:opacity-40",
      ].join(" ")}
    >
      {children}
    </button>
  );
}
