/**
 * The terminal key bar's bytes. The iOS keyboard has no Esc, Tab, Ctrl or arrow keys, so the bar
 * sends them. Ctrl is sticky: it applies to the next character, from the bar or the keyboard.
 */

export type BarKey = "esc" | "tab" | "up" | "down" | "left" | "right" | "pipe" | "tilde" | "slash";

export interface KeyDef {
  key: BarKey;
  label: string;
}

/** The bar's keys in display order (Ctrl is a toggle, drawn before these). */
export const BAR_KEYS: readonly KeyDef[] = [
  { key: "esc", label: "esc" },
  { key: "tab", label: "tab" },
  { key: "left", label: "left" },
  { key: "down", label: "down" },
  { key: "up", label: "up" },
  { key: "right", label: "right" },
  { key: "pipe", label: "|" },
  { key: "tilde", label: "~" },
  { key: "slash", label: "/" },
];

/**
 * The bytes for a bar key. Arrows follow the terminal's cursor-key mode: an application (vim, less,
 * Claude Code) that turned on application mode (DECCKM) expects `ESC O A`, a shell `ESC [ A`.
 */
export function barKeyBytes(key: BarKey, applicationCursor: boolean): string {
  const arrow = (letter: string) => (applicationCursor ? `\u001bO${letter}` : `\u001b[${letter}`);
  switch (key) {
    case "esc":
      return "\u001b";
    case "tab":
      return "\t";
    case "up":
      return arrow("A");
    case "down":
      return arrow("B");
    case "right":
      return arrow("C");
    case "left":
      return arrow("D");
    case "pipe":
      return "|";
    case "tilde":
      return "~";
    case "slash":
      return "/";
  }
}

/**
 * `data` with Ctrl applied: a letter becomes its control code (Ctrl-C is 0x03), and `@ [ \ ] ^ _ ?`
 * map as a hardware terminal does. Anything else, such as an escape sequence or a space-less
 * multi-character paste, passes through unchanged with `applied` false.
 */
export function applyCtrl(data: string): { data: string; applied: boolean } {
  if (data.length !== 1) return { data, applied: false };
  const code = data.charCodeAt(0);
  if (code >= 0x61 && code <= 0x7a)
    return { data: String.fromCharCode(code - 0x60), applied: true };
  if (code >= 0x40 && code <= 0x5f)
    return { data: String.fromCharCode(code - 0x40), applied: true };
  if (data === " ") return { data: "\u0000", applied: true };
  if (data === "?") return { data: "\u007f", applied: true };
  return { data, applied: false };
}

/**
 * The application cursor-key mode (DECCKM) after `text` of terminal output: `ESC [ ? 1 h` turns it
 * on and `ESC [ ? 1 l` off. A chunk with neither leaves `current` as it was.
 */
export function trackCursorMode(current: boolean, text: string): boolean {
  const on = text.lastIndexOf("\u001b[?1h");
  const off = text.lastIndexOf("\u001b[?1l");
  if (on === -1 && off === -1) return current;
  return on > off;
}

const CURSOR_SEQ_LENGTH = 5; // ESC [ ? 1 h|l

/**
 * Like `trackCursorMode`, but scans raw bytes and builds no string. `tail` is the last (up to 4)
 * bytes of the previous frame, so a sequence split across two frames is still found. Returns the
 * new mode and the tail to pass with the next frame.
 */
export function scanCursorMode(
  current: boolean,
  bytes: Uint8Array,
  tail: Uint8Array,
): { mode: boolean; tail: Uint8Array } {
  const lead = tail.length;
  const total = lead + bytes.length;
  const at = (i: number) => (i < lead ? tail[i] : bytes[i - lead]);
  let mode = current;
  for (let i = 0; i + CURSOR_SEQ_LENGTH <= total; i++) {
    // The sequence must end in this frame, or it was already seen with the previous one.
    if (i + CURSOR_SEQ_LENGTH <= lead) continue;
    if (at(i) !== 0x1b || at(i + 1) !== 0x5b || at(i + 2) !== 0x3f || at(i + 3) !== 0x31) continue;
    const last = at(i + 4);
    if (last === 0x68) mode = true;
    else if (last === 0x6c) mode = false;
  }
  const keep = Math.min(CURSOR_SEQ_LENGTH - 1, total);
  const next = new Uint8Array(keep);
  for (let i = 0; i < keep; i++) next[i] = at(total - keep + i);
  return { mode, tail: next };
}
