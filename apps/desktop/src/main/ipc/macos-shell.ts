/**
 * macOS shell bridges. Direct port of
 * `apps/dashboard/src-tauri/src/commands/macos_shell.rs`.
 *
 *   - `pickFolder` — system folder picker (cross-platform via Electron's `dialog`).
 *   - `revealInFinder` — open the path in the platform's file manager.
 *   - `checkAppExists` — look in /Applications and friends, fall back to `which`.
 *   - `openWithApp` — `open -a <app> <path>` (macOS only).
 *   - `installCli` — symlink the CLI binary via `osascript` admin prompt (macOS only).
 *   - `openExternal` — `shell.openExternal(url)` (cross-platform; replaces
 *     the renderer's use of `@tauri-apps/plugin-shell`).
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type BrowserWindow, dialog, shell } from "electron";

const NOT_SUPPORTED = "Not supported on this platform";

// ---------------------------------------------------------------------------
// pickFolder
// ---------------------------------------------------------------------------

/**
 * Open the system folder picker. Returns the absolute POSIX path or `null`
 * when the user cancels. Anchored to `parent` so the dialog is sheet-style
 * on macOS and modal-relative on other platforms.
 */
export async function pickFolder(parent: BrowserWindow | null): Promise<string | null> {
  const opts = {
    title: "Select a git repository",
    properties: ["openDirectory"] as Array<"openDirectory">,
  };
  const result = parent
    ? await dialog.showOpenDialog(parent, opts)
    : await dialog.showOpenDialog(opts);
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0] ?? null;
}

// ---------------------------------------------------------------------------
// revealInFinder
// ---------------------------------------------------------------------------

export async function revealInFinder(path: string): Promise<void> {
  // `shell.openPath` opens the folder/file in the system file manager and
  // returns an error string on failure (empty string on success).
  const err = await shell.openPath(path);
  if (err && err.length > 0) {
    throw new Error(`Failed to open Finder: ${err}`);
  }
}

// ---------------------------------------------------------------------------
// checkAppExists
// ---------------------------------------------------------------------------

/**
 * Check if a macOS app bundle (or CLI binary) is installed. Returns false on
 * non-macOS for `.app` lookups and falls back to `which` on Unix-like systems.
 *
 * Mirrors the Rust impl: tries /Applications, /System/Applications, ~/Applications,
 * then `which <name>`.
 */
export function checkAppExists(appName: string): boolean {
  const home = homedir();
  const candidates = [
    `/Applications/${appName}.app`,
    `/System/Applications/${appName}.app`,
    join(home, "Applications", `${appName}.app`),
  ];
  for (const path of candidates) {
    if (existsSync(path)) return true;
  }
  // Fallback: `which` (Unix) / `where` (Windows) for CLI tools.
  const cmd = process.platform === "win32" ? "where" : "which";
  try {
    const result = spawnSync(cmd, [appName], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// openWithApp
// ---------------------------------------------------------------------------

export async function openWithApp(path: string, appName: string): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error(NOT_SUPPORTED);
  }
  await new Promise<void>((resolve, reject) => {
    const proc = spawn("open", ["-a", appName, path], { stdio: "ignore" });
    proc.on("error", (err) => reject(new Error(`Failed to open with ${appName}: ${err.message}`)));
    proc.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`open -a ${appName} failed with exit code ${code}`));
    });
  });
}

// ---------------------------------------------------------------------------
// installCli
// ---------------------------------------------------------------------------

/**
 * Create a symlink with administrator privileges. Pops a macOS password
 * dialog via osascript. Direct port of the Rust impl, including the same
 * single-quote escaping (replace `'` with `'\''` then JSON-quote).
 */
export async function installCli(binaryPath: string, symlinkPath: string): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error(NOT_SUPPORTED);
  }
  const escapedBinary = binaryPath.replaceAll("'", "'\\''");
  const escapedSymlink = symlinkPath.replaceAll("'", "'\\''");
  const cmd = `ln -sf '${escapedBinary}' '${escapedSymlink}'`;
  // The osascript `do shell script` string is double-quote delimited, so we
  // escape backslashes then double-quotes.
  const script = `do shell script "${cmd
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')}" with administrator privileges`;

  await new Promise<void>((resolve, reject) => {
    const proc = spawn("osascript", ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on("error", (err) => reject(new Error(`Failed to run osascript: ${err.message}`)));
    proc.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      if (stderr.includes("User canceled") || stderr.includes("-128")) {
        reject(new Error("Admin password prompt cancelled"));
        return;
      }
      reject(new Error(`Failed to install CLI: ${stderr || "unknown error"}`));
    });
  });
}

// ---------------------------------------------------------------------------
// openExternal
// ---------------------------------------------------------------------------

/**
 * Open a URL in the user's default browser. Replaces the renderer's use of
 * `@tauri-apps/plugin-shell`'s `open()` from `apps/web/src/lib/open-external-url.ts`.
 */
export async function openExternal(url: string): Promise<void> {
  await shell.openExternal(url);
}
