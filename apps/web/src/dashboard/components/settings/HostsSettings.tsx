import { Button, Input } from "@band-app/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Plus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { openDesktopViewer } from "../../../lib/desktop-viewer";
import { crossOriginHub } from "../../../lib/hub-config";
import { trpc } from "../../../lib/trpc-client";
import { useAdapter } from "../../context";
import { SettingsRow } from "./SettingsRow";
import { ThisComputerSettings } from "./ThisComputerSettings";
import {
  WORKER_INSTALL_TABS,
  type WorkerInstallTab,
  workerInstallCommand,
} from "./worker-install-commands";

/** What a host reported per agent (installed, version, logged in), else the configured list from its hello. */
function agentSummary(host: HostList[number]): string {
  const report = host.report;
  if (!report) return host.agents.length > 0 ? host.agents.join(", ") : "none found";
  if (report.agents.length === 0) return "none found";
  return report.agents
    .map((a) => {
      if (!a.installed) return `${a.type} not installed`;
      const login =
        a.loggedIn === false ? "not logged in" : a.loggedIn ? "logged in" : "login unknown";
      return `${a.type}${a.version ? ` ${a.version}` : ""} ${login}`;
    })
    .join(", ");
}

const CAPABILITY_LABELS: Record<string, string> = {
  desktop: "Desktop",
  git: "Git",
  gh: "GitHub CLI",
  pty: "Terminals",
  acp: "Agents",
  lsp: "Language servers",
  search: "Search",
  fsWatch: "File watching",
};

/** The capabilities a host reported, as words. "Desktop" means it has a display and a VNC server. */
function capabilitySummary(host: HostList[number]): string {
  if (host.capabilities.length === 0) return "none reported";
  return host.capabilities.map((c) => CAPABILITY_LABELS[c] ?? c).join(", ");
}

/** The operating system and architecture a host reported, or "unknown" before its first connect. */
function osOf(host: HostList[number]): string {
  const info = host.info as { os?: unknown; arch?: unknown } | null;
  if (typeof info?.os !== "string") return "unknown";
  return typeof info.arch === "string" ? `${info.os} ${info.arch}` : info.os;
}

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

/** The hub URL a worker dials: the one this page reaches the hub at. */
function hubUrl(): string {
  return crossOriginHub()?.origin ?? window.location.origin;
}

/**
 * Rows for the Settings dialog's Hosts section: the machines Band can run
 * worktrees on, "Add worker" (a one-time bootstrap token and the command
 * that uses it) and the hub's tokens with a Revoke button. Changes apply
 * immediately; they are not part of the dialog's Save. A new token is shown
 * once, because the hub keeps only its hash.
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
  const hosts = useQuery<HostList>({
    queryKey: HOSTS_KEY,
    queryFn: async () => (await trpc.hosts.list.query()).hosts,
  });
  // Device tokens are managed in Settings > Devices; Hosts keeps the workers' tokens.
  const tokens = useQuery<TokenList>({
    queryKey: TOKENS_KEY,
    queryFn: async () => (await trpc.tokens.list.query()).tokens,
    select: (all) => all.filter((t) => t.kind !== "device"),
  });

  const [adding, setAdding] = useState(false);
  const [hostName, setHostName] = useState("");
  const [labels, setLabels] = useState("");
  const [issued, setIssued] = useState<IssuedWorker | null>(null);
  const [installTab, setInstallTab] = useState<WorkerInstallTab>("service");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = () => Promise.all([refetchFresh(HOSTS_KEY), refetchFresh(TOKENS_KEY)]);

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

  const removeHost = async (host: HostList[number]) => {
    setError(null);
    try {
      await trpc.hosts.remove.mutate({ hostId: host.id });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    await refresh();
  };

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).catch(() => undefined);
  };

  const closeAdd = () => {
    setAdding(false);
    setInstallTab("service");
    setIssued(null);
    setError(null);
  };

  const installCommand = issued
    ? workerInstallCommand(installTab, {
        hubUrl: hubUrl(),
        hostId: issued.hostId,
        token: issued.token,
      })
    : "";

  return (
    <>
      <ThisComputerSettings />
      <SettingsRow
        variant="stacked"
        label="Hosts"
        description="Machines that run worktrees. Workers connect to the hub and appear here. On a hub started with BAND_LOCAL_HOST=off the hub itself runs no worktrees and is not listed."
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
                {host.usable ? (
                  <div className="text-xs text-muted-foreground">
                    <span data-testid="settings__host-agents">Agents: {agentSummary(host)}</span>
                    {" · "}
                    <span data-testid="settings__host-roots">
                      Roots: {host.roots.length > 0 ? host.roots.join(", ") : "any path"}
                    </span>
                  </div>
                ) : null}
                {host.usable ? (
                  <div className="text-xs text-muted-foreground">
                    <span data-testid="settings__host-os">OS: {osOf(host)}</span>
                    {" · "}
                    <span data-testid="settings__host-capabilities">
                      Capabilities: {capabilitySummary(host)}
                    </span>
                  </div>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span data-testid="settings__host-status" className="text-xs text-muted-foreground">
                  {host.status}
                </span>
                {host.capabilities.includes("desktop") && host.status === "online" && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label={`Open desktop of ${host.name}`}
                    data-testid="settings__host-open-desktop"
                    onClick={() => openDesktopViewer(host.id)}
                  >
                    Open desktop
                  </Button>
                )}
                {host.id !== "local" && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label={`Remove host ${host.name}`}
                    data-testid="settings__host-remove"
                    disabled={host.status === "online" || host.status === "lost"}
                    onClick={() => void removeHost(host)}
                  >
                    Remove
                  </Button>
                )}
              </div>
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
            <div className="text-xs font-medium">Run on the worker machine</div>
            <div role="tablist" aria-label="Install method" className="flex flex-wrap gap-1">
              {WORKER_INSTALL_TABS.map((tab) => (
                <Button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={installTab === tab.id}
                  data-testid={`settings__install-tab-${tab.id}`}
                  variant={installTab === tab.id ? "secondary" : "ghost"}
                  size="sm"
                  onClick={() => setInstallTab(tab.id)}
                >
                  {tab.label}
                </Button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              {WORKER_INSTALL_TABS.find((t) => t.id === installTab)?.hint}
            </p>
            <textarea
              aria-label="Worker install command"
              readOnly
              rows={installTab === "compose" ? 14 : 4}
              value={installCommand}
              data-testid="settings__worker-command"
              data-tab={installTab}
              className="w-full rounded-md border border-border bg-transparent p-2 font-mono text-xs"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="settings__copy-worker-command"
              onClick={() => copy(installCommand)}
            >
              <Copy className="size-3" />
              Copy command
            </Button>
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
        label="Worker tokens"
        description="Revoking a worker token disconnects that worker. Device tokens are in Settings > Devices."
      >
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
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0"
                aria-label={`Revoke token ${token.label || token.id}`}
                disabled={token.state !== "active"}
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
