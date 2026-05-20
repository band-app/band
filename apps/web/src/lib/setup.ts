import { createLogger } from "@band-app/logger";
import { checkCli, installCli } from "./cli";
import { installSkills } from "./cli-skills";
import { checkHooks, installHooks } from "./hooks";
import { whichBinary } from "./process-utils";
import { type CodingAgentDefinition, loadSettings, saveSettings } from "./state";
import { syncWorktrees } from "./sync-state";

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
  await ensureProjectStateInSync();
}

/**
 * Reconcile every project row against the on-disk filesystem at boot:
 * detect kind from the presence of `.git`, fix orphaned worktrees on
 * `git → plain` flips, and sync the default branch from `origin/HEAD`.
 *
 * This used to live inside the `projects.list` query (so the first
 * dashboard request triggered the reconcile), but writing to the DB
 * from a tRPC query is a contract violation. The branch-status poller
 * runs the same code on every tick, but the poller only starts when an
 * SSE client connects (`watcher.subscribe`) — so a server boot with no
 * dashboard attached would never persist kind self-heal corrections.
 * Running it once at boot closes that gap without requiring a client.
 */
async function ensureProjectStateInSync(): Promise<void> {
  try {
    await syncWorktrees();
  } catch (err) {
    log.warn(
      "Failed to sync project state at boot: %s",
      err instanceof Error ? err.message : String(err),
    );
  }
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
 * Sync the bundled CLI skills into the shared `~/.agents/skills/` root and
 * link each detected agent's skills directory back to it.
 *
 * `installSkills` is idempotent: it only writes a shared SKILL.md when the
 * destination is missing or has different content, and only creates a
 * per-agent symlink when one isn't already in place. After an
 * electron-updater install, the app relaunches → bootstrap → web server
 * boot → `runFirstTimeSetup`, so this same step also handles the
 * post-update refresh — no separate update hook is needed. Failures are
 * logged but don't block boot, matching the rest of the setup pipeline.
 */
async function ensureSkillsInstalled(): Promise<void> {
  try {
    // `installSkills` detects supported agents by checking each agent's
    // parent config dir on the filesystem — no settings lookup needed
    // here. Keeping the trampoline so the boot pipeline stays uniform
    // with the other `ensureXxx` steps.
    const result = await installSkills({ log });
    const wrote = result.written.length + result.updated.length;
    const linkChange = result.linked.length;
    if (wrote > 0 || linkChange > 0 || result.conflicts.length > 0) {
      log.info(
        "Synced CLI skills (shared: %d written, %d updated, %d unchanged; symlinks: %d created, %d already-linked, %d conflicts, %d skipped)",
        result.written.length,
        result.updated.length,
        result.unchanged.length,
        result.linked.length,
        result.alreadyLinked.length,
        result.conflicts.length,
        result.skipped.length,
      );
    }
  } catch (err) {
    log.warn("Failed to sync CLI skills: %s", err instanceof Error ? err.message : String(err));
  }
}
