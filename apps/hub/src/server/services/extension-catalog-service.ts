/**
 * The catalog of official extensions: one `index.json` asset on the `catalog` release of
 * `band-app/band-extensions`. The hub fetches that single file at startup and then once a day,
 * keeps it in memory. When a fetch fails the list is emptied and `available` is false, so the
 * UI shows a quiet "Catalog unavailable" note until the next fetch works. `BAND_EXTENSION_CATALOG_URL`
 * replaces the URL and is read on every fetch.
 */

import { createLogger } from "@band-app/logger";
import { compareVersions, isStrictSemver } from "@band-app/shared/versions";
import { z } from "zod";
import { HUB_VERSION } from "./_utils/hub-version";

const log = createLogger("extension-catalog");

const DAY_MS = 24 * 60 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_INDEX_BYTES = 1024 * 1024;
export const DEFAULT_CATALOG_URL =
  "https://github.com/band-app/band-extensions/releases/download/catalog/index.json";

const semver = z.string().refine((v) => isStrictSemver(v), "not a plain MAJOR.MINOR.PATCH version");

export const catalogEntrySchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  name: z.string().min(1).max(100),
  description: z.string().max(1000).default(""),
  version: semver,
  url: z.string().min(1).max(2000),
  sha256: z.string().regex(/^[0-9a-f]{64}$/i),
  minBand: semver,
  worker: z.boolean().default(false),
  requires: z.array(z.string().max(100)).max(20).default([]),
});

export type CatalogEntry = z.infer<typeof catalogEntrySchema>;

export class ExtensionCatalogService {
  private entries: CatalogEntry[] = [];
  private available = false;
  private timer: NodeJS.Timeout | null = null;
  private failing = false;
  private inFlight: Promise<void> | null = null;

  start(): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), DAY_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** The entries of the last fetch. `available` is false until one worked and after one failed. */
  snapshot(): { entries: CatalogEntry[]; available: boolean } {
    return { entries: this.entries, available: this.available };
  }

  get(id: string): CatalogEntry | undefined {
    return this.entries.find((e) => e.id === id);
  }

  /** Whether this hub meets the entry's `minBand`. */
  compatible(entry: CatalogEntry): boolean {
    return (compareVersions(HUB_VERSION, entry.minBand) ?? -1) >= 0;
  }

  /** Fetches the index once. Never throws: a failure empties the list and is logged once per outage. */
  refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.fetchIndex().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async fetchIndex(): Promise<void> {
    const url = process.env.BAND_EXTENSION_CATALOG_URL?.trim() || DEFAULT_CATALOG_URL;
    try {
      const res = await fetch(url, {
        headers: { accept: "application/json", "user-agent": "band-hub" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`the catalog answered ${res.status}`);
      if (Number(res.headers.get("content-length") ?? 0) > MAX_INDEX_BYTES) {
        throw new Error("the catalog is over 1 MB");
      }
      const text = await res.text();
      if (text.length > MAX_INDEX_BYTES) throw new Error("the catalog is over 1 MB");
      const body = JSON.parse(text) as unknown;
      const list = Array.isArray(body)
        ? body
        : body &&
            typeof body === "object" &&
            Array.isArray((body as { extensions?: unknown }).extensions)
          ? (body as { extensions: unknown[] }).extensions
          : null;
      if (!list) throw new Error("the catalog is not a list of extensions");
      const entries: CatalogEntry[] = [];
      for (const raw of list) {
        const parsed = catalogEntrySchema.safeParse(raw);
        if (!parsed.success) {
          log.warn(`Skipping a catalog entry: ${parsed.error.issues[0]?.message}`);
          continue;
        }
        if (entries.some((e) => e.id === parsed.data.id)) continue;
        entries.push({ ...parsed.data, sha256: parsed.data.sha256.toLowerCase() });
      }
      this.entries = entries;
      this.available = true;
      this.failing = false;
    } catch (err) {
      this.available = false;
      this.entries = [];
      if (!this.failing) {
        log.info(
          `could not read the extension catalog: ${err instanceof Error ? err.message : err}`,
        );
      }
      this.failing = true;
    }
  }
}

export const extensionCatalogService = new ExtensionCatalogService();
