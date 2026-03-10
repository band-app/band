import { useSettingsQuery } from "@band/dashboard-core";
import { Button, Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@band/ui";
import { Loader2 } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useCallback, useEffect, useState } from "react";
import { trpc } from "../lib/trpc-client";

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

  const startConnection = useCallback(async () => {
    try {
      setStep("starting");

      // Web server is always running — just check health for tunnel state
      const health = await trpc.services.health.query();

      // If tunnel is already running on a different host, show message
      if (health.tunnel && health.tunnel_remote_host) {
        setRemoteHost(health.tunnel_remote_host);
        setStep("remote_host");
        return;
      }

      // If tunnel is already healthy (same machine, e.g. after restart), show QR
      if (health.tunnel && health.tunnel_url) {
        setTunnelUrl(health.tunnel_url);
        setStep("ready");
        onTunnelUrl?.(health.tunnel_url);
        return;
      }

      // If tunnel is broken (subdomain configured but not healthy), stop it first
      if (settings.tunnelSubdomain && !health.tunnel) {
        await trpc.tunnel.stop.mutate().catch(() => {});
      }

      if (settings.tunnelSubdomain) {
        const { authenticated } = await trpc.tunnel.authCheck.query();
        if (!authenticated) {
          setStep("auth_required");
          return;
        }
      }

      setStep("connecting");
      const result = await trpc.tunnel.start.mutate({});
      if (result.url) {
        setTunnelUrl(result.url);
        setStep("ready");
        onTunnelUrl?.(result.url);
      }
    } catch (e) {
      setError(String(e));
      setStep("error");
    }
  }, [settings.tunnelSubdomain, onTunnelUrl]);

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

    // Subscribe to tRPC status stream for tunnel events
    const subscription = trpc.status.stream.subscribe(undefined, {
      onData: (event: { kind: string; url?: string; error?: string; host?: string }) => {
        if (cancelled) return;
        if (event.kind === "tunnel-url" && event.url) {
          setTunnelUrl(event.url);
          setStep("ready");
          onTunnelUrl?.(event.url);
        } else if (event.kind === "tunnel-error" && event.error) {
          setError(event.error);
          setStep("error");
        } else if (event.kind === "tunnel-subdomain-taken") {
          setStep("subdomain_taken");
        } else if (event.kind === "tunnel-remote-host" && event.host) {
          setRemoteHost(event.host);
          setStep("remote_host");
        }
      },
    });

    if (!initialUrl) {
      // Check if services are already running
      (async () => {
        try {
          const health = await trpc.services.health.query();
          if (cancelled) return;

          if (health.tunnel && health.tunnel_url && !cancelled) {
            if (health.tunnel_remote_host) {
              setRemoteHost(health.tunnel_remote_host);
              setStep("remote_host");
            } else {
              setTunnelUrl(health.tunnel_url);
              setStep("ready");
              onTunnelUrl?.(health.tunnel_url);
            }
            return;
          }
        } catch {}

        if (!cancelled) {
          await startConnection();
        }
      })();
    }

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, [open, startConnection, initialUrl, onTunnelUrl]);

  const handleRetryAuth = async () => {
    try {
      setStep("starting");
      const { authenticated } = await trpc.tunnel.authCheck.query();
      if (!authenticated) {
        setStep("auth_required");
        return;
      }
      setStep("connecting");
      const result = await trpc.tunnel.start.mutate({});
      if (result.url) {
        setTunnelUrl(result.url);
        setStep("ready");
        onTunnelUrl?.(result.url);
      }
    } catch (e) {
      setError(String(e));
      setStep("error");
    }
  };

  const handleContinueRandom = async () => {
    try {
      setStep("connecting");
      const result = await trpc.tunnel.start.mutate({ skipSubdomain: true });
      if (result.url) {
        setTunnelUrl(result.url);
        setStep("ready");
        onTunnelUrl?.(result.url);
      }
    } catch (e) {
      setError(String(e));
      setStep("error");
    }
  };

  const handleStop = async () => {
    await trpc.tunnel.stop.mutate().catch(() => {});
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
                {step === "starting" ? "Checking services..." : "Creating tunnel..."}
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
              Stop Tunnel
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
