/**
 * The packaged app started as `Band <script>.mjs ...` means a caller meant to run it as Node
 * and left out `ELECTRON_RUN_AS_NODE`. Booting the app then starts a window and a hub in the
 * caller's HOME, and a git credential helper that does this loops without end. Returns the
 * stderr line to print before exiting non-zero, or null for a normal launch.
 *
 * Only a packaged app is checked: an unpackaged launch (`electron <app dir>`, the e2e
 * harness) passes its own entry file as the first argument.
 */
export function scriptLaunchRefusal(
  argv: readonly string[],
  isPackaged: boolean,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!isPackaged || env.ELECTRON_RUN_AS_NODE) return null;
  const first = argv[1];
  if (!first || !/\.(mjs|cjs|js)$/i.test(first)) return null;
  return `Band: refusing to start the desktop app with the script argument "${first}". Set ELECTRON_RUN_AS_NODE=1 to run a script with this binary.\n`;
}
