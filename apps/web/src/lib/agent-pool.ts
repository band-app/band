import { type CodingAgent, type CodingAgentConfig, createCodingAgent } from "@band/coding-agent";
import { createLogger } from "@band/logger";
import { loadSettings } from "./state";

const log = createLogger("agent-pool");

const pool = new Map<string, CodingAgent>();

function getAgentConfig(worktreePath: string): CodingAgentConfig {
  const settings = loadSettings();
  const agentType = settings.codingAgent?.type ?? "claude-code";

  return {
    type: agentType,
    workspaceDir: worktreePath,
    maxTurns: 50,
    options: {
      executablePath: settings.codingAgent?.command,
    },
  } as CodingAgentConfig;
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
