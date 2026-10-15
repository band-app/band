import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
} from "@band-app/ui";
import { Copy, RefreshCw } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { crossOriginHub } from "../../../lib/hub-config";
import { trpc } from "../../../lib/trpc-client";
import {
  buildPairingOptions,
  type PairingInterfaceInfo,
  pairingLink,
  pickDefaultAddress,
} from "../../lib/pairing-options";

interface Addresses {
  publicUrl: string | null;
  interfaces: PairingInterfaceInfo[];
  custom: string[];
}

interface Code {
  code: string;
  expiresAt: number;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The origin this page reaches the hub on: the configured remote hub in the desktop app, else the page's own. */
function pageOrigin(): string {
  return crossOriginHub()?.origin ?? window.location.origin;
}

/** The last address chosen, per hub. A choice that is no longer offered falls back to the default. */
const choiceKey = () => `band.pairing-address:${pageOrigin()}`;

function isLoopback(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "::1" || host === "[::1]" || /^127\./.test(host);
  } catch {
    return false;
  }
}

function formatClock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * Connect details for one device: a link and QR code that hold a one-time pairing code (15
 * minutes, one use), and a picker for the address the link points at. Reopening within the
 * lifetime shows the same code. Regenerate replaces it.
 */
export function PairingDialog({
  device,
  onClose,
}: {
  device: { id: string; label: string };
  onClose: () => void;
}) {
  const [code, setCode] = useState<Code | null>(null);
  const [addresses, setAddresses] = useState<Addresses | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [custom, setCustom] = useState("");
  const [addingCustom, setAddingCustom] = useState(false);

  const loadCode = useCallback(
    async (regenerate: boolean) => {
      setError(null);
      try {
        const res = await trpc.tokens.pairing.mutate({ tokenId: device.id, regenerate });
        setCode({ code: res.code, expiresAt: res.expiresAt });
      } catch (err) {
        setError(errorText(err));
      }
    },
    [device.id],
  );

  const loadAddresses = useCallback(async () => {
    try {
      setAddresses(await trpc.tokens.pairingAddresses.query());
    } catch (err) {
      setError(errorText(err));
    }
  }, []);

  // Both load when the dialog opens. Refresh reads the interfaces again.
  useEffect(() => {
    void loadCode(false);
    void loadAddresses();
  }, [loadCode, loadAddresses]);

  // A code that ran out is replaced, so the QR on screen is never a dead one.
  useEffect(() => {
    if (!code) return;
    const wait = Math.max(0, code.expiresAt - Date.now()) + 250;
    const timer = setTimeout(() => void loadCode(false), wait);
    return () => clearTimeout(timer);
  }, [code, loadCode]);

  const options = useMemo(
    () =>
      addresses
        ? buildPairingOptions({
            publicUrl: addresses.publicUrl,
            pageOrigin: pageOrigin(),
            interfaces: addresses.interfaces,
            custom: addresses.custom,
          })
        : [],
    [addresses],
  );
  const selected = useMemo(() => {
    const stillThere = chosen ? options.find((o) => o.url === chosen) : undefined;
    return stillThere ?? pickDefaultAddress(options, localStorage.getItem(choiceKey()));
  }, [options, chosen]);

  const pick = (url: string) => {
    setChosen(url);
    localStorage.setItem(choiceKey(), url);
  };

  const link = code && selected ? pairingLink(selected.url, code.code) : null;

  const addCustom = async () => {
    setError(null);
    try {
      const res = await trpc.tokens.addPairingAddress.mutate({ url: custom });
      await loadAddresses();
      pick(res.url);
      setCustom("");
      setAddingCustom(false);
    } catch (err) {
      setError(errorText(err));
    }
  };

  const removeCustom = async (url: string) => {
    setError(null);
    try {
      await trpc.tokens.removePairingAddress.mutate({ url });
      if (chosen === url) setChosen(null);
      await loadAddresses();
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-[440px]" data-testid="settings__pairing-dialog">
        <DialogHeader>
          <DialogTitle>Connect {device.label || device.id}</DialogTitle>
          <DialogDescription>
            Open the link or scan the code on the device. It works once and expires in 15 minutes.
            Opening it signs that device in and replaces its previous token.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <label className="block text-xs font-medium" htmlFor="pairing-address">
              Address
            </label>
            <div className="flex gap-2">
              <select
                id="pairing-address"
                data-testid="settings__pairing-address"
                className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-xs"
                value={selected?.url ?? ""}
                onChange={(e) => pick(e.target.value)}
              >
                {options.map((o) => (
                  <option
                    key={o.url}
                    value={o.url}
                    data-testid="settings__pairing-option"
                    data-source={o.source}
                    data-kind={o.kind}
                  >
                    {o.label}
                  </option>
                ))}
              </select>
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-label="Refresh network interfaces"
                onClick={() => void loadAddresses()}
              >
                <RefreshCw className="size-3" />
              </Button>
            </div>
            <div className="flex items-center gap-2">
              {addingCustom ? (
                <>
                  <Input
                    aria-label="Custom address"
                    placeholder="https://band.example.ts.net"
                    value={custom}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCustom(e.target.value)}
                    className="h-8 text-xs"
                  />
                  <Button
                    type="button"
                    size="sm"
                    disabled={custom.trim() === ""}
                    onClick={() => void addCustom()}
                  >
                    Save address
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    data-testid="settings__pairing-cancel-custom"
                    onClick={() => setAddingCustom(false)}
                  >
                    Cancel
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    data-testid="settings__pairing-add-custom"
                    onClick={() => setAddingCustom(true)}
                  >
                    Add custom address…
                  </Button>
                  {selected?.source === "custom" ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      data-testid="settings__pairing-remove-custom"
                      onClick={() => void removeCustom(selected.url)}
                    >
                      Remove this address
                    </Button>
                  ) : null}
                </>
              )}
            </div>
          </div>
          {selected && isLoopback(selected.url) ? (
            <p role="alert" className="text-xs text-destructive">
              {selected.url} is only reachable from this machine. Pick another address for a phone
              or another computer.
            </p>
          ) : null}
          {link ? (
            <div className="space-y-3" data-testid="settings__pairing-result">
              <div className="flex justify-center rounded-lg bg-white p-3">
                <QRCodeSVG
                  value={link}
                  size={200}
                  data-testid="settings__pairing-qr"
                  data-value={link}
                />
              </div>
              <label className="block text-xs font-medium" htmlFor="pairing-link">
                Connect link
              </label>
              <div className="flex gap-2">
                <Input
                  id="pairing-link"
                  readOnly
                  value={link}
                  data-testid="settings__pairing-link"
                  className="h-8 font-mono text-xs"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  data-testid="settings__pairing-copy"
                  onClick={() => void navigator.clipboard?.writeText(link).catch(() => undefined)}
                >
                  <Copy className="size-3" />
                  Copy
                </Button>
              </div>
              <p className="text-xs text-muted-foreground" data-testid="settings__pairing-expiry">
                Expires at {formatClock(code?.expiresAt ?? 0)}.
              </p>
            </div>
          ) : null}
          {error ? (
            <p
              role="alert"
              className="text-xs text-destructive"
              data-testid="settings__pairing-error"
            >
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="settings__pairing-regenerate"
            onClick={() => void loadCode(true)}
          >
            Regenerate
          </Button>
          <Button type="button" size="sm" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
