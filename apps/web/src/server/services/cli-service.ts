import { execFile } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export type CliStatus =
  | "Installed"
  | "NotInstalled"
  | "ConflictingBinary"
  | "DirNotFound"
  | "NotWritable";

/**
 * Directory that holds the Windows `band.cmd` shim. Kept under
 * `%LOCALAPPDATA%\band\bin` (a per-user, no-elevation-required location);
 * falls back to the conventional `AppData\Local` path when the env var is
 * somehow unset.
 */
function windowsBinDir(): string {
  const localAppData = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
  return join(localAppData, "band", "bin");
}

/**
 * Install target for the `band` CLI entry point.
 *
 * - POSIX: a `/usr/local/bin/band` symlink to the resolved binary.
 * - Windows: a `band.cmd` shim under `%LOCALAPPDATA%\band\bin` (symlinks
 *   need Developer Mode / admin, a shim doesn't — see `installCliWindows`).
 */
export const SYMLINK_PATH =
  platform() === "win32" ? join(windowsBinDir(), "band.cmd") : "/usr/local/bin/band";

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

  // Cargo/Electron emit `band.exe` on Windows, `band` elsewhere.
  const exe = platform() === "win32" ? "band.exe" : "band";

  // --- Strategy A: cargo build output (dev & source builds) ---
  const appsStrategies = [
    // cwd = apps/web/ (Vite dev and production server)
    resolve(cwd, ".."),
    // cwd = project root (fallback)
    resolve(cwd, "apps"),
    // From this source file in dev (apps/web/src/server/services/ → apps/)
    resolve(dirname, "..", "..", "..", ".."),
    // From bundled `dist/` file (<Resources>/web/dist/ → <Resources>/) only
    // — in dev mode this resolves to `apps/web/src/`, which has no
    // `cli/target/<profile>/band` and is harmless; the four-level walk
    // above is the actual dev-mode path. Included so a future cargo-target
    // layout under <Resources>/cli/ would still resolve. Today's Electron
    // bundle ships the binary under `binaries/` (handled by Strategy B),
    // so this strategy never hits in production either.
    resolve(dirname, "..", "..", ".."),
  ];

  for (const appsDir of appsStrategies) {
    for (const profile of ["release", "debug"]) {
      const p = join(appsDir, "cli", "target", profile, exe);
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

/**
 * Windows install-status check. The shim is a plain `band.cmd` file (not a
 * symlink), so we read it and confirm it still points at an existing
 * `band.exe`. A shim referencing a moved/removed binary reports
 * `NotInstalled` so first-time setup rewrites it; a `band.cmd` we don't
 * recognise (foreign or hand-edited — its quoted target isn't `band.exe`)
 * reports `ConflictingBinary`, mirroring the POSIX branch rather than
 * silently trusting and later overwriting it.
 */
function checkCliWindows(): CliStatus {
  let contents: string;
  try {
    contents = readFileSync(SYMLINK_PATH, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EACCES") return "NotWritable";
    // ENOENT (no shim yet) or anything else — the bin dir is ours to
    // create in installCli, so treat as a clean "not installed".
    return "NotInstalled";
  }
  // Our shim invokes a quoted absolute path: `"C:\...\band.exe" %*`.
  const match = contents.match(/"([^"]+)"/);
  if (!match) return "ConflictingBinary";
  const target = match[1];
  // A quoted target that isn't `band.exe` is someone else's `band.cmd`.
  if (basename(target).toLowerCase() !== "band.exe") return "ConflictingBinary";
  return existsSync(target) ? "Installed" : "NotInstalled";
}

export async function checkCli(): Promise<CliStatus> {
  // Windows uses a `.cmd` shim, not a symlink — different install/verify
  // shape entirely.
  if (platform() === "win32") {
    return checkCliWindows();
  }
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
  // Strict `=== "1"` rather than truthy: a stray `BAND_PACKAGED=0` is a
  // non-empty string and would otherwise pick the wrong branch. The
  // setter in `apps/desktop/src/main/services/web-server.ts` only writes
  // "1" or omits the key, so this is defense against a future caller
  // doing something weird, not against current behavior.
  if (env.BAND_PACKAGED === "1") {
    return new Error("Bundled CLI binary missing - try reinstalling Band");
  }
  return new Error(
    "Could not find band CLI binary. Build it first with: cargo build --release -p band-cli",
  );
}

/**
 * Run `reg` and resolve with its stdout, never rejecting — callers treat
 * every registry operation as best-effort.
 */
function runReg(args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile("reg", args, { windowsHide: true }, (err, stdout) => {
      resolve(err ? "" : (stdout ?? ""));
    });
  });
}

/**
 * Best-effort: add `binDir` to the *user* `PATH` (HKCU\Environment) so
 * `band` resolves in newly opened shells. Reads the raw (unexpanded) value
 * and rewrites it as `REG_EXPAND_SZ` via `reg add` — deliberately NOT
 * `setx`, which truncates values over 1024 chars and would corrupt a long
 * PATH. A no-op when the dir is already present. Any failure is swallowed:
 * the shim itself is already installed, so the worst case is the user
 * adding the directory to PATH manually. Note that already-running shells
 * won't see the change until they're restarted.
 */
async function addBinDirToUserPath(binDir: string): Promise<void> {
  try {
    const stdout = await runReg(["query", "HKCU\\Environment", "/v", "Path"]);
    // Output line shape: `    Path    REG_EXPAND_SZ    C:\a;C:\b`
    const match = stdout.match(/\bPath\s+REG(?:_EXPAND)?_SZ\s+(.*)/i);
    const current = match ? match[1].trim() : "";
    const parts = current ? current.split(";").filter(Boolean) : [];
    if (parts.some((p) => p.toLowerCase() === binDir.toLowerCase())) {
      return;
    }
    const next = current ? `${current};${binDir}` : binDir;
    await runReg([
      "add",
      "HKCU\\Environment",
      "/v",
      "Path",
      "/t",
      "REG_EXPAND_SZ",
      "/d",
      next,
      "/f",
    ]);
  } catch {
    // Best-effort — the shim works from an absolute path regardless.
  }
}

/**
 * Install the Windows `band.cmd` shim under `%LOCALAPPDATA%\band\bin` and
 * put that directory on the user PATH. A shim (rather than a symlink)
 * avoids the Developer-Mode/admin requirement Windows imposes on symlink
 * creation, and works from cmd, PowerShell, and Git Bash alike.
 */
async function installCliWindows(binaryPath: string): Promise<void> {
  const binDir = windowsBinDir();
  mkdirSync(binDir, { recursive: true });
  // `%*` forwards every argument; the binary path is quoted so a space in
  // the install location (e.g. under a profile dir) is handled correctly.
  // `binaryPath` comes from `findCliBinary()` (a resolved on-disk path) and
  // the Windows filesystem forbids `"` in paths, so the double-quote wrapping
  // can't be broken by the interpolated value — the same assumption
  // `checkCliWindows` relies on when it parses the quoted target back out.
  const shim = `@echo off\r\n"${binaryPath}" %*\r\n`;
  writeFileSync(SYMLINK_PATH, shim, "utf-8");
  await addBinDirToUserPath(binDir);
}

export async function installCli(_opts: InstallCliOptions = {}): Promise<void> {
  const binaryPath = findCliBinary();
  if (!binaryPath) {
    throw noBinaryError();
  }

  if (platform() === "win32") {
    await installCliWindows(binaryPath);
    return;
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
