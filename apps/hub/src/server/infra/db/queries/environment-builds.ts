/** Persistence for `environment_builds`. */

import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../connection";
import { environmentBuilds } from "../schema";

export type EnvironmentBuildRow = typeof environmentBuilds.$inferSelect;

/** The log is kept to its last 256 KiB, so a chatty build cannot grow the database without bound. */
export const MAX_LOG_BYTES = 256 * 1024;

export class EnvironmentBuildQueries {
  insert(row: EnvironmentBuildRow): void {
    getDb().insert(environmentBuilds).values(row).run();
  }

  get(id: string): EnvironmentBuildRow | undefined {
    return getDb().select().from(environmentBuilds).where(eq(environmentBuilds.id, id)).get();
  }

  setLog(id: string, log: string): void {
    getDb().update(environmentBuilds).set({ log }).where(eq(environmentBuilds.id, id)).run();
  }

  finish(
    id: string,
    result: { status: "ready" | "failed"; image?: string; error?: string; log: string; at: number },
  ): void {
    getDb()
      .update(environmentBuilds)
      .set({
        status: result.status,
        image: result.image ?? null,
        error: result.error ?? null,
        log: result.log,
        endedAt: result.at,
      })
      .where(eq(environmentBuilds.id, id))
      .run();
  }

  /** The project's image to boot: the newest ready build. A failed build is never it. */
  current(project: string): EnvironmentBuildRow | undefined {
    return getDb()
      .select()
      .from(environmentBuilds)
      .where(and(eq(environmentBuilds.project, project), eq(environmentBuilds.status, "ready")))
      .orderBy(desc(environmentBuilds.endedAt), desc(environmentBuilds.startedAt))
      .get();
  }

  /** The newest ready build for a key, on the host that built it. */
  readyForKey(project: string, key: string, hostId: string): EnvironmentBuildRow | undefined {
    return getDb()
      .select()
      .from(environmentBuilds)
      .where(
        and(
          eq(environmentBuilds.project, project),
          eq(environmentBuilds.key, key),
          eq(environmentBuilds.hostId, hostId),
          eq(environmentBuilds.status, "ready"),
        ),
      )
      .orderBy(desc(environmentBuilds.startedAt))
      .get();
  }

  /** The newest build, whatever its status. */
  latest(project: string): EnvironmentBuildRow | undefined {
    return getDb()
      .select()
      .from(environmentBuilds)
      .where(eq(environmentBuilds.project, project))
      .orderBy(desc(environmentBuilds.startedAt))
      .get();
  }

  /** Newest first. */
  list(project: string, limit: number): EnvironmentBuildRow[] {
    return getDb()
      .select()
      .from(environmentBuilds)
      .where(eq(environmentBuilds.project, project))
      .orderBy(desc(environmentBuilds.startedAt))
      .limit(limit)
      .all();
  }

  /** Projects that have been built at least once. The auto trigger rebuilds only these. */
  projectsWithBuilds(): string[] {
    return getDb()
      .selectDistinct({ project: environmentBuilds.project })
      .from(environmentBuilds)
      .all()
      .map((r) => r.project);
  }

  /** Marks builds a stopped hub left running as failed. Returns how many. */
  failInterrupted(at: number): number {
    const result = getDb()
      .update(environmentBuilds)
      .set({
        status: "failed",
        error: "The hub stopped while this build was running.",
        endedAt: at,
      })
      .where(eq(environmentBuilds.status, "building"))
      .run();
    return Number(result.changes ?? 0);
  }

  deleteForProject(project: string): void {
    getDb().delete(environmentBuilds).where(eq(environmentBuilds.project, project)).run();
  }
}

export const environmentBuildQueries = new EnvironmentBuildQueries();
