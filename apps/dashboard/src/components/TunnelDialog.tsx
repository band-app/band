import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { QRCodeSVG } from "qrcode.react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";

type TunnelStep =
  | "checking"
  | "not_installed"
  | "installing"
  | "connecting"
  | "ready"
  | "error";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStopped: () => void;
  initialUrl?: string | null;
  onTunnelUrl?: (url: string) => void;
}

export function TunnelDialog({ open, onOpenChange, onStopped, initialUrl, onTunnelUrl }: Props) {
  const [step, setStep] = useState<TunnelStep>("checking");
  const [tunnelUrl, setTunnelUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const startFlow = useCallback(async () => {
    try {
      setStep("checking");
      const installed = await invoke<boolean>("tunnel_check");
      if (!installed) {
        setStep("not_installed");
        return;
      }
      setStep("connecting");
      await invoke("tunnel_start");
    } catch (e) {
      setError(String(e));
      setStep("error");
    }
  }, []);

  useEffect(() => {
    if (!open) return;

    // If we already have a tunnel URL, show it immediately
    if (initialUrl) {
      setTunnelUrl(initialUrl);
      setStep("ready");
      setError(null);
    } else {
      setStep("checking");
      setTunnelUrl(null);
      setError(null);
    }

    let cancelled = false;
    let unlisten: (() => void) | undefined;
    let unlistenError: (() => void) | undefined;

    (async () => {
      // Listen for the tunnel URL event
      unlisten = await listen<string>("tunnel-url", (event) => {
        if (!cancelled) {
          setTunnelUrl(event.payload);
          setStep("ready");
          onTunnelUrl?.(event.payload);
        }
      });

      // Listen for tunnel errors (e.g. cloudflared exited without URL)
      unlistenError = await listen<string>("tunnel-error", (event) => {
        if (!cancelled) {
          setError(event.payload);
          setStep("error");
        }
      });

      // Already showing cached URL — no need to start flow
      if (initialUrl) return;

      // Check if tunnel is already running with a URL
      try {
        const existingUrl = await invoke<string | null>("tunnel_status");
        if (existingUrl && !cancelled) {
          setTunnelUrl(existingUrl);
          setStep("ready");
          onTunnelUrl?.(existingUrl);
          return;
        }
      } catch {}

      if (!cancelled) {
        await startFlow();
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
      unlistenError?.();
    };
  }, [open, startFlow, initialUrl, onTunnelUrl]);

  const handleInstall = async () => {
    try {
      setStep("installing");
      await invoke("tunnel_install");
      setStep("connecting");
      await invoke("tunnel_start");
    } catch (e) {
      setError(String(e));
      setStep("error");
    }
  };

  const handleStop = async () => {
    try {
      await invoke("tunnel_stop");
      await invoke("webserver_stop");
    } catch {}
    onStopped();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[320px]">
        <DialogHeader>
          <DialogTitle>
            {step === "not_installed" ? "cloudflared Required" : "Mobile Access"}
          </DialogTitle>
          {step === "not_installed" && (
            <DialogDescription>
              cloudflared is needed to create a secure tunnel so you can access
              the dashboard from your phone.
            </DialogDescription>
          )}
        </DialogHeader>

        <div className="flex flex-col items-center gap-4 py-2">
          {step === "checking" && (
            <>
              <Loader2 className="size-8 animate-spin text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                Checking cloudflared...
              </p>
            </>
          )}

          {step === "not_installed" && (
            <Button onClick={handleInstall}>Install with Homebrew</Button>
          )}

          {step === "installing" && (
            <>
              <Loader2 className="size-8 animate-spin text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                Installing cloudflared...
              </p>
            </>
          )}

          {step === "connecting" && (
            <>
              <Loader2 className="size-8 animate-spin text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                Creating tunnel...
              </p>
            </>
          )}

          {step === "ready" && tunnelUrl && (
            <>
              <div className="rounded-lg bg-white p-3">
                <QRCodeSVG value={tunnelUrl} size={200} />
              </div>
              <p className="text-xs text-muted-foreground text-center break-all max-w-[260px]">
                {tunnelUrl}
              </p>
            </>
          )}

          {step === "error" && (
            <>
              <p className="text-sm text-destructive text-center">{error}</p>
              <Button variant="outline" size="sm" onClick={startFlow}>
                Retry
              </Button>
            </>
          )}
        </div>

        {step === "ready" && (
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={handleStop}>
              Stop Server
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
