import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Switch,
} from "@band-app/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useState } from "react";

import { trpc } from "../../../lib/trpc-client";
import { PairingDialog } from "./PairingDialog";
import { SettingsRow } from "./SettingsRow";

type TokenList = Awaited<ReturnType<typeof trpc.tokens.list.query>>["tokens"];
type DeviceView = TokenList[number];

const TOKENS_KEY = ["tokens.list"] as const;
const CURRENT_KEY = ["tokens.current"] as const;

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

function formatTime(at: number | null): string {
  return at == null ? "Never" : new Date(at).toLocaleString();
}

/** Whether the signed-in token is an admin one. Settings hides Devices when it is not. */
export function useIsAdmin(): boolean {
  const current = useQuery({
    queryKey: CURRENT_KEY,
    queryFn: () => trpc.tokens.current.query(),
    staleTime: 60_000,
  });
  return current.data?.admin === true;
}

/**
 * Settings > Devices: the devices that reach this hub, "Add device", "Connect details" (a link
 * and QR code with a one-time pairing code, `PairingDialog`) and Revoke, which signs a device
 * out and removes it. Admin only. The hub keeps only a hash of each device token, so a token
 * is never shown. A pairing code replaces the device's token when it is opened.
 */
export function DevicesSettings() {
  const queryClient = useQueryClient();
  const current = useQuery({
    queryKey: CURRENT_KEY,
    queryFn: () => trpc.tokens.current.query(),
  });
  const tokens = useQuery<TokenList>({
    queryKey: TOKENS_KEY,
    queryFn: async () => (await trpc.tokens.list.query()).tokens,
    // A new device signs in elsewhere, so poll to show its last-used time.
    refetchInterval: 5_000,
  });
  const devices = (tokens.data ?? []).filter((t) => t.kind === "device");

  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState("Phone");
  const [admin, setAdmin] = useState(false);
  const [pairing, setPairing] = useState<{ id: string; label: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const refresh = async () => {
    await queryClient.cancelQueries({ queryKey: TOKENS_KEY });
    await queryClient.invalidateQueries({ queryKey: TOKENS_KEY });
  };

  const closeAdd = () => {
    setAdding(false);
    setLabel("Phone");
    setAdmin(false);
    setError(null);
  };

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const { view } = await trpc.tokens.createUnpairedDevice.mutate({
        label: label.trim(),
        admin,
      });
      closeAdd();
      setPairing({ id: view.id, label: view.label });
      await refresh();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (device: DeviceView) => {
    setError(null);
    setConfirmingId(null);
    try {
      await trpc.tokens.revoke.mutate({ tokenId: device.id });
    } catch (err) {
      setError(errorText(err));
    }
    await refresh();
  };

  if (current.data && !current.data.admin) {
    return (
      <p
        role="alert"
        className="text-xs text-muted-foreground"
        data-testid="settings__devices-denied"
      >
        Managing devices needs an admin token.
      </p>
    );
  }

  return (
    <>
      <SettingsRow
        variant="stacked"
        label="Add device"
        description="Connect a phone, tablet or another browser with a one-time link and QR code."
      >
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="settings__add-device"
          onClick={() => setAdding(true)}
        >
          <Plus className="size-3" />
          Add device
        </Button>
      </SettingsRow>

      <SettingsRow
        variant="stacked"
        label="Devices"
        description="Revoking a device signs it out and removes it. The shared token in settings.json cannot be revoked here."
      >
        <ul className="divide-y divide-border rounded-md border border-border">
          {devices.map((device) => {
            const isThis = device.id === current.data?.tokenId;
            const confirming = confirmingId === device.id;
            return (
              <li
                key={device.id}
                data-testid="settings__device"
                data-token-id={device.id}
                data-state={device.state}
                data-current={isThis ? "true" : undefined}
                data-confirming={confirming ? (isThis ? "self" : "other") : undefined}
                className="flex items-center justify-between gap-2 px-3 py-2 text-sm"
              >
                <div className="min-w-0">
                  <div className="truncate">
                    {device.label || device.id}
                    {isThis ? (
                      <span
                        data-testid="settings__device-this"
                        className="ml-2 rounded bg-secondary px-1.5 py-0.5 text-xs"
                      >
                        This device
                      </span>
                    ) : null}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {device.admin ? "Admin" : "Standard"} · {device.state} · Added{" "}
                    {formatTime(device.createdAt)} · Last used {formatTime(device.lastUsedAt)}
                  </div>
                  {confirming ? (
                    <p role="alert" className="mt-1 text-xs text-destructive">
                      {isThis
                        ? "This is the token you are signed in with. Revoking it signs you out here."
                        : "Revoking signs this device out and removes it from the list."}
                    </p>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {confirming ? (
                    <>
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        aria-label={`Confirm revoke ${device.label || device.id}`}
                        onClick={() => void revoke(device)}
                      >
                        Revoke
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setConfirmingId(null)}
                      >
                        Cancel
                      </Button>
                    </>
                  ) : (
                    <>
                      {device.id === "shared" ? null : (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          aria-label={`Connect details ${device.label || device.id}`}
                          onClick={() => setPairing({ id: device.id, label: device.label })}
                        >
                          Connect details
                        </Button>
                      )}
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        aria-label={`Revoke device ${device.label || device.id}`}
                        disabled={device.state !== "active" || device.id === "shared"}
                        onClick={() => setConfirmingId(device.id)}
                      >
                        Revoke
                      </Button>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        {error && !adding ? (
          <p role="alert" className="mt-2 text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </SettingsRow>

      <Dialog open={adding} onOpenChange={(open) => (open ? setAdding(true) : closeAdd())}>
        <DialogContent className="sm:max-w-[420px]" data-testid="settings__add-device-dialog">
          <DialogHeader>
            <DialogTitle>Add device</DialogTitle>
            <DialogDescription>
              Name the device. You get a link and QR code to connect it next. You can revoke it from
              this list later.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              aria-label="Device label"
              placeholder="Label"
              value={label}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setLabel(e.target.value)}
              className="h-8 text-sm"
            />
            <div className="flex items-center justify-between gap-2">
              <label htmlFor="device-admin" className="text-sm">
                Admin device
              </label>
              <Switch id="device-admin" checked={admin} onCheckedChange={setAdmin} />
            </div>
            {admin ? (
              <p role="alert" className="text-xs text-destructive">
                An admin device can create and revoke devices, workers and credentials. Give it to
                devices you trust as much as this one.
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="ghost" size="sm" onClick={closeAdd}>
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={busy || label.trim() === ""}
                onClick={() => void create()}
              >
                Create device
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
      {pairing ? (
        <PairingDialog
          device={pairing}
          onClose={() => {
            setPairing(null);
            void refresh();
          }}
        />
      ) : null}
    </>
  );
}
