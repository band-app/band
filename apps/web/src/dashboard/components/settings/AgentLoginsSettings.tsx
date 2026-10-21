import { loginKindsFor } from "@band-app/shared/agent-logins";
import { Button, Input } from "@band-app/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { trpc } from "../../../lib/trpc-client";
import { Chip, Hint, RepoRow, SELECT_CLASS } from "./repo-page-ui";
import { SettingsRow } from "./SettingsRow";

export type AgentLoginList = Awaited<ReturnType<typeof trpc.agentLogins.list.query>>;
export type AgentLogin = AgentLoginList["logins"][number];

export const AGENT_LOGINS_KEY = ["agentLogins.list"] as const;

/** Logins, defaults and repo overrides. The query fails with 403 for a token that is not an admin. */
export function useAgentLogins() {
  return useQuery<AgentLoginList>({
    queryKey: AGENT_LOGINS_KEY,
    queryFn: () => trpc.agentLogins.list.query(),
    retry: false,
  });
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The agent types of the configured coding agents that Band can hold a login for. */
export function useLoginAgents() {
  const models = useQuery({
    queryKey: ["models.listAll"],
    queryFn: () => trpc.models.listAll.query(),
  });
  const seen = new Set<string>();
  const agents: { type: string; label: string }[] = [];
  for (const a of models.data?.agents ?? []) {
    if (seen.has(a.agentType) || loginKindsFor(a.agentType).length === 0) continue;
    seen.add(a.agentType);
    agents.push({ type: a.agentType, label: a.agentLabel });
  }
  return agents;
}

function AddLoginForm({ agentType, onAdded }: { agentType: string; onAdded: () => void }) {
  const kinds = loginKindsFor(agentType);
  const [kindId, setKindId] = useState(kinds[0]?.id ?? "");
  const [label, setLabel] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const kind = kinds.find((k) => k.id === kindId);

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      await trpc.agentLogins.create.mutate({
        agentType,
        kind: kindId,
        label: label.trim(),
        secret,
      });
      setLabel("");
      setSecret("");
      onAdded();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2" data-testid="settings-agent-logins__add">
      <select
        aria-label={`Login kind for ${agentType}`}
        value={kindId}
        onChange={(e) => setKindId(e.target.value)}
        className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm"
      >
        {kinds.map((k) => (
          <option key={k.id} value={k.id}>
            {k.label}
          </option>
        ))}
      </select>
      {agentType === "codex" ? (
        <p
          className="text-xs text-muted-foreground"
          data-testid="settings-agent-logins__codex-note"
        >
          Used only on hosts with no Codex login of their own. Isolating CODEX_HOME comes later.
        </p>
      ) : null}
      {kind?.note ? (
        <p className="text-xs text-muted-foreground" data-testid="settings-agent-logins__note">
          {kind.note}
        </p>
      ) : null}
      <Input
        aria-label={`Login label for ${agentType}`}
        placeholder="Label, such as Team subscription"
        value={label}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setLabel(e.target.value)}
        className="h-8 text-sm"
      />
      <Input
        aria-label={`Login secret for ${agentType}`}
        type="password"
        autoComplete="off"
        placeholder="Secret"
        value={secret}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSecret(e.target.value)}
        className="h-8 text-sm"
      />
      <Button
        type="button"
        size="sm"
        data-testid="settings-agent-logins__add-submit"
        disabled={busy || label.trim() === "" || secret === ""}
        onClick={() => void add()}
      >
        Add login
      </Button>
      {error ? (
        <p
          role="alert"
          className="text-xs text-destructive"
          data-testid="settings-agent-logins__error"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}

function LoginRow({ login, onChanged }: { login: AgentLogin; onChanged: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = async () => {
    setError(null);
    try {
      await trpc.agentLogins.remove.mutate({ id: login.id });
      onChanged();
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <li
      className="flex items-center justify-between gap-2 px-3 py-2 text-sm"
      data-testid="settings-agent-logins__login"
      data-login-id={login.id}
    >
      <div className="min-w-0">
        <div className="truncate" data-testid="settings-agent-logins__login-label">
          {login.label}
        </div>
        <div className="text-xs text-muted-foreground">
          {login.kindLabel} · {login.envVar}
          {login.missingSecret ? (
            <span className="text-destructive" data-testid="settings-agent-logins__missing">
              {" "}
              · missing secret
            </span>
          ) : null}
        </div>
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </div>
      {confirming ? (
        <div className="flex shrink-0 gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="settings-agent-logins__remove-confirm"
            onClick={() => void remove()}
          >
            Confirm remove
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
        </div>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="shrink-0"
          aria-label={`Remove login ${login.label}`}
          data-testid="settings-agent-logins__remove"
          onClick={() => setConfirming(true)}
        >
          Remove
        </Button>
      )}
    </li>
  );
}

/**
 * Settings > Agent logins: the credentials Band gives a coding agent when it starts one, backed by
 * vault items. A secret is write-only. An agent with no login chosen uses
 * the machine's own login, as before. Admin only: a token that is not an admin sees a notice.
 */
export function AgentLoginsSettings() {
  const queryClient = useQueryClient();
  const logins = useAgentLogins();
  const agents = useLoginAgents();
  const [error, setError] = useState<string | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: AGENT_LOGINS_KEY });

  if (logins.isError) {
    return (
      <p
        role="alert"
        className="text-xs text-muted-foreground"
        data-testid="settings-agent-logins__denied"
      >
        Managing agent logins needs an admin token.
      </p>
    );
  }

  const setDefault = async (agentType: string, loginId: string) => {
    setError(null);
    try {
      await trpc.agentLogins.setDefault.mutate({ agentType, loginId: loginId || null });
      await refresh();
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <>
      {agents.map((agent) => {
        const own = (logins.data?.logins ?? []).filter((l) => l.agentType === agent.type);
        const defaultId = logins.data?.defaults[agent.type] ?? "";
        return (
          <SettingsRow
            key={agent.type}
            variant="stacked"
            label={agent.label}
            description="With no default, the agent uses the machine's own login."
          >
            <div
              className="space-y-3"
              data-testid="settings-agent-logins__agent"
              data-agent={agent.type}
            >
              {own.length > 0 ? (
                <ul className="divide-y divide-border rounded-md border border-border">
                  {own.map((login) => (
                    <LoginRow key={login.id} login={login} onChanged={() => void refresh()} />
                  ))}
                </ul>
              ) : null}
              <select
                aria-label={`Default login for ${agent.label}`}
                data-testid="settings-agent-logins__default"
                value={defaultId}
                onChange={(e) => void setDefault(agent.type, e.target.value)}
                className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm"
              >
                <option value="">The machine's own login</option>
                {own.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.label}
                  </option>
                ))}
              </select>
              <AddLoginForm agentType={agent.type} onAdded={() => void refresh()} />
            </div>
          </SettingsRow>
        );
      })}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </>
  );
}

/**
 * The repo page's Agents rows: one per coding agent Band can hold a login for, with the login it
 * uses in this repo. "Use the default" follows the agent's default from Agent logins; another pick
 * is an override, marked with a chip. An agent with no logins says where to add one.
 */
export function RepoLoginOverrides({ repoName }: { repoName: string }) {
  const queryClient = useQueryClient();
  const logins = useAgentLogins();
  const agents = useLoginAgents();
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const data = logins.data;
  if (!data) {
    return (
      <p
        className="px-4 py-3 text-xs text-muted-foreground"
        data-testid="settings-repo__logins-none"
      >
        {logins.isError ? "Changing logins needs an admin token." : "Loading…"}
      </p>
    );
  }
  if (agents.length === 0) {
    return (
      <p
        className="px-4 py-3 text-xs text-muted-foreground"
        data-testid="settings-repo__logins-none"
      >
        No coding agent that takes a login is set up. Enable one in Coding Agents.
      </p>
    );
  }

  const change = async (agentType: string, loginId: string) => {
    setError(null);
    setSaving(true);
    try {
      await trpc.agentLogins.setRepoOverride.mutate({
        agentType,
        repo: repoName,
        loginId: loginId || null,
      });
      await queryClient.invalidateQueries({ queryKey: AGENT_LOGINS_KEY });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      {agents.map((agent) => {
        const own = data.logins.filter((l) => l.agentType === agent.type);
        const current =
          data.repoOverrides.find((o) => o.agentType === agent.type && o.repo === repoName)
            ?.loginId ?? "";
        const fallback = data.logins.find((l) => l.id === data.defaults[agent.type]);
        const id = `settings-repo-${repoName}-login-${agent.type}`;
        if (own.length === 0) {
          return (
            <RepoRow
              key={agent.type}
              label={agent.label}
              description="No logins yet."
              testId="settings-repo__login-row"
              data={{ "data-agent": agent.type }}
            >
              <Hint>Add one in Agent logins</Hint>
            </RepoRow>
          );
        }
        return (
          <RepoRow
            key={agent.type}
            htmlFor={id}
            label={agent.label}
            description={`Default: ${fallback?.label ?? "none (the machine's own login)"}.`}
            testId="settings-repo__login-row"
            data={{ "data-agent": agent.type }}
          >
            <select
              id={id}
              aria-label={`${agent.label} login for ${repoName}`}
              data-testid="settings-repo__login-override"
              data-agent={agent.type}
              data-repo={repoName}
              value={current}
              disabled={saving}
              onChange={(e) => void change(agent.type, e.target.value)}
              className={SELECT_CLASS}
            >
              <option value="">Use the default</option>
              {own.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label}
                </option>
              ))}
            </select>
            {current ? (
              <Chip tone="scoped" testId="settings-repo__login-override-chip">
                override
              </Chip>
            ) : null}
          </RepoRow>
        );
      })}
      {error ? (
        <p role="alert" className="px-4 py-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </>
  );
}
