/**
 * Compose a `command + args[]` invocation into a single shell-safe command
 * string for a terminal pane's PTY (`terminalService.spawn` writes the
 * `command` option directly to the shell as text, see
 * `terminal-pool.ts::spawn`).
 *
 * Each token is:
 *
 *   1. **Stripped of C0/C1 control characters** (`\x00..\x1f`, `\x7f`,
 *      `\x80..\x9f`). The PTY driver interprets these *before* the shell
 *      tokenises the line — e.g. `\x03` becomes SIGINT, `\x04` is EOF,
 *      `\x1b[` opens a CSI sequence; some emulators also act on C1
 *      single-byte controls (`\x80..\x9f`) before the shell sees them.
 *      The user-controlled fields (`prompt`, and downstream the agent
 *      session ID) are plain strings so a malicious or malformed input
 *      could otherwise abort the vendor CLI before it ever started. The
 *      strip is per-token because the shell-quote dance only protects
 *      against shell metacharacters, not against control codes the PTY
 *      layer eats.
 *   2. **Wrapped in single quotes**, with any embedded `'` rewritten as
 *      `'\''` (POSIX-style — the only escape sequence single-quoted
 *      strings accept). This is the same algorithm `shell-quote` and
 *      `child_process`'s POSIX shell helpers use; inlined here to avoid
 *      the dependency.
 *
 * Empty `args` returns the bare command so an interactive REPL without
 * positional arguments still launches cleanly.
 *
 * Shared by the two terminal-spawn paths that compose a vendor-CLI
 * invocation: `workspaces.create --via terminal` (issue #551) and the chat
 * tab's "Continue in terminal" action.
 */

// Hoisted to module scope so the regex compiles once at load time
// instead of on every `formatShellCommand` invocation. Matches the C0
// range (`\x00..\x1f`), DEL (`\x7f`), and the C1 range (`\x80..\x9f`).
// The character-class bounds are spelled with `String.fromCharCode` so
// biome's `noControlCharactersInRegex` rule (which flags any literal
// control-char in regex source) doesn't misread the intent.
const PTY_CONTROL_CHAR_RANGE = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}${String.fromCharCode(
    0x7f,
  )}-${String.fromCharCode(0x9f)}]`,
  "g",
);

export function formatShellCommand(command: string, args: string[]): string {
  const stripControls = (s: string) => s.replace(PTY_CONTROL_CHAR_RANGE, "");
  const quoted = [command, ...args].map(
    (token) => `'${stripControls(token).replace(/'/g, "'\\''")}'`,
  );
  return quoted.join(" ");
}
