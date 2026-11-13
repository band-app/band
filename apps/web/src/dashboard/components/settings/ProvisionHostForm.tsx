import { Button, Input } from "@band-app/ui";
import { useQuery } from "@tanstack/react-query";
import { Copy, Terminal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { crossOriginHub } from "../../../lib/hub-config";
import { trpc } from "../../../lib/trpc-client";
import { useIsAdmin } from "./DevicesSettings";
import { ErrorPopover } from "./ErrorPopover";
import { useWorkerProfiles } from "./WorkerProfilesSettings";

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
 * "Add a worker", one command to paste on a blank Linux or macOS computer, with the optional
 * provisioning repo it runs first, the live status and the log.
 * Admin only. It is one tab of the Add worker dialog; manual install is the other.
 */
export function ProvisionHostForm() {
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
  const [profile, setProfile] = useState("");
  const [tokenItem, setTokenItem] = useState("");
  const vault = useQuery({
    queryKey: ["vault.list"],
    queryFn: async () => (await trpc.vault.list.query()).items,
    enabled: isAdmin,
  });
  const profiles = useWorkerProfiles(isAdmin);
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
    setTokenItem(settings.data.tokenItem ?? "");
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
        tokenItem,
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
          profile: profile || undefined,
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
    <div className="space-y-2" data-testid="settings__provision">
      <p className="text-xs text-muted-foreground">
        Paste one command on a blank Linux or macOS computer. It works once and expires in an hour.
      </p>
      <details>
        <summary className="cursor-pointer text-xs font-medium">Provisioning repo</summary>
        <div className="mt-2 space-y-2">
          <p className="text-xs text-muted-foreground">
            Optional. The hub fetches this repo with the vault item chosen below and the computer
            runs the start command from it before the worker starts. Leave it empty for the built-in
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
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setStartCommand(e.target.value)}
              className="h-8 text-sm"
            />
          </div>
          <select
            aria-label="Provisioning token item"
            value={tokenItem}
            onChange={(e) => setTokenItem(e.target.value)}
            className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm"
          >
            <option value="">No token item</option>
            {(vault.data ?? [])
              .filter((i) => i.kind === "api_key" || i.kind === "env")
              .map((i) => (
                <option key={i.id} value={i.name}>
                  {i.name}
                </option>
              ))}
          </select>
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
          {(profiles.data?.profiles ?? []).length > 0 ? (
            <select
              aria-label="Worker profile"
              data-testid="settings__provision-profile"
              value={profile}
              onChange={(e) => setProfile(e.target.value)}
              className="h-8 shrink-0 rounded-md border border-input bg-transparent px-2 text-sm"
            >
              <option value="">No profile</option>
              {(profiles.data?.profiles ?? []).map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}
                </option>
              ))}
            </select>
          ) : null}
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
        <ErrorPopover
          label="Provisioning failed"
          testId="settings__provision-error"
          message={error}
        />
      ) : null}
    </div>
  );
}
