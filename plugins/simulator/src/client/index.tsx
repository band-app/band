import {
  defineClientPlugin,
  type RemoteScreenApi,
  useClientPluginHost,
  type WorktreePanelProps,
} from "@band-app/plugin-api/client";
import { Home, ScanEye } from "lucide-react";
import { useEffect, useState } from "react";

function SimulatorPanel({ worktreeId, visible }: WorktreePanelProps) {
  const host = useClientPluginHost();
  const Screen = host.RemoteScreen;
  const [canReveal, setCanReveal] = useState(false);
  useEffect(() => {
    let live = true;
    void host
      .canRevealSimulator?.(worktreeId)
      .then((ok) => live && setCanReveal(ok))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [host, worktreeId]);

  const actions = (api: RemoteScreenApi) => {
    const udid = typeof api.info?.udid === "string" ? api.info.udid : null;
    return (
      <>
        <button
          type="button"
          aria-label="Home"
          title="Home"
          disabled={!api.controlling}
          data-testid="simulator-panel__home"
          onClick={() => api.send({ type: "button", name: "HOME" })}
          className="inline-flex size-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
        >
          <Home className="size-3.5" />
        </button>
        {canReveal && host.revealSimulator && udid && (
          <button
            type="button"
            aria-label="Reveal in Simulator.app"
            title="Reveal in Simulator.app"
            data-testid="simulator-panel__reveal"
            onClick={() => void host.revealSimulator?.(worktreeId, udid)}
            className="inline-flex size-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <ScanEye className="size-3.5" />
          </button>
        )}
      </>
    );
  };

  return (
    <Screen
      pluginId="simulator"
      worktreeId={worktreeId}
      visible={visible}
      title="iOS Simulator"
      actions={actions}
    />
  );
}

/** The client half of the simulator plugin: the Simulator tab of a worktree's center dock. */
export default defineClientPlugin({
  id: "simulator",
  contributions: {
    "worktree.panels": [
      {
        id: "simulator",
        label: "Simulator",
        icon: ScanEye,
        capability: "simulator",
        component: SimulatorPanel,
      },
    ],
  },
});
