import { Button, Input } from "@band-app/ui";
import { useQuery } from "@tanstack/react-query";
import { Copy, Terminal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { crossOriginHub } from "../../../lib/hub-config";
import { trpc } from "../../../lib/trpc-client";
import { useIsAdmin } from "./DevicesSettings";
import { SettingsRow } from "./SettingsRow";

type Created = Awaited<ReturnType<typeof trpc.provisioning.createCommand.mutate>>;
type View = Awaited<ReturnType<typeof trpc.provisioning.status.query>>["commands"][number];

const STATUS_LABEL: Record<string, string> = {
  waiting: "Waiting for the command to run",
  provisioning: "Provisioning",
  online: "Online",
  failed: "Failed",
  expired: "Expired",
};

/** The address the new machine reaches the hub at: the one this page uses. */
function hubUrl(): string {
  return crossOriginHub()?.origin ?? window.location.origin;
}

function copy(text: string) {
  void navigator.clipboard?.writeText(text).catch(() => undefined);
}

/**
 * "Add a host": one command to paste on a blank Linux or macOS computer, with the optional
 * provisioning repo it runs first, the live status and the log.
 * Admin only. Manual install stays in the row below.
 */
export function ProvisionHostRow() {
  const isAdmin = useIsAdmin();
  const settings = useQuery({
    queryKey: ["provisioning", "settings"],
    queryFn: () => trpc.provisioning.settings.query(),
    enabled: isAdmin,
  });
  const [repoUrl, setRepoUrl] = useState("");
  const [branch, setBranch] = useState("");
  const [startCommand, setStartCommand] = useState("");
  const [hostName, setHostName] = useState("");
  const [created, setCreated] = useState<Created | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const hydrated = useRef(false);
  useEffect(() => {
    if (!settings.data || hydrated.current) return;
    hydrated.current = true;
    setRepoUrl(settings.data.repoUrl);
    setBranch(settings.data.branch);
    setStartCommand(settings.data.command);
  }, [settings.data]);

  const id = created?.id;
  useEffect(() => {
    if (!id) return;
    let stopped = false;
    let finished = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    const poll = async () => {
      if (finished) return;
      try {
        const { commands } = await trpc.provisioning.status.query({ id });
        const next = commands[0] ?? null;
        if (stopped) return;
        setView(next);
        if (next && ["online", "failed", "expired"].includes(next.status)) {
          finished = true;
          clearInterval(timer);
        }
      } catch {
        // The next tick tries again.
      }
    };
    void poll();
    timer = setInterval(() => void poll(), 2000);
    return () => {
      stopped = true;
      if (timer) clearInterval(timer);
    };
  }, [id]);

  if (!isAdmin) return null;

  const saveRepo = async () => {
    setError(null);
    setNotice(null);
    try {
      await trpc.provisioning.updateSettings.mutate({
        repoUrl: repoUrl.trim(),
        branch: branch.trim(),
        command: startCommand.trim() || undefined,
      });
      setNotice("Saved. New commands use this repo.");
      await settings.refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const create = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setView(null);
      setCreated(
        await trpc.provisioning.createCommand.mutate({
          hubUrl: hubUrl(),
          hostName: hostName.trim() || undefined,
        }),
      );
      setHostName("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const status = view?.status ?? "waiting";

  return (
    <SettingsRow
      variant="stacked"
      label="Add a worker"
      description="Paste one command on a blank Linux or macOS computer. It works once and expires in an hour."
    >
      <div className="space-y-2" data-testid="settings__provision">
        <details>
          <summary className="cursor-pointer text-xs font-medium">Provisioning repo</summary>
          <div className="mt-2 space-y-2">
            <p className="text-xs text-muted-foreground">
              Optional. The hub fetches this repo with its git credential and the computer runs the
              start command from it before the worker starts. Leave it empty for the built-in
              install.
            </p>
            <Input
              aria-label="Provisioning repo URL"
              placeholder="https://github.com/you/dotfiles.git"
              value={repoUrl}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setRepoUrl(e.target.value)}
              className="h-8 text-sm"
            />
            <div className="flex gap-2">
              <Input
                aria-label="Provisioning repo branch"
                placeholder="Branch (default branch if empty)"
                value={branch}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setBranch(e.target.value)}
                className="h-8 text-sm"
              />
              <Input
                aria-label="Provisioning start command"
                placeholder="band/provision.sh"
                value={startCommand}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setStartCommand(e.target.value)
                }
                className="h-8 text-sm"
              />
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="settings__provision-save"
              onClick={() => void saveRepo()}
            >
              Save repo
            </Button>
          </div>
        </details>

        {created ? (
          <div className="space-y-2" data-testid="settings__provision-result">
            <textarea
              aria-label="Provisioning command"
              readOnly
              rows={3}
              value={created.command}
              data-testid="settings__provision-command"
              className="w-full rounded-md border border-border bg-transparent p-2 font-mono text-xs"
            />
            <p
              className="text-xs text-muted-foreground"
              data-testid="settings__provision-expiry"
              data-expires-at={created.expiresAt}
            >
              Expires {new Date(created.expiresAt).toLocaleString()}. It works once.
              {created.commitSha ? ` Repo pinned at ${created.commitSha.slice(0, 12)}.` : ""}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="settings__provision-copy"
                onClick={() => copy(created.command)}
              >
                <Copy className="size-3" />
                Copy command
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="settings__provision-copy-cloud-init"
                onClick={() => copy(created.cloudInit)}
              >
                <Copy className="size-3" />
                Copy as cloud-init
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setCreated(null)}>
                Done
              </Button>
            </div>
            <div className="text-xs" data-testid="settings__provision-status" data-status={status}>
              {STATUS_LABEL[status] ?? status}
              {view?.hostId ? ` (${view.hostId})` : ""}
            </div>
            {view?.log ? (
              <pre
                data-testid="settings__provision-log"
                className="max-h-64 overflow-auto rounded-md border border-border p-2 font-mono text-xs"
              >
                {view.log}
              </pre>
            ) : null}
          </div>
        ) : (
          <div className="flex gap-2">
            <Input
              aria-label="Name for the new worker"
              placeholder="Worker name (optional)"
              value={hostName}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setHostName(e.target.value)}
              className="h-8 text-sm"
            />
            <Button
              type="button"
              size="sm"
              disabled={busy}
              data-testid="settings__provision-create"
              onClick={() => void create()}
            >
              <Terminal className="size-3" />
              Get provisioning command
            </Button>
          </div>
        )}
        {notice ? <p className="text-xs text-muted-foreground">{notice}</p> : null}
        {error ? (
          <p
            role="alert"
            className="text-xs text-destructive"
            data-testid="settings__provision-error"
          >
            {error}
          </p>
        ) : null}
      </div>
    </SettingsRow>
  );
}
