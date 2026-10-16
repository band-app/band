/**
 * The "keep this Mac awake" switch, kept in `~/.band/desktop-keep-awake.json`
 * so a relaunch restores it. While on, an Electron `powerSaveBlocker` of type
 * `prevent-app-suspension` holds a PreventUserIdleSystemSleep assertion: the
 * system stays awake and the display may still turn off. The blocker lives in
 * this process, so quitting the app releases it.
 *
 * The blocker is injected so the controller loads without the `electron`
 * package (same split as `window-state.ts`).
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bandHome } from "./log.js";

export interface PowerSaveBlocker {
  start(type: "prevent-app-suspension"): number;
  stop(id: number): void;
}

function stateFile(): string {
  return join(bandHome(), "desktop-keep-awake.json");
}

export function loadKeepAwake(): boolean {
  try {
    const parsed = JSON.parse(readFileSync(stateFile(), "utf8")) as Record<string, unknown>;
    return parsed.enabled === true;
  } catch {
    return false;
  }
}

export function saveKeepAwake(enabled: boolean): void {
  const file = stateFile();
  mkdirSync(bandHome(), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify({ enabled }));
  renameSync(tmp, file);
}

export class KeepAwakeController {
  private blockerId: number | null = null;

  private readonly blocker: PowerSaveBlocker;

  constructor(blocker: PowerSaveBlocker) {
    this.blocker = blocker;
  }

  isEnabled(): boolean {
    return this.blockerId !== null;
  }

  /** Apply the saved state at launch. */
  restore(): void {
    if (loadKeepAwake()) this.apply(true);
  }

  set(enabled: boolean): boolean {
    this.apply(enabled);
    try {
      saveKeepAwake(enabled);
    } catch {
      // The switch still works for this run; only the restore at the next launch is lost.
    }
    return this.isEnabled();
  }

  private apply(enabled: boolean): void {
    if (enabled && this.blockerId === null) {
      this.blockerId = this.blocker.start("prevent-app-suspension");
    } else if (!enabled && this.blockerId !== null) {
      this.blocker.stop(this.blockerId);
      this.blockerId = null;
    }
  }
}
