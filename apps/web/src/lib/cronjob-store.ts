import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createLogger } from "@band/logger";
import type { CronjobDefinition, CronjobFile } from "./cronjob-types";
import { bandHome } from "./state";

const log = createLogger("cronjob-store");

export function cronjobsDir(): string {
  return join(bandHome(), "cronjobs");
}

export function ensureCronjobsDir(): void {
  mkdirSync(cronjobsDir(), { recursive: true });
}

export function generateCronjobId(): string {
  return `cj_${Date.now()}`;
}

/** Load all jobs from a specific file (project or workspace key) */
export function loadCronjobFile(key: string): CronjobFile {
  try {
    const filePath = join(cronjobsDir(), `${key}.json`);
    const data = readFileSync(filePath, "utf-8");
    return JSON.parse(data) as CronjobFile;
  } catch {
    return { jobs: [] };
  }
}

/** Save jobs for a specific key, using atomic write (temp + rename) */
export function saveCronjobFile(key: string, file: CronjobFile): void {
  ensureCronjobsDir();
  const filePath = join(cronjobsDir(), `${key}.json`);
  const tmpPath = join(cronjobsDir(), `.${key}.json.tmp`);
  writeFileSync(tmpPath, JSON.stringify(file, null, 2), "utf-8");
  renameSync(tmpPath, filePath);
}

/** List all cronjob files, returning all jobs across all files with their file keys */
export function listAllCronjobs(): (CronjobDefinition & { fileKey: string })[] {
  const dir = cronjobsDir();
  const allJobs: (CronjobDefinition & { fileKey: string })[] = [];
  try {
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      const key = file.replace(".json", "");
      try {
        const data = readFileSync(join(dir, file), "utf-8");
        const parsed = JSON.parse(data) as CronjobFile;
        for (const job of parsed.jobs) {
          allJobs.push({ ...job, fileKey: key });
        }
      } catch (err) {
        log.warn({ file, err }, "skipping invalid cronjob file");
      }
    }
  } catch {
    // Dir may not exist yet
  }
  return allJobs;
}

/** Delete all jobs for a key (used during workspace/project removal) */
export function deleteCronjobFile(key: string): void {
  try {
    const filePath = join(cronjobsDir(), `${key}.json`);
    unlinkSync(filePath);
  } catch {
    // File may not exist
  }
}
