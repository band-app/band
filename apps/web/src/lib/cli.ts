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

/**
 * Pure resolver for the band CLI binary. Takes the cwd and the calling
 * module's dirname as inputs so callers can drive it with synthetic paths in
 * tests. The function still hits the real filesystem to confirm each
 * candidate exists — that's the actual contract we care about — but it has
 * no dependency on `process.cwd()` or `import.meta.dirname` so an integration
 * test can lay out a fake packaged-app tree under a tmp dir and call this
 * directly, without subprocess gymnastics.
 */
export function findCliBinaryAt(opts: { cwd: string; dirname: string }): string | null {
  const { cwd, dirname } = opts;

  // --- Strategy A: cargo build output (dev & source builds) ---
  const appsStrategies = [
    // cwd = apps/web/ (Vite dev and production server)
    resolve(cwd, ".."),
    // cwd = project root (fallback)
    resolve(cwd, "apps"),
    // From this source file (apps/web/src/lib/ → apps/)
    resolve(dirname, "..", "..", ".."),
  ];

  for (const appsDir of appsStrategies) {
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

  // --- Strategy B: Electron extraResources layout (issue #364) ---
  // electron-builder ships the sidecar at <Resources>/binaries/band on every
  // platform. The web server runs as a child of the main process with cwd
  // set to <Resources>/web by `services/web-server.ts` (via
  // `web-paths.ts::resolveWebDir`), so the sidecar is one level up and
  // across into `binaries/`. We try both the cwd-based and module-relative
  // paths so the resolution survives a future change to the spawn cwd (the
  // dirname path matches the bundled file's installed location at
  // `<Resources>/web/dist/start-server.mjs`).
  const exe = platform() === "win32" ? "band.exe" : "band";
  const electronCandidates = [
    // From cwd (<Resources>/web) → <Resources>/binaries/band
    resolve(cwd, "..", "binaries", exe),
    // From the bundled dist file (<Resources>/web/dist/start-server.mjs)
    // → <Resources>/binaries/band
    resolve(dirname, "..", "..", "binaries", exe),
  ];
  for (const p of electronCandidates) {
    try {
      lstatSync(p);
      return p;
    } catch {
      // Continue
    }
  }

  return null;
}

/** Find the CLI binary by trying multiple resolution strategies. */
export function findCliBinary(): string | null {
  return findCliBinaryAt({ cwd: process.cwd(), dirname: import.meta.dirname });
}

export async function checkCli(): Promise<CliStatus> {
  try {
    const stat = lstatSync(SYMLINK_PATH);
    if (!stat.isSymbolicLink()) {
      return "ConflictingBinary";
    }

    // Resolve the symlink target — may throw if the target no longer exists
    // (e.g. the symlink pointed to a deleted worktree).
    let target: string;
    try {
      target = realpathSync(SYMLINK_PATH);
    } catch {
      // Dangling symlink — treat as not installed so installCli() can
      // replace it with a valid path.
      return "NotInstalled";
    }

    // Accept our own cargo build output OR the Electron sidecar binary
    // (shipped as an extraResource at <Resources>/binaries/band — platform-
    // agnostic, so the matcher just looks for the trailing `/binaries/band`
    // segment).
    const isCargoBuild = target.includes(join("apps", "cli", "target"));
    const isElectronSidecar = target.endsWith(join("binaries", "band"));
    if (isCargoBuild || isElectronSidecar) {
      return "Installed";
    }

    // A symlink that resolves into a Band.app bundle but doesn't match the
    // Electron sidecar layout is a stale leftover from the Tauri build,
    // where the CLI sidecar lived at Contents/MacOS/band. On macOS's case-
    // insensitive filesystem that path now resolves to the Electron main
    // binary, which is not a CLI — invoking it spawns a second Electron
    // process that kills the user's web server on port 3456. Treat as
    // "NotInstalled" so first-time setup repairs it.
    const isStaleAppLink = target.toLowerCase().includes("/band.app/contents/macos/");
    if (isStaleAppLink) {
      return "NotInstalled";
    }
    return "ConflictingBinary";
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

/**
 * Pick the right message when `findCliBinary` returns null. The two
 * audiences are mutually exclusive: a .dmg user has no source tree (so the
 * cargo build advice is useless), and a developer running `pnpm dev`
 * without a built CLI has no .app bundle to reinstall. The desktop main
 * process tags the spawned web server with `BAND_PACKAGED=1` when
 * `app.isPackaged === true` (see `apps/desktop/src/main/services/web-server.ts`),
 * which is the cleanest available signal — `ELECTRON_RUN_AS_NODE` is set
 * in both packaged and dev-electron runs, so it can't distinguish them.
 */
export function noBinaryError(env: NodeJS.ProcessEnv = process.env): Error {
  if (env.BAND_PACKAGED) {
    return new Error("Bundled CLI binary missing - try reinstalling Band");
  }
  return new Error(
    "Could not find band CLI binary. Build it first with: cargo build --release -p band-cli",
  );
}

export async function installCli(_opts: InstallCliOptions = {}): Promise<void> {
  const binaryPath = findCliBinary();
  if (!binaryPath) {
    throw noBinaryError();
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
    // Elevation must happen in the desktop shell (foreground GUI process).
    // Throw a recognizable error so the hybrid adapter can catch it and
    // delegate to the Electron `install_cli` IPC command.
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
