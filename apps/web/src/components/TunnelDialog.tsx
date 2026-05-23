import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@band-app/ui";
import { Loader2 } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useRef, useState } from "react";
import { useAdapter } from "@/dashboard";
import { trpc } from "../lib/trpc-client";

type TunnelStep = "starting" | "connecting" | "ready" | "error";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStopped: () => void;
  initialUrl?: string | null;
  onTunnelUrl?: (url: string) => void;
}

export function TunnelDialog({ open, onOpenChange, onStopped, initialUrl, onTunnelUrl }: Props) {
  const adapter = useAdapter();
  const [step, setStep] = useState<TunnelStep>("starting");
  const [tunnelUrl, setTunnelUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Use refs for values that shouldn't trigger effect re-runs
  const onTunnelUrlRef = useRef(onTunnelUrl);
  onTunnelUrlRef.current = onTunnelUrl;
  const initialUrlRef = useRef(initialUrl);
  initialUrlRef.current = initialUrl;

  useEffect(() => {
    if (!open) return;

    if (initialUrlRef.current) {
      setTunnelUrl(initialUrlRef.current);
      setStep("ready");
      setError(null);
      return;
    }

    setStep("starting");
    setTunnelUrl(null);
    setError(null);

    let cancelled = false;

    // Subscribe via the adapter's shared SSE connection for tunnel events
    const unsubscribe = adapter.subscribeStatusEvents((event) => {
      if (cancelled) return;
      if (event.kind === "tunnel-url" && typeof event.url === "string") {
        setTunnelUrl(event.url);
        setStep("ready");
        onTunnelUrlRef.current?.(event.url);
      } else if (event.kind === "tunnel-error" && typeof event.error === "string") {
        setError(event.error);
        setStep("error");
      }
    });

    // Check if services are already running, otherwise start tunnel
    (async () => {
      try {
        const health = await trpc.services.health.query();
        if (cancelled) return;

        if (health.tunnel && health.tunnel_url) {
          setTunnelUrl(health.tunnel_url);
          setStep("ready");
          onTunnelUrlRef.current?.(health.tunnel_url);
          return;
        }
      } catch {}

      if (cancelled) return;

      try {
        setStep("connecting");
        const result = await trpc.tunnel.start.mutate({});
        if (cancelled) return;
        if (result.url) {
          setTunnelUrl(result.url);
          setStep("ready");
          onTunnelUrlRef.current?.(result.url);
        }
      } catch (e) {
        if (!cancelled) {
          setError(String(e));
          setStep("error");
        }
      }
    })();

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [open, adapter]);

  const handleRetry = async () => {
    try {
      setStep("connecting");
      setError(null);
      const result = await trpc.tunnel.start.mutate({});
      if (result.url) {
        setTunnelUrl(result.url);
        setStep("ready");
        onTunnelUrlRef.current?.(result.url);
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

          {step === "error" && (
            <>
              <p className="text-sm text-destructive text-center">{error}</p>
              <Button variant="outline" size="sm" onClick={handleRetry}>
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
