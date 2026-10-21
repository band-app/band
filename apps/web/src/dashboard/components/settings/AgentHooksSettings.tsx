import { Button } from "@band-app/ui";
import { useState } from "react";
import { trpc } from "../../../lib/trpc-client";
import { type HookState, hookStateOf, useHostHooks } from "../../hooks/use-hooks-setup";
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

  const run = async (hostId: string, action: "install" | "remove") => {
    setBusy(hostId);
    setError(null);
    try {
      await trpc.hooks[action].mutate({ hostId });
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
      label="Claude Code hooks"
      description="Hooks report what Claude Code does in a terminal (working, waiting for an answer, done), so the sidebar and notifications can show it. Chats in Band need no hooks. Remove deletes only Band's entries."
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
          const working = busy === host.hostId;
          return (
            <li
              key={host.hostId}
              data-testid="settings__hooks-host"
              data-host-id={host.hostId}
              data-state={state}
              className="flex items-center justify-between gap-2 px-3 py-2 text-sm"
            >
              <div className="min-w-0">
                <div className="truncate font-medium">{host.name}</div>
                <div className="text-xs text-muted-foreground" data-testid="settings__hooks-state">
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
            </li>
          );
        })}
      </ul>
    </SettingsRow>
  );
}
