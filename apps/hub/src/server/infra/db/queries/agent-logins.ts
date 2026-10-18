/**
 * Persistence for `agent_logins` and `agent_login_choices`. Rows name a vault item and never hold a
 * secret. Only `AgentLoginService` calls this.
 */

import { and, asc, eq } from "drizzle-orm";
import { getDb } from "../connection";
import { agentLoginChoices, agentLogins } from "../schema";

export type AgentLoginRow = typeof agentLogins.$inferSelect;
export type AgentLoginChoiceRow = typeof agentLoginChoices.$inferSelect;

/** The `repo` of a choice that is the agent type's default. */
export const DEFAULT_CHOICE_REPO = "";

export class AgentLoginQueries {
  list(): AgentLoginRow[] {
    return getDb().select().from(agentLogins).orderBy(asc(agentLogins.createdAt)).all();
  }

  find(id: string): AgentLoginRow | undefined {
    return getDb().select().from(agentLogins).where(eq(agentLogins.id, id)).get();
  }

  insert(row: AgentLoginRow): void {
    getDb().insert(agentLogins).values(row).run();
  }

  update(
    id: string,
    patch: Partial<Pick<AgentLoginRow, "label" | "vaultItemId" | "updatedAt">>,
  ): void {
    getDb().update(agentLogins).set(patch).where(eq(agentLogins.id, id)).run();
  }

  /** Deletes the login and every default or override that points at it. */
  remove(id: string): void {
    getDb().transaction((tx) => {
      tx.delete(agentLoginChoices).where(eq(agentLoginChoices.loginId, id)).run();
      tx.delete(agentLogins).where(eq(agentLogins.id, id)).run();
    });
  }

  choices(): AgentLoginChoiceRow[] {
    return getDb().select().from(agentLoginChoices).all();
  }

  choice(agentType: string, repo: string): string | undefined {
    return getDb()
      .select()
      .from(agentLoginChoices)
      .where(and(eq(agentLoginChoices.agentType, agentType), eq(agentLoginChoices.repo, repo)))
      .get()?.loginId;
  }

  setChoice(agentType: string, repo: string, loginId: string): void {
    getDb()
      .insert(agentLoginChoices)
      .values({ agentType, repo, loginId })
      .onConflictDoUpdate({
        target: [agentLoginChoices.agentType, agentLoginChoices.repo],
        set: { loginId },
      })
      .run();
  }

  clearChoice(agentType: string, repo: string): void {
    getDb()
      .delete(agentLoginChoices)
      .where(and(eq(agentLoginChoices.agentType, agentType), eq(agentLoginChoices.repo, repo)))
      .run();
  }
}
