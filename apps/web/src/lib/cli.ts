import { execFile } from "node:child_process";
import { accessSync, constants, lstatSync, realpathSync, symlinkSync, unlinkSync } from "node:fs";
import { platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export type CliStatus =
  | "Installed"
  | "NotInstalled"
  | "ConflictingBinary"
  | "DirNotFound"
  | "NotWritable";

const SYMLINK_PATH = "/usr/local/bin/band";

/** Find the CLI binary by trying multiple resolution strategies. */
function findCliBinary(): string | null {
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

export async function installCli(opts: InstallCliOptions = {}): Promise<void> {
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
    if (opts.allowPrompt) {
      await installViaOsascript(binaryPath, SYMLINK_PATH);
      return;
    }
    // On macOS the user can elevate by clicking the Install button —
    // surface a friendly message rather than telling them to run sudo.
    throw new Error("admin password required");
  }

  throw new Error(`Run: sudo ln -sf "${binaryPath}" "${SYMLINK_PATH}"`);
}

/** Quote a string for use as a single shell argument inside single quotes. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Quote a string as an AppleScript string literal. */
function appleScriptString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * On macOS, run `ln -sf` with admin privileges via osascript so the OS
 * displays a single password prompt instead of asking the user to run sudo
 * in a terminal.
 */
async function installViaOsascript(binaryPath: string, symlinkPath: string): Promise<void> {
  const cmd = `ln -sf ${shellQuote(binaryPath)} ${shellQuote(symlinkPath)}`;
  const script = `do shell script ${appleScriptString(cmd)} with administrator privileges`;
  try {
    await execFileP("osascript", ["-e", script]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("User canceled") || message.includes("-128")) {
      throw new Error("Admin password prompt cancelled");
    }
    throw new Error(`Failed to install band CLI: ${message}`);
  }
}
