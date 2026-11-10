import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  SegmentedControl,
} from "@band-app/ui";
import { Copy } from "lucide-react";
import { useState } from "react";
import { trpc } from "../../../lib/trpc-client";
import { ErrorPopover } from "./ErrorPopover";
import { ProvisionHostForm } from "./ProvisionHostForm";
import { errorText, hubUrl } from "./worker-format";
import {
  WORKER_INSTALL_TABS,
  type WorkerInstallTab,
  workerInstallCommand,
} from "./worker-install-commands";

interface IssuedWorker {
  hostId: string;
  token: string;
}

type Method = "provision" | "manual";

function ManualInstall({ onIssued }: { onIssued: () => Promise<unknown> }) {
  const [hostName, setHostName] = useState("");
  const [labels, setLabels] = useState("");
  const [issued, setIssued] = useState<IssuedWorker | null>(null);
  const [installTab, setInstallTab] = useState<WorkerInstallTab>("service");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
      setIssued({ hostId: result.hostId, token: result.token });
      setHostName("");
      setLabels("");
      await onIssued();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const installCommand = issued
    ? workerInstallCommand(installTab, {
        hubUrl: hubUrl(),
        hostId: issued.hostId,
        token: issued.token,
      })
    : "";

  if (issued) {
    return (
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
        <div className="text-xs font-medium">Run on the worker</div>
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
          onClick={() => void navigator.clipboard?.writeText(installCommand).catch(() => undefined)}
        >
          <Copy className="size-3" />
          Copy command
        </Button>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        Create a one-time token for a worker on another computer. It works once and expires in an
        hour.
      </p>
      <Input
        aria-label="Worker name"
        placeholder="Worker name"
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
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          disabled={busy || hostName.trim() === ""}
          onClick={() => void issue()}
        >
          Create token
        </Button>
        {error ? (
          <ErrorPopover
            label="Could not create the token"
            testId="settings__bootstrap-error"
            message={error}
          />
        ) : null}
      </div>
    </div>
  );
}

/**
 * The one "Add worker" dialog: a provisioning command for a blank computer, or a manual install
 * with a one-time bootstrap token. Closing it drops the token from the page.
 */
export function AddWorkerDialog({
  open,
  onOpenChange,
  onIssued,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onIssued: () => Promise<unknown>;
}) {
  const [method, setMethod] = useState<Method>("provision");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[85dvh] overflow-y-auto sm:max-w-[560px]"
        data-testid="settings__add-worker-dialog"
      >
        <DialogHeader>
          <DialogTitle>Add worker</DialogTitle>
          <DialogDescription>Connect another computer to this hub.</DialogDescription>
        </DialogHeader>
        <SegmentedControl<Method>
          ariaLabel="How to add the worker"
          value={method}
          onChange={setMethod}
          options={[
            { value: "provision", label: "One command" },
            { value: "manual", label: "Manual install" },
          ]}
          className="w-fit bg-muted"
        />
        {method === "provision" ? <ProvisionHostForm /> : <ManualInstall onIssued={onIssued} />}
      </DialogContent>
    </Dialog>
  );
}
