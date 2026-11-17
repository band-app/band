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
import { useState } from "react";
import { trpc } from "../../lib/trpc-client";
import { useDashboardStore } from "../stores/index";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  worktreeId: string;
  /** The PR's URL when it is set by hand, to prefill the field and offer Clear. */
  currentManualUrl: string | null;
}

/**
 * Sets the worktree's pull request by URL, or clears a manual one so detection takes over.
 * The new PR reaches the badge through the branch-status event the hub emits.
 */
export function SetPullRequestDialog({ open, onOpenChange, worktreeId, currentManualUrl }: Props) {
  const [url, setUrl] = useState(currentManualUrl ?? "");
  const [busy, setBusy] = useState(false);
  const setError = useDashboardStore((s) => s.setError);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
      onOpenChange(false);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="lg:max-w-[480px]" data-testid="set-pr__dialog">
        <DialogHeader>
          <DialogTitle>Pull request</DialogTitle>
          <DialogDescription>
            Paste the GitHub pull request URL to show for this worktree instead of the detected one.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (url.trim() === "") return;
            void run(() => trpc.worktrees.prSet.mutate({ worktreeId, url: url.trim() }));
          }}
        >
          <Input
            autoFocus
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://github.com/owner/repo/pull/123"
            aria-label="Pull request URL"
            data-testid="set-pr__url"
          />
          <DialogFooter>
            {currentManualUrl !== null && (
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                data-testid="set-pr__clear"
                onClick={() => void run(() => trpc.worktrees.prClear.mutate({ worktreeId }))}
              >
                Clear
              </Button>
            )}
            <Button type="submit" disabled={busy || url.trim() === ""} data-testid="set-pr__save">
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
