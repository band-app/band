import { createLogger } from "@band-app/logger";
import { checkCli, installCli } from "./cli-service";
import { installSkills } from "./cli-skills-service";
import { checkHooks, installHooks } from "./hooks-service";
import { modelRefreshService } from "./model-refresh-service";
import { type CodingAgentDefinition, loadSettings, saveSettings } from "./state";
import { syncService } from "./sync-service";
import { systemService } from "./system-service";

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
 * Execution graph (warm boot — see issue #472 cold-start work):
 *
 *   ensureProjectStateInSync ─────────────────────────────────┐
 *                                                             │
 *   ensureCliInstalled ──┬─► ensureSettingsDefaults  ──────── ─┤
 *                        ├─► ensureClaudeHooks      ──────── ─┤
 *                        └─► ensureSkillsInstalled  ──────── ─┘
 *                                                             │
 *                                                            await
 *
 * Two parallelism dimensions:
 *
 *   1. The CLI install gates `ensureClaudeHooks` and `ensureSkillsInstalled`
 *      because both need `band` resolvable on PATH (the hooks register a
 *      `band notify …` command; the skills install spawns
 *      `band generate-skills`). `ensureSettingsDefaults` doesn't strictly
 *      need the CLI, but it's grouped here for code clarity and the cost
 *      is negligible on warm boots.
 *   2. `ensureProjectStateInSync` (DB + `git worktree list`) doesn't touch
 *      the band CLI at all — kick it off *before* the CLI gate so its
 *      ~100 ms of git fork/exec overlaps with the CLI stat AND the
 *      downstream group, instead of sitting in series after them. On the
 *      author's 28-project host this is the longest single step in the
 *      pipeline, so getting it off the critical path is the biggest win.
 *
 * Settings.json RMW must stay internally sequential (one reader → mutate →
 * writer can't be interleaved with another), so `ensureSettingsDefaults`
 * wraps that pair.
 *
 * `Promise.allSettled` (not `Promise.all`) so one failing step never
 * poisons the others — every `ensureXxx` already has its own try/catch
 * and logs warns, but defense-in-depth is cheap here. The
 * `projectSync` promise is created before the CLI await; if
 * `ensureCliInstalled` were to throw synchronously (it doesn't — internal
 * try/catch), the project sync promise would still be in flight without
 * a handler attached. That's fine because `ensureProjectStateInSync`
 * itself has a try/catch and never rejects, so no unhandled-rejection
 * risk exists today. If you ever drop that try/catch, attach a
 * `.catch()` here to preserve the invariant.
 */
export async function runFirstTimeSetup(): Promise<void> {
  // Kick this off immediately — independent of CLI install and settings.
  const projectSync = ensureProjectStateInSync();

  await ensureCliInstalled();

  const results = await Promise.allSettled([
    projectSync,
    ensureSettingsDefaults(),
    ensureClaudeHooks(),
    ensureSkillsInstalled(),
  ]);

  // Surface any unexpected rejections — every `ensureXxx` is supposed to
  // catch its own errors and log warns. If something escaped, log it here
  // rather than swallowing it silently.
  for (const r of results) {
    if (r.status === "rejected") {
      log.warn(
        "Setup step failed: %s",
        r.reason instanceof Error ? r.reason.message : String(r.reason),
      );
    }
  }

  // Kick off a background refresh of each configured coding agent's model
  // list. MUST run after `ensureSettingsDefaults` (which is the step that
  // detects + persists the `codingAgents` array on a fresh install) so
  // the refresh actually has agents to iterate over. Fire-and-forget —
  // the SDK calls can take several seconds (network round-trip + binary
  // spawn) and we don't want to delay the server starting to accept
  // requests. Failures inside `refreshAll` are already swallowed by the
  // service; the outer `.catch` here only fires if something explodes
  // before reaching the try/catch (e.g. dynamic import failure).
  void refreshAgentModelsInBackground();
}

/**
 * Fire-and-forget background refresh of every configured coding agent's
 * model list at boot. The result is persisted into `settings.codingAgents[].cachedModels`
 * by `ModelRefreshService.refreshAll()` so the Settings UI and the chat
 * picker have the live list available without anyone having to start a
 * session first. Errors are intentionally swallowed at the top level —
 * the refresh service already logs per-agent failures at warn level.
 */
async function refreshAgentModelsInBackground(): Promise<void> {
  try {
    const results = await modelRefreshService.refreshAll();
    const ok = results.filter((r) => !r.error).length;
    const failed = results.length - ok;
    if (results.length > 0) {
      log.info(
        "Background model refresh: %d/%d agents updated (%d failed)",
        ok,
        results.length,
        failed,
      );
    }
  } catch (err) {
    log.warn(
      "Background model refresh failed: %s",
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Settings.json read-modify-write group. `ensureDefaultCodingAgents` and
 * `ensureNotificationDefaults` both call `loadSettings()` → mutate →
 * `saveSettings()` against the same `~/.band/settings.json` file. Running
 * them concurrently would race: one's load happens before the other's
 * save, so the later write clobbers the earlier mutation. Keep them
 * sequential here; the rest of `runFirstTimeSetup` parallelises around
 * this whole group.
 */
async function ensureSettingsDefaults(): Promise<void> {
  await ensureDefaultCodingAgents();
  ensureNotificationDefaults();
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
 *
 * `syncWorktrees` runs `git worktree list --porcelain` per project,
 * which can take a non-trivial amount of time on users with many
 * projects on slow/network-mounted drives. We `await` it anyway
 * because:
 *   1. Most users have <10 projects and the call completes in <100 ms.
 *   2. The dashboard's first `projects.list` fetch (which happens
 *      immediately on connect) needs the in-memory state to be
 *      reconciled. If we let the server start listening before the
 *      sync finishes, the first response would show stale data and
 *      the user would see a 30 s delay (next react-query refetch)
 *      before things looked right.
 *   3. The CLI tests' fixture rely on the seeded state being
 *      reconciled before `band notify` lands.
 *
 * If this ever becomes a startup bottleneck, the better fix is to make
 * the sync parallel-per-project rather than sequential — not to drop
 * the await.
 */
async function ensureProjectStateInSync(): Promise<void> {
  try {
    await syncService.syncWorktrees();
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
    const path = await systemService.whichBinary(check.binary);
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

/**
 * Class wrapper around the module-level `runFirstTimeSetup` orchestrator
 * (issue #535 follow-up — class-with-DI shape per the architecture doc).
 * The class delegates to the existing function so the existing wire-up
 * (called from `start-server.ts` and several tests) is preserved.
 */
export class SetupService {
  async run(): Promise<void> {
    return runFirstTimeSetup();
  }
}

export const setupService = new SetupService();
