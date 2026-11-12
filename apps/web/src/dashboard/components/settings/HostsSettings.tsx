import { Button } from "@band-app/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useThisComputerWorker } from "../../../lib/this-computer-worker";
import { trpc } from "../../../lib/trpc-client";
import { useAdapter } from "../../context";
import { useUpdateStatus } from "../../hooks/use-update-status";
import { UpdateAllWorkers } from "../UpdateAllWorkers";
import { AddWorkerDialog } from "./AddWorkerDialog";
import { CheckForUpdates } from "./CheckForUpdates";
import { useIsAdmin } from "./DevicesSettings";
import { ErrorPopover } from "./ErrorPopover";
import { EvacuateHostDialog } from "./EvacuateHostDialog";
import { SettingsRow } from "./SettingsRow";
import { ThisComputerRow, thisComputerHostId } from "./ThisComputerSettings";
import { WorkerDrawer } from "./WorkerDrawer";
import { WorkerProfilesSettings } from "./WorkerProfilesSettings";
import { WorkersActivity } from "./WorkersActivity";
import { WorkersTable } from "./WorkersTable";
import {
  AUDIT_KEY,
  type AuditEntries,
  errorText,
  formatTime,
  HOSTS_KEY,
  type HostList,
  KIND_LABEL,
  TOKENS_KEY,
  type TokenList,
  type TokenView,
} from "./worker-format";

type Tab = "workers" | "profiles" | "activity" | "tokens";

/**
 * Settings > Workers: the computers Band can run worktrees on as one table (this Mac included),
 * one "Check for updates", a banner when a worker is behind the hub, and a drawer per worker.
 * Activity and worker tokens are tabs. Changes apply at once; they are not part of the dialog's
 * Save. A new token is shown once, because the hub keeps only its hash.
 */
export function HostsSettings() {
  const queryClient = useQueryClient();
  const adapter = useAdapter();
  // Refetches a list that something just changed. A plain invalidate during the
  // first load reuses that load's request, which the hub may have answered
  // before the change, so the stale answer would stay on screen. Cancelling
  // first makes the refetch a new request.
  const refetchFresh = useCallback(
    async (queryKey: readonly string[]) => {
      await queryClient.cancelQueries({ queryKey });
      await queryClient.invalidateQueries({ queryKey });
    },
    [queryClient],
  );
  // A worker connecting or dropping changes its row, so follow the hub's status stream.
  useEffect(
    () =>
      adapter.subscribeStatusEvents((event) => {
        if (event.kind === "host-status-changed") {
          void refetchFresh(HOSTS_KEY);
        }
      }),
    [adapter, refetchFresh],
  );
  const isAdmin = useIsAdmin();
  const hosts = useQuery<HostList>({
    queryKey: HOSTS_KEY,
    queryFn: async () => (await trpc.workers.list.query()).hosts,
  });
  // Device tokens are managed in Settings > Devices; Workers keeps the workers' tokens.
  const tokens = useQuery<TokenList>({
    queryKey: TOKENS_KEY,
    queryFn: async () => (await trpc.tokens.list.query()).tokens,
    select: (all) => all.filter((t) => t.kind !== "device"),
  });
  const audit = useQuery<AuditEntries>({
    queryKey: AUDIT_KEY,
    queryFn: async () => (await trpc.workers.audit.query({ limit: 200 })).entries,
    enabled: isAdmin,
  });
  const updateStatus = useUpdateStatus();
  const thisComputer = useThisComputerWorker();

  const [tab, setTab] = useState<Tab>("workers");
  const [openId, setOpenId] = useState<string | null>(null);
  const [evacuating, setEvacuating] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [revokeError, setRevokeError] = useState<{ id: string; message: string } | null>(null);

  const refresh = () =>
    Promise.all([refetchFresh(HOSTS_KEY), refetchFresh(TOKENS_KEY), refetchFresh(AUDIT_KEY)]);

  const revoke = async (token: TokenView) => {
    setRevokeError(null);
    try {
      await trpc.tokens.revoke.mutate({ tokenId: token.id });
    } catch (err) {
      setRevokeError({ id: token.id, message: errorText(err) });
    }
    await refresh();
  };

  const list = hosts.data ?? [];
  const thisId = thisComputerHostId(thisComputer.status);
  const behind = list.filter(
    (h) => h.usable && h.versionState === "behind" && h.status !== "disposed",
  );
  const hubVersion = updateStatus.data?.hubVersion ?? null;
  const open = list.find((h) => h.id === openId) ?? null;
  const sessionToken =
    (tokens.data ?? []).find(
      (t) => t.kind === "worker_session" && t.hostId === openId && t.state === "active",
    ) ?? null;

  const tabs: { id: Tab; label: string; show: boolean }[] = [
    { id: "workers", label: "Workers", show: true },
    { id: "profiles", label: "Profiles", show: isAdmin },
    { id: "activity", label: "Activity", show: isAdmin },
    { id: "tokens", label: "Tokens", show: true },
  ];

  return (
    <>
      <SettingsRow variant="stacked">
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CheckForUpdates />
            {isAdmin ? (
              <Button
                type="button"
                size="sm"
                data-testid="settings__add-worker"
                onClick={() => setAdding(true)}
              >
                <Plus className="size-3" />
                Add worker
              </Button>
            ) : null}
          </div>

          {isAdmin && behind.length > 0 ? (
            <div
              className="space-y-2 rounded-md border border-warning/40 bg-warning-bg px-3 py-2.5 text-sm"
              data-testid="settings__workers-behind"
            >
              <div className="flex items-start gap-2">
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
                <p data-testid="settings__workers-behind-text">
                  {behind
                    .map(
                      (h) =>
                        `${h.name} is behind the hub (${h.workerVersion ?? "unknown"}${hubVersion ? `, hub runs ${hubVersion}` : ""})`,
                    )
                    .join(". ")}
                  .
                </p>
              </div>
              <UpdateAllWorkers behindCount={behind.length} />
            </div>
          ) : null}

          <div role="tablist" aria-label="Workers" className="flex gap-1 border-b border-border">
            {tabs
              .filter((t) => t.show)
              .map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.id}
                  data-testid={`settings__workers-tab-${t.id}`}
                  onClick={() => setTab(t.id)}
                  className={`-mb-px border-b-2 px-3 py-1.5 text-sm ${
                    tab === t.id
                      ? "border-foreground font-medium"
                      : "border-transparent text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {t.label}
                </button>
              ))}
          </div>

          {tab === "workers" ? (
            <div>
              <WorkersTable
                hosts={list}
                thisComputerId={thisId}
                thisComputerBundled={thisComputer.status?.bundled === true}
                onOpen={setOpenId}
                onDismissUpdate={(hostId) =>
                  void trpc.workers.dismissUpdate
                    .mutate({ hostId })
                    .catch(() => undefined)
                    .then(() => refetchFresh(HOSTS_KEY))
                }
              />
              <ThisComputerRow computer={thisComputer} />
            </div>
          ) : null}

          {tab === "profiles" && isAdmin ? <WorkerProfilesSettings /> : null}

          {tab === "activity" && isAdmin ? (
            <WorkersActivity entries={audit.data ?? []} hosts={list} />
          ) : null}

          {tab === "tokens" ? (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                Revoking a worker token disconnects that worker. Device tokens are in Settings &gt;
                Devices.
              </p>
              {tokens.isError ? (
                <p
                  role="alert"
                  className="text-xs text-muted-foreground"
                  data-testid="settings__tokens-denied"
                >
                  Managing worker tokens needs an admin token.
                </p>
              ) : null}
              <ul className="divide-y divide-border rounded-md border border-border">
                {(tokens.data ?? []).map((token) => (
                  <li
                    key={token.id}
                    data-testid="settings__token"
                    data-token-id={token.id}
                    data-state={token.state}
                    className="flex items-center justify-between gap-2 px-3 py-2 text-sm"
                  >
                    <div className="min-w-0">
                      <div className="truncate">{token.label || KIND_LABEL[token.kind]}</div>
                      <div className="text-xs text-muted-foreground">
                        {KIND_LABEL[token.kind]}
                        {token.admin ? " (admin)" : ""} · {token.state} · Last used{" "}
                        {formatTime(token.lastUsedAt)}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {revokeError?.id === token.id ? (
                        <ErrorPopover
                          label="Could not revoke the token"
                          testId="settings__token-revoke-error"
                          message={revokeError.message}
                        />
                      ) : null}
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        aria-label={`Revoke token ${token.label || token.id}`}
                        disabled={token.state !== "active"}
                        onClick={() => void revoke(token)}
                      >
                        Revoke
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </SettingsRow>

      <WorkerDrawer
        host={open}
        isAdmin={isAdmin}
        sessionToken={sessionToken}
        isThisComputer={open !== null && open.id === thisId}
        thisComputer={thisComputer}
        onClose={() => setOpenId(null)}
        onEvacuate={setEvacuating}
        refresh={refresh}
      />
      {list
        .filter((h) => h.id === evacuating)
        .map((h) => (
          <EvacuateHostDialog
            key={h.id}
            open
            onOpenChange={(isOpen) => {
              if (!isOpen) setEvacuating(null);
            }}
            from={h}
            hosts={list}
          />
        ))}
      <AddWorkerDialog open={adding} onOpenChange={setAdding} onIssued={refresh} />
    </>
  );
}
