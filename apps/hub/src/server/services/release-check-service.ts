/**
 * Asks GitHub which Band release is the latest, once at startup and then once a day, so the UI can
 * say an update exists. It uses the unauthenticated API (60 requests an hour), keeps the answer in
 * memory, and says nothing when GitHub cannot be reached: no result means no badge. Air-gapped
 * hubs turn it off with `BAND_UPDATE_CHECK=off`.
 */

import { createLogger } from "@band-app/logger";
import { compareVersions, isStrictSemver } from "@band-app/shared/versions";
import { HUB_VERSION } from "./_utils/hub-version";

const log = createLogger("release-check");

const DAY_MS = 24 * 60 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const REPO = "band-app/band";

export interface ReleaseStatus {
  /** False when the check is turned off. */
  enabled: boolean;
  /** The newest release GitHub reported, or null before the first answer or when it never came. */
  latest: string | null;
  /** True when `latest` is newer than this hub. */
  updateAvailable: boolean;
  checkedAt: number | null;
}

export class ReleaseCheckService {
  private latest: string | null = null;
  private checkedAt: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  private failing = false;

  /** Whether the check runs. Read on every call. */
  enabled(): boolean {
    const v = process.env.BAND_UPDATE_CHECK?.trim().toLowerCase();
    return !(v === "off" || v === "0" || v === "false");
  }

  start(): void {
    if (this.timer || !this.enabled()) return;
    void this.check();
    const every = Number(process.env.BAND_UPDATE_CHECK_INTERVAL_MS);
    this.timer = setInterval(() => void this.check(), every > 0 ? every : DAY_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  status(): ReleaseStatus {
    const latest = this.enabled() ? this.latest : null;
    return {
      enabled: this.enabled(),
      latest,
      updateAvailable: latest !== null && (compareVersions(HUB_VERSION, latest) ?? 0) < 0,
      checkedAt: this.checkedAt,
    };
  }

  /** Fetches the latest release once. Never throws: a failure keeps the earlier answer and is logged once. */
  async check(): Promise<void> {
    if (!this.enabled()) return;
    const base = (process.env.BAND_GITHUB_API_URL ?? "https://api.github.com").replace(/\/+$/, "");
    try {
      const res = await fetch(`${base}/repos/${REPO}/releases/latest`, {
        headers: { accept: "application/vnd.github+json", "user-agent": "band-hub" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
      const body = (await res.json()) as {
        tag_name?: unknown;
        draft?: unknown;
        prerelease?: unknown;
      };
      const version = typeof body.tag_name === "string" ? body.tag_name.replace(/^v/, "") : "";
      if (body.draft === true || body.prerelease === true || !isStrictSemver(version)) {
        throw new Error("the latest release has no plain version");
      }
      this.failing = false;
      this.checkedAt = Date.now();
      this.latest = version;
    } catch (err) {
      // Once per outage, not once per day.
      if (!this.failing) {
        log.info(`could not check for a new release: ${err instanceof Error ? err.message : err}`);
      }
      this.failing = true;
    }
  }
}

export const releaseCheckService = new ReleaseCheckService();
