import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@band/ui";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { trpc } from "../lib/trpc-client";

type PrereqStep = "checking" | "missing" | "installing" | "error";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onReady: () => void;
}

export function PrereqDialog({ open, onOpenChange, onReady }: Props) {
  const [step, setStep] = useState<PrereqStep>("checking");
  const [needNode, setNeedNode] = useState(false);
  const [needInstatunnel, setNeedInstatunnel] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setStep("checking");
    setError(null);

    let cancelled = false;
    (async () => {
      try {
        const status = await trpc.prereqs.check.query();
        if (cancelled) return;
        if (status.node && status.instatunnel) {
          onReady();
          return;
        }
        setNeedNode(!status.node);
        setNeedInstatunnel(!status.instatunnel);
        setStep("missing");
      } catch (e) {
        if (!cancelled) {
          setError(String(e));
          setStep("error");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, onReady]);

  const handleInstall = async () => {
    try {
      setStep("installing");
      if (needNode) {
        await trpc.prereqs.installNode.mutate();
      }
      if (needInstatunnel) {
        await trpc.prereqs.installTunnel.mutate();
      }
      onReady();
    } catch (e) {
      setError(String(e));
      setStep("error");
    }
  };

  const missingLabel =
    needNode && needInstatunnel ? "Node.js & instatunnel" : needNode ? "Node.js" : "instatunnel";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[320px]">
        <DialogHeader>
          <DialogTitle>
            {step === "missing" ? `Install ${missingLabel}` : "Checking Requirements"}
          </DialogTitle>
          {step === "missing" && (
            <DialogDescription>
              {needNode && needInstatunnel
                ? "Node.js and instatunnel are required for mobile access."
                : needNode
                  ? "Node.js is required to run the web server."
                  : "instatunnel is required to create a secure tunnel."}
            </DialogDescription>
          )}
        </DialogHeader>

        <div className="flex flex-col items-center gap-4 py-2">
          {step === "checking" && (
            <>
              <Loader2 className="size-8 animate-spin text-muted-foreground" />
              <p className="text-sm text-muted-foreground">Checking requirements...</p>
            </>
          )}

          {step === "missing" && (
            <Button onClick={handleInstall} className="w-full">
              Install {missingLabel}
            </Button>
          )}

          {step === "installing" && (
            <>
              <Loader2 className="size-8 animate-spin text-muted-foreground" />
              <p className="text-sm text-muted-foreground">Installing {missingLabel}...</p>
            </>
          )}

          {step === "error" && (
            <>
              <p className="text-sm text-destructive text-center">{error}</p>
              <Button variant="outline" size="sm" onClick={handleInstall}>
                Retry
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
