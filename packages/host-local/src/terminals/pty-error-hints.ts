/**
 * Turns a raw node-pty spawn/load error into a short, human message safe to
 * show in a terminal pane. The technical detail (stack, raw message) stays in
 * the server log; only this hint crosses the wire to the client.
 */

const MODULE_LOAD_PATTERN = /Cannot find module|MODULE_NOT_FOUND|pty\.node/i;
const RESOURCE_EXHAUSTION_PATTERN = /\b(EMFILE|ENFILE|ENOMEM|EAGAIN)\b/;

export function hintForPtySpawnError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (MODULE_LOAD_PATTERN.test(message)) {
    return "The terminal service could not load its native module. Restart the terminal service from Settings.";
  }
  if (RESOURCE_EXHAUSTION_PATTERN.test(message)) {
    return "Your system cannot start another terminal process. Close unused terminals and try again.";
  }
  return "Failed to start the terminal shell.";
}
