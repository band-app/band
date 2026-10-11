import { useQuery } from "@tanstack/react-query";
import { Monitor } from "lucide-react";
import { toWorktreeId, useRepos } from "@/dashboard";
import { openDesktopViewer } from "../lib/desktop-viewer";
import { trpc } from "../lib/trpc-client";

/**
 * Opens the desktop viewer of the host a worktree lives on. Rendered in the center group header
 * only when that host is online and reports the `desktop` capability, so most worktrees show nothing.
 */
export function DesktopHeaderButton({ worktreeId }: { worktreeId: string }) {
  const { repos } = useRepos();
  const hosts = useQuery({
    queryKey: ["hosts.list"],
    queryFn: async () => (await trpc.hosts.list.query()).hosts,
  });
  const hostId = repos
    .flatMap((repo) =>
      repo.worktrees.map((wt) => ({ id: toWorktreeId(repo.name, wt.name, wt.hostId), wt })),
    )
    .find((entry) => entry.id === worktreeId)?.wt.hostId;
  const host = hosts.data?.find((h) => h.id === (hostId ?? "local"));
  if (!host || host.status !== "online" || !host.capabilities.includes("desktop")) return null;
  return (
    <button
      type="button"
      aria-label="Open desktop"
      data-testid="worktree-center__open-desktop"
      onClick={() => openDesktopViewer(host.id)}
      className="inline-flex size-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      <Monitor className="size-3.5" />
    </button>
  );
}
