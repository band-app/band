/** Persistence for `retro_proposals`. Only `ProjectRetroService` calls this. */

import { desc, eq } from "drizzle-orm";
import { getDb } from "../connection";
import { retroProposals } from "../schema";

export type RetroProposalRow = typeof retroProposals.$inferSelect;

export class RetroProposalQueries {
  insert(row: RetroProposalRow): void {
    getDb().insert(retroProposals).values(row).run();
  }

  find(id: string): RetroProposalRow | undefined {
    return getDb().select().from(retroProposals).where(eq(retroProposals.id, id)).get();
  }

  /** Newest first. */
  listOf(projectId: string, limit: number): RetroProposalRow[] {
    return getDb()
      .select()
      .from(retroProposals)
      .where(eq(retroProposals.projectId, projectId))
      .orderBy(desc(retroProposals.createdAt))
      .limit(limit)
      .all();
  }

  withStatus(status: string): RetroProposalRow[] {
    return getDb().select().from(retroProposals).where(eq(retroProposals.status, status)).all();
  }

  update(id: string, patch: Partial<Omit<RetroProposalRow, "id" | "projectId">>): void {
    getDb().update(retroProposals).set(patch).where(eq(retroProposals.id, id)).run();
  }
}
