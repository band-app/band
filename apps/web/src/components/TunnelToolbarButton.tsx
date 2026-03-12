import { Button, Tooltip, TooltipContent, TooltipTrigger } from "@band/ui";
import { Globe } from "lucide-react";
import { useTunnel } from "@/hooks/use-tunnel";
import { PrereqDialog } from "./PrereqDialog";
import { TunnelDialog } from "./TunnelDialog";

export function TunnelToolbarButton() {
  const {
    webServerRunning,
    tunnelUrl,
    tunnelError,
    setTunnelUrl,
    showPrereq,
    setShowPrereq,
    onPrereqReady,
    showDialog,
    setShowDialog,
    openDialog,
    handleStopped,
  } = useTunnel();

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="icon-sm"
            variant="ghost"
            className={tunnelError ? "text-red-500" : webServerRunning ? "text-green-500" : ""}
            onClick={openDialog}
          >
            <Globe className="size-5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {tunnelError ? `Tunnel error: ${tunnelError}` : webServerRunning ? "Mobile access" : "Start tunnel"}
        </TooltipContent>
      </Tooltip>

      <PrereqDialog open={showPrereq} onOpenChange={setShowPrereq} onReady={onPrereqReady} />

      <TunnelDialog
        open={showDialog}
        onOpenChange={setShowDialog}
        onStopped={handleStopped}
        initialUrl={tunnelUrl}
        onTunnelUrl={setTunnelUrl}
      />
    </>
  );
}
