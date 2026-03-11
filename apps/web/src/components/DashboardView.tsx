import { DashboardProvider, DashboardShell } from "@band/dashboard-core";
import {
  HybridDashboardAdapter,
  NativeShellCapabilities,
} from "@band/dashboard-core/adapters/hybrid";
import { Button, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@band/ui";
import { Link } from "@tanstack/react-router";
import { ListTodo } from "lucide-react";
import { TunnelToolbarButton } from "./TunnelToolbarButton";

const adapter = new HybridDashboardAdapter();
const capabilities = new NativeShellCapabilities();

export function DashboardView() {
  return (
    <DashboardProvider adapter={adapter} capabilities={capabilities}>
      <TooltipProvider>
        <DashboardShell
          toolbarExtra={
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button size="icon-sm" variant="ghost" asChild>
                    <Link to="/tasks">
                      <ListTodo className="size-5" />
                    </Link>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Tasks</TooltipContent>
              </Tooltip>
              <TunnelToolbarButton />
            </>
          }
        />
      </TooltipProvider>
    </DashboardProvider>
  );
}
