import type { Terminal } from "@xterm/xterm";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ClipboardCopy,
  ClipboardPaste,
  TextCursorInput,
} from "lucide-react";
import { useCallback, useMemo } from "react";
import { useVirtualKeyboardToolbar } from "../hooks/useVirtualKeyboardToolbar";

/**
 * Floating accessory toolbar rendered above the iOS virtual keyboard inside the
 * terminal panel. Provides copy/paste/select-all (since iOS Safari's native
 * long-press menu never reaches the xterm canvas) plus the keys the soft
 * keyboard hides that terminal users need (Esc, Tab, Ctrl, arrows).
 *
 * Design notes:
 * - We render only on touch-only devices via {@link useVirtualKeyboardToolbar}.
 *   Desktops never paint this — there's no virtual keyboard to float above.
 * - All actions are dispatched on `onPointerDown` rather than `onClick`. iOS
 *   Safari treats a `pointerdown` as part of the user gesture chain that
 *   enables `navigator.clipboard.readText()`; a separate `click` event fires
 *   too late and after the gesture has expired in some installable-PWA
 *   contexts. We also call `preventDefault()` so the tap never blurs the
 *   terminal's hidden textarea — keeping the soft keyboard up between actions.
 * - "Ctrl" is sticky: tapping it sets a pending flag that the next regular
 *   keystroke from the iOS keyboard consumes (mapped to a control character by
 *   the parent's xterm key handler). The button stays highlighted while
 *   pending and clears itself once a key is sent. This matches Termius /
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
}

// ANSI / CSI escape sequences for the keys the iOS soft keyboard omits.
// These are the same sequences xterm.js itself generates internally for these
// keys on a desktop browser — sending them as raw input mirrors that path.
const SEQ_ESC = "\x1b";
const SEQ_TAB = "\t";
const SEQ_ARROW_UP = "\x1b[A";
const SEQ_ARROW_DOWN = "\x1b[B";
const SEQ_ARROW_RIGHT = "\x1b[C";
const SEQ_ARROW_LEFT = "\x1b[D";

export function TerminalToolbar({
  terminal,
  sendInput,
  pendingCtrl,
  onToggleCtrl,
}: TerminalToolbarProps) {
  const { enabled, bottomOffset } = useVirtualKeyboardToolbar();

  const handleCopy = useCallback(async () => {
    if (!terminal.hasSelection()) return;
    const text = terminal.getSelection();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch (err) {
      // iOS may reject this if the page lost the user-gesture token between
      // pointerdown and the clipboard promise resolving. Surface to console
      // only — the alternative is a blocking modal that's much worse UX.
      console.warn("[TerminalToolbar] clipboard write failed:", err);
    }
  }, [terminal]);

  const handlePaste = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) sendInput(text);
    } catch (err) {
      // iOS 13.4+ prompts for clipboard permission the first time and the
      // promise rejects on denial. Nothing to do — the user can retry.
      console.warn("[TerminalToolbar] clipboard read failed:", err);
    }
  }, [sendInput]);

  const handleSelectAll = useCallback(() => {
    terminal.selectAll();
    // selectAll() does not move focus; re-focus so subsequent toolbar Copy
    // works without an intermediate tap.
    terminal.focus();
  }, [terminal]);

  // Build a list of static key buttons. Memoized so the inline object identity
  // is stable across re-renders (helps if anyone wraps the toolbar in memo).
  const keyButtons = useMemo(
    () => [
      { label: "Esc", seq: SEQ_ESC, ariaLabel: "Send Escape" },
      { label: "Tab", seq: SEQ_TAB, ariaLabel: "Send Tab" },
    ],
    [],
  );

  const arrowButtons = useMemo(
    () => [
      { Icon: ArrowLeft, seq: SEQ_ARROW_LEFT, ariaLabel: "Arrow Left" },
      { Icon: ArrowDown, seq: SEQ_ARROW_DOWN, ariaLabel: "Arrow Down" },
      { Icon: ArrowUp, seq: SEQ_ARROW_UP, ariaLabel: "Arrow Up" },
      { Icon: ArrowRight, seq: SEQ_ARROW_RIGHT, ariaLabel: "Arrow Right" },
    ],
    [],
  );

  if (!enabled) return null;

  // Common pointerdown wrapper: prevent the default so the tap doesn't blur
  // the xterm helper textarea (which would dismiss the iOS keyboard).
  // Returns a handler that calls `fn` after preventing default.
  const tap =
    (fn: () => void | Promise<void>) =>
    (e: React.PointerEvent<HTMLButtonElement>): void => {
      e.preventDefault();
      void fn();
    };

  return (
    <div
      data-testid="terminal-toolbar"
      role="toolbar"
      aria-label="Terminal accessory keys"
      // `position: fixed` so the bar tracks the visual viewport regardless of
      // where the terminal panel sits inside its dockview layout. `left: 0;
      // right: 0` spans the full width; the inner flex row centers content.
      style={{ bottom: bottomOffset }}
      className="fixed inset-x-0 z-50 flex justify-center border-t border-border bg-background/95 shadow-lg backdrop-blur-md"
    >
      <div className="flex w-full max-w-3xl items-center gap-1 overflow-x-auto px-2 py-1.5">
        {/* Selection / clipboard group */}
        <ToolbarButton
          ariaLabel="Copy selection"
          title="Copy"
          onPointerDown={tap(handleCopy)}
          disabled={!terminal.hasSelection()}
        >
          <ClipboardCopy className="size-4" />
          <span className="text-xs">Copy</span>
        </ToolbarButton>
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
          onPointerDown={tap(handleSelectAll)}
        >
          <TextCursorInput className="size-4" />
          <span className="text-xs">All</span>
        </ToolbarButton>

        <div className="mx-1 h-6 w-px shrink-0 bg-border" aria-hidden="true" />

        {/* Special keys */}
        {keyButtons.map(({ label, seq, ariaLabel }) => (
          <ToolbarButton
            key={label}
            ariaLabel={ariaLabel}
            title={label}
            onPointerDown={tap(() => sendInput(seq))}
          >
            <span className="text-xs font-medium">{label}</span>
          </ToolbarButton>
        ))}
        <ToolbarButton
          ariaLabel={pendingCtrl ? "Cancel pending Ctrl" : "Arm Ctrl modifier"}
          title="Ctrl (sticky — taps the next key as Ctrl+key)"
          onPointerDown={tap(onToggleCtrl)}
          active={pendingCtrl}
        >
          <span className="text-xs font-medium">Ctrl</span>
        </ToolbarButton>

        <div className="mx-1 h-6 w-px shrink-0 bg-border" aria-hidden="true" />

        {/* Arrow cluster */}
        {arrowButtons.map(({ Icon, seq, ariaLabel }) => (
          <ToolbarButton
            key={ariaLabel}
            ariaLabel={ariaLabel}
            title={ariaLabel}
            onPointerDown={tap(() => sendInput(seq))}
          >
            <Icon className="size-4" />
          </ToolbarButton>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ToolbarButton — minimal local component to keep the markup readable.
// Not exported from the package's `<Button>` because we want pointerdown
// semantics, larger touch targets, and the active-state styling for sticky
// Ctrl; the shared component is built for click semantics.
// ---------------------------------------------------------------------------

interface ToolbarButtonProps {
  ariaLabel: string;
  title: string;
  onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => void;
  active?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}

function ToolbarButton({
  ariaLabel,
  title,
  onPointerDown,
  active,
  disabled,
  children,
}: ToolbarButtonProps) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      aria-pressed={active ? true : undefined}
      title={title}
      onPointerDown={onPointerDown}
      disabled={disabled}
      // 44×N min-height matches iOS HIG touch target; gap-1 keeps the button
      // pill compact so the whole row fits on a 320px-wide iPhone SE without
      // wrapping (the parent uses `overflow-x-auto` as a final safety net).
      className={[
        "inline-flex h-9 min-w-9 shrink-0 items-center justify-center gap-1 rounded-md px-2",
        "text-foreground transition-colors",
        active
          ? "bg-primary text-primary-foreground"
          : "bg-muted/60 hover:bg-muted active:bg-muted",
        "disabled:opacity-40",
      ].join(" ")}
    >
      {children}
    </button>
  );
}
