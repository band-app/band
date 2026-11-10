import { Button, Input } from "@band-app/ui";
import { useState } from "react";
import { UpdateControls } from "./settings/UpdateControls";
import { useHubUpdate } from "./useHubUpdate";

/**
 * Admin controls for updating the hub from the update panel: the command field, the Update hub
 * button, the state while the hub restarts, and the failure with the log tail. Without a command
 * only the field shows, and the panel keeps the manual command. Settings > Hub has its own
 * `HubUpdateCard`.
 */
export function HubUpdateControls() {
  const hub = useHubUpdate();
  const { status, hubUpdate, updating, busy, error, savedUpdate } = hub;
  const saved = savedUpdate?.command;
  const [draft, setDraft] = useState<string | null>(null);
  const lastRun = hubUpdate?.lastRun;

  return (
    <div className="mt-3 space-y-2" data-testid="hub-update-section">
      <UpdateControls
        testId="hub-update"
        name="the hub"
        showHeader={false}
        auto={savedUpdate?.auto === true}
        onAutoChange={(on) => void hub.setAuto(on)}
        autoLabel="Update automatically when no agent turn runs"
        autoDisabledReason={null}
        busy={busy || hubUpdate?.builtIn === false}
        updateAction={
          hubUpdate?.configured && status.data?.updateAvailable ? (
            <>
              <Button
                type="button"
                size="sm"
                data-testid="hub-update__button"
                disabled={busy || updating}
                onClick={() => void hub.startUpdate()}
              >
                {updating ? "Updating the hub…" : "Update hub"}
              </Button>
              {updating ? (
                <span className="text-xs text-muted-foreground" data-testid="hub-update__state">
                  Updating to {hubUpdate.target}. This page reconnects when the hub is back.
                </span>
              ) : null}
            </>
          ) : null
        }
      />
      {hub.dialog}
      {hubUpdate?.state === "failed" ? (
        <div className="flex items-start justify-between gap-2 text-xs text-destructive">
          <pre
            role="alert"
            data-testid="hub-update__error"
            className="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono"
          >
            {hubUpdate.error}
          </pre>
          <Button type="button" variant="ghost" size="sm" onClick={() => void hub.dismiss()}>
            Dismiss
          </Button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" data-testid="hub-update__action-error" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {hubUpdate?.builtIn === false && hubUpdate.builtInBlockedReason ? (
        <p className="text-xs text-muted-foreground" data-testid="hub-update__blocked">
          The built-in updater is off: {hubUpdate.builtInBlockedReason}.
        </p>
      ) : null}
      {hubUpdate?.deferredSince ? (
        <p className="text-xs text-muted-foreground" data-testid="hub-update__deferred">
          Waiting for running agent turns since {new Date(hubUpdate.deferredSince).toLocaleString()}
          .
        </p>
      ) : null}
      {lastRun ? (
        <div className="space-y-1 text-xs" data-testid="hub-update__last-run">
          <div data-testid="hub-update__last-result">
            Last run: {lastRun.from} to {lastRun.to}, {lastRun.result} ({lastRun.message})
          </div>
          {lastRun.backup ? (
            <div
              className="break-all font-mono text-muted-foreground"
              data-testid="hub-update__backup"
            >
              {lastRun.backup}
            </div>
          ) : null}
        </div>
      ) : null}
      {hubUpdate?.logTail ? (
        <pre
          data-testid="hub-update__log"
          className="max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-muted-foreground"
        >
          {hubUpdate.logTail}
        </pre>
      ) : null}
      <div className="flex items-center gap-2">
        <Input
          aria-label="Hub update command"
          data-testid="hub-update__command"
          placeholder="systemctl --user start --no-block band-hub-update.service"
          value={draft ?? saved ?? ""}
          onChange={(e) => setDraft(e.target.value)}
          className="h-8 font-mono text-xs"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="hub-update__save"
          disabled={busy || draft === null || draft === (saved ?? "")}
          onClick={() => void hub.saveCommand(draft ?? "").then(() => setDraft(null))}
        >
          Save
        </Button>
      </div>
    </div>
  );
}
