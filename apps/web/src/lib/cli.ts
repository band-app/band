import { execSync } from "node:child_process";
import { accessSync, constants, lstatSync, realpathSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

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

export async function installCli(): Promise<void> {
  const binaryPath = findCliBinary();
  if (!binaryPath) {
    throw new Error(
      "Could not find band CLI binary. Build it first with: cargo build --release -p band-cli",
    );
  }

  const dir = dirname(SYMLINK_PATH);

  if (isDirWritable(dir)) {
    // Directory is writable — do it directly
    try {
      lstatSync(SYMLINK_PATH);
      unlinkSync(SYMLINK_PATH);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw err;
    }
    symlinkSync(binaryPath, SYMLINK_PATH);
  } else {
    // Need elevated permissions — use osascript to prompt for admin auth
    const script = `do shell script "ln -sf '${binaryPath}' '${SYMLINK_PATH}'" with administrator privileges`;
    try {
      execSync(`osascript -e '${script}'`, { stdio: "pipe" });
    } catch {
      throw new Error(
        `Permission denied. Run manually: sudo ln -sf "${binaryPath}" "${SYMLINK_PATH}"`,
      );
    }
  }
}
