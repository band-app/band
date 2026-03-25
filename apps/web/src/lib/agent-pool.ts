import { join } from "node:path";
import {
  type CodingAgent,
  type CodingAgentConfig,
  createCodingAgent,
} from "@band-app/coding-agent";
import { createLogger } from "@band-app/logger";
import { bandHome, loadSettings } from "./state";

const log = createLogger("agent-pool");

// Use globalThis to ensure a single shared state across multiple bundles
const POOL_KEY = Symbol.for("band.agent-pool");
const g = globalThis as unknown as Record<symbol, unknown>;
if (!g[POOL_KEY]) g[POOL_KEY] = new Map<string, CodingAgent>();
const pool = g[POOL_KEY] as Map<string, CodingAgent>;

function getAgentConfig(worktreePath: string): CodingAgentConfig {
  const settings = loadSettings();
  const agentType = settings.codingAgent?.type ?? "claude-code";

  return {
    type: agentType,
    workspaceDir: worktreePath,
    maxTurns: 50,
    additionalDirectories: [join(bandHome(), "uploads")],
    options: {
      executablePath: settings.codingAgent?.command,
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
): Promise<CodingAgent> {
  const existing = pool.get(workspaceId);
  if (existing) return existing;

  const config = getAgentConfig(worktreePath);
  log.info({ workspaceId, type: config.type, cwd: worktreePath }, "creating agent");
  const agent = await createCodingAgent(config);
  pool.set(workspaceId, agent);
  return agent;
}
