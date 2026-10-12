import { CONTINUE_LIMITS, formatAge } from "@band-app/shared/continuation";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Spinner,
} from "@band-app/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useContinueAnnouncement, useContinueRequest } from "../../lib/continue-prompt";
import { trpc } from "../../lib/trpc-client";
import { useCapabilities } from "../context";

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Mounted once at the root. Shows the offer when an action needs a worktree whose host is offline:
 * who could take the work from the hub's latest checkpoint, what will not carry over, or why the
 * work cannot continue. Continue restores the worktree on the chosen host and moves the UI to it.
 */
export function ContinuePromptHost() {
  const request = useContinueRequest();
  const announcement = useContinueAnnouncement();
  const queryClient = useQueryClient();
  const capabilities = useCapabilities();
  // The hub continued the work by itself: refresh the lists and go to the new worktree.
  const announcedId = announcement?.id;
  const announcedWorktree = announcement?.worktreeId;
  useEffect(() => {
    if (announcedId === undefined || !announcedWorktree) return;
    void queryClient.invalidateQueries({ queryKey: ["repos"] });
    const href = capabilities.getWorktreeHref?.(announcedWorktree);
    if (href && capabilities.navigate) capabilities.navigate(href);
  }, [announcedId, announcedWorktree, queryClient, capabilities]);
  if (!request) return null;
  return <ContinueOnHostDialog key={request.id} request={request} />;
}

function ContinueOnHostDialog({
  request,
}: {
  request: NonNullable<ReturnType<typeof useContinueRequest>>;
}) {
  const { answer, chatId } = request;
  const { offer } = answer;
  const queryClient = useQueryClient();
  const capabilities = useCapabilities();
  const recommended = offer.targets.find((t) => t.recommended)?.hostId ?? "";
  const [chosen, setChosen] = useState(recommended);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blocked = answer.code === "CONTINUE_NOT_POSSIBLE" || offer.blocked;

  const cancel = () => {
    if (busy) return;
    request.resolve(null);
  };

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await trpc.follow.continue.mutate({
        worktreeId: offer.worktreeId,
        toHostId: chosen,
        ...(chatId ? { chatId } : {}),
      });
      await queryClient.invalidateQueries({ queryKey: ["repos"] });
      const href = capabilities.getWorktreeHref?.(res.worktreeId);
      if (href && capabilities.navigate) capabilities.navigate(href);
      request.resolve({ worktreeId: res.worktreeId });
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : cancel())}>
      <DialogContent className="sm:max-w-[520px]" data-testid="continue-dialog">
        <DialogHeader>
          <DialogTitle>{blocked ? "Cannot continue elsewhere" : "Host is offline"}</DialogTitle>
          <DialogDescription data-testid="continue-dialog__question">
            {blocked ? (offer.blocked?.message ?? answer.error) : offer.question}
          </DialogDescription>
        </DialogHeader>
        {blocked ? (
          <div className="flex justify-end">
            <Button size="sm" data-testid="continue-dialog__close" onClick={cancel}>
              Close
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <fieldset className="space-y-1.5" data-testid="continue-dialog__targets">
              <legend className="text-xs font-medium">Continue on</legend>
              {offer.targets.map((t) => (
                <label
                  key={t.hostId}
                  className={`flex items-start gap-2 text-sm ${t.agentReady ? "" : "opacity-60"}`}
                >
                  <input
                    type="radio"
                    name="continue-target"
                    value={t.hostId}
                    checked={chosen === t.hostId}
                    disabled={!t.agentReady || busy}
                    data-testid="continue-dialog__target"
                    data-host-id={t.hostId}
                    onChange={() => setChosen(t.hostId)}
                  />
                  <span>
                    {t.hostName}
                    <span className="block text-xs text-muted-foreground">
                      {[
                        t.recommended ? "recommended" : null,
                        t.hasClone ? "has a clone" : "no clone yet",
                        `${t.load} worktree${t.load === 1 ? "" : "s"}`,
                        t.agentReady ? null : (t.agentProblem ?? "agent not available"),
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>
            <div className="space-y-1" data-testid="continue-dialog__notes">
              {(offer.limits.length > 0 ? offer.limits : [...CONTINUE_LIMITS]).map((line) => (
                <p key={line} className="text-xs text-muted-foreground">
                  {line}
                </p>
              ))}
              {offer.willRun.map((line) => (
                <p key={line} className="text-xs text-muted-foreground">
                  {line}
                </p>
              ))}
              {offer.checkpointAgeMs !== undefined ? (
                <p className="text-xs text-muted-foreground">
                  Work after the checkpoint ({formatAge(offer.checkpointAgeMs)} old) is not carried
                  over.
                </p>
              ) : null}
            </div>
            {error ? (
              <p
                role="alert"
                className="text-xs text-destructive"
                data-testid="continue-dialog__error"
              >
                {error}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                data-testid="continue-dialog__cancel"
                disabled={busy}
                onClick={cancel}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                data-testid="continue-dialog__confirm"
                disabled={busy || chosen === ""}
                onClick={() => void run()}
              >
                {busy ? <Spinner className="size-3" /> : null}
                Continue
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
