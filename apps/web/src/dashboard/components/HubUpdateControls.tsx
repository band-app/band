import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
} from "@band-app/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { trpc } from "../../lib/trpc-client";
import { UPDATE_STATUS_KEY, useUpdateStatus } from "../hooks/use-update-status";

/** Polls while a hub update runs, because the hub is gone for a moment when it restarts. */
const POLL_MS = 2000;

/**
 * Admin controls for updating the hub from the panel: the command field, the Update hub button,
 * the state while the hub restarts, and the failure with the log tail. Without a command only the
 * field shows, and the panel keeps the manual command.
 */
export function HubUpdateControls() {
  const queryClient = useQueryClient();
  const status = useUpdateStatus();
  const settings = useQuery({
    queryKey: ["settings.get", "hubUpdate"],
    queryFn: () => trpc.settings.get.query(),
  });
  const saved = (settings.data as { hubUpdate?: { command?: string } } | undefined)?.hubUpdate
    ?.command;
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [turns, setTurns] = useState<{ chatId: string; worktreeId: string }[]>([]);
  const hubUpdate = status.data?.hubUpdate;
  const updating = hubUpdate?.state === "updating";

  useQuery({
    queryKey: ["hub-update-poll"],
    queryFn: async () => {
      await queryClient.invalidateQueries({ queryKey: UPDATE_STATUS_KEY });
      return null;
    },
    enabled: updating,
    refetchInterval: POLL_MS,
  });

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      await queryClient.invalidateQueries({ queryKey: UPDATE_STATUS_KEY });
    }
  };

  const save = () =>
    run(async () => {
      await trpc.settings.update.mutate({ hubUpdate: { command: (draft ?? "").trim() } });
      setDraft(null);
      await queryClient.invalidateQueries({ queryKey: ["settings.get", "hubUpdate"] });
    });

  return (
    <div className="mt-3 space-y-2" data-testid="hub-update">
      {hubUpdate?.configured && status.data?.updateAvailable ? (
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            data-testid="hub-update__button"
            disabled={busy || updating}
            onClick={() =>
              void run(async () => {
                const { agents } = await trpc.workers.hubInterruptions.query();
                const running = agents.filter((a) => a.busy);
                if (running.length === 0) {
                  await trpc.workers.updateHub.mutate();
                  return;
                }
                setTurns(running);
                setConfirmOpen(true);
              })
            }
          >
            {updating ? "Updating the hub…" : "Update hub"}
          </Button>
          {updating ? (
            <span className="text-xs text-muted-foreground" data-testid="hub-update__state">
              Updating to {hubUpdate.target}. This page reconnects when the hub is back.
            </span>
          ) : null}
        </div>
      ) : null}
      <Dialog open={confirmOpen} onOpenChange={(next) => !busy && setConfirmOpen(next)}>
        <DialogContent className="sm:max-w-[460px]" data-testid="hub-update__dialog">
          <DialogHeader>
            <DialogTitle>Update the hub?</DialogTitle>
            <DialogDescription>
              The hub restarts. Every agent it runs stops, and a turn in progress is lost.
            </DialogDescription>
          </DialogHeader>
          <div className="text-sm" data-testid="hub-update__agents">
            <div className="mb-1 font-medium">
              {turns.length === 1 ? "1 running turn" : `${turns.length} running turns`} will end:
            </div>
            <ul className="list-disc pl-5">
              {turns.map((a) => (
                <li key={a.chatId} data-testid="hub-update__agent">
                  {a.worktreeId} (chat {a.chatId})
                </li>
              ))}
            </ul>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              data-testid="hub-update__confirm"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await trpc.workers.updateHub.mutate({ confirmInterruptions: true });
                  setConfirmOpen(false);
                })
              }
            >
              Update and restart
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {hubUpdate?.state === "failed" ? (
        <div className="flex items-start justify-between gap-2 text-xs text-destructive">
          <pre
            role="alert"
            data-testid="hub-update__error"
            className="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono"
          >
            {hubUpdate.error}
          </pre>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void run(() => trpc.workers.dismissHubUpdate.mutate())}
          >
            Dismiss
          </Button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" data-testid="hub-update__action-error" className="text-xs text-destructive">
          {error}
        </p>
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
          onClick={() => void save()}
        >
          Save
        </Button>
      </div>
    </div>
  );
}
