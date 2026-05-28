import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type CodingAgent,
  type CodingAgentConfig,
  createCodingAgent,
} from "@band-app/coding-agent";
import { createLogger } from "@band-app/logger";
import { bandHome, getAgentDefinition, loadSettings } from "../../../lib/state";

const log = createLogger("agent-pool");

/**
 * Coding-agent process pool (Phase 6 of the 3-tier refactor — issue #317).
 *
 * Moved from `lib/agent-pool.ts` to the infra tier because the pool wraps
 * external processes (the agent CLIs) — same category as `terminal-pool`
 * and the future `lsp-client` / `tunnel-client`. The service tier
 * (`TaskService` and `SessionService`) consumes this module via
 * the function exports below.
 *
 * Kept as plain functions (rather than a class) because the pool's
 * `globalThis`-keyed singleton state survives module re-evaluation and
 * concurrent callers, and exposing the singleton through a class would
 * leak the symbol-keyed state into the type signature without buying any
 * additional encapsulation. Other infra modules with the same shape (e.g.
 * `task-prune-scheduler` in `db/queries/tasks.ts`) follow the same
 * convention.
 */

/** Pool entry: agent instance + the definition ID it was created with. */
interface PoolEntry {
  agent: CodingAgent;
  agentDefId: string;
}

/** In-flight creation entry — concurrent callers join the same promise. */
interface PendingEntry {
  promise: Promise<CodingAgent>;
  agentDefId: string;
}

// Use globalThis to ensure a single shared state across multiple bundles
const POOL_KEY = Symbol.for("band.agent-pool.v2");
const PENDING_KEY = Symbol.for("band.agent-pool.pending");
const g = globalThis as unknown as Record<symbol, unknown>;
if (!g[POOL_KEY]) g[POOL_KEY] = new Map<string, PoolEntry>();
if (!g[PENDING_KEY]) g[PENDING_KEY] = new Map<string, PendingEntry>();
const pool = g[POOL_KEY] as Map<string, PoolEntry>;
const pending = g[PENDING_KEY] as Map<string, PendingEntry>;

/**
 * Read the 'model' field from ~/.claude/settings.json as a fallback
 * for claude-code agents that don't have a model set in Band settings.
 */
function loadClaudeSettingsModel(): string | undefined {
  try {
    const data = readFileSync(join(homedir(), ".claude", "settings.json"), "utf-8");
    const parsed = JSON.parse(data) as Record<string, unknown>;
    return typeof parsed.model === "string" ? parsed.model : undefined;
  } catch {
    return undefined;
  }
}

function getAgentConfig(worktreePath: string, agentId?: string): CodingAgentConfig {
  const settings = loadSettings();
  const agentDef = getAgentDefinition(settings, agentId);

  // Resolve model: prefer Band agent definition, fall back to ~/.claude/settings.json for claude-code
  let model = agentDef.model;
  if (!model && agentDef.type === "claude-code") {
    model = loadClaudeSettingsModel();
  }

  // Claude-Code-specific settings flow through `options`. Other adapters
  // strip unknown keys via Zod, so leaking these here is harmless if the
  // type isn't claude-code, but we keep the conditional for clarity.
  const claudeOnly =
    agentDef.type === "claude-code"
      ? { partialMessages: settings.claudeCodePartialMessages === true }
      : {};

  return {
    type: agentDef.type,
    workspaceDir: worktreePath,
    maxTurns: 100,
    additionalDirectories: [join(bandHome(), "uploads"), join(bandHome(), "shared")],
    options: {
      executablePath: agentDef.command,
      model,
      ...claudeOnly,
    },
  } as CodingAgentConfig;
}

/** Resolve the canonical agent definition ID (resolves undefined → default). */
function resolveAgentDefId(agentId?: string): string {
  const settings = loadSettings();
  return getAgentDefinition(settings, agentId).id;
}

/**
 * Get an existing agent by chatId.
 */
export function getAgent(chatId: string): CodingAgent | undefined {
  return pool.get(chatId)?.agent;
}

/**
 * Remove an agent from the pool by chatId.
 */
export function removeAgent(chatId: string): boolean {
  log.info({ chatId }, "removing agent from pool");
  return pool.delete(chatId);
}

/**
 * Get or create an agent for a chat pane.
 * The pool is keyed by chatId (one agent per chat pane).
 * If the cached agent was created with a different agentId, it is
 * replaced so that a chatId reused for a different agent type gets
 * the correct process.
 *
 * Concurrent callers with the same chatId share a single in-flight
 * createCodingAgent() promise so we don't pay the dynamic-import cost
 * twice when sessions.list and sessions.messages race on workspace
 * switch.
 */
export async function getOrCreateAgent(
  chatId: string,
  worktreePath: string,
  agentId?: string,
): Promise<CodingAgent> {
  const existing = pool.get(chatId);
  if (existing) {
    // Validate the cached agent matches the requested definition.
    const requestedDefId = resolveAgentDefId(agentId);
    if (existing.agentDefId !== requestedDefId) {
      log.info(
        { chatId, cached: existing.agentDefId, requested: requestedDefId },
        "cached agent definition mismatch, replacing",
      );
      return replaceAgent(chatId, worktreePath, agentId ?? requestedDefId);
    }
    return existing.agent;
  }

  const defId = resolveAgentDefId(agentId);

  // Join an in-flight creation if one matches the requested definition.
  const inFlight = pending.get(chatId);
  if (inFlight && inFlight.agentDefId === defId) {
    return inFlight.promise;
  }

  const config = getAgentConfig(worktreePath, agentId);
  log.info({ chatId, type: config.type, defId, cwd: worktreePath }, "creating agent");

  const promise: Promise<CodingAgent> = createCodingAgent(config).then(
    (agent) => {
      pool.set(chatId, { agent, agentDefId: defId });
      // Only clear the pending entry if it's still ours — if another
      // request swapped in a different definition, leave that one alone.
      const current = pending.get(chatId);
      if (current?.promise === promise) pending.delete(chatId);
      return agent;
    },
    (err) => {
      const current = pending.get(chatId);
      if (current?.promise === promise) pending.delete(chatId);
      throw err;
    },
  );
  pending.set(chatId, { promise, agentDefId: defId });
  return promise;
}

/**
 * Create a short-lived agent for metadata queries (listModes, listModels).
 * Does NOT add it to the pool — caller should discard after use.
 */
export async function createMetadataAgent(agentId?: string): Promise<CodingAgent> {
  const config = getAgentConfig(bandHome(), agentId);
  return createCodingAgent(config);
}

/**
 * Create a short-lived agent rooted at a workspace's worktree, for one-shot
 * tool-using tasks (e.g. summarising pending changes into a commit message).
 *
 * Unlike `createMetadataAgent`, this gives the agent a real codebase to
 * explore — it can run `git diff` / `git log` / `Read` files itself rather
 * than receiving a serialised diff in the prompt. Does NOT join the chat
 * pool; the caller should discard the agent after a single `runSession`.
 */
export async function createWorkspaceAgent(
  worktreePath: string,
  agentId?: string,
): Promise<CodingAgent> {
  const config = getAgentConfig(worktreePath, agentId);
  return createCodingAgent(config);
}

/**
 * Replace the current agent for a chat pane with one using a different config.
 * Aborts the existing agent (if any) before creating the new one.
 */
export async function replaceAgent(
  chatId: string,
  worktreePath: string,
  agentId: string,
): Promise<CodingAgent> {
  const existing = pool.get(chatId);
  if (existing?.agent.abort) {
    existing.agent.abort();
  }
  pool.delete(chatId);
  return getOrCreateAgent(chatId, worktreePath, agentId);
}
