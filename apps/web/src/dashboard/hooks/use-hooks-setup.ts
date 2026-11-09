import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState, useSyncExternalStore } from "react";
import { clientStorage } from "../../lib/client-state";
import { trpc } from "../../lib/trpc-client";
import type { HookAgentType, HostHooks } from "../types";

export const AGENT_HOOKS_KEY = ["hooks.hosts"] as const;
const DISMISSED_KEY = "band:agent-hooks-banner-dismissed";

export const HOOK_AGENT_LABEL: Record<HookAgentType, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  "gemini-cli": "Gemini CLI",
  opencode: "OpenCode",
};

/** One agent's hooks on one host that are not the current set. */
export interface MissingHooks {
  host: HostHooks;
  agent: HookAgentType;
  version: number;
}

/** The agents on a host whose hooks are not the current set. */
export function missingHooksOf(host: HostHooks): MissingHooks[] {
  if (!host.online) return [];
  const missing: MissingHooks[] = [];
  if (host.hasClaudeCode && host.status !== null && !host.status.installed) {
    missing.push({ host, agent: "claude-code", version: host.status.version });
  }
  for (const a of host.agents ?? []) {
    if (a.status !== null && !a.status.installed) {
      missing.push({ host, agent: a.agent, version: a.status.version });
    }
  }
  return missing;
}

/** What a host's hooks are, for Settings and the banner. */
export type HookState = "installed" | "outdated" | "not_installed" | "offline";

export function hookStateOf(host: { online: boolean; status: HostHooks["status"] }): HookState {
  if (!host.online || !host.status) return "offline";
  if (host.status.installed) return "installed";
  return host.status.outdated ? "outdated" : "not_installed";
}

/** The hosts and their hooks. The call needs an admin token; for any other the list stays empty. */
export function useHostHooks() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: AGENT_HOOKS_KEY,
    queryFn: async () => (await trpc.hooks.hosts.query()).hosts as HostHooks[],
    retry: false,
  });
  const refresh = useCallback(
    () => queryClient.invalidateQueries({ queryKey: AGENT_HOOKS_KEY }),
    [queryClient],
  );
  return { hosts: query.data ?? [], isLoading: query.isLoading, isError: query.isError, refresh };
}

const dismissListeners = new Set<() => void>();

function readDismissed(): number {
  const raw = clientStorage.getItem(DISMISSED_KEY);
  const value = raw === null ? 0 : Number(raw);
  return Number.isFinite(value) ? value : 0;
}

/**
 * State of the install banner. Nothing installs by itself: the banner shows
 * while a host with Claude Code lacks the current hooks, until the user
 * dismisses it. The dismissal names the hook version, so a newer set shows
 * the banner once more. The value syncs across devices (`client_state`).
 */
export function useHooksSetup() {
  const { hosts, refresh } = useHostHooks();
  const dismissedVersion = useSyncExternalStore(
    (listener) => {
      dismissListeners.add(listener);
      return () => dismissListeners.delete(listener);
    },
    readDismissed,
    () => 0,
  );
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);

  const missing = hosts.flatMap(missingHooksOf);
  const version = Math.max(0, ...missing.map((m) => m.version));
  const visible = missing.length > 0 && dismissedVersion < version;
  const agentNames = [...new Set(missing.map((m) => HOOK_AGENT_LABEL[m.agent]))];

  const install = async () => {
    setInstalling(true);
    setError(null);
    try {
      for (const m of missing) {
        await trpc.hooks.install.mutate({ hostId: m.host.hostId, agent: m.agent });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setInstalling(false);
      await refresh();
    }
  };

  const dismiss = () => {
    clientStorage.setItem(DISMISSED_KEY, String(version));
    for (const listener of dismissListeners) listener();
  };

  return { visible, agentNames, installing, error, install, dismiss };
}
