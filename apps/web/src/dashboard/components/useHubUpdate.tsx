import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@band-app/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { trpc } from "../../lib/trpc-client";
import { UPDATE_STATUS_KEY, useUpdateStatus } from "../hooks/use-update-status";

/** Polls while a hub update runs, because the hub is gone for a moment when it restarts. */
const POLL_MS = 2000;

const SETTINGS_KEY = ["settings.get", "hubUpdate"] as const;

/**
 * The actions behind the hub's update controls, shared by the update panel and Settings > Hub:
 * start the update (with the interruption dialog when a turn is running), the auto-update switch,
 * the custom command, and dismissing a failure. `dialog` must be rendered by the caller.
 */
export function useHubUpdate() {
  const queryClient = useQueryClient();
  const status = useUpdateStatus();
  const settings = useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: () => trpc.settings.get.query(),
  });
  const savedUpdate = (
    settings.data as { hubUpdate?: { command?: string; auto?: boolean } } | undefined
  )?.hubUpdate;
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

  const startUpdate = () =>
    run(async () => {
      const { agents } = await trpc.workers.hubInterruptions.query();
      const running = agents.filter((a) => a.busy);
      if (running.length === 0) {
        await trpc.workers.updateHub.mutate();
        return;
      }
      setTurns(running);
      setConfirmOpen(true);
    });

  const saveCommand = (command: string) =>
    run(async () => {
      await trpc.settings.update.mutate({ hubUpdate: { command: command.trim() } });
      await queryClient.invalidateQueries({ queryKey: SETTINGS_KEY });
    });

  const setAuto = (auto: boolean) =>
    run(async () => {
      await trpc.settings.update.mutate({ hubUpdate: { auto } });
      queryClient.setQueryData(SETTINGS_KEY, (old: object | undefined) => ({
        ...old,
        hubUpdate: { ...savedUpdate, auto },
      }));
      await queryClient.invalidateQueries({ queryKey: SETTINGS_KEY });
    });

  const dismiss = () => run(() => trpc.workers.dismissHubUpdate.mutate());

  const dialog: ReactNode = (
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
  );

  return {
    status,
    hubUpdate,
    updating,
    busy,
    error,
    savedUpdate,
    startUpdate,
    saveCommand,
    setAuto,
    dismiss,
    dialog,
  };
}
