import { drainExitRecords as drain, writeExitRecord as write } from "../../daemon-kit/exit-records";
import type { TerminalExitEvent } from "../terminal-pool";

/**
 * Exits of shells that ended while no server was connected to their daemon.
 * Only daemons started with `--record-exits` write them: the worker does, the
 * hub's own daemon does not.
 */
export function writeExitRecord(runDir: string, event: TerminalExitEvent): void {
  write(runDir, event.terminalId, event);
}

export function drainExitRecords(runDir: string): TerminalExitEvent[] {
  return drain(
    runDir,
    (value): value is TerminalExitEvent =>
      typeof value === "object" &&
      value !== null &&
      typeof (value as TerminalExitEvent).terminalId === "string" &&
      typeof (value as TerminalExitEvent).worktreeId === "string",
  );
}
