import { Button, Input } from "@band-app/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { crossOriginHub } from "../../../lib/hub-config";
import { trpc } from "../../../lib/trpc-client";
import { useAdapter } from "../../context";
import { SettingsRow } from "./SettingsRow";

type HostList = Awaited<ReturnType<typeof trpc.hosts.list.query>>["hosts"];
type TokenList = Awaited<ReturnType<typeof trpc.tokens.list.query>>["tokens"];
type TokenView = TokenList[number];

const HOSTS_KEY = ["hosts.list"] as const;
const TOKENS_KEY = ["tokens.list"] as const;

interface IssuedWorker {
  hostId: string;
  token: string;
  expiresAt: number | null;
}

const KIND_LABEL: Record<TokenView["kind"], string> = {
  device: "Device",
  worker_bootstrap: "Worker bootstrap",
  worker_session: "Worker session",
};

function formatTime(at: number | null): string {
  return at == null ? "Never" : new Date(at).toLocaleString();
}

/** The command a user runs on the new machine. The hub URL is the one this page reaches the hub at. */
function workerCommand(issued: IssuedWorker): string {
  const hub = crossOriginHub()?.origin ?? window.location.origin;
  return [
    `BAND_HUB_URL=${hub}`,
    `BAND_WORKER_ID=${issued.hostId}`,
    `BAND_BOOTSTRAP_TOKEN=${issued.token}`,
    "band-worker",
  ].join(" ");
}

/**
 * Rows for the Settings dialog's Hosts section: the machines Band can run
 * workspaces on, "Add worker" (a one-time bootstrap token and the command
 * that uses it) and the hub's tokens with a Revoke button. Changes apply
 * immediately; they are not part of the dialog's Save. A new token is shown
 * once, because the hub keeps only its hash.
 */
export function HostsSettings() {
  const queryClient = useQueryClient();
  const adapter = useAdapter();
  // A worker connecting or dropping changes its row, so follow the hub's status stream.
  useEffect(
    () =>
      adapter.subscribeStatusEvents((event) => {
        if (event.kind === "host-status-changed") {
          void queryClient.invalidateQueries({ queryKey: HOSTS_KEY });
        }
      }),
    [adapter, queryClient],
  );
  const hosts = useQuery<HostList>({
    queryKey: HOSTS_KEY,
    queryFn: async () => (await trpc.hosts.list.query()).hosts,
  });
  const tokens = useQuery<TokenList>({
    queryKey: TOKENS_KEY,
    queryFn: async () => (await trpc.tokens.list.query()).tokens,
  });

  const [adding, setAdding] = useState(false);
  const [hostName, setHostName] = useState("");
  const [labels, setLabels] = useState("");
  const [issued, setIssued] = useState<IssuedWorker | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: HOSTS_KEY }),
      queryClient.invalidateQueries({ queryKey: TOKENS_KEY }),
    ]);

  const issue = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await trpc.tokens.issueWorkerBootstrap.mutate({
        hostName: hostName.trim(),
        labels: labels
          .split(",")
          .map((l) => l.trim())
          .filter(Boolean),
      });
      setIssued({
        hostId: result.hostId,
        token: result.token,
        expiresAt: result.view.expiresAt,
      });
      setHostName("");
      setLabels("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (token: TokenView) => {
    setError(null);
    try {
      await trpc.tokens.revoke.mutate({ tokenId: token.id });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    await refresh();
  };

  const closeAdd = () => {
    setAdding(false);
    setIssued(null);
    setError(null);
  };

  return (
    <>
      <SettingsRow
        variant="stacked"
        label="Hosts"
        description="Machines that run workspaces. Local is this hub's own machine. Workers connect to the hub and appear here."
      >
        <ul className="divide-y divide-border rounded-md border border-border">
          {(hosts.data ?? []).map((host) => (
            <li
              key={host.id}
              data-testid="settings__host"
              data-status={host.status}
              className="flex items-start justify-between gap-3 px-3 py-2 text-sm"
            >
              <div className="min-w-0">
                <div className="truncate" data-testid="settings__host-name">
                  {host.name}
                </div>
                <div className="text-xs text-muted-foreground">
                  <span data-testid="settings__host-id">{host.id}</span>
                  {" · "}
                  {host.labels.length > 0 ? host.labels.join(", ") : "No labels"}
                  {" · "}
                  Last seen {formatTime(host.lastSeenAt)}
                </div>
              </div>
              <span
                data-testid="settings__host-status"
                className="shrink-0 text-xs text-muted-foreground"
              >
                {host.status}
              </span>
            </li>
          ))}
        </ul>
      </SettingsRow>

      <SettingsRow
        variant="stacked"
        label="Add worker"
        description="Create a one-time token for a worker on another machine. It works once and expires in an hour."
      >
        {!adding ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="settings__add-worker"
            onClick={() => setAdding(true)}
          >
            <Plus className="size-3" />
            Add worker
          </Button>
        ) : issued ? (
          <div className="space-y-2" data-testid="settings__bootstrap-result">
            <p className="text-xs text-muted-foreground">
              Copy this now. The hub keeps only a hash of the token and cannot show it again.
            </p>
            <label className="block text-xs font-medium" htmlFor="bootstrap-token">
              Bootstrap token
            </label>
            <Input
              id="bootstrap-token"
              readOnly
              value={issued.token}
              data-testid="settings__bootstrap-token"
              className="h-8 font-mono text-xs"
            />
            <label className="block text-xs font-medium" htmlFor="worker-command">
              Run on the worker machine
            </label>
            <Input
              id="worker-command"
              readOnly
              value={workerCommand(issued)}
              data-testid="settings__worker-command"
              className="h-8 font-mono text-xs"
            />
            <Button type="button" variant="outline" size="sm" onClick={closeAdd}>
              Done
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            <Input
              aria-label="Host name"
              placeholder="Host name"
              value={hostName}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setHostName(e.target.value)}
              className="h-8 text-sm"
            />
            <Input
              aria-label="Labels"
              placeholder="Labels, comma separated (optional)"
              value={labels}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setLabels(e.target.value)}
              className="h-8 text-sm"
            />
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                disabled={busy || hostName.trim() === ""}
                onClick={() => void issue()}
              >
                Create token
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={closeAdd}>
                Cancel
              </Button>
            </div>
          </div>
        )}
        {error ? (
          <p role="alert" className="mt-2 text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </SettingsRow>

      <SettingsRow
        variant="stacked"
        label="Tokens"
        description="Revoking a token signs out whatever uses it. The shared token in settings.json cannot be revoked here."
      >
        {tokens.isError ? (
          <p
            role="alert"
            className="text-xs text-muted-foreground"
            data-testid="settings__tokens-denied"
          >
            Managing tokens needs an admin token.
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
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0"
                aria-label={`Revoke token ${token.label || token.id}`}
                disabled={token.state !== "active" || token.id === "shared"}
                onClick={() => void revoke(token)}
              >
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      </SettingsRow>
    </>
  );
}
