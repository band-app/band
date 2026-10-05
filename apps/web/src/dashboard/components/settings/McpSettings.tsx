import { Button, Input } from "@band-app/ui";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { crossOriginHub } from "../../../lib/hub-config";
import { trpc } from "../../../lib/trpc-client";
import { SettingsRow } from "./SettingsRow";

type McpList = Awaited<ReturnType<typeof trpc.mcp.list.query>>;
type McpServer = McpList["servers"][number];
type TestResult = Awaited<ReturnType<typeof trpc.mcp.test.mutate>>;
type ToolInfo = Extract<TestResult, { ok: true }>["tools"][number];
type VaultItem = Awaited<ReturnType<typeof trpc.vault.list.query>>["items"][number];

const MCP_KEY = ["mcp.list"] as const;
const VAULT_KEY = ["mcp.vault-items"] as const;
const AUDIT_PAGE = 20;
const POLL_MS = 1000;

type ScopeMode = "all" | "repos" | "hosts";

/** One environment variable of a stdio server: a literal, or the id of a vault item. */
interface EnvRow {
  name: string;
  source: "value" | "vault";
  value: string;
  vaultItemId: string;
}

interface FormState {
  /** The saved server being edited, or null for a new one. */
  editing: string | null;
  name: string;
  transport: "http" | "stdio";
  url: string;
  /** A stdio server's host, command, arguments (one per line), working directory and environment. */
  hostId: string;
  command: string;
  args: string;
  cwd: string;
  env: EnvRow[];
  vaultItemId: string;
  headerName: string;
  headerPrefix: string;
  allowAll: boolean;
  allowed: string[];
  readOnly: boolean;
  enabled: boolean;
  scopeMode: ScopeMode;
  scopeRepos: string[];
  scopeHosts: string[];
}

const EMPTY_FORM: FormState = {
  editing: null,
  name: "",
  transport: "http",
  url: "",
  hostId: "",
  command: "",
  args: "",
  cwd: "",
  env: [],
  vaultItemId: "",
  headerName: "Authorization",
  headerPrefix: "Bearer ",
  allowAll: true,
  allowed: [],
  readOnly: false,
  enabled: true,
  scopeMode: "all",
  scopeRepos: [],
  scopeHosts: [],
};

function formFor(server: McpServer): FormState {
  return {
    editing: server.name,
    name: server.name,
    transport: server.transport,
    url: server.url,
    hostId: server.hostId ?? "",
    command: server.command ?? "",
    args: server.args.join("\n"),
    cwd: server.cwd ?? "",
    env: server.env.map((entry) =>
      "vaultItemId" in entry
        ? { name: entry.name, source: "vault", value: "", vaultItemId: entry.vaultItemId }
        : { name: entry.name, source: "value", value: entry.value, vaultItemId: "" },
    ),
    vaultItemId: server.vaultItemId ?? "",
    headerName: server.headerName,
    headerPrefix: server.headerPrefix,
    allowAll: server.allowTools === null,
    allowed: server.allowTools ?? [],
    readOnly: server.readOnly,
    enabled: server.enabled,
    scopeMode: server.scopeRepos ? "repos" : server.scopeHosts ? "hosts" : "all",
    scopeRepos: server.scopeRepos ?? [],
    scopeHosts: server.scopeHosts ?? [],
  };
}

function scopeSummary(server: McpServer): string {
  if (server.scopeRepos) return `Repos: ${server.scopeRepos.join(", ") || "none"}`;
  if (server.scopeHosts) return `Hosts: ${server.scopeHosts.join(", ") || "none"}`;
  return "All worktrees";
}

/** What the hub is sent for a stdio server's process. Rows with no name are dropped. */
function stdioFields(form: FormState) {
  return {
    hostId: form.hostId,
    command: form.command.trim(),
    args: form.args.split("\n").filter((line) => line !== ""),
    cwd: form.cwd.trim() === "" ? null : form.cwd.trim(),
    env: form.env
      .filter((row) => row.name.trim() !== "")
      .map((row) =>
        row.source === "vault"
          ? { name: row.name.trim(), vaultItemId: row.vaultItemId }
          : { name: row.name.trim(), value: row.value },
      ),
  };
}

function formReady(form: FormState): boolean {
  if (!form.editing && form.name.trim() === "") return false;
  if (form.transport === "stdio") return form.hostId !== "" && form.command.trim() !== "";
  return form.url.trim() !== "";
}

function serverState(
  server: McpServer,
  result: TestResult | "checking" | undefined,
  hostStatus: string | undefined,
): "disabled" | "ok" | "other" {
  if (!server.enabled) return "disabled";
  if (server.transport === "stdio") return hostStatus === "online" ? "ok" : "other";
  return typeof result === "object" && result.ok ? "ok" : "other";
}

function toggle(list: string[], value: string, on: boolean): string[] {
  return on ? [...new Set([...list, value])] : list.filter((v) => v !== value);
}

function statusText(result: TestResult | "checking" | undefined): string {
  if (!result) return "Not checked";
  if (result === "checking") return "Checking";
  if (result.ok) return `Reachable, ${result.tools.length} tools`;
  return result.reason === "auth" ? "Reachable, credential refused" : "Unreachable";
}

/**
 * Rows for the Settings dialog's MCP section (plan step 4.5): the HTTP and stdio MCP servers the hub
 * proxies, with the credential from the vault, the tool allowlist (picked from the server's live
 * `tools/list`), read-only mode, scope, status and the audit log. Changes apply at once and are
 * not part of the dialog's Save. A credential is only ever named by its vault id here.
 */
export function McpSettings() {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<FormState | null>(null);
  const servers = useQuery<McpList>({ queryKey: MCP_KEY, queryFn: () => trpc.mcp.list.query() });
  const vault = useQuery({
    queryKey: VAULT_KEY,
    queryFn: async () => (await trpc.vault.list.query()).items,
    enabled: servers.isSuccess && form !== null,
  });
  const repos = useQuery({
    queryKey: ["mcp.repos"],
    queryFn: async () =>
      ((await trpc.repos.list.query()).repos as Array<{ name: string }>).map((p) => p.name),
    enabled: form?.scopeMode === "repos",
  });
  // Scope choices, the stdio host picker and the status of a stdio server's host.
  const hosts = useQuery({
    queryKey: ["mcp.hosts"],
    queryFn: async () => (await trpc.hosts.list.query()).hosts,
    enabled: servers.isSuccess,
    // A worker may join or drop while this section is open.
    refetchInterval: 5000,
  });

  const [tools, setTools] = useState<ToolInfo[] | null>(null);
  const [testMessage, setTestMessage] = useState<string | null>(null);
  const [testOk, setTestOk] = useState(false);
  const [status, setStatus] = useState<Record<string, TestResult | "checking">>({});
  const [auditFor, setAuditFor] = useState<string | null>(null);
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

  const stopPolling = () => {
    if (polling.current) clearInterval(polling.current);
    polling.current = null;
    setNotice(null);
  };
  const refresh = () => queryClient.invalidateQueries({ queryKey: MCP_KEY });
  const fail = (err: unknown) => setError(err instanceof Error ? err.message : String(err));
  const patch = (changes: Partial<FormState>) =>
    setForm((current) => (current ? { ...current, ...changes } : current));

  const check = async (server: Pick<McpServer, "name">) => {
    setStatus((s) => ({ ...s, [server.name]: "checking" }));
    try {
      const result = await trpc.mcp.test.mutate({ name: server.name });
      setStatus((s) => ({ ...s, [server.name]: result }));
    } catch (err) {
      setStatus((s) => ({
        ...s,
        [server.name]: {
          ok: false,
          reason: "error",
          message: err instanceof Error ? err.message : String(err),
        },
      }));
    }
  };

  // Status of each enabled server, checked once when the list first loads.
  const checkedOnce = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once, when the list first loads
  useEffect(() => {
    if (!servers.data || checkedOnce.current) return;
    checkedOnce.current = true;
    // A stdio server is not started for a status check; its status is whether its host is online.
    for (const server of servers.data.servers) {
      if (server.enabled && server.transport === "http") void check(server);
    }
  }, [servers.data]);

  const open = (next: FormState) => {
    stopPolling();
    // The Credentials section may have added a key since the last load.
    void vault.refetch();
    void hosts.refetch();
    setForm(next);
    setTools(null);
    setTestMessage(null);
    setError(null);
    setNotice(null);
  };

  const testConnection = async () => {
    if (!form) return;
    setBusy(true);
    setError(null);
    setTestMessage(null);
    try {
      const result = await trpc.mcp.test.mutate(
        form.transport === "stdio"
          ? { transport: "stdio", ...stdioFields(form) }
          : {
              url: form.url.trim(),
              vaultItemId: form.vaultItemId || null,
              headerName: form.headerName,
              headerPrefix: form.headerPrefix,
            },
      );
      if (result.ok) {
        setTools(result.tools);
        setTestOk(true);
        setTestMessage(`Connected. ${result.tools.length} tools.`);
      } else {
        setTools(null);
        setTestOk(false);
        setTestMessage(result.message);
      }
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!form) return;
    setBusy(true);
    setError(null);
    const connection =
      form.transport === "stdio"
        ? stdioFields(form)
        : {
            url: form.url.trim(),
            vaultItemId: form.vaultItemId || null,
            headerName: form.headerName,
            headerPrefix: form.headerPrefix,
          };
    const settings = {
      ...connection,
      allowTools: form.allowAll ? null : form.allowed,
      readOnly: form.readOnly,
      enabled: form.enabled,
      scopeRepos: form.scopeMode === "repos" ? form.scopeRepos : null,
      scopeHosts: form.scopeMode === "hosts" ? form.scopeHosts : null,
    };
    try {
      if (form.editing) await trpc.mcp.update.mutate({ name: form.editing, ...settings });
      else {
        await trpc.mcp.add.mutate({
          name: form.name.trim(),
          transport: form.transport,
          ...settings,
        });
      }
      const savedName = form.editing ?? form.name.trim();
      stopPolling();
      setForm(null);
      await refresh();
      if (form.enabled && form.transport === "http") void check({ name: savedName });
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (server: McpServer) => {
    setError(null);
    try {
      await trpc.mcp.remove.mutate({ name: server.name });
    } catch (err) {
      fail(err);
    }
    if (auditFor === server.name) setAuditFor(null);
    await refresh();
  };

  const connectOAuth = async () => {
    if (!form) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    // Opened inside the click so the browser does not take it for a pop-up.
    const consent = window.open("about:blank", "_blank");
    if (consent) consent.opener = null;
    try {
      const { flowId, authorizationUrl } = await trpc.vault.startOAuth.mutate({
        name: form.name.trim() || "mcp-oauth",
        serverUrl: form.url.trim(),
        scope: "global",
        redirectBase: crossOriginHub()?.origin ?? window.location.origin,
      });
      if (consent) consent.location.href = authorizationUrl;
      else window.open(authorizationUrl, "_blank");
      setNotice("Waiting for you to approve the connection in the new window.");
      if (polling.current) clearInterval(polling.current);
      const startedAt = Date.now();
      const timer: ReturnType<typeof setInterval> = setInterval(() => {
        void (async () => {
          try {
            const state = await trpc.vault.oauthStatus.query({ flowId });
            // The form was cancelled, saved or reopened while the request was in flight.
            if (polling.current !== timer) return;
            if (
              (state.status === "pending" || state.status === "exchanging") &&
              Date.now() - startedAt < 10 * 60_000
            )
              return;
            if (polling.current) clearInterval(polling.current);
            polling.current = null;
            setNotice(null);
            if (state.status === "connected") {
              await queryClient.invalidateQueries({ queryKey: VAULT_KEY });
              // The Credentials section lists the new OAuth credential.
              await queryClient.invalidateQueries({ queryKey: ["vault.list"] });
              if (state.item) patch({ vaultItemId: state.item.id });
            } else {
              setError(state.error ?? "The connection was not completed.");
            }
          } catch (err) {
            if (polling.current) clearInterval(polling.current);
            polling.current = null;
            setNotice(null);
            fail(err);
          }
        })();
      }, POLL_MS);
      polling.current = timer;
    } catch (err) {
      consent?.close();
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  if (servers.isError) {
    return (
      <SettingsRow variant="stacked" label="MCP servers">
        <p
          role="alert"
          className="text-xs text-muted-foreground"
          data-testid="settings__mcp-denied"
        >
          Managing MCP servers needs an admin token.
        </p>
      </SettingsRow>
    );
  }

  const hostStatus = (server: McpServer) =>
    server.hostId ? (hosts.data ?? []).find((h) => h.id === server.hostId)?.status : undefined;
  // Only an API key or an OAuth connection can authenticate a server. A git credential cannot.
  const credentials = (vault.data ?? []).filter(
    (i: VaultItem) => i.kind === "api_key" || i.kind === "oauth",
  );
  const envItems = vault.data ?? [];
  const toolNames = new Set([...(tools ?? []).map((t) => t.name), ...(form?.allowed ?? [])]);

  return (
    <>
      <SettingsRow
        variant="stacked"
        label="MCP servers"
        description="MCP servers the hub proxies to coding agents, over HTTP or as a process on a host. The hub adds the credential, so an agent never holds it."
      >
        <ul className="divide-y divide-border rounded-md border border-border">
          {(servers.data?.servers ?? []).map((server) => (
            <li
              key={server.id}
              data-testid="settings__mcp-server"
              className="flex items-center justify-between gap-2 px-3 py-2 text-sm"
            >
              <div className="min-w-0">
                <div className="truncate" data-testid="settings__mcp-server-name">
                  {server.name}
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  {server.transport === "stdio"
                    ? `${server.command ?? ""} ${server.args.join(" ")} on ${server.hostId ?? "no host"}`
                    : server.url}
                </div>
                <div className="text-xs text-muted-foreground">
                  <span data-testid="settings__mcp-server-scope">{scopeSummary(server)}</span>
                  {" · "}
                  {server.enabled ? "Enabled" : "Disabled"}
                  {server.readOnly ? " · Read-only" : ""}
                  {server.allowTools ? ` · ${server.allowTools.length} tools allowed` : ""}
                </div>
                <div
                  className="text-xs text-muted-foreground"
                  data-testid="settings__mcp-status"
                  data-state={serverState(server, status[server.name], hostStatus(server))}
                >
                  {server.enabled
                    ? server.transport === "stdio"
                      ? `Host ${hostStatus(server) ?? "unknown"}`
                      : statusText(status[server.name])
                    : "Disabled"}
                </div>
              </div>
              <div className="flex shrink-0 gap-1">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-label={`Audit log of ${server.name}`}
                  onClick={() => setAuditFor(auditFor === server.name ? null : server.name)}
                >
                  Audit
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-label={`Edit MCP server ${server.name}`}
                  onClick={() => open(formFor(server))}
                >
                  Edit
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-label={`Remove MCP server ${server.name}`}
                  onClick={() => void remove(server)}
                >
                  Remove
                </Button>
              </div>
            </li>
          ))}
        </ul>
        {!form ? (
          <Button
            type="button"
            size="sm"
            className="mt-2"
            data-testid="settings__mcp-add"
            onClick={() => open(EMPTY_FORM)}
          >
            Add server
          </Button>
        ) : null}
      </SettingsRow>

      {form ? (
        <SettingsRow
          variant="stacked"
          label={form.editing ? `Edit ${form.editing}` : "Add a server"}
        >
          <div className="space-y-2" data-testid="settings__mcp-form">
            <Input
              aria-label="MCP server name"
              placeholder="Name (lowercase letters, digits, - and _)"
              value={form.name}
              disabled={form.editing !== null}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => patch({ name: e.target.value })}
              className="h-8 text-sm"
            />
            <select
              aria-label="MCP transport"
              value={form.transport}
              disabled={form.editing !== null}
              onChange={(e) => patch({ transport: e.target.value as "http" | "stdio" })}
              className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm"
            >
              <option value="http">HTTP server</option>
              <option value="stdio">Process on a host (stdio)</option>
            </select>
            {form.transport === "stdio" ? (
              <div className="space-y-2" data-testid="settings__mcp-stdio">
                <select
                  aria-label="MCP host"
                  value={form.hostId}
                  onChange={(e) => patch({ hostId: e.target.value })}
                  className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm"
                >
                  <option value="">Choose a host</option>
                  {(hosts.data ?? []).map((host) => (
                    <option key={host.id} value={host.id}>
                      {host.name} ({host.id}, {host.status})
                    </option>
                  ))}
                </select>
                <Input
                  aria-label="MCP command"
                  placeholder="Executable, for example npx"
                  value={form.command}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    patch({ command: e.target.value })
                  }
                  className="h-8 text-sm"
                />
                <textarea
                  aria-label="MCP arguments"
                  placeholder="Arguments, one per line"
                  value={form.args}
                  onChange={(e) => patch({ args: e.target.value })}
                  rows={3}
                  className="w-full rounded-md border border-border bg-background px-2 py-1 font-mono text-sm"
                />
                <Input
                  aria-label="MCP working directory"
                  placeholder="Working directory (optional, inside the worker's roots)"
                  value={form.cwd}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    patch({ cwd: e.target.value })
                  }
                  className="h-8 text-sm"
                />
                <div className="space-y-1" data-testid="settings__mcp-env">
                  {form.env.map((row, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: rows have no id and are only edited in place
                    <div key={index} className="flex gap-2">
                      <Input
                        aria-label={`Environment variable ${index + 1} name`}
                        placeholder="NAME"
                        value={row.name}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                          patch({
                            env: form.env.map((r, i) =>
                              i === index ? { ...r, name: e.target.value } : r,
                            ),
                          })
                        }
                        className="h-8 text-sm"
                      />
                      <select
                        aria-label={`Environment variable ${index + 1} source`}
                        value={row.source}
                        onChange={(e) =>
                          patch({
                            env: form.env.map((r, i) =>
                              i === index
                                ? { ...r, source: e.target.value as EnvRow["source"] }
                                : r,
                            ),
                          })
                        }
                        className="h-8 rounded-md border border-border bg-background px-2 text-sm"
                      >
                        <option value="value">Value</option>
                        <option value="vault">Vault item</option>
                      </select>
                      {row.source === "vault" ? (
                        <select
                          aria-label={`Environment variable ${index + 1} vault item`}
                          value={row.vaultItemId}
                          onChange={(e) =>
                            patch({
                              env: form.env.map((r, i) =>
                                i === index ? { ...r, vaultItemId: e.target.value } : r,
                              ),
                            })
                          }
                          className="h-8 rounded-md border border-border bg-background px-2 text-sm"
                        >
                          <option value="">Choose an item</option>
                          {envItems
                            .filter(
                              (item: VaultItem) => item.kind === "api_key" || item.kind === "env",
                            )
                            .map((item: VaultItem) => (
                              <option key={item.id} value={item.id}>
                                {item.name}
                              </option>
                            ))}
                        </select>
                      ) : (
                        <Input
                          aria-label={`Environment variable ${index + 1} value`}
                          placeholder="value"
                          value={row.value}
                          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                            patch({
                              env: form.env.map((r, i) =>
                                i === index ? { ...r, value: e.target.value } : r,
                              ),
                            })
                          }
                          className="h-8 text-sm"
                        />
                      )}
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        aria-label={`Remove environment variable ${index + 1}`}
                        onClick={() => patch({ env: form.env.filter((_, i) => i !== index) })}
                      >
                        Remove
                      </Button>
                    </div>
                  ))}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    data-testid="settings__mcp-env-add"
                    onClick={() =>
                      patch({
                        env: [
                          ...form.env,
                          { name: "", source: "value", value: "", vaultItemId: "" },
                        ],
                      })
                    }
                  >
                    Add environment variable
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <Input
                  aria-label="MCP server URL"
                  placeholder="https://mcp.example.com/mcp"
                  value={form.url}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    patch({ url: e.target.value })
                  }
                  className="h-8 text-sm"
                />
                <select
                  aria-label="MCP credential"
                  value={form.vaultItemId}
                  onChange={(e) => patch({ vaultItemId: e.target.value })}
                  className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm"
                >
                  <option value="">No credential</option>
                  {credentials.map((item: VaultItem) => (
                    <option key={item.id} value={item.id}>
                      {item.name} ({item.kind === "oauth" ? "OAuth" : "API key"})
                    </option>
                  ))}
                </select>
                <div className="flex gap-2">
                  <Input
                    aria-label="MCP header name"
                    value={form.headerName}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                      patch({ headerName: e.target.value })
                    }
                    className="h-8 text-sm"
                  />
                  <Input
                    aria-label="MCP header prefix"
                    value={form.headerPrefix}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                      patch({ headerPrefix: e.target.value })
                    }
                    className="h-8 text-sm"
                  />
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  data-testid="settings__mcp-connect-oauth"
                  disabled={busy || form.url.trim() === ""}
                  onClick={() => void connectOAuth()}
                >
                  Connect with OAuth
                </Button>
                {notice ? (
                  <p className="text-xs text-muted-foreground" data-testid="settings__mcp-notice">
                    {notice}
                  </p>
                ) : null}
              </>
            )}

            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="settings__mcp-test"
                disabled={busy || !formReady({ ...form, name: form.name || "x" })}
                onClick={() => void testConnection()}
              >
                Test connection
              </Button>
              {testMessage ? (
                <span
                  className="text-xs text-muted-foreground"
                  data-testid="settings__mcp-test-result"
                  data-ok={testOk ? "true" : "false"}
                >
                  {testMessage}
                </span>
              ) : null}
            </div>

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.allowAll}
                onChange={(e) => patch({ allowAll: e.target.checked })}
              />
              Allow every tool
            </label>
            {!form.allowAll ? (
              <ul className="space-y-1" data-testid="settings__mcp-tools">
                {toolNames.size === 0 ? (
                  <li className="text-xs text-muted-foreground">
                    Test the connection to list the server's tools.
                  </li>
                ) : null}
                {[...toolNames].map((toolName) => {
                  const info = tools?.find((t) => t.name === toolName);
                  return (
                    <li key={toolName} className="text-sm">
                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          aria-label={`Allow tool ${toolName}`}
                          checked={form.allowed.includes(toolName)}
                          onChange={(e) =>
                            patch({ allowed: toggle(form.allowed, toolName, e.target.checked) })
                          }
                        />
                        <span>{toolName}</span>
                        {info?.readOnly ? (
                          <span className="text-xs text-muted-foreground">read-only</span>
                        ) : null}
                      </label>
                      {info?.description ? (
                        <p className="ml-6 truncate text-xs text-muted-foreground">
                          {info.description}
                        </p>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            ) : null}

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.readOnly}
                onChange={(e) => patch({ readOnly: e.target.checked })}
              />
              Read-only (only tools marked read-only)
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) => patch({ enabled: e.target.checked })}
              />
              Enabled
            </label>

            <fieldset className="space-y-1" data-testid="settings__mcp-scope">
              <legend className="text-sm font-medium">Scope</legend>
              {(
                [
                  ["all", "All worktrees"],
                  ["repos", "Selected repos"],
                  ["hosts", "Selected hosts"],
                ] as const
              ).map(([mode, label]) => (
                <label key={mode} className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="mcp-scope"
                    aria-label={`Scope: ${label}`}
                    checked={form.scopeMode === mode}
                    onChange={() => patch({ scopeMode: mode })}
                  />
                  {label}
                </label>
              ))}
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                <input type="radio" name="mcp-scope" disabled aria-label="Scope: Missions" />
                Missions (not available yet)
              </label>
              {form.scopeMode === "repos"
                ? (repos.data ?? []).map((repo) => (
                    <label key={repo} className="ml-6 flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        aria-label={`Repo ${repo}`}
                        checked={form.scopeRepos.includes(repo)}
                        onChange={(e) =>
                          patch({
                            scopeRepos: toggle(form.scopeRepos, repo, e.target.checked),
                          })
                        }
                      />
                      {repo}
                    </label>
                  ))
                : null}
              {form.scopeMode === "hosts"
                ? (hosts.data ?? []).map((host) => (
                    <label key={host.id} className="ml-6 flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        aria-label={`Host ${host.id}`}
                        checked={form.scopeHosts.includes(host.id)}
                        onChange={(e) =>
                          patch({ scopeHosts: toggle(form.scopeHosts, host.id, e.target.checked) })
                        }
                      />
                      {host.id}
                    </label>
                  ))
                : null}
            </fieldset>

            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                data-testid="settings__mcp-save"
                disabled={busy || !formReady(form)}
                onClick={() => void save()}
              >
                Save
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  stopPolling();
                  setForm(null);
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        </SettingsRow>
      ) : null}

      {auditFor ? <McpAudit server={auditFor} /> : null}

      {error ? (
        <p role="alert" className="text-xs text-destructive" data-testid="settings__mcp-error">
          {error}
        </p>
      ) : null}
    </>
  );
}

/** One server's audit log, newest first, `AUDIT_PAGE` rows at a time. */
function McpAudit({ server }: { server: string }) {
  const audit = useInfiniteQuery({
    queryKey: ["mcp.audit", server],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      trpc.mcp.audit.query({ server, limit: AUDIT_PAGE, offset: pageParam }),
    getNextPageParam: (last, all) => (last.hasMore ? all.length * AUDIT_PAGE : undefined),
    refetchInterval: 5000,
  });
  const entries = audit.data?.pages.flatMap((page) => page.entries) ?? [];
  return (
    <SettingsRow
      variant="stacked"
      label={`Audit log of ${server}`}
      description="Tool calls made through the proxy. Arguments and results are not stored."
    >
      <ul className="divide-y divide-border rounded-md border border-border">
        {entries.length === 0 ? (
          <li className="px-3 py-2 text-xs text-muted-foreground">No calls yet.</li>
        ) : null}
        {entries.map((entry) => (
          <li
            key={entry.id}
            data-testid="settings__mcp-audit-entry"
            data-ok={entry.ok ? "true" : "false"}
            className="px-3 py-2 text-xs"
          >
            <span data-testid="settings__mcp-audit-tool" className="text-sm">
              {entry.tool}
            </span>{" "}
            <span>{entry.ok ? "ok" : `failed: ${entry.error ?? "error"}`}</span>
            <div className="text-muted-foreground">
              Session <span data-testid="settings__mcp-audit-session">{entry.sessionId}</span> ·{" "}
              {new Date(entry.at).toLocaleString()}
            </div>
          </li>
        ))}
      </ul>
      {audit.hasNextPage ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-2"
          disabled={audit.isFetchingNextPage}
          onClick={() => void audit.fetchNextPage()}
        >
          Load more
        </Button>
      ) : null}
    </SettingsRow>
  );
}
