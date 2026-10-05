import { Button, Input } from "@band-app/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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

type ScopeMode = "all" | "projects" | "hosts";

interface FormState {
  /** The saved server being edited, or null for a new one. */
  editing: string | null;
  name: string;
  url: string;
  vaultItemId: string;
  headerName: string;
  headerPrefix: string;
  allowAll: boolean;
  allowed: string[];
  readOnly: boolean;
  enabled: boolean;
  scopeMode: ScopeMode;
  scopeProjects: string[];
  scopeHosts: string[];
}

const EMPTY_FORM: FormState = {
  editing: null,
  name: "",
  url: "",
  vaultItemId: "",
  headerName: "Authorization",
  headerPrefix: "Bearer ",
  allowAll: true,
  allowed: [],
  readOnly: false,
  enabled: true,
  scopeMode: "all",
  scopeProjects: [],
  scopeHosts: [],
};

function formFor(server: McpServer): FormState {
  return {
    editing: server.name,
    name: server.name,
    url: server.url,
    vaultItemId: server.vaultItemId ?? "",
    headerName: server.headerName,
    headerPrefix: server.headerPrefix,
    allowAll: server.allowTools === null,
    allowed: server.allowTools ?? [],
    readOnly: server.readOnly,
    enabled: server.enabled,
    scopeMode: server.scopeProjects ? "projects" : server.scopeHosts ? "hosts" : "all",
    scopeProjects: server.scopeProjects ?? [],
    scopeHosts: server.scopeHosts ?? [],
  };
}

function scopeSummary(server: McpServer): string {
  if (server.scopeProjects) return `Projects: ${server.scopeProjects.join(", ") || "none"}`;
  if (server.scopeHosts) return `Hosts: ${server.scopeHosts.join(", ") || "none"}`;
  return "All workspaces";
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
 * Rows for the Settings dialog's MCP section (plan step 4.5): the HTTP MCP servers the hub
 * proxies, with the credential from the vault, the tool allowlist (picked from the server's live
 * `tools/list`), read-only mode, scope, status and the audit log. Changes apply at once and are
 * not part of the dialog's Save. A credential is only ever named by its vault id here.
 */
export function McpSettings() {
  const queryClient = useQueryClient();
  const servers = useQuery<McpList>({ queryKey: MCP_KEY, queryFn: () => trpc.mcp.list.query() });
  const vault = useQuery({
    queryKey: VAULT_KEY,
    queryFn: async () => (await trpc.vault.list.query()).items,
    enabled: servers.isSuccess,
  });
  const projects = useQuery({
    queryKey: ["mcp.projects"],
    queryFn: async () =>
      ((await trpc.projects.list.query()).projects as Array<{ name: string }>).map((p) => p.name),
    enabled: servers.isSuccess,
  });
  const hosts = useQuery({
    queryKey: ["hosts.list"],
    queryFn: async () => (await trpc.hosts.list.query()).hosts,
    enabled: servers.isSuccess,
  });

  const [form, setForm] = useState<FormState | null>(null);
  const [tools, setTools] = useState<ToolInfo[] | null>(null);
  const [testMessage, setTestMessage] = useState<string | null>(null);
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
    for (const server of servers.data.servers) if (server.enabled) void check(server);
  }, [servers.data]);

  const open = (next: FormState) => {
    // The Credentials section may have added a key since the last load.
    void vault.refetch();
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
      const result = await trpc.mcp.test.mutate({
        url: form.url.trim(),
        vaultItemId: form.vaultItemId || null,
        headerName: form.headerName,
        headerPrefix: form.headerPrefix,
      });
      if (result.ok) {
        setTools(result.tools);
        setTestMessage(`Connected. ${result.tools.length} tools.`);
      } else {
        setTools(null);
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
    const settings = {
      url: form.url.trim(),
      vaultItemId: form.vaultItemId || null,
      headerName: form.headerName,
      headerPrefix: form.headerPrefix,
      allowTools: form.allowAll ? null : form.allowed,
      readOnly: form.readOnly,
      enabled: form.enabled,
      scopeProjects: form.scopeMode === "projects" ? form.scopeProjects : null,
      scopeHosts: form.scopeMode === "hosts" ? form.scopeHosts : null,
    };
    try {
      if (form.editing) await trpc.mcp.update.mutate({ name: form.editing, ...settings });
      else await trpc.mcp.add.mutate({ name: form.name.trim(), ...settings });
      const savedName = form.editing ?? form.name.trim();
      setForm(null);
      await refresh();
      if (form.enabled) void check({ name: savedName });
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
      polling.current = setInterval(() => {
        void (async () => {
          try {
            const state = await trpc.vault.oauthStatus.query({ flowId });
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

  const credentials = (vault.data ?? []).filter((i: VaultItem) => i.kind !== "env");
  const toolNames = new Set([...(tools ?? []).map((t) => t.name), ...(form?.allowed ?? [])]);

  return (
    <>
      <SettingsRow
        variant="stacked"
        label="MCP servers"
        description="HTTP MCP servers the hub proxies to coding agents. The hub adds the credential, so an agent never holds it."
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
                <div className="truncate text-xs text-muted-foreground">{server.url}</div>
                <div className="text-xs text-muted-foreground">
                  <span data-testid="settings__mcp-server-scope">{scopeSummary(server)}</span>
                  {" · "}
                  {server.enabled ? "Enabled" : "Disabled"}
                  {server.readOnly ? " · Read-only" : ""}
                  {server.allowTools ? ` · ${server.allowTools.length} tools allowed` : ""}
                </div>
                <div className="text-xs text-muted-foreground" data-testid="settings__mcp-status">
                  {server.enabled ? statusText(status[server.name]) : "Disabled"}
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
          description="Stdio servers on a worker come with plan step 4.4."
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
            <Input
              aria-label="MCP server URL"
              placeholder="https://mcp.example.com/mcp"
              value={form.url}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => patch({ url: e.target.value })}
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

            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="settings__mcp-test"
                disabled={busy || form.url.trim() === ""}
                onClick={() => void testConnection()}
              >
                Test connection
              </Button>
              {testMessage ? (
                <span
                  className="text-xs text-muted-foreground"
                  data-testid="settings__mcp-test-result"
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
                  ["all", "All workspaces"],
                  ["projects", "Selected projects"],
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
                Missions (available with Phase 6)
              </label>
              {form.scopeMode === "projects"
                ? (projects.data ?? []).map((project) => (
                    <label key={project} className="ml-6 flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        aria-label={`Project ${project}`}
                        checked={form.scopeProjects.includes(project)}
                        onChange={(e) =>
                          patch({
                            scopeProjects: toggle(form.scopeProjects, project, e.target.checked),
                          })
                        }
                      />
                      {project}
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
                disabled={
                  busy || form.url.trim() === "" || (!form.editing && form.name.trim() === "")
                }
                onClick={() => void save()}
              >
                Save
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => setForm(null)}>
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
  const [pages, setPages] = useState(1);
  const audit = useQuery({
    queryKey: ["mcp.audit", server, pages],
    queryFn: () => trpc.mcp.audit.query({ server, limit: AUDIT_PAGE * pages }),
    refetchInterval: 5000,
  });
  const entries = audit.data?.entries ?? [];
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
              Session {entry.sessionId} · {new Date(entry.at).toLocaleString()}
            </div>
          </li>
        ))}
      </ul>
      {audit.data?.hasMore ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-2"
          onClick={() => setPages(pages + 1)}
        >
          Load more
        </Button>
      ) : null}
    </SettingsRow>
  );
}
