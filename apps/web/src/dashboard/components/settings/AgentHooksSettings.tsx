import { Button } from "@band-app/ui";
import { useState } from "react";
import { trpc } from "../../../lib/trpc-client";
import {
  HOOK_AGENT_LABEL,
  type HookState,
  hookStateOf,
  useHostHooks,
} from "../../hooks/use-hooks-setup";
import type { HookAgentType, HostAgentHooks } from "../../types";
import { SettingsRow } from "./SettingsRow";

const STATE_LABEL: Record<HookState, string> = {
  installed: "Installed",
  outdated: "Outdated",
  not_installed: "Not installed",
  offline: "Worker offline",
};

/**
 * Rows for the Settings dialog's Agent hooks section: per host, whether the
 * Claude Code hooks that report an agent's state are in that machine's
 * `~/.claude/settings.json`. Install and Remove change that file on the host
 * and touch Band's entries only. Nothing installs unless the user clicks.
 */
export function AgentHooksSettings() {
  const { hosts, isError, refresh } = useHostHooks();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (hostId: string, action: "install" | "remove", agent?: HookAgentType) => {
    setBusy(`${hostId}:${agent ?? "claude-code"}`);
    setError(null);
    try {
      await trpc.hooks[action].mutate({ hostId, agent });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
      await refresh();
    }
  };

  return (
    <SettingsRow
      variant="stacked"
      label="Agent hooks"
      description="Hooks report what Claude Code, Codex, Gemini CLI and OpenCode do in a terminal (working, waiting for an answer, done), so the sidebar and notifications can show it. Chats in Band need no hooks. Remove deletes only Band's entries."
    >
      {isError ? (
        <p
          role="alert"
          className="text-xs text-muted-foreground"
          data-testid="settings__hooks-denied"
        >
          Managing hooks needs an admin token.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive" data-testid="settings__hooks-error">
          {error}
        </p>
      ) : null}
      <ul className="divide-y divide-border rounded-md border border-border">
        {hosts.map((host) => {
          const state = hookStateOf(host);
          const working = busy === `${host.hostId}:claude-code`;
          return (
            <li
              key={host.hostId}
              data-testid="settings__hooks-host"
              data-host-id={host.hostId}
              data-state={state}
              className="text-sm"
            >
              <div className="flex items-center justify-between gap-2 px-3 py-2">
                <div className="min-w-0">
                  <div className="truncate font-medium">{host.name} · Claude Code</div>
                  <div
                    className="text-xs text-muted-foreground"
                    data-testid="settings__hooks-state"
                  >
                    {STATE_LABEL[state]}
                    {host.online && !host.hasClaudeCode ? " · Claude Code not found" : ""}
                    {host.error ? ` · ${host.error}` : ""}
                  </div>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!host.online || working}
                    data-testid="settings__hooks-install"
                    onClick={() => run(host.hostId, "install")}
                  >
                    {state === "installed" || state === "outdated" ? "Reinstall" : "Install"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!host.online || working || state === "not_installed"}
                    data-testid="settings__hooks-remove"
                    onClick={() => run(host.hostId, "remove")}
                  >
                    Remove
                  </Button>
                </div>
              </div>
              {(host.agents ?? []).map((a) => (
                <AgentHooksRow
                  key={a.agent}
                  hostId={host.hostId}
                  online={host.online}
                  entry={a}
                  busy={busy === `${host.hostId}:${a.agent}`}
                  onRun={(action) => run(host.hostId, action, a.agent)}
                />
              ))}
            </li>
          );
        })}
      </ul>
    </SettingsRow>
  );
}

function AgentHooksRow({
  hostId,
  online,
  entry,
  busy,
  onRun,
}: {
  hostId: string;
  online: boolean;
  entry: HostAgentHooks;
  busy: boolean;
  onRun: (action: "install" | "remove") => void;
}) {
  const state = hookStateOf({ online, status: entry.status });
  return (
    <div
      data-testid="settings__hooks-agent"
      data-host-id={hostId}
      data-agent={entry.agent}
      data-state={state}
      className="flex items-center justify-between gap-2 border-t border-border px-3 py-2"
    >
      <div className="min-w-0">
        <div className="truncate">{HOOK_AGENT_LABEL[entry.agent]}</div>
        <div className="text-xs text-muted-foreground" data-testid="settings__hooks-agent-state">
          {entry.error ? "Could not check" : STATE_LABEL[state]}
          {entry.error ? ` · ${entry.error}` : ""}
        </div>
      </div>
      <div className="flex shrink-0 gap-1">
        <Button
          size="sm"
          variant="outline"
          disabled={!online || busy}
          data-testid="settings__hooks-agent-install"
          onClick={() => onRun("install")}
        >
          {state === "installed" || state === "outdated" ? "Reinstall" : "Install"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!online || busy || state === "not_installed"}
          data-testid="settings__hooks-agent-remove"
          onClick={() => onRun("remove")}
        >
          Remove
        </Button>
      </div>
    </div>
  );
}
