import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Popover,
  PopoverContent,
  PopoverTrigger,
  SegmentedControl,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@band-app/ui";
import { Info } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { trpc } from "../../../lib/trpc-client";
import { ErrorPopover } from "./ErrorPopover";
import { HostAgentCommands } from "./HostAgentCommands";
import { type ThisComputer, ThisComputerDrawerSection } from "./ThisComputerSettings";
import { WorkerUpdatesSection } from "./WorkerUpdatesSection";
import {
  type AgentLine,
  agentLines,
  capabilityList,
  errorText,
  formatTime,
  type HostItem,
  osOf,
  STATUS_PILL,
  type TokenView,
  TRUST_HINT,
  TRUST_LABEL,
  TRUST_LEVELS,
  type TrustLevel,
} from "./worker-format";

function Section({
  title,
  testId,
  children,
}: {
  title: string;
  testId: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2 border-t border-border px-4 py-3.5" data-testid={testId}>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}

const AGENT_TONE: Record<AgentLine["state"]["tone"], string> = {
  ok: "text-success",
  warn: "text-warning",
  bad: "text-destructive",
  muted: "text-muted-foreground",
};

interface Props {
  host: HostItem | null;
  isAdmin: boolean;
  /** The worker's live session token, when the caller may see tokens. */
  sessionToken: TokenView | null;
  isThisComputer: boolean;
  thisComputer: ThisComputer;
  onClose: () => void;
  onEvacuate: (hostId: string) => void;
  /** Reads the worker list, tokens and activity again after a change. */
  refresh: () => Promise<unknown>;
}

/**
 * The detail drawer of one worker: Updates, Agents, Trust and access, Details and the Danger
 * zone. A side sheet on wide windows and the full screen on a phone.
 */
export function WorkerDrawer({
  host,
  isAdmin,
  sessionToken,
  isThisComputer,
  thisComputer,
  onClose,
  onEvacuate,
  refresh,
}: Props) {
  const [trustError, setTrustError] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);
  const hostId = host?.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset the per-worker state when another worker opens
  useEffect(() => {
    setTrustError(null);
    setRevokeError(null);
    setRemoveError(null);
    setConfirmRemove(false);
  }, [hostId]);

  const setTrust = async (hostItem: HostItem, trust: TrustLevel) => {
    setTrustError(null);
    try {
      await trpc.workers.setTrust.mutate({ hostId: hostItem.id, trust });
    } catch (err) {
      setTrustError(errorText(err));
    }
    await refresh();
  };

  const revoke = async (token: TokenView) => {
    setRevokeError(null);
    try {
      await trpc.tokens.revoke.mutate({ tokenId: token.id });
    } catch (err) {
      setRevokeError(errorText(err));
    }
    await refresh();
  };

  const remove = async (hostItem: HostItem) => {
    setRemoving(true);
    setRemoveError(null);
    try {
      await trpc.workers.remove.mutate({ hostId: hostItem.id });
      setConfirmRemove(false);
      onClose();
    } catch (err) {
      setConfirmRemove(false);
      setRemoveError(errorText(err));
    } finally {
      setRemoving(false);
    }
    await refresh();
  };

  const removeBlocked =
    host && (host.status === "online" || host.status === "lost")
      ? `${host.name} is ${host.status}. Stop its worker process first; a worker can be removed once it is offline.`
      : null;

  return (
    <Sheet open={host !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        className="w-full overflow-y-auto sm:w-[30rem] sm:max-w-none"
        data-testid="settings__host-drawer"
        data-host-id={host?.id}
      >
        {host ? (
          <>
            <SheetHeader className="pr-12">
              <SheetTitle className="flex flex-wrap items-center gap-2">
                <span data-testid="settings__host-drawer-name">{host.name}</span>
                <span
                  className={`rounded-full px-2.5 py-0.5 text-xs font-normal ${STATUS_PILL[host.status] ?? "bg-muted text-muted-foreground"}`}
                >
                  {host.status}
                </span>
              </SheetTitle>
              <SheetDescription>{osOf(host)}</SheetDescription>
            </SheetHeader>

            {host.usable ? (
              <Section title="Updates" testId="settings__host-updates">
                <WorkerUpdatesSection
                  host={host}
                  isAdmin={isAdmin}
                  bundled={isThisComputer && thisComputer.status?.bundled === true}
                />
              </Section>
            ) : null}

            {host.usable ? (
              <Section title="Agents" testId="settings__host-agents-section">
                <HostAgentCommands host={host} isAdmin={isAdmin} onChanged={() => void refresh()} />
              </Section>
            ) : null}

            {isThisComputer ? (
              <Section title="This computer" testId="settings__host-this-computer">
                <ThisComputerDrawerSection computer={thisComputer} />
              </Section>
            ) : null}

            {host.id !== "local" ? (
              <Section title="Trust and access" testId="settings__host-trust-section">
                {isAdmin ? (
                  <div className="flex items-center gap-2">
                    <SegmentedControl<TrustLevel>
                      ariaLabel={`Trust level of ${host.name}`}
                      value={host.trust}
                      onChange={(level) => void setTrust(host, level)}
                      options={TRUST_LEVELS.map((level) => ({
                        value: level,
                        label: TRUST_LABEL[level],
                      }))}
                      className="bg-muted"
                    />
                    {trustError ? (
                      <ErrorPopover
                        label="Could not change the trust level"
                        testId="settings__host-trust-error"
                        message={trustError}
                      />
                    ) : null}
                  </div>
                ) : (
                  <span
                    data-testid="settings__host-drawer-trust"
                    className="inline-block rounded-md border border-border px-1.5 py-0.5 text-xs text-muted-foreground"
                  >
                    {TRUST_LABEL[host.trust]}
                  </span>
                )}
                <p
                  className="text-xs text-muted-foreground"
                  data-testid="settings__host-trust-hint"
                >
                  {TRUST_HINT[host.trust]}
                </p>
                {isAdmin ? (
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <div className="min-w-0">
                      <div className="font-medium">Session token</div>
                      <div className="text-muted-foreground">
                        {sessionToken
                          ? `Last used ${formatTime(sessionToken.lastUsedAt)}`
                          : "No active session token."}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {revokeError ? (
                        <ErrorPopover
                          label="Could not revoke the session token"
                          testId="settings__host-revoke-error"
                          message={revokeError}
                        />
                      ) : null}
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        data-testid="settings__host-revoke"
                        aria-label={`Revoke the session token of ${host.name}`}
                        disabled={!sessionToken}
                        onClick={() => sessionToken && void revoke(sessionToken)}
                      >
                        Revoke
                      </Button>
                    </div>
                  </div>
                ) : null}
              </Section>
            ) : null}

            <Section title="Details" testId="settings__host-details">
              <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-2.5 text-xs">
                <dt className="text-muted-foreground">ID</dt>
                <dd data-testid="settings__host-id" className="break-all font-mono">
                  {host.id}
                </dd>
                <dt className="text-muted-foreground">Labels</dt>
                <dd>
                  {host.labels.length > 0 ? (
                    <span className="flex flex-wrap gap-1">
                      {host.labels.map((label) => (
                        <span key={label} className="rounded bg-muted px-1.5 py-0.5">
                          {label}
                        </span>
                      ))}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">None</span>
                  )}
                </dd>
                <dt className="text-muted-foreground">Last seen</dt>
                <dd>{formatTime(host.lastSeenAt)}</dd>
                {host.usable ? (
                  <>
                    <dt className="text-muted-foreground">OS</dt>
                    <dd data-testid="settings__host-os">{osOf(host)}</dd>
                    <dt className="text-muted-foreground">Roots</dt>
                    <dd data-testid="settings__host-roots" className="break-all font-mono">
                      {host.roots.length > 0 ? (
                        host.roots.join(", ")
                      ) : (
                        <span className="font-sans text-muted-foreground">Any path</span>
                      )}
                    </dd>
                    <dt className="text-muted-foreground">Agents</dt>
                    <dd data-testid="settings__host-agents">
                      {agentLines(host).length === 0 ? (
                        <span className="text-muted-foreground">None found</span>
                      ) : (
                        <ul className="space-y-1">
                          {agentLines(host).map((a) => (
                            <li key={a.type} className="flex flex-wrap items-center gap-x-2">
                              <span className="font-medium">{a.type}</span>
                              {a.version ? (
                                <span className="text-muted-foreground">{a.version}</span>
                              ) : null}
                              <span className={AGENT_TONE[a.state.tone]}>{a.state.label}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </dd>
                    <dt className="text-muted-foreground">Capabilities</dt>
                    <dd data-testid="settings__host-capabilities">
                      {capabilityList(host).length === 0 ? (
                        <span className="text-muted-foreground">None reported</span>
                      ) : (
                        <span className="flex flex-wrap gap-1">
                          {capabilityList(host).map((c) => (
                            <span key={c} className="rounded bg-muted px-1.5 py-0.5">
                              {c}
                            </span>
                          ))}
                        </span>
                      )}
                    </dd>
                  </>
                ) : null}
              </dl>
            </Section>

            {host.id !== "local" && isAdmin ? (
              <Section title="Danger zone" testId="settings__host-danger">
                <div className="flex flex-wrap items-center gap-2">
                  {host.status !== "disposed" ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      data-testid="settings__host-evacuate"
                      onClick={() => onEvacuate(host.id)}
                    >
                      Move all worktrees…
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    data-testid="settings__host-remove"
                    aria-label={`Remove worker ${host.name}`}
                    disabled={removeBlocked !== null}
                    onClick={() => setConfirmRemove(true)}
                  >
                    Remove worker
                  </Button>
                  {removeBlocked ? (
                    <Popover>
                      <PopoverTrigger asChild>
                        <button
                          type="button"
                          aria-label="Why this worker cannot be removed"
                          data-testid="settings__host-remove-reason-icon"
                          className="shrink-0 rounded-sm text-muted-foreground hover:text-foreground"
                        >
                          <Info className="size-3.5" aria-hidden="true" />
                        </button>
                      </PopoverTrigger>
                      <PopoverContent align="start" className="w-72 text-xs">
                        <p data-testid="settings__host-remove-reason">{removeBlocked}</p>
                      </PopoverContent>
                    </Popover>
                  ) : null}
                  {removeError ? (
                    <ErrorPopover
                      label="Could not remove the worker"
                      testId="settings__host-remove-error"
                      message={removeError}
                    />
                  ) : null}
                </div>
              </Section>
            ) : null}

            <Dialog
              open={confirmRemove}
              onOpenChange={(next) => !removing && setConfirmRemove(next)}
            >
              <DialogContent
                className="sm:max-w-[420px]"
                data-testid="settings__host-remove-dialog"
              >
                <DialogHeader>
                  <DialogTitle>Remove {host.name}?</DialogTitle>
                  <DialogDescription>
                    The hub forgets this worker and revokes its tokens, so it cannot connect again.
                    A worker with worktrees cannot be removed.
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <Button
                    variant="ghost"
                    disabled={removing}
                    data-testid="settings__host-remove-cancel"
                    onClick={() => setConfirmRemove(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="destructive"
                    data-testid="settings__host-remove-confirm"
                    disabled={removing}
                    onClick={() => void remove(host)}
                  >
                    Remove worker
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
