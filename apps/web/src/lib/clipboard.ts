/**
 * Clipboard helpers that work in both secure and non-secure contexts.
 *
 * `navigator.clipboard` is only exposed by browsers in secure contexts —
 * HTTPS pages or localhost-on-this-device. On iOS Safari that means hitting
 * a dev server over your LAN (`http://192.168.x.x:port`) makes
 * `navigator.clipboard` literally `undefined`, and any access throws
 * `TypeError: undefined is not an object`. Wrapping the modern API in a
 * try/catch swallows the error and the user just sees nothing on their
 * clipboard.
 *
 * `document.execCommand('copy')` is deprecated but still implemented across
 * every browser we care about (including iOS Safari) and does not require a
 * secure context. We use it as the fallback path.
 *
 * `readText` is harder — `execCommand('paste')` is blocked in most modern
 * browsers for security. If `navigator.clipboard.readText` is unavailable
 * the function rejects, and the caller should surface that to the user.
 */

/**
 * Write `text` to the OS clipboard. Tries `navigator.clipboard.writeText`
 * first (the only path that works in a sandboxed PWA / iframe) and falls
 * back to a temporary-textarea + `execCommand('copy')` flow if the modern
 * API is unavailable or rejects.
 *
 * MUST be called inside a user gesture (click / pointerdown / keydown).
 * Both code paths require it.
 *
 * Returns true if the write succeeded; false if both paths failed. The
 * caller decides whether to surface an error to the user.
 */
export async function writeClipboardText(text: string): Promise<boolean> {
  // Modern path — secure-context only.
  // Use optional chaining so an undefined `navigator.clipboard` (non-secure
  // context) does NOT throw on property access.
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission denied or transient error — fall through to the legacy
      // path. We don't log: the fallback is the answer in most cases.
    }
  }
  return legacyCopy(text);
}

/**
 * Legacy fallback: create an invisible textarea, select its contents, run
 * `document.execCommand('copy')`, and clean up. Works in non-secure
 * contexts (the common iPhone-on-LAN dev case).
 *
 * iOS Safari quirks this dance requires:
 * - The textarea must be visible (not `display:none`) AND focusable.
 *   We achieve "invisible but focusable" with `opacity: 0` + `position:
 *   fixed` (so it doesn't shift the layout).
 * - `select()` alone isn't enough on iOS — we also need
 *   `setSelectionRange(0, text.length)`. Without it, the selected range
 *   is empty and the copy is a no-op.
 * - The element must be `readonly` so the soft keyboard doesn't pop up
 *   for the split-second it's focused.
 */
function legacyCopy(text: string): boolean {
  if (typeof document === "undefined") return false;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "0";
  textarea.style.width = "1px";
  textarea.style.height = "1px";
  textarea.style.padding = "0";
  textarea.style.border = "0";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.appendChild(textarea);
  // Remember the previously focused element so we can restore it. On
  // iOS this matters: stealing focus from the xterm helper textarea
  // and not restoring it would dismiss the soft keyboard mid-tap.
  const previouslyFocused = document.activeElement as HTMLElement | null;
  try {
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    document.body.removeChild(textarea);
    // Best-effort restore; some elements (xterm's textarea is one) lose
    // focus state irreversibly when stolen from briefly, which is fine
    // for our use case (the toolbar's Copy button blurs the terminal
    // anyway in selection mode).
    previouslyFocused?.focus?.();
  }
}

/**
 * Read text from the OS clipboard. Only the modern API can do this; there
 * is no execCommand-based fallback that works in modern browsers. Returns
 * an empty string if the API is unavailable or the read fails.
 */
export async function readClipboardText(): Promise<string> {
  if (typeof navigator === "undefined" || !navigator.clipboard?.readText) {
    return "";
  }
  try {
    return await navigator.clipboard.readText();
  } catch {
    return "";
  }
}
