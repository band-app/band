import { Button } from "@band-app/ui";
import { useQueryClient } from "@tanstack/react-query";
import { TriangleAlert } from "lucide-react";
import { useState } from "react";
import { trpc } from "../../lib/trpc-client";
import { type HostInfoLite, hostLabel } from "../lib/sidebar-grouping";
import type { RepoInfo } from "../types";

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

interface Props {
  repo: RepoInfo;
  /** Host names by id, for the row's text. */
  hosts: HostInfoLite[];
}

/**
 * Shown when no host lists the repo's default branch: the primary host's clone is on another
 * branch and no other host has it checked out. Names the host and offers each other clone
 * as the new primary, so a repo never shows nothing for its main.
 */
export function MainMissingRow({ repo, hosts }: Props) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const missing = repo.mainMissing;
  if (!missing) return null;
  const others = (repo.clones ?? []).filter(
    (c) =>
      c.hostId !== missing.hostId &&
      (!repo.allowedHostIds || repo.allowedHostIds.includes(c.hostId)),
  );
  const primaryName = hostLabel(missing.hostId, hosts);

  const makePrimary = async (hostId: string) => {
    setError(null);
    setBusy(hostId);
    try {
      await trpc.repos.update.mutate({ name: repo.name, primaryHostId: hostId });
      await queryClient.invalidateQueries({ queryKey: ["repos"] });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      className="flex flex-col gap-1 rounded-md px-3 py-2 text-[13px]"
      data-testid="repo-main-missing"
      data-primary-host={missing.hostId}
    >
      <div className="flex items-start gap-2">
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-500" aria-hidden />
        <div className="min-w-0">
          <div className="truncate font-medium">{repo.defaultBranch}</div>
          <div className="text-foreground/60" data-testid="repo-main-missing__text">
            not checked out on {primaryName}
          </div>
        </div>
      </div>
      {others.length === 0 ? (
        <p className="text-xs text-foreground/60">
          Check out {repo.defaultBranch} on {primaryName}, or add another clone from Add repo.
        </p>
      ) : null}
      {others.map((clone) => (
        <Button
          key={clone.hostId}
          size="sm"
          variant="outline"
          disabled={busy !== null}
          data-testid="repo-main-missing__make-primary"
          data-host-id={clone.hostId}
          onClick={() => makePrimary(clone.hostId)}
        >
          Make {hostLabel(clone.hostId, hosts)} the primary host
        </Button>
      ))}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
