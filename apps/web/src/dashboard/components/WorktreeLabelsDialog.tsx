import { toWorktreeId } from "@band-app/shared/worktree-id";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@band-app/ui";
import { useQueryClient } from "@tanstack/react-query";
import { CircleAlert, X } from "lucide-react";
import { useState } from "react";
import { trpc } from "../../lib/trpc-client";
import { queryKeys } from "../query-client";
import type { WorktreeInfo } from "../types";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repoName: string;
  worktree: Pick<WorktreeInfo, "name" | "hostId" | "labels">;
}

/** Adds and removes a worktree's key/value labels. Each change is saved at once. */
export function WorktreeLabelsDialog({ open, onOpenChange, repoName, worktree }: Props) {
  const queryClient = useQueryClient();
  const worktreeId = toWorktreeId(repoName, worktree.name, worktree.hostId);
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const labels = Object.entries(worktree.labels ?? {}).sort(([a], [b]) => (a < b ? -1 : 1));

  const save = async (input: { set?: Record<string, string>; remove?: string[] }) => {
    setBusy(true);
    setError(null);
    try {
      await trpc.worktrees.setLabels.mutate({ worktreeId, ...input });
      await queryClient.invalidateQueries({ queryKey: queryKeys.repos });
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    if (await save({ set: { [key.trim()]: value.trim() } })) {
      setKey("");
      setValue("");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="lg:max-w-[460px]" data-testid="worktree-labels__dialog">
        <DialogHeader>
          <DialogTitle>Labels</DialogTitle>
          <DialogDescription>
            Key/value labels on {worktree.name}, shared by every device.
          </DialogDescription>
        </DialogHeader>
        {labels.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="worktree-labels__empty">
            No labels yet.
          </p>
        ) : (
          <ul className="flex flex-wrap gap-1.5" data-testid="worktree-labels__list">
            {labels.map(([k, v]) => (
              <li
                key={k}
                data-testid={`worktree-labels__item--${k}`}
                className="flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs"
              >
                <span>
                  {k}={v}
                </span>
                <button
                  type="button"
                  aria-label={`Remove label ${k}`}
                  data-testid={`worktree-labels__remove--${k}`}
                  disabled={busy}
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => void save({ remove: [k] })}
                >
                  <X className="size-3" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (key.trim() && value.trim()) void add();
          }}
        >
          <Input
            aria-label="Label key"
            data-testid="worktree-labels__key"
            placeholder="key"
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
          <Input
            aria-label="Label value"
            data-testid="worktree-labels__value"
            placeholder="value"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <Button
            type="submit"
            data-testid="worktree-labels__add"
            disabled={busy || !key.trim() || !value.trim()}
          >
            Add
          </Button>
        </form>
        {error && (
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label="Label not saved"
                className="self-start text-destructive"
                data-testid="worktree-labels__error"
              >
                <CircleAlert className="size-4" />
              </button>
            </PopoverTrigger>
            <PopoverContent className="text-xs text-destructive" role="alert">
              {error}
            </PopoverContent>
          </Popover>
        )}
      </DialogContent>
    </Dialog>
  );
}
