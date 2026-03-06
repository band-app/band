import { Globe } from "lucide-react";
import { Button, Tooltip, TooltipContent, TooltipTrigger } from "@band/ui";
import { PrereqDialog } from "./PrereqDialog";
import { TunnelDialog } from "./TunnelDialog";
import { useTunnel } from "@/hooks/use-tunnel";

export function TunnelToolbarButton() {
  const {
    webServerRunning,
    tunnelUrl,
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
            size="icon-xs"
            variant="ghost"
            className={webServerRunning ? "text-green-500" : ""}
            onClick={openDialog}
          >
            <Globe className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {webServerRunning ? "Mobile access" : "Start web server"}
        </TooltipContent>
      </Tooltip>

      <PrereqDialog
        open={showPrereq}
        onOpenChange={setShowPrereq}
        onReady={onPrereqReady}
      />

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
