const OFF = new Set(["off", "false", "0"]);
const ON = new Set(["on", "true", "1"]);
let warned = false;

/**
 * `BAND_LOCAL_WORKER=off` turns off worktrees on the hub's own machine. Read on every call.
 * `BAND_LOCAL_HOST` is the older name and is read when the new one is unset.
 * A set value that is neither an off nor an on spelling counts as off, with one warning, so a
 * typo never leaves worktrees running on a machine the operator meant to keep clear.
 */
export function isLocalHostEnabled(): boolean {
  const value = (process.env.BAND_LOCAL_WORKER?.trim() || process.env.BAND_LOCAL_HOST)
    ?.trim()
    .toLowerCase();
  if (!value || ON.has(value)) return true;
  if (OFF.has(value)) return false;
  if (!warned) {
    warned = true;
    console.warn(
      `BAND_LOCAL_WORKER has the unrecognised value "${value}". Use "off" or "on". Treating it as off.`,
    );
  }
  return false;
}
