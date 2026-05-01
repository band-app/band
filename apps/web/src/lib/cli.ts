import { accessSync, constants, lstatSync, realpathSync, symlinkSync, unlinkSync } from "node:fs";
import { platform } from "node:os";
import { dirname, join, resolve } from "node:path";

export type CliStatus =
  | "Installed"
  | "NotInstalled"
  | "ConflictingBinary"
  | "DirNotFound"
  | "NotWritable";

export const SYMLINK_PATH = "/usr/local/bin/band";

/** Find the CLI binary by trying multiple resolution strategies. */
export function findCliBinary(): string | null {
  const strategies = [
    // cwd = apps/web/ (Vite dev and production server)
    resolve(process.cwd(), ".."),
    // cwd = project root (fallback)
    resolve(process.cwd(), "apps"),
    // From this source file (apps/web/src/lib/ → apps/)
    resolve(import.meta.dirname, "..", "..", ".."),
  ];

  for (const appsDir of strategies) {
    for (const profile of ["release", "debug"]) {
      const p = join(appsDir, "cli", "target", profile, "band");
      try {
        lstatSync(p);
        return p;
      } catch {
        // Continue
      }
    }
  }
  return null;
}

export async function checkCli(): Promise<CliStatus> {
  try {
    const stat = lstatSync(SYMLINK_PATH);
    if (!stat.isSymbolicLink()) {
      return "ConflictingBinary";
    }
    // Check if the symlink points to our CLI binary
    const target = realpathSync(SYMLINK_PATH);
    if (!target.includes(join("apps", "cli", "target"))) {
      return "ConflictingBinary";
    }
    return "Installed";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      // Check if /usr/local/bin exists
      try {
        lstatSync("/usr/local/bin");
        return "NotInstalled";
      } catch {
        return "DirNotFound";
      }
    }
    if (code === "EACCES") {
      return "NotWritable";
    }
    return "NotInstalled";
  }
}

/** Check if the current process can write to a directory. */
function isDirWritable(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export interface InstallCliOptions {
  /**
   * If true and the symlink directory isn't writable on macOS, prompt for
   * admin credentials via osascript and run the install with elevated
   * privileges. Should only be true when triggered by an explicit user
   * action (e.g. clicking an Install button), never on background auto-
   * install paths.
   */
  allowPrompt?: boolean;
}

export async function installCli(_opts: InstallCliOptions = {}): Promise<void> {
  const binaryPath = findCliBinary();
  if (!binaryPath) {
    throw new Error(
      "Could not find band CLI binary. Build it first with: cargo build --release -p band-cli",
    );
  }

  const dir = dirname(SYMLINK_PATH);

  if (isDirWritable(dir)) {
    try {
      lstatSync(SYMLINK_PATH);
      unlinkSync(SYMLINK_PATH);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw err;
    }
    symlinkSync(binaryPath, SYMLINK_PATH);
    return;
  }

  if (platform() === "darwin") {
    // Elevation must happen in the Tauri desktop app (foreground GUI process).
    // Throw a recognizable error so the hybrid adapter can catch it and
    // delegate to the Tauri `install_cli` command.
    throw new Error("elevation-required");
  }

  throw new Error(`Run: sudo ln -sf "${binaryPath}" "${SYMLINK_PATH}"`);
}

/** Resolve the CLI binary path and symlink path for the frontend. */
export function resolveCliPaths(): { binaryPath: string; symlinkPath: string } | null {
  const binaryPath = findCliBinary();
  if (!binaryPath) return null;
  return { binaryPath, symlinkPath: SYMLINK_PATH };
}
