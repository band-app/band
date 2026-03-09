import { lstatSync, readlinkSync, symlinkSync } from "node:fs";
import { join } from "node:path";

export type CliStatus =
  | "Installed"
  | "NotInstalled"
  | "ConflictingBinary"
  | "DirNotFound"
  | "NotWritable";

const SYMLINK_PATH = "/usr/local/bin/band";

export async function checkCli(): Promise<CliStatus> {
  try {
    const stat = lstatSync(SYMLINK_PATH);
    if (!stat.isSymbolicLink()) {
      return "ConflictingBinary";
    }
    // Check if the symlink target exists
    const target = readlinkSync(SYMLINK_PATH);
    try {
      lstatSync(target);
      return "Installed";
    } catch {
      return "NotInstalled";
    }
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
  // Find the CLI binary from npm package build output
  // The CLI binary is built with cargo and placed at apps/cli/target/release/band
  // In production, it may be at various locations. Try common paths.
  const possiblePaths = [
    join(import.meta.dirname, "..", "..", "..", "..", "cli", "target", "release", "band"),
    join(import.meta.dirname, "..", "..", "..", "..", "cli", "target", "debug", "band"),
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

  // Remove existing symlink if present
  try {
    lstatSync(SYMLINK_PATH);
    const { unlinkSync } = await import("node:fs");
    unlinkSync(SYMLINK_PATH);
  } catch {
    // No existing file
  }

  symlinkSync(binaryPath, SYMLINK_PATH);
}
