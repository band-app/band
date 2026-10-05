import { Button } from "@band-app/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { trpc } from "../../../lib/trpc-client";
import { useAdapter } from "../../context";
import { SettingsRow } from "./SettingsRow";

type RunnerList = Awaited<ReturnType<typeof trpc.runners.list.query>>;
type MachineList = Awaited<ReturnType<typeof trpc.runners.machines.query>>["machines"];
type Machine = MachineList[number];

const RUNNERS_KEY = ["runners.list"] as const;
const MACHINES_KEY = ["runners.machines"] as const;

/** "45s", "12m", "3h 5m", "2d 4h": the two largest units of a duration. */
function ageText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function labelText(labels: Record<string, string>): string {
  const pairs = Object.entries(labels).map(([k, v]) => `${k}=${v}`);
  return pairs.length > 0 ? pairs.join(", ") : "No labels";
}

/**
 * Rows for the Settings dialog's Runners section: the runner hooks the hub runs
 * when a worktree waits for a host (plan step 3.4), what they are running,
 * and each run's log. Read-only: runners are set in `settings.json`
 * (`docs/runner-hooks.md`).
 */
export function RunnersSettings() {
  const queryClient = useQueryClient();
  const adapter = useAdapter();
  // A lease, a fulfil or a failure changes a run, so follow the hub's status stream.
  useEffect(
    () =>
      adapter.subscribeStatusEvents((event) => {
        if (event.kind === "host-request-changed") {
          void queryClient.invalidateQueries({ queryKey: RUNNERS_KEY });
          void queryClient.invalidateQueries({ queryKey: MACHINES_KEY });
        }
      }),
    [adapter, queryClient],
  );
  const list = useQuery<RunnerList>({
    queryKey: RUNNERS_KEY,
    queryFn: () => trpc.runners.list.query(),
    refetchInterval: 5000,
  });
  const machines = useQuery<MachineList>({
    queryKey: MACHINES_KEY,
    queryFn: async () => (await trpc.runners.machines.query()).machines,
    refetchInterval: 5000,
  });
  // The machine whose destroy the hub refused because its worktrees are not stored, with why.
  const [refused, setRefused] = useState<{ id: string; message: string } | null>(null);
  const [destroyError, setDestroyError] = useState<string | null>(null);
  const destroyMachine = async (machine: Machine, force: boolean) => {
    setDestroyError(null);
    try {
      await trpc.runners.destroyMachine.mutate({ id: machine.id, force });
      setRefused(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!force && /not stored/.test(message)) setRefused({ id: machine.id, message });
      else setDestroyError(message);
    }
    await queryClient.invalidateQueries({ queryKey: MACHINES_KEY });
  };
  const [openLog, setOpenLog] = useState<string | null>(null);
  const log = useQuery({
    queryKey: ["runners.log", openLog],
    queryFn: () => trpc.runners.log.query({ requestId: openLog as string }),
    enabled: openLog !== null,
    refetchInterval: 2000,
  });

  const runners = list.data?.runners ?? [];
  const runs = list.data?.runs ?? [];
  return (
    <>
      <SettingsRow
        variant="stacked"
        label="Runners"
        description="Scripts the hub runs to start a worker when a worktree asks for a host that does not exist yet. Set them in settings.json under runners."
      >
        {runners.length === 0 ? (
          <p className="text-xs text-muted-foreground" data-testid="settings__runners-empty">
            No runners configured.
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {runners.map((runner) => (
              <li
                key={runner.id}
                data-testid="settings__runner"
                className="flex items-start justify-between gap-3 px-3 py-2 text-sm"
              >
                <div className="min-w-0">
                  <div className="truncate" data-testid="settings__runner-id">
                    {runner.id}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {runner.spawn}
                    {" · "}
                    {labelText(runner.labels)}
                    {" · "}
                    {runner.isolation}
                    {" · "}
                    Timeout {runner.timeoutSec}s
                  </div>
                </div>
                <span
                  data-testid="settings__runner-running"
                  data-running={runner.running}
                  data-max={runner.maxConcurrent}
                  className="shrink-0 text-xs text-muted-foreground"
                >
                  {runner.running}/{runner.maxConcurrent} running
                </span>
              </li>
            ))}
          </ul>
        )}
        {(list.data?.errors ?? []).map((error) => (
          <p key={error} role="alert" className="mt-2 text-xs text-destructive">
            {error}
          </p>
        ))}
      </SettingsRow>

      <SettingsRow
        variant="stacked"
        label="Machines"
        description="Every machine a runner started. The hub destroys one that never connects, that goes offline, that no runner knows about, or that outlives the runner's maximum lifetime (docs/runner-hooks.md)."
      >
        {(machines.data ?? []).length === 0 ? (
          <p className="text-xs text-muted-foreground" data-testid="settings__machines-empty">
            No machines yet.
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {(machines.data ?? []).map((machine) => (
              <li
                key={machine.id}
                data-testid="settings__machine"
                data-state={machine.state}
                className="px-3 py-2 text-sm"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate">
                      <span data-testid="settings__machine-worker">{machine.workerId}</span>
                      <span className="text-xs text-muted-foreground">
                        {" · "}
                        {machine.runnerId}
                        {machine.handle ? ` · ${machine.handle}` : ""}
                        {" · "}
                        <span data-testid="settings__machine-state">{machine.state}</span>
                        {" · "}
                        <span data-testid="settings__machine-age">
                          {ageText((machine.destroyedAt ?? Date.now()) - machine.spawnedAt)}
                        </span>
                      </span>
                    </div>
                    {machine.note ? (
                      <p
                        data-testid="settings__machine-note"
                        className="text-xs text-muted-foreground"
                      >
                        {machine.note}
                      </p>
                    ) : null}
                  </div>
                  {machine.state !== "destroyed" ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-label={`Destroy machine ${machine.workerId}`}
                      data-testid="settings__machine-destroy"
                      onClick={() => void destroyMachine(machine, false)}
                    >
                      Destroy
                    </Button>
                  ) : null}
                </div>
                {refused?.id === machine.id ? (
                  <div role="alert" className="mt-2 flex items-center justify-between gap-3">
                    <p className="text-xs text-destructive" data-testid="settings__machine-refused">
                      {refused.message}
                    </p>
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      data-testid="settings__machine-destroy-force"
                      onClick={() => void destroyMachine(machine, true)}
                    >
                      Destroy anyway
                    </Button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {destroyError ? (
          <p role="alert" className="mt-2 text-xs text-destructive">
            {destroyError}
          </p>
        ) : null}
      </SettingsRow>

      {runs.length > 0 ? (
        <SettingsRow
          variant="stacked"
          label="Runner activity"
          description="Recent requests the runners took, with what their scripts printed."
        >
          <ul className="divide-y divide-border rounded-md border border-border">
            {runs.map((run) => (
              <li
                key={`${run.requestId}-${run.startedAt}`}
                data-testid="settings__runner-run"
                data-status={run.status}
                className="px-3 py-2 text-sm"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0 truncate">
                    <span data-testid="settings__runner-run-worktree">{run.worktreeId}</span>
                    <span className="text-xs text-muted-foreground">
                      {" · "}
                      {run.runnerId}
                      {" · attempt "}
                      {run.attempt}
                      {" · "}
                      <span data-testid="settings__runner-run-status">{run.status}</span>
                    </span>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label={`Show log of ${run.worktreeId}`}
                    data-testid="settings__runner-run-log-toggle"
                    onClick={() => setOpenLog(openLog === run.requestId ? null : run.requestId)}
                  >
                    {openLog === run.requestId ? "Hide log" : "Show log"}
                  </Button>
                </div>
                {run.error ? <p className="mt-1 text-xs text-destructive">{run.error}</p> : null}
                {openLog === run.requestId ? (
                  <pre
                    data-testid="settings__runner-log"
                    className="mt-2 max-h-64 overflow-auto rounded-md bg-muted p-2 font-mono text-xs"
                  >
                    {log.data?.log ?? "No log."}
                  </pre>
                ) : null}
              </li>
            ))}
          </ul>
        </SettingsRow>
      ) : null}
    </>
  );
}
