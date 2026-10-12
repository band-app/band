import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Spinner,
} from "@band-app/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { trpc } from "../../lib/trpc-client";

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The superseded copy on the host that came back. */
  worktreeId: string;
}

/**
 * The old copy of a continued worktree, once its host is back: the files it changed since the
 * checkpoint the continuation used, the diff of each, "Bring these changes over" (a patch on the
 * new copy; conflicts change nothing) and "Discard old copy" (deletes its files, after asking).
 */
export function DivergencePanel({ open, onOpenChange, worktreeId }: Props) {
  const queryClient = useQueryClient();
  const report = useQuery({
    queryKey: ["follow.divergence", worktreeId],
    queryFn: () => trpc.follow.divergence.query({ worktreeId }),
    enabled: open,
  });
  const [path, setPath] = useState<string | null>(null);
  const diff = useQuery({
    queryKey: ["follow.divergenceDiff", worktreeId, path],
    queryFn: () => trpc.follow.divergenceDiff.query({ worktreeId, path: path as string }),
    enabled: open && path !== null,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<Array<{ path: string; message: string }>>([]);
  const [confirming, setConfirming] = useState(false);
  // A diverged copy needs a second confirmation that names what would be lost.
  const [confirmingLoss, setConfirmingLoss] = useState(false);

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["repos"] });
    await queryClient.invalidateQueries({ queryKey: ["follow.divergence", worktreeId] });
  };

  const bringOver = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    setConflicts([]);
    try {
      const res = await trpc.follow.bringOver.mutate({ worktreeId });
      if (res.applied) {
        setNotice(`Brought over ${res.files} file${res.files === 1 ? "" : "s"} to the new copy.`);
        await refresh();
      } else {
        setConflicts(res.conflicts);
        setNotice("The changes conflict with the new copy. Nothing was changed.");
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const discard = async () => {
    setBusy(true);
    setError(null);
    try {
      await trpc.follow.discardOld.mutate({
        worktreeId,
        confirm: true,
        ...(report.data?.state === "diverged" ? { discardChanges: true } : {}),
      });
      await queryClient.invalidateQueries({ queryKey: ["repos"] });
      onOpenChange(false);
    } catch (err) {
      setError(errorText(err));
      setConfirming(false);
      setConfirmingLoss(false);
    } finally {
      setBusy(false);
    }
  };

  const data = report.data;
  const lostFiles = data?.files.length ?? 0;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[640px]" data-testid="divergence-panel">
        <DialogHeader>
          <DialogTitle>Changes on the old copy</DialogTitle>
          <DialogDescription>
            This host was offline while the work continued elsewhere. These files differ from the
            checkpoint the continuation used.
          </DialogDescription>
        </DialogHeader>
        {report.isLoading ? <Spinner className="size-4" /> : null}
        {report.error ? (
          <p role="alert" className="text-xs text-destructive">
            {errorText(report.error)}
          </p>
        ) : null}
        {data && !data.hostOnline ? (
          <p className="text-sm text-muted-foreground">
            The host is offline, so the old copy cannot be compared now.
          </p>
        ) : null}
        {data?.hostOnline && data.state === "clean" ? (
          <p className="text-sm text-muted-foreground" data-testid="divergence-panel__clean">
            The old copy has nothing the continuation lacks.
          </p>
        ) : null}
        {data && data.files.length > 0 ? (
          <ul className="max-h-40 space-y-0.5 overflow-auto" data-testid="divergence-panel__files">
            {data.files.map((f) => (
              <li key={f.path}>
                <button
                  type="button"
                  data-testid="divergence-panel__file"
                  data-path={f.path}
                  className={`w-full text-left font-mono text-xs hover:underline ${path === f.path ? "font-bold" : ""}`}
                  onClick={() => setPath(f.path)}
                >
                  {f.status} {f.path}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {path !== null ? (
          <pre
            className="max-h-60 overflow-auto rounded border bg-muted/40 p-2 font-mono text-xs"
            data-testid="divergence-panel__diff"
          >
            {diff.isLoading ? "Loading…" : (diff.data?.diff ?? errorText(diff.error))}
          </pre>
        ) : null}
        {notice ? (
          <p className="text-xs" data-testid="divergence-panel__notice">
            {notice}
          </p>
        ) : null}
        {conflicts.length > 0 ? (
          <ul
            className="space-y-0.5 text-xs text-destructive"
            data-testid="divergence-panel__conflicts"
          >
            {conflicts.map((c) => (
              <li key={c.path}>
                <span className="font-mono">{c.path}</span>: {c.message}
              </li>
            ))}
          </ul>
        ) : null}
        {error ? (
          <p
            role="alert"
            className="text-xs text-destructive"
            data-testid="divergence-panel__error"
          >
            {error}
          </p>
        ) : null}
        {confirming ? (
          <div
            className="space-y-2 rounded border border-destructive/50 p-2"
            data-testid="divergence-panel__confirm"
          >
            {data?.state === "diverged" && confirmingLoss ? (
              <p className="text-xs font-medium" data-testid="divergence-panel__loss">
                {lostFiles} changed file{lostFiles === 1 ? "" : "s"} exist only on the old copy and
                will be lost for good. Bring them over first if you want to keep them.
              </p>
            ) : (
              <p className="text-xs">
                Discard the old copy? Its files on the old host are deleted. The continued worktree
                is not touched.
                {data?.state === "diverged"
                  ? ` It holds ${lostFiles} changed file${lostFiles === 1 ? "" : "s"} the new copy lacks (listed above).`
                  : ""}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setConfirming(false);
                  setConfirmingLoss(false);
                }}
              >
                Keep it
              </Button>
              {data?.state === "diverged" && !confirmingLoss ? (
                <Button
                  variant="destructive"
                  size="sm"
                  data-testid="divergence-panel__review-loss"
                  disabled={busy}
                  onClick={() => setConfirmingLoss(true)}
                >
                  Continue
                </Button>
              ) : (
                <Button
                  variant="destructive"
                  size="sm"
                  data-testid="divergence-panel__confirm-discard"
                  disabled={busy}
                  onClick={() => void discard()}
                >
                  {data?.state === "diverged"
                    ? `Delete old copy and ${lostFiles} changed file${lostFiles === 1 ? "" : "s"}`
                    : "Delete old copy"}
                </Button>
              )}
            </div>
          </div>
        ) : (
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              data-testid="divergence-panel__discard"
              disabled={busy}
              onClick={() => setConfirming(true)}
            >
              Discard old copy
            </Button>
            <Button
              size="sm"
              data-testid="divergence-panel__bring-over"
              disabled={busy || !data?.hostOnline || data.state !== "diverged"}
              onClick={() => void bringOver()}
            >
              {busy ? <Spinner className="size-3" /> : null}
              Bring these changes over
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
