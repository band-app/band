import { eq } from "drizzle-orm";
import type { CronjobDefinition, CronjobFile } from "./cronjob-types";
import { getDb } from "./db/connection";
import { cronjobs } from "./db/schema";

export function generateCronjobId(): string {
  return `cj_${Date.now()}`;
}

/** Load all jobs for a specific key (project or workspace). */
export function loadCronjobFile(key: string): CronjobFile {
  const db = getDb();
  const rows = db.select().from(cronjobs).where(eq(cronjobs.fileKey, key)).all();
  return { jobs: rows.map(rowToDefinition) };
}

/** Save jobs for a specific key — upserts each job and removes stale ones. */
export function saveCronjobFile(key: string, file: CronjobFile): void {
  const db = getDb();

  // Delete all existing jobs for this key, then insert fresh
  db.delete(cronjobs).where(eq(cronjobs.fileKey, key)).run();

  for (const job of file.jobs) {
    db.insert(cronjobs)
      .values({
        id: job.id,
        fileKey: key,
        name: job.name,
        prompt: job.prompt,
        cronExpression: job.cronExpression,
        scope: job.scope,
        workspaceId: job.workspaceId ?? null,
        enabled: job.enabled,
        createdAt: job.createdAt,
        lastRunAt: job.lastRunAt ?? null,
        lastRunStatus: job.lastRunStatus ?? null,
      })
      .run();
  }
}

/** List all cronjobs across all keys. */
export function listAllCronjobs(): (CronjobDefinition & { fileKey: string })[] {
  const db = getDb();
  const rows = db.select().from(cronjobs).all();
  return rows.map((row) => ({ ...rowToDefinition(row), fileKey: row.fileKey }));
}

/** Delete all jobs for a key (used during workspace/project removal). */
export function deleteCronjobFile(key: string): void {
  const db = getDb();
  db.delete(cronjobs).where(eq(cronjobs.fileKey, key)).run();
}

function rowToDefinition(row: typeof cronjobs.$inferSelect): CronjobDefinition {
  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    cronExpression: row.cronExpression,
    scope: row.scope as CronjobDefinition["scope"],
    workspaceId: row.workspaceId ?? undefined,
    enabled: row.enabled,
    createdAt: row.createdAt,
    lastRunAt: row.lastRunAt ?? undefined,
    lastRunStatus: row.lastRunStatus as CronjobDefinition["lastRunStatus"],
  };
}
