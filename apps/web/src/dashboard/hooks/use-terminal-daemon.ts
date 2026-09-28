import { useMutation } from "@tanstack/react-query";
import { trpc } from "../../lib/trpc-client";
import { useDashboardStore } from "../stores/index";

/**
 * "Restart the terminal service" (Settings > Terminal). Ends every terminal
 * hosted by the current-build daemon; retired-daemon sessions from a
 * previous version of Band are untouched. See `terminal.restartDaemon`.
 */
export function useRestartTerminalDaemon() {
  const setError = useDashboardStore((s) => s.setError);

  return useMutation({
    mutationFn: () => trpc.terminal.restartDaemon.mutate(),
    onError: (err) => {
      setError(err);
    },
  });
}
