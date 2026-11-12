import { Button, Input } from "@band-app/ui";
import { useQuery } from "@tanstack/react-query";
import { Terminal } from "lucide-react";
import { useEffect, useState } from "react";
import { useThisComputerWorker } from "../../../lib/this-computer-worker";
import { trpc } from "../../../lib/trpc-client";
import { useIsAdmin } from "./DevicesSettings";
import { ErrorPopover } from "./ErrorPopover";
import { errorText, type HostList, hubUrl } from "./worker-format";

type View = Awaited<ReturnType<typeof trpc.provisioning.status.query>>["commands"][number];
type Fingerprints = { type: string; fingerprint: string }[];

const STATUS_LABEL: Record<string, string> = {
  waiting: "Connecting over ssh",
  provisioning: "Provisioning",
  online: "Online",
  failed: "Failed",
  expired: "Expired",
};

/**
 * "Over ssh": installs a worker on a machine from the ssh config of this computer's worker, or
 * of a worker the admin picks when this computer has none. ssh never asks for input, and a host
 * whose key is new is installed only after the admin confirms its fingerprint.
 */
export function SshInstallForm() {
  const isAdmin = useIsAdmin();
  const thisComputer = useThisComputerWorker();
  const workers = useQuery<HostList>({
    queryKey: ["hosts.list"],
    queryFn: async () => (await trpc.workers.list.query()).hosts,
    enabled: isAdmin,
  });
  const online = (workers.data ?? []).filter((w) => w.status === "online");
  const mine = thisComputer.status;
  const thisWorker =
    mine?.forThisHub && mine.running && mine.hostId
      ? (online.find((w) => w.id === mine.hostId) ?? null)
      : null;
  const [picked, setPicked] = useState("");
  const workerId = thisWorker?.id ?? (online.some((w) => w.id === picked) ? picked : online[0]?.id);

  const hosts = useQuery({
    queryKey: ["provisioning", "ssh-hosts", workerId],
    queryFn: () => trpc.provisioning.sshHosts.query({ workerId: workerId as string }),
    enabled: isAdmin && !!workerId,
  });
  const [typed, setTyped] = useState("");
  const [hostName, setHostName] = useState("");
  const [pending, setPending] = useState<{ target: string; fingerprints: Fingerprints } | null>(
    null,
  );
  const [runId, setRunId] = useState<string | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!runId) return;
    let stopped = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    const poll = async () => {
      try {
        const { commands } = await trpc.provisioning.status.query({ id: runId });
        const next = commands[0] ?? null;
        if (stopped) return;
        setView(next);
        if (next && ["online", "failed", "expired"].includes(next.status)) clearInterval(timer);
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
  }, [runId]);

  if (!isAdmin) return null;

  const install = async (target: string, trustFingerprints?: string[]) => {
    if (!workerId) return;
    const result = await trpc.provisioning.sshInstall.mutate({
      workerId,
      target,
      hubUrl: hubUrl(),
      hostName: hostName.trim() || undefined,
      trustFingerprints,
    });
    setPending(null);
    setView(null);
    setRunId(result.id);
  };

  const start = async (target: string) => {
    if (!workerId) return;
    setBusy(true);
    setError(null);
    setPending(null);
    try {
      const found = await trpc.provisioning.sshInspect.mutate({ workerId, target });
      if (found.state === "unknown") {
        setPending({ target, fingerprints: found.fingerprints });
      } else {
        await install(target);
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      await install(
        pending.target,
        pending.fingerprints.map((f) => f.fingerprint),
      );
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const status = view?.status ?? "waiting";
  const failure = status === "failed" ? view?.log || "The install failed." : null;

  if (!workerId) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="settings__ssh-no-worker">
        No worker is online to run ssh from. Connect one first, or use the one-line command.
      </p>
    );
  }

  return (
    <div className="space-y-2" data-testid="settings__ssh">
      <p className="text-xs text-muted-foreground">
        Band runs ssh on a worker with that computer's keys and ssh config, then installs a worker
        on the machine you pick. ssh cannot ask for a passphrase or a password.
      </p>
      {thisWorker ? (
        <p className="text-xs" data-testid="settings__ssh-source" data-worker={thisWorker.id}>
          Running ssh from this computer ({thisWorker.name}).
        </p>
      ) : (
        <label className="block text-xs font-medium">
          Run ssh from
          <select
            aria-label="Run ssh from"
            data-testid="settings__ssh-worker"
            value={workerId}
            onChange={(e) => setPicked(e.target.value)}
            className="mt-1 block h-8 w-full rounded-md border border-border bg-transparent px-2 text-sm"
          >
            {online.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
      )}

      {hosts.data && hosts.data.length > 0 ? (
        <ul className="divide-y divide-border rounded-md border border-border">
          {hosts.data.map((h) => (
            <li
              key={h.name}
              className="flex items-center justify-between gap-2 px-2 py-1.5 text-sm"
              data-testid="settings__ssh-host"
              data-host={h.name}
            >
              <span className="min-w-0 truncate">
                <span className="font-medium">{h.name}</span>
                {h.label ? (
                  <span className="ml-2 text-xs text-muted-foreground">{h.label}</span>
                ) : null}
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                aria-label={`Install on ${h.name}`}
                data-testid="settings__ssh-host-install"
                onClick={() => void start(h.name)}
              >
                Install
              </Button>
            </li>
          ))}
        </ul>
      ) : hosts.data ? (
        <p className="text-xs text-muted-foreground" data-testid="settings__ssh-no-hosts">
          No hosts in that worker's ~/.ssh/config. Type user@host below.
        </p>
      ) : null}

      <div className="flex gap-2">
        <Input
          aria-label="ssh target"
          placeholder="user@host"
          value={typed}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTyped(e.target.value)}
          className="h-8 text-sm"
        />
        <Button
          type="button"
          size="sm"
          disabled={busy || typed.trim() === ""}
          data-testid="settings__ssh-target-install"
          onClick={() => void start(typed.trim())}
        >
          <Terminal className="size-3" />
          Install
        </Button>
      </div>
      <Input
        aria-label="Name for the new worker"
        placeholder="Worker name (optional)"
        value={hostName}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setHostName(e.target.value)}
        className="h-8 text-sm"
      />

      {pending ? (
        <div
          className="space-y-2 rounded-md border border-border p-2"
          data-testid="settings__ssh-confirm-panel"
        >
          <p className="text-xs">
            {pending.target} is not in known_hosts. Check that this fingerprint is the machine's
            before you continue.
          </p>
          {pending.fingerprints.map((f) => (
            <code
              key={f.fingerprint}
              data-testid="settings__ssh-fingerprint"
              className="block break-all font-mono text-xs"
            >
              {f.type} {f.fingerprint}
            </code>
          ))}
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              disabled={busy}
              data-testid="settings__ssh-confirm"
              onClick={() => void confirm()}
            >
              Trust and install
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              data-testid="settings__ssh-cancel"
              onClick={() => setPending(null)}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {runId ? (
        <div className="space-y-2" data-testid="settings__ssh-result">
          <div
            className="flex items-center gap-2 text-xs"
            data-testid="settings__ssh-status"
            data-status={status}
          >
            <span>
              {STATUS_LABEL[status] ?? status}
              {view?.hostId ? ` (${view.hostId})` : ""}
            </span>
            {failure ? (
              <ErrorPopover
                label="The install over ssh failed"
                testId="settings__ssh-run-error"
                message={failure}
              />
            ) : null}
          </div>
          {view?.log && status !== "failed" ? (
            <pre
              data-testid="settings__ssh-log"
              className="max-h-64 overflow-auto rounded-md border border-border p-2 font-mono text-xs"
            >
              {view.log}
            </pre>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <ErrorPopover
          label="Could not install over ssh"
          testId="settings__ssh-error"
          message={error}
        />
      ) : null}
    </div>
  );
}
