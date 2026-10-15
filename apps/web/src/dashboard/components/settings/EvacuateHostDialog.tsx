import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Label,
  Spinner,
} from "@band-app/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { trpc } from "../../../lib/trpc-client";
import { useWorktreeDisplay } from "../../hooks/use-worktree-display";

type Hosts = Awaited<ReturnType<typeof trpc.hosts.list.query>>["hosts"];
type Summary = Awaited<ReturnType<typeof trpc.checkpoints.evacuate.mutate>>;

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Moves every worktree on a host to another one after the other and shows what happened to each.
 * An online host moves its worktrees (fresh checkpoint, source removed). An offline host restores
 * them from their last checkpoints and leaves its copies superseded.
 */
export function EvacuateHostDialog({
  open,
  onOpenChange,
  from,
  hosts,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  from: Hosts[number];
  hosts: Hosts;
}) {
  const queryClient = useQueryClient();
  const displayWorktree = useWorktreeDisplay();
  const targets = hosts.filter(
    (h) => h.id !== from.id && h.id !== "local" && h.status === "online",
  );
  const [target, setTarget] = useState("");
  const [addHost, setAddHost] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const chosen = target || targets[0]?.id || "";

  const worktrees = useQuery({
    queryKey: ["checkpoints.evacuable", from.id],
    queryFn: async () => (await trpc.checkpoints.evacuable.query({ hostId: from.id })).worktrees,
    enabled: open,
  });

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setSummary(
        await trpc.checkpoints.evacuate.mutate({
          fromHostId: from.id,
          toHostId: chosen,
          ...(addHost ? { addHost: true } : {}),
        }),
      );
      await queryClient.invalidateQueries({ queryKey: ["repos"] });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const count = worktrees.data?.length ?? 0;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]" data-testid="evacuate__dialog">
        <DialogHeader>
          <DialogTitle>Move all worktrees on {from.name}</DialogTitle>
          <DialogDescription>
            {from.status === "online"
              ? "Each worktree gets a fresh checkpoint, is recreated on the target host, and is then removed here. One at a time."
              : `${from.name} is offline, so each worktree is restored from its last checkpoint. The copies on ${from.name} stay untouched and are listed as superseded when it comes back.`}
          </DialogDescription>
        </DialogHeader>
        {summary ? (
          <ul className="space-y-1 text-sm" data-testid="evacuate__summary">
            {summary.results.length === 0 ? <li>There was nothing to move.</li> : null}
            {summary.results.map((r) => (
              <li
                key={r.worktreeId}
                data-testid="evacuate__result"
                data-worktree={r.worktreeId}
                data-ok={r.ok ? "true" : "false"}
              >
                <span className="font-mono">{displayWorktree(r.worktreeId).label}</span>:{" "}
                {r.ok
                  ? `${r.mode === "move" ? "moved" : "restored"} as ${displayWorktree(r.newWorktreeId ?? "").label}`
                  : `failed. ${r.error}`}
              </li>
            ))}
          </ul>
        ) : (
          <div className="space-y-3">
            <p className="text-sm" data-testid="evacuate__count">
              {worktrees.isLoading
                ? "Counting worktrees…"
                : `${count} worktree${count === 1 ? "" : "s"} will move.`}
            </p>
            <ul className="max-h-32 overflow-auto text-xs text-muted-foreground">
              {(worktrees.data ?? []).map((w) => (
                <li key={w.worktreeId} data-testid="evacuate__worktree">
                  {displayWorktree(w.worktreeId).label}
                </li>
              ))}
            </ul>
            {targets.length === 0 ? (
              <p className="text-sm text-muted-foreground">No other worker is online.</p>
            ) : (
              <div className="space-y-1.5">
                <Label htmlFor="evacuate-target">Target host</Label>
                <select
                  id="evacuate-target"
                  data-testid="evacuate__target"
                  className="h-8 w-full rounded-md border border-border bg-transparent px-2 text-sm"
                  value={chosen}
                  disabled={busy}
                  onChange={(e) => setTarget(e.target.value)}
                >
                  {targets.map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.name || h.id}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={addHost}
                disabled={busy}
                data-testid="evacuate__add-host"
                onChange={(e) => setAddHost(e.target.checked)}
              />
              Add the target host to the allowed hosts of repos that need it
            </label>
            {error ? (
              <p role="alert" className="text-xs text-destructive" data-testid="evacuate__error">
                {error}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                size="sm"
                data-testid="evacuate__submit"
                disabled={busy || chosen === "" || count === 0}
                onClick={() => void run()}
              >
                {busy ? <Spinner className="size-3" /> : null}
                Move all
              </Button>
            </div>
          </div>
        )}
        {summary ? (
          <div className="flex justify-end">
            <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
