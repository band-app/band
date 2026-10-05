import { Button, Input } from "@band-app/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { crossOriginHub } from "../../../lib/hub-config";
import { trpc } from "../../../lib/trpc-client";
import { SettingsRow } from "./SettingsRow";

type VaultList = Awaited<ReturnType<typeof trpc.vault.list.query>>;
type VaultItem = VaultList["items"][number];

const VAULT_KEY = ["vault.list"] as const;
const POLL_MS = 1000;

const KIND_LABEL: Record<VaultItem["kind"], string> = {
  api_key: "API key",
  env: "Environment variable",
  oauth: "OAuth",
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
 * and the hub never returns it. "Connect" starts an OAuth consent in a new
 * window and follows the flow until the hub has stored the tokens. Changes
 * apply at once and are not part of the dialog's Save.
 */
export function CredentialsSettings() {
  const queryClient = useQueryClient();
  const vault = useQuery<VaultList>({
    queryKey: VAULT_KEY,
    queryFn: () => trpc.vault.list.query(),
  });

  const [name, setName] = useState("");
  const [kind, setKind] = useState<"api_key" | "env">("api_key");
  const [value, setValue] = useState("");
  const [oauthName, setOauthName] = useState("");
  const [serverUrl, setServerUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const polling = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(
    () => () => {
      if (polling.current) clearInterval(polling.current);
    },
    [],
  );

  const refresh = () => queryClient.invalidateQueries({ queryKey: VAULT_KEY });
  const fail = (err: unknown) => setError(err instanceof Error ? err.message : String(err));

  const add = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await trpc.vault.put.mutate({ name: name.trim(), kind, value, scope: "global" });
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
    setNotice(null);
    try {
      await trpc.vault.delete.mutate({ id: item.id });
    } catch (err) {
      fail(err);
    }
    await refresh();
  };

  const connect = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    // Opened inside the click, so the browser does not take it for a pop-up. It is pointed at the
    // consent page once the hub has discovered the server.
    const consent = window.open("about:blank", "_blank");
    if (consent) consent.opener = null;
    try {
      const { flowId, authorizationUrl } = await trpc.vault.startOAuth.mutate({
        name: oauthName.trim(),
        serverUrl: serverUrl.trim(),
        scope: "global",
        redirectBase: crossOriginHub()?.origin ?? window.location.origin,
      });
      if (consent) consent.location.href = authorizationUrl;
      else window.open(authorizationUrl, "_blank");
      setNotice("Waiting for you to approve the connection in the new window.");
      if (polling.current) clearInterval(polling.current);
      const startedAt = Date.now();
      polling.current = setInterval(() => {
        void (async () => {
          try {
            const status = await trpc.vault.oauthStatus.query({ flowId });
            if (
              (status.status === "pending" || status.status === "exchanging") &&
              Date.now() - startedAt < 10 * 60_000
            )
              return;
            if (polling.current) clearInterval(polling.current);
            polling.current = null;
            if (status.status === "connected") {
              setNotice(null);
              setOauthName("");
              setServerUrl("");
              await refresh();
            } else {
              setNotice(null);
              setError(status.error ?? "The connection was not completed.");
            }
          } catch (err) {
            if (polling.current) clearInterval(polling.current);
            polling.current = null;
            setNotice(null);
            fail(err);
          }
        })();
      }, POLL_MS);
    } catch (err) {
      consent?.close();
      fail(err);
    } finally {
      setBusy(false);
    }
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
            onChange={(e) => setKind(e.target.value as "api_key" | "env")}
            className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm"
          >
            <option value="api_key">API key</option>
            <option value="env">Environment variable</option>
          </select>
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
            disabled={busy || name.trim() === "" || value === ""}
            onClick={() => void add()}
          >
            Add credential
          </Button>
        </div>
      </SettingsRow>

      <SettingsRow
        variant="stacked"
        label="Connect a service"
        description="Sign in to an OAuth-protected server, such as an HTTP MCP server. Band finds the sign-in page from the server URL and stores the tokens."
      >
        <div className="space-y-2">
          <Input
            aria-label="Connection name"
            placeholder="Name"
            value={oauthName}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setOauthName(e.target.value)}
            className="h-8 text-sm"
          />
          <Input
            aria-label="Server URL"
            placeholder="https://mcp.example.com/mcp"
            value={serverUrl}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setServerUrl(e.target.value)}
            className="h-8 text-sm"
          />
          <Button
            type="button"
            size="sm"
            data-testid="settings__credential-connect"
            disabled={busy || oauthName.trim() === "" || serverUrl.trim() === ""}
            onClick={() => void connect()}
          >
            Connect
          </Button>
          {notice ? (
            <p className="text-xs text-muted-foreground" data-testid="settings__credential-notice">
              {notice}
            </p>
          ) : null}
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
