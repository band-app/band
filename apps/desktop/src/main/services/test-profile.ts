import { join } from "node:path";

/** The slice of Electron's `app` the test profile needs. */
export interface PathSetter {
  setPath(name: "userData" | "sessionData" | "logs" | "crashDumps", path: string): void;
}

/**
 * `BAND_DESKTOP_USER_DATA_DIR` moves everything Electron keeps for the app (cookies and
 * storage of every browser-pane partition, logs, crash dumps) under one directory. Electron
 * resolves the default from the user's account home, not `$HOME`, so a test instance with a
 * temp `HOME` would otherwise share `~/Library/Application Support/Band` with the real app.
 *
 * Read once at startup from the app's own environment, before anything reads a path. It
 * takes only an absolute path. Returns the directory it applied, or null when unset.
 */
export function applyTestProfile(
  app: PathSetter,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const dir = env.BAND_DESKTOP_USER_DATA_DIR?.trim();
  if (!dir) return null;
  if (!dir.startsWith("/")) {
    throw new Error(`BAND_DESKTOP_USER_DATA_DIR must be an absolute path, got "${dir}"`);
  }
  app.setPath("userData", dir);
  app.setPath("sessionData", join(dir, "session"));
  app.setPath("logs", join(dir, "logs"));
  app.setPath("crashDumps", join(dir, "crashDumps"));
  return dir;
}
