import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { createLogger } from "@band-app/logger";
import { checkCli, installCli } from "./cli";
import { checkHooks, installHooks } from "./hooks";
import { shellPath, whichBinary } from "./process-utils";
import { type CodingAgentDefinition, loadSettings, saveSettings } from "./state";

const execFileP = promisify(execFile);

const log = createLogger("setup");

// Editors to detect, in priority order.
// Each entry maps a settings `type` to the CLI binary name to look for.
const EDITOR_CHECKS: { type: string; binary: string }[] = [
  { type: "vscode", binary: "code" },
  { type: "cursor", binary: "cursor" },
  { type: "zed", binary: "zed" },
  // JetBrains IDEs
  { type: "idea", binary: "idea" },
  { type: "webstorm", binary: "webstorm" },
  { type: "pycharm", binary: "pycharm" },
  { type: "goland", binary: "goland" },
  { type: "clion", binary: "clion" },
  { type: "rider", binary: "rider" },
  { type: "rubymine", binary: "rubymine" },
  { type: "phpstorm", binary: "phpstorm" },
];

interface DetectedEditor {
  type: string;
  binary: string;
  path: string;
}

// Coding agents to detect, in priority order. The first detected agent
// becomes the default if no default has been chosen yet.
const AGENT_CHECKS: { id: string; type: string; label: string; binary: string }[] = [
  { id: "claude-code", type: "claude-code", label: "Claude Code", binary: "claude" },
  { id: "codex", type: "codex", label: "Codex", binary: "codex" },
  { id: "opencode", type: "opencode", label: "OpenCode", binary: "opencode" },
];

/** Detect the first available supported editor on the system. */
async function detectEditor(): Promise<DetectedEditor | null> {
  for (const check of EDITOR_CHECKS) {
    const path = await whichBinary(check.binary);
    if (path) {
      return { type: check.type, binary: check.binary, path };
    }
  }
  return null;
}

/**
 * VS Code marks uninstalled extensions in `.obsolete` and skips loading
 * them on subsequent launches — even after their files are restored.
 * Remove our entry so the freshly-copied extension is picked up.
 */
function clearObsoleteFlag(extensionsRoot: string, extensionId: string): void {
  const obsoletePath = join(extensionsRoot, ".obsolete");
  let parsed: Record<string, boolean>;
  try {
    parsed = JSON.parse(readFileSync(obsoletePath, "utf-8")) as Record<string, boolean>;
  } catch {
    return; // file missing or unreadable — nothing to clear
  }
  if (!parsed[extensionId]) return;
  delete parsed[extensionId];
  writeFileSync(obsoletePath, JSON.stringify(parsed), "utf-8");
}

/**
 * Install the Band VS Code extension via `code --install-extension`
 * (or `cursor --install-extension`). This is the proper VS Code install
 * path — it registers the extension in `extensions.json` so the editor
 * actually loads it, rather than just dropping files into the extensions
 * directory (which modern VS Code ignores).
 */
async function installExtension(editorType: "vscode" | "cursor"): Promise<{
  installed: boolean;
  error?: string;
}> {
  // Resolve path to the bundled .vsix file.
  // This source file lives at apps/web/src/lib/setup.ts, so go up to the
  // project root and then into extensions/vscode/.
  const extensionSrcDir = resolve(
    import.meta.dirname,
    "..",
    "..",
    "..",
    "..",
    "extensions",
    "vscode",
  );
  const vsixPath = join(extensionSrcDir, "band-vscode-0.1.0.vsix");

  if (!existsSync(vsixPath)) {
    return {
      installed: false,
      error: `VSIX not found at ${vsixPath} — run \`vsce package\` in extensions/vscode/`,
    };
  }

  const cliBinary = editorType === "cursor" ? "cursor" : "code";
  const cliPath = await whichBinary(cliBinary);
  if (!cliPath) {
    return {
      installed: false,
      error: `${cliBinary} CLI not found on PATH`,
    };
  }

  // `code` may be a shell wrapper, so run it through the user's shell PATH
  // to pick up node, etc.
  const env = { ...process.env, PATH: await shellPath() };
  // Defensive: clear the obsolete flag in case the extension was previously
  // uninstalled — `code --install-extension` will not re-enable it otherwise.
  const home = homedir();
  const extensionsRoot =
    editorType === "cursor"
      ? join(home, ".cursor", "extensions")
      : join(home, ".vscode", "extensions");
  clearObsoleteFlag(extensionsRoot, "band.band-vscode-0.1.0");

  try {
    await execFileP(cliPath, ["--install-extension", vsixPath, "--force"], { env });
    return { installed: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { installed: false, error: message };
  }
}

/**
 * Run startup setup. Called every server boot. Each step is idempotent —
 * it checks whether the relevant setting is already present and only acts
 * when something is missing.
 *
 * Steps:
 * 1. Ensure `defaults.apps` is populated with the detected editor
 *    (also installs the VS Code extension and CLI on first run).
 * 2. Ensure `codingAgents` is populated with detected agent CLIs.
 * 3. Ensure `notifications.soundOnNeedsAttention` defaults to `true`.
 * 4. Ensure Claude Code hooks are installed.
 */
export async function runFirstTimeSetup(): Promise<void> {
  await ensureDefaultApps();
  await ensureDefaultCodingAgents();
  ensureNotificationDefaults();
  await ensureClaudeHooks();
}

/**
 * If `defaults.apps` is missing or empty, detect the user's editor and
 * write a default config. Also installs the VS Code extension (when
 * applicable) and the band CLI symlink — these run once because they're
 * gated on the same condition.
 */
async function ensureDefaultApps(): Promise<void> {
  const settings = loadSettings();
  const existingApps = (settings.defaults as { apps?: unknown[] } | undefined)?.apps;
  if (Array.isArray(existingApps) && existingApps.length > 0) {
    return;
  }

  log.info("Setting up default apps...");

  const editor = await detectEditor();
  if (editor) {
    log.info("Detected editor: %s (%s)", editor.type, editor.path);
  } else {
    log.info("No supported editor detected, defaulting to vscode");
  }

  const editorType = editor?.type ?? "vscode";
  const current = loadSettings();
  const existingDefaults = (current.defaults as Record<string, unknown> | undefined) ?? {};
  current.defaults = { ...existingDefaults, apps: [{ type: editorType }] };

  // Persist appMode if Tauri hasn't already written it.
  if (!current.appMode) {
    (current as Record<string, unknown>).appMode = "full-editor";
  }

  saveSettings(current);

  // --- Extension installation ---
  if (editor?.type === "vscode" || editor?.type === "cursor") {
    const result = await installExtension(editor.type);
    if (result.installed) {
      log.info("Installed VS Code extension for %s", editor.type);
    } else {
      log.warn("Failed to install extension for %s: %s", editor.type, result.error);
    }

    const otherType = editor.type === "vscode" ? "cursor" : "vscode";
    const otherBinary = otherType === "vscode" ? "code" : "cursor";
    const otherPath = await whichBinary(otherBinary);
    if (otherPath) {
      const otherResult = await installExtension(otherType);
      if (otherResult.installed) {
        log.info("Also installed VS Code extension for %s", otherType);
      }
    }
  }

  // --- CLI installation ---
  try {
    const cliStatus = await checkCli();
    if (cliStatus === "NotInstalled") {
      await installCli();
      log.info("CLI installed to /usr/local/bin/band");
    } else if (cliStatus === "Installed") {
      log.info("CLI already installed");
    } else {
      log.warn("CLI not auto-installed (status: %s)", cliStatus);
    }
  } catch (err) {
    log.warn("CLI installation failed: %s", err instanceof Error ? err.message : String(err));
  }
}

/**
 * If `codingAgents` is missing or empty, detect which agent CLIs are
 * installed and enable them. Sets `defaultCodingAgent` to the first
 * detected agent (priority order in AGENT_CHECKS) when not already set.
 */
async function ensureDefaultCodingAgents(): Promise<void> {
  const settings = loadSettings();
  const existing = settings.codingAgents;
  if (Array.isArray(existing) && existing.length > 0) {
    return;
  }

  log.info("Detecting installed coding agents...");

  const detected: CodingAgentDefinition[] = [];
  for (const check of AGENT_CHECKS) {
    const path = await whichBinary(check.binary);
    if (path) {
      log.info("Detected coding agent: %s (%s)", check.id, path);
      detected.push({ id: check.id, type: check.type, label: check.label });
    }
  }

  if (detected.length === 0) {
    log.info("No coding agent CLIs detected on PATH");
    return;
  }

  const current = loadSettings();
  current.codingAgents = detected;
  if (!current.defaultCodingAgent) {
    current.defaultCodingAgent = detected[0].id;
  }
  saveSettings(current);
  log.info("Enabled %d coding agent(s); default = %s", detected.length, current.defaultCodingAgent);
}

/**
 * Ensure `notifications.soundOnNeedsAttention` is set. Only writes when
 * the field is `undefined` so an explicit user choice (true or false)
 * is preserved.
 */
function ensureNotificationDefaults(): void {
  const settings = loadSettings();
  const notifications = settings.notifications ?? {};
  if (notifications.soundOnNeedsAttention !== undefined) {
    return;
  }

  saveSettings({
    ...settings,
    notifications: { ...notifications, soundOnNeedsAttention: true },
  });
  log.info("Set default notifications.soundOnNeedsAttention = true");
}

/**
 * Install Claude Code hooks if they're not already present. Relies on
 * the band CLI being on PATH, so this must run after `ensureDefaultApps`.
 */
async function ensureClaudeHooks(): Promise<void> {
  try {
    const status = await checkHooks();
    if (status.installed) {
      return;
    }
    await installHooks();
    log.info("Installed Claude Code hooks");
  } catch (err) {
    log.warn(
      "Failed to install Claude Code hooks: %s",
      err instanceof Error ? err.message : String(err),
    );
  }
}
