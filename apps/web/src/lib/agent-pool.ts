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

// Use globalThis to ensure a single shared state across multiple bundles
const POOL_KEY = Symbol.for("band.agent-pool");
const g = globalThis as unknown as Record<symbol, unknown>;
if (!g[POOL_KEY]) g[POOL_KEY] = new Map<string, CodingAgent>();
const pool = g[POOL_KEY] as Map<string, CodingAgent>;

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

export function getAgent(workspaceId: string): CodingAgent | undefined {
  return pool.get(workspaceId);
}

export function removeAgent(workspaceId: string): boolean {
  log.info({ workspaceId }, "removing agent from pool");
  return pool.delete(workspaceId);
}

export async function getOrCreateAgent(
  workspaceId: string,
  worktreePath: string,
  agentId?: string,
): Promise<CodingAgent> {
  const existing = pool.get(workspaceId);
  if (existing) return existing;

  const config = getAgentConfig(worktreePath, agentId);
  log.info({ workspaceId, type: config.type, cwd: worktreePath }, "creating agent");
  const agent = await createCodingAgent(config);
  pool.set(workspaceId, agent);
  return agent;
}

/**
 * Replace the current agent for a workspace with one using a different config.
 * Aborts the existing agent (if any) before creating the new one.
 */
/**
 * Create a short-lived agent for metadata queries (listModes, listModels).
 * Does NOT add it to the pool — caller should discard after use.
 */
export async function createMetadataAgent(agentId?: string): Promise<CodingAgent> {
  const config = getAgentConfig(bandHome(), agentId);
  return createCodingAgent(config);
}

export async function replaceAgent(
  workspaceId: string,
  worktreePath: string,
  agentId: string,
): Promise<CodingAgent> {
  const existing = pool.get(workspaceId);
  if (existing?.abort) {
    existing.abort();
  }
  pool.delete(workspaceId);
  return getOrCreateAgent(workspaceId, worktreePath, agentId);
}
