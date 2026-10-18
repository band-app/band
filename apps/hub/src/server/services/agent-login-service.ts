/**
 * Band-managed logins for coding agents.
 *
 * A login is a vault item plus a kind (`@band-app/shared/agent-logins`) that says which environment
 * variable carries it. The hub resolves one at every agent start (a chat's own pick, then the
 * repo's override, then the agent type's default), reads the vault then, and adds the variable to
 * that one process. Nothing here stores or returns a secret.
 */

import { randomUUID } from "node:crypto";
import { createLogger } from "@band-app/logger";
import {
  AGENT_LOGIN_KINDS,
  findLoginKind,
  type LoginEnv,
  loginEnvFor,
  MAX_LOGIN_SECRET_LENGTH,
} from "@band-app/shared/agent-logins";
import { AgentLoginInputError, AgentLoginNotFoundError } from "../errors";
import {
  AgentLoginQueries,
  type AgentLoginRow,
  DEFAULT_CHOICE_REPO,
} from "../infra/db/queries/agent-logins";
import { VaultQueries } from "../infra/db/queries/vault";
import { vaultService } from "./vault-service";

const log = createLogger("agent-login-service");

/** Vault items the service creates are named `agent-login:<login id>`. */
const OWNED_PREFIX = "agent-login:";
const LABEL = /^[^\n\r]{1,80}$/;
const REPO = /^[^\s:]{1,100}$/;

export interface AgentLoginView {
  id: string;
  agentType: string;
  label: string;
  kind: string;
  kindLabel: string;
  /** The variable that carries the secret. */
  envVar: string;
  vaultItemId: string;
  /** True when the vault item is gone, so the login cannot be used until it is replaced. */
  missingSecret: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface AgentLoginList {
  logins: AgentLoginView[];
  defaults: Record<string, string>;
  repoOverrides: { agentType: string; repo: string; loginId: string }[];
}

/** What the chat picker shows: no vault ids. */
export interface AgentLoginOption {
  id: string;
  label: string;
  kindLabel: string;
  isDefault: boolean;
}

export interface ResolveInput {
  agentType: string;
  /** The repo the agent runs in. */
  repo?: string;
  /** The login the chat picked. */
  chatLoginId?: string;
}

export class AgentLoginService {
  constructor(
    private readonly queries: AgentLoginQueries = new AgentLoginQueries(),
    private readonly vaultQueries: VaultQueries = new VaultQueries(),
  ) {}

  // ---- reads (metadata only) ------------------------------------------------------

  list(): AgentLoginList {
    const choices = this.queries.choices();
    return {
      logins: this.queries.list().map((row) => this.view(row)),
      defaults: Object.fromEntries(
        choices.filter((c) => c.repo === DEFAULT_CHOICE_REPO).map((c) => [c.agentType, c.loginId]),
      ),
      repoOverrides: choices
        .filter((c) => c.repo !== DEFAULT_CHOICE_REPO)
        .map(({ agentType, repo, loginId }) => ({ agentType, repo, loginId })),
    };
  }

  /** The logins of one agent type that a chat may pick, for any device. */
  optionsFor(agentType: string): AgentLoginOption[] {
    const defaultId = this.queries.choice(agentType, DEFAULT_CHOICE_REPO);
    return this.queries
      .list()
      .filter((row) => row.agentType === agentType)
      .map((row) => ({
        id: row.id,
        label: row.label,
        kindLabel: this.kindLabel(row),
        isDefault: row.id === defaultId,
      }));
  }

  /** Whether any login with a secret exists for the agent type, so a host without its own login can run it. */
  hasUsableLogin(agentType: string): boolean {
    return this.queries
      .list()
      .some((row) => row.agentType === agentType && this.vaultQueries.find(row.vaultItemId));
  }

  /** Throws unless `loginId` is a login of `agentType`. For a chat that picks one. */
  assertPickable(loginId: string, agentType: string): void {
    const row = this.queries.find(loginId);
    if (!row || row.agentType !== agentType) {
      throw new AgentLoginInputError(`That is not a login for ${agentType}.`);
    }
  }

  // ---- writes ---------------------------------------------------------------------

  /** Adds a login. A `secret` becomes a new vault item. A `vaultItemId` reuses an existing one. */
  create(input: {
    agentType: string;
    kind: string;
    label: string;
    secret?: string;
    vaultItemId?: string;
  }): AgentLoginView {
    if (!AGENT_LOGIN_KINDS[input.agentType]) {
      throw new AgentLoginInputError(`${input.agentType} has no Band-managed logins.`);
    }
    if (!findLoginKind(input.agentType, input.kind)) {
      throw new AgentLoginInputError(`${input.kind} is not a login kind of ${input.agentType}.`);
    }
    const label = this.checkLabel(input.label);
    if (Boolean(input.secret) === Boolean(input.vaultItemId)) {
      throw new AgentLoginInputError("Give either a secret or a vault item id.");
    }
    const id = `al-${randomUUID().slice(0, 12)}`;
    let vaultItemId = input.vaultItemId ?? "";
    if (input.secret) {
      vaultItemId = this.storeSecret(id, input.secret);
    } else {
      const item = this.vaultQueries.find(vaultItemId);
      if (!item) throw new AgentLoginInputError("That vault item does not exist.");
      if (item.kind !== "api_key" && item.kind !== "env") {
        throw new AgentLoginInputError("Only an API key or env vault item can carry a login.");
      }
    }
    const now = Date.now();
    const row: AgentLoginRow = {
      id,
      agentType: input.agentType,
      label,
      kind: input.kind,
      vaultItemId,
      createdAt: now,
      updatedAt: now,
    };
    this.queries.insert(row);
    log.info({ id, agentType: row.agentType, kind: row.kind }, "agent login created");
    return this.view(row);
  }

  /** Renames a login, and replaces its secret when the vault item is one the service created. */
  update(input: { id: string; label?: string; secret?: string }): AgentLoginView {
    const row = this.require(input.id);
    // Every check runs before the first write, so a refused secret leaves the label alone.
    const label = input.label === undefined ? undefined : this.checkLabel(input.label);
    if (input.secret !== undefined) {
      const item = this.vaultQueries.find(row.vaultItemId);
      if (item && !item.name.startsWith(OWNED_PREFIX)) {
        throw new AgentLoginInputError(
          "This login uses a vault item you added. Change the secret under Credentials.",
        );
      }
      this.checkSecret(input.secret);
    }
    if (label !== undefined) this.queries.update(row.id, { label, updatedAt: Date.now() });
    if (input.secret !== undefined) {
      const vaultItemId = this.storeSecret(row.id, input.secret);
      this.queries.update(row.id, { vaultItemId, updatedAt: Date.now() });
    }
    return this.view(this.require(row.id));
  }

  /** Removes a login, the defaults and overrides that use it, and the vault item it created. */
  async remove(id: string): Promise<{ removed: true }> {
    const row = this.require(id);
    this.queries.remove(id);
    const item = this.vaultQueries.find(row.vaultItemId);
    if (item?.name.startsWith(OWNED_PREFIX)) await vaultService.remove(item.id);
    log.info({ id, agentType: row.agentType }, "agent login removed");
    return { removed: true };
  }

  setDefault(agentType: string, loginId: string | null): void {
    this.setChoice(agentType, DEFAULT_CHOICE_REPO, loginId);
  }

  setRepoOverride(agentType: string, repo: string, loginId: string | null): void {
    if (!REPO.test(repo)) throw new AgentLoginInputError("The repo name has characters we refuse.");
    this.setChoice(agentType, repo, loginId);
  }

  // ---- launch ---------------------------------------------------------------------

  /**
   * The environment for an agent about to start, or null for the machine's own login. A chat's pick
   * wins over the repo's override, which wins over the default. A login whose secret is gone is
   * skipped. Reads the vault on every call.
   */
  async resolve(input: ResolveInput): Promise<LoginEnv | null> {
    const ids = [
      input.chatLoginId,
      input.repo ? this.queries.choice(input.agentType, input.repo) : undefined,
      this.queries.choice(input.agentType, DEFAULT_CHOICE_REPO),
    ];
    for (const id of ids) {
      if (!id) continue;
      const row = this.queries.find(id);
      if (!row || row.agentType !== input.agentType) continue;
      const kind = findLoginKind(row.agentType, row.kind);
      if (!kind) continue;
      try {
        const { value } = await vaultService.getCredential(row.vaultItemId);
        return loginEnvFor(kind, value);
      } catch {
        log.warn({ id, agentType: row.agentType }, "agent login has no readable secret; skipped");
      }
    }
    return null;
  }

  // ---- helpers --------------------------------------------------------------------

  /** The secret without a trailing newline, or throws when it is not one line of 1 to 8192 characters. */
  private checkSecret(secret: string): string {
    const value = secret.replace(/\r?\n$/, "");
    if (!value || value.length > MAX_LOGIN_SECRET_LENGTH || /[\0\r\n]/.test(value)) {
      throw new AgentLoginInputError("The secret must be one line of 1 to 8192 characters.");
    }
    return value;
  }

  private storeSecret(loginId: string, secret: string): string {
    const value = this.checkSecret(secret);
    return vaultService.put({
      name: `${OWNED_PREFIX}${loginId}`,
      kind: "api_key",
      scope: "global",
      value,
      description: "Agent login",
    }).id;
  }

  private setChoice(agentType: string, repo: string, loginId: string | null): void {
    if (loginId === null) {
      this.queries.clearChoice(agentType, repo);
      return;
    }
    const row = this.require(loginId);
    if (row.agentType !== agentType) {
      throw new AgentLoginInputError(`That login belongs to ${row.agentType}, not ${agentType}.`);
    }
    this.queries.setChoice(agentType, repo, loginId);
  }

  private require(id: string): AgentLoginRow {
    const row = this.queries.find(id);
    if (!row) throw new AgentLoginNotFoundError();
    return row;
  }

  private checkLabel(label: string): string {
    const trimmed = label.trim();
    if (!LABEL.test(trimmed))
      throw new AgentLoginInputError("The label must be 1 to 80 characters.");
    return trimmed;
  }

  private kindLabel(row: AgentLoginRow): string {
    return findLoginKind(row.agentType, row.kind)?.label ?? row.kind;
  }

  private view(row: AgentLoginRow): AgentLoginView {
    const kind = findLoginKind(row.agentType, row.kind);
    return {
      id: row.id,
      agentType: row.agentType,
      label: row.label,
      kind: row.kind,
      kindLabel: kind?.label ?? row.kind,
      envVar: kind?.secretVar ?? "",
      vaultItemId: row.vaultItemId,
      missingSecret: !this.vaultQueries.find(row.vaultItemId),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

export const agentLoginService = new AgentLoginService();
