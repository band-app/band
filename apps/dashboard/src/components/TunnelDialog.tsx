import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Loader2 } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useSettingsStore } from "@/stores/settings-store";

type TunnelStep =
  | "starting"
  | "auth_required"
  | "connecting"
  | "ready"
  | "subdomain_taken"
  | "error";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStopped: () => void;
  initialUrl?: string | null;
  onTunnelUrl?: (url: string) => void;
}

export function TunnelDialog({ open, onOpenChange, onStopped, initialUrl, onTunnelUrl }: Props) {
  const [step, setStep] = useState<TunnelStep>("starting");
  const [tunnelUrl, setTunnelUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const settings = useSettingsStore((s) => s.settings);

  const ensureWebServer = useCallback(async () => {
    const running = await invoke<boolean>("webserver_status");
    if (!running) {
      await invoke("webserver_start");
      await invoke("webserver_wait_ready");
      await invoke<string>("webserver_get_token");
    }
  }, []);

  const startConnection = useCallback(async () => {
    try {
      setStep("starting");
      await ensureWebServer();

      if (settings.tunnelSubdomain) {
        const authed = await invoke<boolean>("tunnel_auth_check");
        if (!authed) {
          setStep("auth_required");
          return;
        }
      }

      setStep("connecting");
      await invoke("tunnel_start");
    } catch (e) {
      setError(String(e));
      setStep("error");
    }
  }, [settings.tunnelSubdomain, ensureWebServer]);

  useEffect(() => {
    if (!open) return;

    if (initialUrl) {
      setTunnelUrl(initialUrl);
      setStep("ready");
      setError(null);
    } else {
      setStep("starting");
      setTunnelUrl(null);
      setError(null);
    }

    let cancelled = false;
    let unlisten: (() => void) | undefined;
    let unlistenError: (() => void) | undefined;
    let unlistenSubdomainTaken: (() => void) | undefined;

    (async () => {
      unlisten = await listen<string>("tunnel-url", (event) => {
        if (!cancelled) {
          setTunnelUrl(event.payload);
          setStep("ready");
          onTunnelUrl?.(event.payload);
        }
      });

      unlistenError = await listen<string>("tunnel-error", (event) => {
        if (!cancelled) {
          setError(event.payload);
          setStep("error");
        }
      });

      unlistenSubdomainTaken = await listen("tunnel-subdomain-taken", () => {
        if (!cancelled) {
          setStep("subdomain_taken");
        }
      });

      if (initialUrl) return;

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
        await startConnection();
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
      unlistenError?.();
      unlistenSubdomainTaken?.();
    };
  }, [open, startConnection, initialUrl, onTunnelUrl]);

  const handleRetryAuth = async () => {
    try {
      setStep("starting");
      const authed = await invoke<boolean>("tunnel_auth_check");
      if (!authed) {
        setStep("auth_required");
        return;
      }
      setStep("connecting");
      await invoke("tunnel_start");
    } catch (e) {
      setError(String(e));
      setStep("error");
    }
  };

  const handleContinueRandom = async () => {
    try {
      setStep("connecting");
      await invoke("tunnel_start", { skipSubdomain: true });
    } catch (e) {
      setError(String(e));
      setStep("error");
    }
  };

  const handleStop = async () => {
    await invoke("tunnel_stop").catch(() => {});
    await invoke("webserver_stop").catch(() => {});
    onStopped();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[320px]">
        <DialogHeader>
          <DialogTitle>Mobile Access</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col items-center gap-4 py-2">
          {(step === "starting" || step === "connecting") && (
            <>
              <Loader2 className="size-8 animate-spin text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                {step === "starting" ? "Starting web server..." : "Creating tunnel..."}
              </p>
            </>
          )}

          {step === "auth_required" && (
            <>
              <p className="text-sm text-muted-foreground text-center">
                You need to log in to instatunnel to use the subdomain{" "}
                <strong>{settings.tunnelSubdomain}</strong>.
              </p>
              <p className="text-xs text-muted-foreground text-center">
                Run in your terminal:
              </p>
              <code className="text-xs bg-muted px-2 py-1 rounded select-all">
                instatunnel auth login
              </code>
              <Button onClick={handleRetryAuth} className="w-full">
                Try Again
              </Button>
              <Button variant="ghost" size="sm" onClick={handleContinueRandom}>
                Continue without subdomain
              </Button>
            </>
          )}

          {step === "ready" && tunnelUrl && (
            <>
              <a href={tunnelUrl} target="_blank" rel="noopener noreferrer" className="rounded-lg bg-white p-3 block cursor-pointer hover:opacity-80 transition-opacity">
                <QRCodeSVG value={tunnelUrl} size={200} />
              </a>
              <p className="text-xs text-muted-foreground text-center break-all max-w-[260px]">
                {tunnelUrl.replace(/\?token=[^&]+/, "")}
              </p>
            </>
          )}

          {step === "subdomain_taken" && (
            <>
              <p className="text-sm text-muted-foreground text-center">
                The subdomain <strong>{settings.tunnelSubdomain}</strong> is already in use by another session.
              </p>
              <p className="text-xs text-muted-foreground text-center">
                You can change it in Settings &gt; Web Server.
              </p>
              <Button onClick={handleContinueRandom} className="w-full">
                Continue with Random URL
              </Button>
            </>
          )}

          {step === "error" && (
            <>
              <p className="text-sm text-destructive text-center">{error}</p>
              <Button variant="outline" size="sm" onClick={startConnection}>
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
