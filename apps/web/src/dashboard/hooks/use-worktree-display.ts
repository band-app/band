import {
  hostDisplay,
  type WorktreeDisplay,
  worktreeDisplay,
} from "@band-app/shared/worktree-display";
import { useQuery } from "@tanstack/react-query";
import { trpc } from "../../lib/trpc-client";
import { useRepos } from "./use-repos";

function useHostList() {
  const hosts = useQuery({
    queryKey: ["hosts.list"],
    queryFn: async () => (await trpc.hosts.list.query()).hosts,
  });
  return hosts.data;
}

/** Turns a worktree id into what a person reads: `repo · name`, plus `on <host>` off the hub. */
export function useWorktreeDisplay(): (worktreeId: string) => WorktreeDisplay {
  const { repos } = useRepos();
  const hosts = useHostList();
  return (worktreeId) => worktreeDisplay(worktreeId, repos, hosts);
}

/** Turns a host id into the host's name, or "unknown host". */
export function useHostDisplay(): (hostId: string | null | undefined) => string {
  const hosts = useHostList();
  return (hostId) => hostDisplay(hostId, hosts);
}
