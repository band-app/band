import { Button, Input } from "@band-app/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { trpc } from "../../../lib/trpc-client";
import { SettingsRow } from "./SettingsRow";

type VaultList = Awaited<ReturnType<typeof trpc.vault.list.query>>;
type VaultItem = VaultList["items"][number];

const VAULT_KEY = ["vault.list"] as const;

const KIND_LABEL: Record<VaultItem["kind"], string> = {
  api_key: "API key",
  env: "Environment variable",
  oauth: "OAuth",
  git: "Git credential",
};

function formatTime(at: number | null): string {
  return at == null ? "Never" : new Date(at).toLocaleString();
}

function oauthDetail(item: VaultItem): string {
  const account = typeof item.metadata.account === "string" ? item.metadata.account : null;
  const scopes = typeof item.metadata.scopes === "string" ? item.metadata.scopes : null;
  return [account ? `Account ${account}` : null, scopes ? `Scopes ${scopes}` : null]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Rows for the Settings dialog's Credentials section (plan step 4.1): the
 * secrets the hub stores encrypted. A value is write-only: the form sends it
 * and the hub never returns it. OAuth credentials are created from the MCP
 * section, which starts the consent flow; they are listed and deleted here.
 * Changes apply at once and are not part of the dialog's Save.
 */
export function CredentialsSettings() {
  const queryClient = useQueryClient();
  const vault = useQuery<VaultList>({
    queryKey: VAULT_KEY,
    queryFn: () => trpc.vault.list.query(),
  });

  const [name, setName] = useState("");
  const [kind, setKind] = useState<"api_key" | "env" | "git">("api_key");
  const [gitHost, setGitHost] = useState("github.com");
  const [gitPath, setGitPath] = useState("");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => queryClient.invalidateQueries({ queryKey: VAULT_KEY });
  const fail = (err: unknown) => setError(err instanceof Error ? err.message : String(err));

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      await trpc.vault.put.mutate({
        name: name.trim(),
        kind,
        value,
        scope: "global",
        ...(kind === "git" && { host: gitHost.trim(), pathPattern: gitPath.trim() }),
      });
      setName("");
      setValue("");
      await refresh();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (item: VaultItem) => {
    setError(null);
    try {
      await trpc.vault.delete.mutate({ id: item.id });
    } catch (err) {
      fail(err);
    }
    await refresh();
  };

  return (
    <>
      <SettingsRow
        variant="stacked"
        label="Stored credentials"
        description="Encrypted on the hub. A value cannot be read back, only replaced or deleted. The hub refreshes OAuth tokens before they expire."
      >
        {vault.isError ? (
          <p
            role="alert"
            className="text-xs text-muted-foreground"
            data-testid="settings__credentials-denied"
          >
            Managing credentials needs an admin token.
          </p>
        ) : null}
        <ul className="divide-y divide-border rounded-md border border-border">
          {(vault.data?.items ?? []).map((item) => (
            <li
              key={item.id}
              data-testid="settings__credential"
              data-kind={item.kind}
              className="flex items-center justify-between gap-2 px-3 py-2 text-sm"
            >
              <div className="min-w-0">
                <div className="truncate" data-testid="settings__credential-name">
                  {item.name}
                </div>
                <div className="text-xs text-muted-foreground">
                  {KIND_LABEL[item.kind]} · {item.scope} · Last used {formatTime(item.lastUsedAt)}
                </div>
                {item.kind === "oauth" ? (
                  <div
                    className="truncate text-xs text-muted-foreground"
                    data-testid="settings__credential-oauth"
                  >
                    {oauthDetail(item)}
                  </div>
                ) : null}
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0"
                aria-label={`Delete credential ${item.name}`}
                onClick={() => void remove(item)}
              >
                Delete
              </Button>
            </li>
          ))}
        </ul>
      </SettingsRow>

      <SettingsRow
        variant="stacked"
        label="Add a key"
        description="An API key or an environment variable value. The value is sent once and is not shown again."
      >
        <div className="space-y-2">
          <Input
            aria-label="Credential name"
            placeholder="Name (for an environment variable, its name)"
            value={name}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
            className="h-8 text-sm"
          />
          <select
            aria-label="Credential kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as "api_key" | "env" | "git")}
            className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm"
          >
            <option value="api_key">API key</option>
            <option value="env">Environment variable</option>
            <option value="git">Git credential (access token)</option>
          </select>
          {kind === "git" && (
            <>
              <Input
                aria-label="Git host"
                placeholder="Host, such as github.com"
                value={gitHost}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setGitHost(e.target.value)}
                className="h-8 text-sm"
              />
              <Input
                aria-label="Git path pattern"
                placeholder="Repositories, such as owner/* or owner/repo"
                value={gitPath}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setGitPath(e.target.value)}
                className="h-8 text-sm"
              />
            </>
          )}
          <Input
            aria-label="Credential value"
            type="password"
            autoComplete="off"
            placeholder="Value"
            value={value}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setValue(e.target.value)}
            className="h-8 text-sm"
          />
          <Button
            type="button"
            size="sm"
            data-testid="settings__credential-add"
            disabled={
              busy ||
              name.trim() === "" ||
              value === "" ||
              (kind === "git" && gitPath.trim() === "")
            }
            onClick={() => void add()}
          >
            Add credential
          </Button>
        </div>
      </SettingsRow>

      {error ? (
        <p
          role="alert"
          className="text-xs text-destructive"
          data-testid="settings__credential-error"
        >
          {error}
        </p>
      ) : null}
    </>
  );
}
