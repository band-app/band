/**
 * Strip terminal query/request escape sequences from buffered scrollback so
 * replaying them on reconnect doesn't cause the client's terminal emulator
 * (xterm.js) to emit spurious responses.
 *
 * Why this matters: when scrollback is replayed, xterm.js parses it just like
 * live PTY output. Any *query* sequence it sees (a request for cursor
 * position, device attributes, or the current colors) it answers per spec via
 * `term.onData()`. The dashboard forwards that answer back to the PTY stdin,
 * where the shell's line editor inserts the printable remainder as literal
 * text at the prompt — e.g. `10;rgb:e8e8/e8e8/e8e811;rgb:1e1e/1e1e/1e1e`
 * appearing out of nowhere (band-app/band#613). Live output never triggers
 * this because the query response is consumed by whatever tool issued it; the
 * leak is specific to replaying a stale query with no matching reader.
 *
 * Covers:
 *  CSI (ESC [ …):
 *   \x1b[6n   — Cursor Position Report (DSR CPR)
 *   \x1b[?6n  — Extended CPR
 *   \x1b[5n   — Device Status Report
 *   \x1b[c    — Primary Device Attributes (DA1)
 *   \x1b[>c   — Secondary Device Attributes (DA2)
 *   \x1b[=c   — Tertiary Device Attributes (DA3)
 *  OSC (ESC ] …), terminated by BEL (\x07) or ST (ESC \):
 *   \x1b]10;…  — foreground color query/report
 *   \x1b]11;…  — background color query/report
 *   \x1b]12;…  — cursor color query/report
 *  Both the `?` query form (`ESC]11;?BEL`) and any `rgb:` report form that
 *  may already be sitting in scrollback are removed.
 */
export function stripTerminalQueries(data: string): string {
  return (
    data
      // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — matching real ESC sequences in terminal output
      .replace(/\x1b\[\??[0-9]*[nc]|\x1b\[>[0-9]*c|\x1b\[=[0-9]*c/g, "")
      // OSC 10/11/12 color queries/reports. The payload runs until the first
      // BEL or ST, so `[^\x07\x1b]*` stops at either terminator byte. The
      // terminator is OPTIONAL so an *unterminated* opener is stripped too:
      // PTY output arrives in chunks, so scrollback can end mid-sequence
      // (`\x1b]11;?` with its BEL not yet appended). Replaying that dangling
      // query would leave xterm.js waiting for the terminator, which the live
      // stream then supplies — re-triggering the #613 leak. Because the
      // negated class stops at any ESC, the optional terminator only ever
      // consumes a real terminator or nothing; it never eats a following
      // escape sequence.
      // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — matching real OSC sequences in terminal output
      .replace(/\x1b\]1[012];[^\x07\x1b]*(?:\x07|\x1b\\)?/g, "")
  );
}
