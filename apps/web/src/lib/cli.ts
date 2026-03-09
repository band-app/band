import { lstatSync, readlinkSync, realpathSync, symlinkSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";

export type CliStatus =
  | "Installed"
  | "NotInstalled"
  | "ConflictingBinary"
  | "DirNotFound"
  | "NotWritable";

const SYMLINK_PATH = "/usr/local/bin/band";

/** Resolve the project root from the web app's working directory (apps/web/). */
function projectRoot(): string {
  // Both Vite dev and the production server run with cwd = apps/web/
  return resolve(process.cwd(), "..", "..");
}

export async function checkCli(): Promise<CliStatus> {
  try {
    const stat = lstatSync(SYMLINK_PATH);
    if (!stat.isSymbolicLink()) {
      return "ConflictingBinary";
    }
    // Check if the symlink points to our CLI binary
    const target = realpathSync(SYMLINK_PATH);
    const root = projectRoot();
    if (!target.startsWith(join(root, "apps", "cli"))) {
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

export async function installCli(): Promise<void> {
  const root = projectRoot();
  const possiblePaths = [
    join(root, "apps", "cli", "target", "release", "band"),
    join(root, "apps", "cli", "target", "debug", "band"),
  ];

  let binaryPath: string | null = null;
  for (const p of possiblePaths) {
    try {
      lstatSync(p);
      binaryPath = p;
      break;
    } catch {
      // Continue
    }
  }

  if (!binaryPath) {
    throw new Error(
      "Could not find band CLI binary. Build it first with: cargo build --release -p band-cli",
    );
  }

  // Remove existing file/symlink if present
  try {
    lstatSync(SYMLINK_PATH);
    unlinkSync(SYMLINK_PATH);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw err;
  }

  symlinkSync(binaryPath, SYMLINK_PATH);
}
