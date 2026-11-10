import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
} from "@band-app/ui";
import { CircleAlert, CircleCheck, Clock, Download, Loader } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useHostsList } from "../../hooks/use-update-status";
import { CopyCommand } from "../CopyCommand";
import { useHubUpdate } from "../useHubUpdate";
import { ErrorPopover } from "./ErrorPopover";
import { UpdateControls } from "./UpdateControls";

type UpdateState = "up-to-date" | "available" | "updating" | "waiting" | "failed" | "blocked";

const RESULT_LABEL = { ok: "Succeeded", failed: "Failed", "rolled-back": "Rolled back" } as const;

/**
 * The Updates card of Settings > Hub: one state line (Up to date, Update available, Updating,
 * Waiting for agent turns, Failed, Cannot update itself) with its action, the auto-update switch,
 * the last run with a View log dialog, and the custom command under Advanced.
 */
export function HubUpdateCard({ onOpenWorkers }: { onOpenWorkers?: () => void }) {
  const hub = useHubUpdate();
  const { status, hubUpdate, updating, busy, error, savedUpdate } = hub;
  const hosts = useHostsList();
  const [logOpen, setLogOpen] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);

  const data = status.data;
  const saved = savedUpdate?.command ?? "";
  const available = data?.updateAvailable === true;
  const lastRun = hubUpdate?.lastRun ?? null;

  let state: UpdateState = "up-to-date";
  if (hubUpdate?.state === "failed") state = "failed";
  else if (updating) state = "updating";
  else if (hubUpdate?.deferredSince) state = "waiting";
  else if (available && hubUpdate && !hubUpdate.configured) state = "blocked";
  else if (available) state = "available";

  const checkedAt = data?.checkedAt ? new Date(data.checkedAt).toLocaleString() : null;
  const usableHosts = (hosts.data ?? []).filter((h) => h.usable && h.status !== "disposed");
  const behind = usableHosts.filter((h) => h.versionState === "behind").length;

  let headline: ReactNode;
  let icon: ReactNode;
  switch (state) {
    case "available":
      headline = `Update available ${data?.latest ?? ""}`;
      icon = <Download className="size-4 text-warning" aria-hidden="true" />;
      break;
    case "updating":
      headline = `Updating to ${hubUpdate?.target ?? "the new version"}`;
      icon = <Loader className="size-4 animate-spin text-muted-foreground" aria-hidden="true" />;
      break;
    case "waiting":
      headline = "Waiting for agent turns";
      icon = <Clock className="size-4 text-warning" aria-hidden="true" />;
      break;
    case "failed":
      headline = "Update failed";
      icon = <CircleAlert className="size-4 text-destructive" aria-hidden="true" />;
      break;
    case "blocked":
      headline = "Cannot update itself";
      icon = <CircleAlert className="size-4 text-warning" aria-hidden="true" />;
      break;
    default:
      headline = "Up to date";
      icon = <CircleCheck className="size-4 text-success" aria-hidden="true" />;
  }

  const method = hubUpdate?.hasCommand
    ? "Custom command"
    : hubUpdate?.builtIn
      ? "Built-in updater"
      : "Manual";

  return (
    <div className="space-y-3" data-testid="hub-update-section">
      <div
        className="flex flex-wrap items-center gap-x-3 gap-y-2"
        data-testid="hub-update__status"
        data-state={state}
      >
        {icon}
        <div className="min-w-0 flex-1 text-sm">
          <div className="font-medium" data-testid="hub-update__headline">
            {headline}
          </div>
          <div className="text-xs text-muted-foreground" data-testid="hub-update__summary">
            {state === "up-to-date"
              ? `Version ${data?.hubVersion ?? "unknown"}${checkedAt ? `. Checked ${checkedAt}` : ""}`
              : `Running ${data?.hubVersion ?? "unknown"}`}
            {state === "waiting" && hubUpdate?.deferredSince
              ? `. Waiting since ${new Date(hubUpdate.deferredSince).toLocaleString()}`
              : ""}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {state === "failed" ? (
            <>
              <ErrorPopover
                label="Update failed"
                testId="hub-update__error"
                message={hubUpdate?.error}
                onDismiss={() => void hub.dismiss()}
                dismissTestId="hub-update__dismiss"
              />
              <Button
                type="button"
                size="sm"
                data-testid="hub-update__retry"
                disabled={busy}
                onClick={() => void hub.dismiss().then(() => hub.startUpdate())}
              >
                Retry
              </Button>
            </>
          ) : null}
          {state === "available" || state === "updating" ? (
            <Button
              type="button"
              size="sm"
              data-testid="hub-update__button"
              disabled={busy || updating}
              onClick={() => void hub.startUpdate()}
            >
              {updating ? "Updating…" : "Update now"}
            </Button>
          ) : null}
          {error ? (
            <ErrorPopover
              label="The hub update action failed"
              testId="hub-update__action-error"
              message={error}
            />
          ) : null}
        </div>
      </div>
      {state === "updating" ? (
        <p className="text-xs text-muted-foreground" data-testid="hub-update__state">
          This page reconnects when the hub is back.
        </p>
      ) : null}
      {state === "blocked" ? (
        <div
          className="space-y-1 text-xs text-muted-foreground"
          data-testid="hub-update__manual-note"
        >
          <p data-testid="hub-update__blocked">
            {hubUpdate?.builtInBlockedReason
              ? `The built-in updater is off: ${hubUpdate.builtInBlockedReason}. `
              : ""}
            Run this on the hub's machine, then restart the hub:
          </p>
          {data?.hubCommand ? (
            <CopyCommand
              command={data.hubCommand}
              testId="hub-update__manual"
              label="Copy the hub update command"
            />
          ) : null}
        </div>
      ) : null}

      <UpdateControls
        testId="hub-update"
        name="the hub"
        version={data?.hubVersion ?? null}
        updateAction={null}
        auto={savedUpdate?.auto === true}
        onAutoChange={(on) => void hub.setAuto(on)}
        autoLabel="Update automatically. Waits for running agent turns."
        autoDisabledReason={null}
        busy={busy || hubUpdate?.builtIn === false}
      />

      {lastRun ? (
        <div
          className="flex flex-wrap items-center gap-x-2 text-xs"
          data-testid="hub-update__last-run"
        >
          <span data-testid="hub-update__last-result">
            Last update: {lastRun.from} → {lastRun.to} · {RESULT_LABEL[lastRun.result]} ·{" "}
            {new Date(lastRun.at).toLocaleString()}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="hub-update__view-log"
            onClick={() => setLogOpen(true)}
          >
            View log
          </Button>
        </div>
      ) : state === "failed" && hubUpdate?.logTail ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid="hub-update__view-log"
          onClick={() => setLogOpen(true)}
        >
          View log
        </Button>
      ) : null}

      <Dialog open={logOpen} onOpenChange={setLogOpen}>
        <DialogContent className="sm:max-w-[640px]" data-testid="hub-update__log-dialog">
          <DialogHeader>
            <DialogTitle>Hub update log</DialogTitle>
            <DialogDescription>The last lines of the update log.</DialogDescription>
          </DialogHeader>
          {lastRun?.backup ? (
            <div className="text-xs">
              <span className="text-muted-foreground">Backup </span>
              <span className="break-all font-mono" data-testid="hub-update__backup">
                {lastRun.backup}
              </span>
            </div>
          ) : null}
          <pre
            data-testid="hub-update__log"
            className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border p-2 font-mono text-xs text-muted-foreground"
          >
            {hubUpdate?.logTail || "The log is empty."}
          </pre>
        </DialogContent>
      </Dialog>
      {hub.dialog}

      {usableHosts.length > 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="hub-update__workers-line">
          {behind === 0
            ? "Every worker runs the hub's version."
            : `${behind} of ${usableHosts.length} ${usableHosts.length === 1 ? "worker is" : "workers are"} behind the hub.`}{" "}
          {onOpenWorkers ? (
            <button
              type="button"
              data-testid="hub-update__open-workers"
              className="underline"
              onClick={onOpenWorkers}
            >
              Open Workers
            </button>
          ) : null}
        </p>
      ) : null}

      <details className="text-xs" data-testid="hub-update__advanced">
        <summary className="cursor-pointer font-medium" data-testid="hub-update__advanced-toggle">
          Advanced
        </summary>
        <div className="mt-2 space-y-2">
          <div className="text-muted-foreground" data-testid="hub-update__method">
            Update method: {method}
          </div>
          <label className="block font-medium" htmlFor="hub-update-command">
            Custom update command
          </label>
          <div className="flex items-center gap-2">
            <Input
              id="hub-update-command"
              data-testid="hub-update__command"
              placeholder="Not set"
              value={draft ?? saved}
              onChange={(e) => setDraft(e.target.value)}
              className="h-8 font-mono text-xs"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="hub-update__save"
              disabled={busy || draft === null || draft === saved}
              onClick={() => void hub.saveCommand(draft ?? "").then(() => setDraft(null))}
            >
              Save
            </Button>
          </div>
          <p className="text-muted-foreground">
            Runs on the hub's machine and overrides the built-in updater. Leave it empty to use the
            built-in updater.
          </p>
        </div>
      </details>
    </div>
  );
}
