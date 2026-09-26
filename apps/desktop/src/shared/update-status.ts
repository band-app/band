/**
 * Auto-update status pushed from the main process (`main/updater.ts`) to the
 * renderer's update toast over `updater-status-changed`, and returned by the
 * `updater_status` invoke. The web app keeps a structural copy of this type
 * in `apps/web/src/dashboard/adapter.ts`; change both together.
 *
 * `userInitiated` marks a check the user asked for (the "Check for Updates…"
 * menu item or a toast Retry). The toast shows `checking`, `up-to-date` and
 * check errors only for those, so the startup and periodic checks stay
 * silent unless they find an update.
 */
export type UpdateStatus =
  | { state: "idle" }
  | { state: "checking"; userInitiated: boolean }
  | { state: "up-to-date"; currentVersion: string; userInitiated: boolean }
  | ({ state: "available" } & UpdateRelease)
  | ({ state: "downloading"; percent: number } & UpdateRelease)
  | ({ state: "downloaded" } & UpdateRelease)
  | {
      state: "error";
      message: string;
      /** Which step failed. The toast's Retry re-runs that step. */
      phase: "check" | "download";
      userInitiated: boolean;
    };

export interface UpdateRelease {
  version: string;
  currentVersion: string;
  releaseName: string | null;
  /** Plain-text release notes, tags stripped and truncated. */
  releaseNotes: string | null;
  /** GitHub release page for `version`. */
  releaseUrl: string;
}
