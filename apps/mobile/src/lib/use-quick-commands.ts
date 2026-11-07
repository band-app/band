import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useHubSession } from "./hub-session";
import type { QuickCommand, QuickCommandInput } from "./quick-commands.ts";

const KEY = ["quickCommands.list"];

/** Every saved quick command, most recently run first, and the changes a person can make. */
export function useQuickCommands() {
  const { client } = useHubSession();
  const queryClient = useQueryClient();
  const list = useQuery({
    queryKey: KEY,
    queryFn: async () => (await client.quickCommands.list.query()).commands as QuickCommand[],
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: KEY });
  const create = useMutation({
    mutationFn: (input: QuickCommandInput) => client.quickCommands.create.mutate(input),
    onSuccess: refresh,
  });
  const update = useMutation({
    mutationFn: (v: { id: string; command: QuickCommandInput }) =>
      client.quickCommands.update.mutate(v),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: string) => client.quickCommands.remove.mutate({ id }),
    onSuccess: refresh,
  });
  const markRun = useMutation({
    mutationFn: (id: string) => client.quickCommands.markRun.mutate({ id }),
    onSuccess: refresh,
  });
  return { commands: list.data ?? [], loading: list.isPending, create, update, remove, markRun };
}
