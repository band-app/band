import { HOOK_AGENT_TYPES, type HookAgentType, type HooksStatus } from "@band-app/host-api";
import { hostRegistry } from "../infra/host/registry";
import { tokenService } from "./token-service";

const LOCAL_HOST_ID = "local";

/** One host's Claude Code hooks, for Settings > Agent hooks and the install banner. */
export interface HostHooksView {
  hostId: string;
  name: string;
  online: boolean;
  /** Whether Claude Code can start on the host. */
  hasClaudeCode: boolean;
  /** Claude Code's hooks. Null when the host is offline or could not be read; `error` says why. */
  status: HooksStatus | null;
  error?: string;
  /** The hooks of Codex, Gemini CLI and OpenCode on the host, for the agents it can start. */
  agents: HostAgentHooks[];
}

/** One non-Claude agent's hooks on one host. */
export interface HostAgentHooks {
  agent: HookAgentType;
  status: HooksStatus | null;
  error?: string;
}

const OTHER_AGENTS = HOOK_AGENT_TYPES.filter((a) => a !== "claude-code");

/**
 * Band's hooks live in each host's own `~/.claude/settings.json`, so every
 * call here goes to a host (`host.agentEnv`). Nothing installs on its own: a
 * person asks for it per host.
 */
function hostOf(hostId: string) {
  return hostRegistry.hostById(hostId);
}

export function checkHooks(hostId: string = LOCAL_HOST_ID, agent?: HookAgentType) {
  return hostOf(hostId).agentEnv.hooksStatus(agent);
}

export function installHooks(hostId: string = LOCAL_HOST_ID, agent?: HookAgentType): Promise<void> {
  return hostOf(hostId).agentEnv.installHooks(agent);
}

export function removeHooks(hostId: string = LOCAL_HOST_ID, agent?: HookAgentType): Promise<void> {
  return hostOf(hostId).agentEnv.removeHooks(agent);
}

/**
 * The hub's own capability report. `info()` never waits for the first probe,
 * so right after boot there is none; ask again for up to 15 seconds so a
 * dashboard that loads then still lists the installed agents.
 */
async function localReport(host: ReturnType<typeof hostOf>) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const report = (await host.info()).report;
    if (report) return report;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return undefined;
}

async function agentOn(hostId: string, agents: string[], type: HookAgentType): Promise<boolean> {
  if (hostId !== LOCAL_HOST_ID) return agents.includes(type);
  const host = hostOf(hostId);
  if (type === "claude-code") {
    try {
      return typeof (await host.acp.resolveLaunch({ type })) !== "string";
    } catch {
      return false;
    }
  }
  try {
    // The hub's own machine reports which CLIs are installed. Launching an
    // agent resolves for every type, so it says nothing about the CLI.
    const report = await localReport(host);
    return report?.agents.find((a) => a.type === type)?.installed === true;
  } catch {
    return false;
  }
}

/** The hooks of every usable host. An offline host has no status. */
export async function listHostHooks(): Promise<HostHooksView[]> {
  const hosts = tokenService.listHosts().filter((h) => h.id !== LOCAL_HOST_ID || h.usable);
  return Promise.all(
    hosts.map(async (h): Promise<HostHooksView> => {
      const online = h.id === LOCAL_HOST_ID || h.status === "online";
      const view: HostHooksView = {
        hostId: h.id,
        name: h.name,
        online,
        hasClaudeCode: await agentOn(h.id, h.agents, "claude-code"),
        status: null,
        agents: [],
      };
      if (!online) return view;
      try {
        view.status = await checkHooks(h.id);
      } catch (err) {
        view.error = err instanceof Error ? err.message : String(err);
      }
      const others = await Promise.all(
        OTHER_AGENTS.map(async (agent): Promise<HostAgentHooks | null> => {
          if (!(await agentOn(h.id, h.agents, agent))) return null;
          try {
            return { agent, status: await checkHooks(h.id, agent) };
          } catch (err) {
            return {
              agent,
              status: null,
              error: err instanceof Error ? err.message : String(err),
            };
          }
        }),
      );
      view.agents = others.filter((a): a is HostAgentHooks => a !== null);
      return view;
    }),
  );
}
