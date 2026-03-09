import { useSettingsQuery } from "@band/dashboard-core";
import { Button, Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@band/ui";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Loader2 } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useCallback, useEffect, useState } from "react";

interface ServiceHealth {
  webserver: boolean;
  tunnel: boolean;
  tunnel_url: string | null;
  tunnel_remote_host: string | null;
}

type TunnelStep =
  | "starting"
  | "auth_required"
  | "connecting"
  | "ready"
  | "subdomain_taken"
  | "remote_host"
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
  const [remoteHost, setRemoteHost] = useState<string | null>(null);
  const { settings } = useSettingsQuery();

  const ensureWebServer = useCallback(async () => {
    const health = await invoke<ServiceHealth>("service_health_check");
    if (!health.webserver) {
      await invoke("webserver_start");
      // Wait for server to be ready by polling health
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const h = await invoke<ServiceHealth>("service_health_check");
        if (h.webserver) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      await invoke<string>("webserver_get_token");
    }
    return health;
  }, []);

  const startConnection = useCallback(async () => {
    try {
      setStep("starting");
      const health = await ensureWebServer();

      // If tunnel is already running on a different host, show message
      if (health.tunnel && health.tunnel_remote_host) {
        setRemoteHost(health.tunnel_remote_host);
        setStep("remote_host");
        return;
      }

      // If tunnel is broken (subdomain configured but not healthy), kill it first
      if (settings.tunnelSubdomain && !health.tunnel) {
        await invoke("tunnel_stop").catch(() => {});
      }

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
      setRemoteHost(null);
    } else {
      setStep("starting");
      setTunnelUrl(null);
      setError(null);
      setRemoteHost(null);
    }

    let cancelled = false;
    let unlisten: (() => void) | undefined;
    let unlistenError: (() => void) | undefined;
    let unlistenSubdomainTaken: (() => void) | undefined;
    let unlistenRemoteHost: (() => void) | undefined;

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

      unlistenRemoteHost = await listen<string>("tunnel-remote-host", (event) => {
        if (!cancelled) {
          setRemoteHost(event.payload);
          setStep("remote_host");
        }
      });

      if (initialUrl) return;

      // Check if services are already running
      try {
        const health = await invoke<ServiceHealth>("service_health_check");
        if (health.tunnel && health.tunnel_url && !cancelled) {
          const token = await invoke<string>("webserver_get_token").catch(() => null);
          const url = token ? `${health.tunnel_url}?token=${token}` : health.tunnel_url;
          if (health.tunnel_remote_host) {
            setRemoteHost(health.tunnel_remote_host);
            setStep("remote_host");
          } else {
            setTunnelUrl(url);
            setStep("ready");
            onTunnelUrl?.(url);
          }
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
      unlistenRemoteHost?.();
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
              <p className="text-xs text-muted-foreground text-center">Run in your terminal:</p>
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
              <a
                href={tunnelUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-lg bg-white p-3 block cursor-pointer hover:opacity-80 transition-opacity"
              >
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
                The subdomain <strong>{settings.tunnelSubdomain}</strong> is already in use by
                another session.
              </p>
              <p className="text-xs text-muted-foreground text-center">
                You can change it in Settings &gt; Web Server.
              </p>
              <Button onClick={handleContinueRandom} className="w-full">
                Continue with Random URL
              </Button>
            </>
          )}

          {step === "remote_host" && (
            <>
              <p className="text-sm text-muted-foreground text-center">
                Tunnel subdomain <strong>{settings.tunnelSubdomain}</strong> is currently in use on{" "}
                <strong>{remoteHost}</strong>.
              </p>
              <p className="text-xs text-muted-foreground text-center">
                Stop it on the other computer first, or use a different subdomain.
              </p>
              <Button onClick={handleContinueRandom} className="w-full">
                Continue with Random URL
              </Button>
              <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                Close
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
