import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type CodingAgent,
  type CodingAgentConfig,
  createCodingAgent,
} from "@band-app/coding-agent";
import { createLogger } from "@band-app/logger";
import { bandHome, getAgentDefinition, loadSettings } from "./state";

const log = createLogger("agent-pool");

/** Pool entry: agent instance + the definition ID it was created with. */
interface PoolEntry {
  agent: CodingAgent;
  agentDefId: string;
}

// Use globalThis to ensure a single shared state across multiple bundles
const POOL_KEY = Symbol.for("band.agent-pool.v2");
const g = globalThis as unknown as Record<symbol, unknown>;
if (!g[POOL_KEY]) g[POOL_KEY] = new Map<string, PoolEntry>();
const pool = g[POOL_KEY] as Map<string, PoolEntry>;

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

  return {
    type: agentDef.type,
    workspaceDir: worktreePath,
    maxTurns: 100,
    additionalDirectories: [join(bandHome(), "uploads"), join(bandHome(), "shared")],
    options: {
      executablePath: agentDef.command,
      model,
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
  const config = getAgentConfig(worktreePath, agentId);
  log.info({ chatId, type: config.type, defId, cwd: worktreePath }, "creating agent");
  const agent = await createCodingAgent(config);
  pool.set(chatId, { agent, agentDefId: defId });
  return agent;
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
