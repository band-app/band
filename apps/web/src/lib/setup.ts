import { createLogger } from "@band-app/logger";
import { checkCli, installCli } from "./cli";
import { installSkills } from "./cli-skills";
import { checkHooks, installHooks } from "./hooks";
import { whichBinary } from "./process-utils";
import { type CodingAgentDefinition, loadSettings, saveSettings } from "./state";

const log = createLogger("setup");

// Coding agents to detect, in priority order. The first detected agent
// becomes the default if no default has been chosen yet.
const AGENT_CHECKS: { id: string; type: string; label: string; binary: string }[] = [
  { id: "claude-code", type: "claude-code", label: "Claude Code", binary: "claude" },
  { id: "codex", type: "codex", label: "Codex", binary: "codex" },
  { id: "opencode", type: "opencode", label: "OpenCode", binary: "opencode" },
];

/**
 * Run startup setup. Called every server boot. Each step is idempotent —
 * it checks whether the relevant resource is already present and only acts
 * when something is missing.
 *
 * Steps:
 * 1. Install the band CLI on first launch (gated on CLI status — once
 *    `/usr/local/bin/band` exists we treat first-time setup as done).
 * 2. Ensure `codingAgents` is populated with detected agent CLIs.
 * 3. Ensure `notifications.soundOnNeedsAttention` defaults to `true`.
 * 4. Ensure Claude Code hooks are installed.
 * 5. Sync the CLI-shipped skills into each detected agent's global skills
 *    directory so a fresh install / auto-update lands the latest SKILL.md
 *    files automatically (issue: sync-cli-skills).
 */
export async function runFirstTimeSetup(): Promise<void> {
  await ensureCliInstalled();
  await ensureDefaultCodingAgents();
  ensureNotificationDefaults();
  await ensureClaudeHooks();
  await ensureSkillsInstalled();
}

/**
 * On first launch (when the band CLI symlink is missing) install it.
 * `checkCli()` returns "Installed" once we've put the symlink in place,
 * which serves as the natural first-run-done flag.
 */
async function ensureCliInstalled(): Promise<void> {
  let cliStatus: Awaited<ReturnType<typeof checkCli>>;
  try {
    cliStatus = await checkCli();
  } catch (err) {
    log.warn("Could not check CLI status: %s", err instanceof Error ? err.message : String(err));
    return;
  }

  if (cliStatus === "Installed") {
    return;
  }

  if (cliStatus !== "NotInstalled") {
    log.warn("CLI not auto-installed (status: %s)", cliStatus);
    return;
  }

  log.info("Installing band CLI...");
  try {
    await installCli();
    log.info("CLI installed to /usr/local/bin/band");
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
 * the band CLI being on PATH, so this must run after `ensureCliInstalled`.
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

/**
 * Sync the bundled CLI skills into each detected agent's global skills dir.
 *
 * `installSkills` is idempotent: it only writes when the destination is
 * missing or has different content. After an electron-updater install, the
 * app relaunches → bootstrap → web server boot → `runFirstTimeSetup`, so
 * this same step also handles the post-update refresh — no separate update
 * hook is needed. Failures are logged but don't block boot, matching the
 * rest of the setup pipeline.
 */
async function ensureSkillsInstalled(): Promise<void> {
  try {
    const settings = loadSettings();
    const agentIds = (settings.codingAgents ?? []).map((a) => a.id);
    if (agentIds.length === 0) {
      // Nothing detected → nothing to sync. The next boot after an agent is
      // installed will pick it up.
      return;
    }

    const result = await installSkills({ agentIds, log });
    const wrote = result.written.length + result.updated.length;
    if (wrote > 0) {
      log.info(
        "Synced CLI skills (%d written, %d updated, %d unchanged, %d skipped)",
        result.written.length,
        result.updated.length,
        result.unchanged.length,
        result.skipped.length,
      );
    }
  } catch (err) {
    log.warn("Failed to sync CLI skills: %s", err instanceof Error ? err.message : String(err));
  }
}
