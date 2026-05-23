import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Spinner,
  Textarea,
} from "@band-app/ui";
import { Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { useAdapter } from "../context";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  /** Number of changed files in the workspace — shown in the header. */
  filesChanged: number;
  /** Called once a commit has succeeded; the parent typically refreshes. */
  onCommitted: () => void;
}

/**
 * Modal for staging-and-committing every change in a workspace.
 *
 * Two ways to populate the message:
 *   1. The user types a subject + optional body.
 *   2. They press "Auto-generate" (or commit while empty) and the user's
 *      default coding agent summarises the diff into a subject/body.
 *
 * Auto-generate falls back gracefully when the adapter doesn't expose the
 * generator (older platforms, embedded contexts) — the button is hidden and
 * the empty-message-triggered fallback is suppressed.
 */
export function CommitDialog({
  open,
  onOpenChange,
  workspaceId,
  filesChanged,
  onCommitted,
}: Props) {
  const adapter = useAdapter();
  const canAutoGenerate = Boolean(adapter.generateCommitMessage);
  const canCommit = Boolean(adapter.gitCommitWorkspace);

  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [generating, setGenerating] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agentLabel, setAgentLabel] = useState<string | null>(null);

  // Reset state every time the dialog re-opens so the previous attempt's
  // message/error doesn't leak into a fresh commit.
  useEffect(() => {
    if (open) {
      setSubject("");
      setBody("");
      setError(null);
      setAgentLabel(null);
      setGenerating(false);
      setCommitting(false);
    }
  }, [open]);

  const handleAutoGenerate = async () => {
    const generate = adapter.generateCommitMessage;
    if (!generate) return;
    setError(null);
    setGenerating(true);
    try {
      const result = await generate.call(adapter, workspaceId);
      setSubject(result.message);
      setBody(result.body);
      setAgentLabel(result.agentLabel);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setGenerating(false);
    }
  };

  const performCommit = async (message: string, bodyToCommit: string) => {
    const commit = adapter.gitCommitWorkspace;
    if (!commit) return;
    setCommitting(true);
    setError(null);
    try {
      await commit.call(adapter, workspaceId, message, bodyToCommit || undefined);
      onCommitted();
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCommitting(false);
    }
  };

  const handleCommit = async () => {
    const trimmedSubject = subject.trim();
    const trimmedBody = body.trim();

    // If the user clicks Commit without a subject, treat it as a request to
    // auto-generate — but only if the adapter supports it. Otherwise fall
    // back to a friendly inline error.
    if (!trimmedSubject) {
      if (!canAutoGenerate) {
        setError("Enter a commit message before committing.");
        return;
      }
      const generate = adapter.generateCommitMessage;
      if (!generate) return;
      setError(null);
      setGenerating(true);
      try {
        const result = await generate.call(adapter, workspaceId);
        setSubject(result.message);
        setBody(result.body);
        setAgentLabel(result.agentLabel);
        // Commit immediately after a successful generation. If the user
        // wants to edit first, they can clear the dialog and re-open it.
        await performCommit(result.message, result.body);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setGenerating(false);
      }
      return;
    }

    await performCommit(trimmedSubject, trimmedBody);
  };

  const busy = generating || committing;

  return (
    <Dialog open={open} onOpenChange={(o) => (busy ? null : onOpenChange(o))}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>Commit changes</DialogTitle>
          <DialogDescription>
            {filesChanged === 1
              ? "Stage and commit 1 changed file."
              : `Stage and commit ${filesChanged} changed files.`}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="commit-subject">Message</Label>
            <Input
              id="commit-subject"
              placeholder="Short summary of the change"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              disabled={busy}
              maxLength={200}
              autoFocus
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="commit-body">
              Details <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Textarea
              id="commit-body"
              placeholder="Explain why this change is being made…"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              disabled={busy}
              rows={5}
              className="font-mono text-xs"
            />
          </div>

          {agentLabel && !error && (
            <p className="text-xs text-muted-foreground">
              Generated with <span className="font-medium">{agentLabel}</span>. Edit before
              committing if needed.
            </p>
          )}

          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          )}
        </div>

        {/*
          Force a row layout at every width so Auto-generate stays on the left
          (DialogFooter's default is `flex-col-reverse` on mobile, which would
          stack it below Commit). The text label collapses to an icon-only
          button below `sm` — the button itself shrinks via `has-[>svg]:px-3`
          in the default Button size, so it reads as an icon button there.
        */}
        <DialogFooter className="flex-row items-center justify-between">
          {canAutoGenerate ? (
            <Button
              variant="outline"
              onClick={handleAutoGenerate}
              disabled={busy}
              type="button"
              title="Auto-generate commit message"
              aria-label="Auto-generate commit message"
            >
              {generating ? <Spinner className="size-4" /> : <Sparkles className="size-4" />}
              <span className="hidden sm:inline">Auto-generate</span>
            </Button>
          ) : (
            // Empty placeholder keeps Commit pinned to the right via
            // justify-between when no agent is configured.
            <span />
          )}
          <Button onClick={handleCommit} disabled={busy || !canCommit}>
            {committing ? <Spinner className="size-4" /> : null}
            Commit
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
