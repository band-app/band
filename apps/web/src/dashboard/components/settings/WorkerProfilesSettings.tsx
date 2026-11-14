import { Button, Input } from "@band-app/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useState } from "react";
import { trpc } from "../../../lib/trpc-client";
import { useVaultItems } from "../../hooks/use-vault-items";
import { ErrorPopover } from "./ErrorPopover";
import { errorText } from "./worker-format";

export type ProfileList = Awaited<ReturnType<typeof trpc.workerProfiles.list.query>>;
export type ProfileItem = ProfileList["profiles"][number];
export const PROFILES_KEY = ["workerProfiles.list"] as const;

/** The profiles an admin can attach. Only an admin token may read them. */
export function useWorkerProfiles(enabled: boolean) {
  return useQuery<ProfileList>({
    queryKey: PROFILES_KEY,
    queryFn: () => trpc.workerProfiles.list.query(),
    enabled,
  });
}

const TRUST_CHOICES = ["restricted", "standard", "admin"] as const;
type Trust = (typeof TRUST_CHOICES)[number];

interface Draft {
  name: string;
  repoUrl: string;
  branch: string;
  command: string;
  labels: string;
  trust: "" | Trust;
  env: string;
  ownChats: boolean;
  tokenItem: string;
  secrets: SecretRow[];
}

/** One mapping of a vault item to an env variable or a file under ~/. */
interface SecretRow {
  item: string;
  target: "env" | "file";
  /** The variable name, or the `~/` path. */
  value: string;
  /** Octal file mode. Empty means the hub default. */
  mode: string;
}

const EMPTY: Draft = {
  name: "",
  repoUrl: "",
  branch: "",
  command: "",
  labels: "",
  trust: "",
  env: "",
  ownChats: false,
  tokenItem: "",
  secrets: [],
};

function toDraft(p: ProfileItem): Draft {
  return {
    name: p.name,
    repoUrl: p.provisioning?.repoUrl ?? "",
    branch: p.provisioning?.branch ?? "",
    command: p.provisioning?.command ?? "",
    labels: (p.labels ?? []).join(", "),
    trust: p.trust ?? "",
    env: Object.entries(p.env ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
    ownChats: p.ownChats ?? false,
    tokenItem: p.provisioning?.tokenItem ?? "",
    secrets: (p.secrets ?? []).map((m) =>
      "env" in m
        ? { item: m.item, target: "env" as const, value: m.env, mode: "" }
        : { item: m.item, target: "file" as const, value: m.file, mode: m.mode ?? "" },
    ),
  };
}

/** The request body. An empty field is left out, so the hub's defaults apply. */
function toProfile(d: Draft) {
  const split = (text: string, sep: RegExp) =>
    text
      .split(sep)
      .map((s) => s.trim())
      .filter(Boolean);
  const env: Record<string, string> = {};
  for (const line of split(d.env, /\n/)) {
    const eq = line.indexOf("=");
    env[eq === -1 ? line : line.slice(0, eq).trim()] = eq === -1 ? "" : line.slice(eq + 1).trim();
  }
  const labels = split(d.labels, /,/);
  const provisioning = {
    ...(d.repoUrl.trim() ? { repoUrl: d.repoUrl.trim() } : {}),
    ...(d.branch.trim() ? { branch: d.branch.trim() } : {}),
    ...(d.command.trim() ? { command: d.command.trim() } : {}),
    ...(d.tokenItem ? { tokenItem: d.tokenItem } : {}),
  };
  const secrets = d.secrets.map((r) =>
    r.target === "env"
      ? { item: r.item, env: r.value.trim() }
      : {
          item: r.item,
          file: r.value.trim(),
          ...(r.mode.trim() ? { mode: r.mode.trim() } : {}),
        },
  );
  return {
    name: d.name.trim(),
    ...(Object.keys(provisioning).length > 0 ? { provisioning } : {}),
    ...(labels.length > 0 ? { labels } : {}),
    ...(d.trust ? { trust: d.trust } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(d.ownChats ? { ownChats: true } : {}),
    ...(secrets.length > 0 ? { secrets } : {}),
  };
}

/**
 * Settings > Workers > Profiles: named worker profiles with a credential policy. Admin only.
 * A profile names vault items, never secrets. Changes save at once.
 */
export function WorkerProfilesSettings() {
  const queryClient = useQueryClient();
  const profiles = useWorkerProfiles(true);
  const vault = useVaultItems();
  // `null` is the closed editor; `editing` is the name being edited, or null for a new profile.
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ name: string; message: string } | null>(null);

  const secretItems = (vault.data ?? [])
    .filter((i) => i.kind === "api_key" || i.kind === "env")
    .map((i) => i.name);
  const setRow = (index: number, patch: Partial<SecretRow>) =>
    setDraft((d) =>
      d ? { ...d, secrets: d.secrets.map((r, i) => (i === index ? { ...r, ...patch } : r)) } : d,
    );
  const refresh = () => queryClient.invalidateQueries({ queryKey: PROFILES_KEY });

  const save = async () => {
    if (!draft) return;
    setError(null);
    try {
      const profile = toProfile(draft);
      if (editing) await trpc.workerProfiles.update.mutate({ name: editing, profile });
      else await trpc.workerProfiles.create.mutate(profile);
      setDraft(null);
      setEditing(null);
      await refresh();
    } catch (err) {
      setError(errorText(err));
    }
  };

  const remove = async (name: string) => {
    setRowError(null);
    try {
      await trpc.workerProfiles.delete.mutate({ name });
    } catch (err) {
      setRowError({ name, message: errorText(err) });
    }
    await refresh();
  };

  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const field = "h-8 text-sm";

  return (
    <div className="space-y-3" data-testid="settings__profiles">
      <p className="text-xs text-muted-foreground">
        A profile fixes how a worker is provisioned and which vault items it receives as env
        variables or files. It names vault items, never their secrets. A worker cannot choose its
        own.
      </p>
      {(profiles.data?.invalid ?? []).map((bad) => (
        <p
          key={bad.index}
          role="alert"
          className="text-xs text-destructive"
          data-testid="settings__profile-invalid"
        >
          Entry {bad.index + 1}
          {bad.name ? ` (${bad.name})` : ""} in settings.json is not applied: {bad.error}
        </p>
      ))}
      <ul className="divide-y divide-border rounded-md border border-border">
        {(profiles.data?.profiles ?? []).map((p) => (
          <li
            key={p.name}
            data-testid="settings__profile"
            data-profile-name={p.name}
            data-trust={p.trust ?? "default"}
            data-workers={p.workers}
            className="flex items-center justify-between gap-2 px-3 py-2 text-sm"
          >
            <div className="min-w-0">
              <div className="truncate font-medium">{p.name}</div>
              <div className="text-xs text-muted-foreground">
                Trust {p.trust ?? "default"} · {p.secrets?.length ?? 0}{" "}
                {p.secrets?.length === 1 ? "secret" : "secrets"} · {p.workers}{" "}
                {p.workers === 1 ? "worker" : "workers"}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {rowError?.name === p.name ? (
                <ErrorPopover
                  label="Could not delete the profile"
                  testId="settings__profile-error"
                  message={rowError.message}
                />
              ) : null}
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-label={`Edit profile ${p.name}`}
                onClick={() => {
                  setEditing(p.name);
                  setDraft(toDraft(p));
                  setError(null);
                }}
              >
                Edit
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-label={`Delete profile ${p.name}`}
                onClick={() => void remove(p.name)}
              >
                Delete
              </Button>
            </div>
          </li>
        ))}
        {profiles.data && profiles.data.profiles.length === 0 ? (
          <li className="px-3 py-2 text-xs text-muted-foreground">No profiles yet.</li>
        ) : null}
      </ul>

      {draft ? (
        <fieldset
          className="space-y-2 rounded-md border border-border p-3"
          data-testid="settings__profile-editor"
        >
          <legend className="px-1 text-xs font-medium">
            {editing ? `Edit ${editing}` : "New profile"}
          </legend>
          <Input
            aria-label="Profile name"
            placeholder="agent-user"
            value={draft.name}
            disabled={editing !== null}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => set({ name: e.target.value })}
            className={field}
          />
          <div className="flex gap-2">
            <Input
              aria-label="Profile provisioning repo URL"
              placeholder="Provisioning repo URL (optional)"
              value={draft.repoUrl}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                set({ repoUrl: e.target.value })
              }
              className={field}
            />
            <Input
              aria-label="Profile provisioning branch"
              placeholder="Branch"
              value={draft.branch}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => set({ branch: e.target.value })}
              className={field}
            />
            <Input
              aria-label="Profile start command"
              placeholder="band/provision.sh"
              value={draft.command}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                set({ command: e.target.value })
              }
              className={field}
            />
          </div>
          <div className="flex gap-2">
            <Input
              aria-label="Profile labels"
              placeholder="Labels: gui=1, zone=a"
              value={draft.labels}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => set({ labels: e.target.value })}
              className={field}
            />
            <select
              aria-label="Profile trust"
              value={draft.trust}
              onChange={(e) => set({ trust: e.target.value as Draft["trust"] })}
              className="h-8 rounded-md border border-input bg-transparent px-2 text-sm"
            >
              <option value="">Trust: default</option>
              {TRUST_CHOICES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
          <textarea
            aria-label="Profile worker env"
            placeholder={"BAND_WORKER_IDLE_EXIT=30m\nOne BAND_WORKER_* setting per line"}
            rows={2}
            value={draft.env}
            onChange={(e) => set({ env: e.target.value })}
            className="w-full rounded-md border border-border bg-transparent p-2 font-mono text-xs"
          />
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={draft.ownChats}
              onChange={(e) => set({ ownChats: e.target.checked })}
            />
            The worker runs the chats of its own worktrees
          </label>

          <label className="flex items-center gap-2 text-xs">
            Item whose token clones the provisioning repo
            <select
              aria-label="Profile provisioning token item"
              value={draft.tokenItem}
              onChange={(e) => set({ tokenItem: e.target.value })}
              className="h-8 rounded-md border border-input bg-transparent px-2 text-sm"
            >
              <option value="">None</option>
              {secretItems.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>

          <div
            className="space-y-2 rounded-md border border-border p-2"
            data-testid="settings__profile-secrets"
          >
            <div className="text-xs font-medium">Secrets</div>
            <p className="text-xs text-muted-foreground">
              Each row gives the worker one vault item, as an environment variable or as a file
              under ~/. With no rows the worker gets none.
            </p>
            {draft.secrets.map((row, i) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: rows have no id and are edited in place
                key={i}
                className="flex items-center gap-2"
                data-testid="settings__profile-secret"
              >
                <select
                  aria-label={`Secret ${i + 1} vault item`}
                  value={row.item}
                  onChange={(e) => setRow(i, { item: e.target.value })}
                  className="h-8 rounded-md border border-input bg-transparent px-2 text-sm"
                >
                  <option value="">Vault item</option>
                  {secretItems.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
                <select
                  aria-label={`Secret ${i + 1} target`}
                  value={row.target}
                  onChange={(e) => setRow(i, { target: e.target.value as SecretRow["target"] })}
                  className="h-8 rounded-md border border-input bg-transparent px-2 text-sm"
                >
                  <option value="env">Env variable</option>
                  <option value="file">File</option>
                </select>
                <Input
                  aria-label={`Secret ${i + 1} ${row.target === "env" ? "variable name" : "file path"}`}
                  placeholder={row.target === "env" ? "ANTHROPIC_API_KEY" : "~/.config/tool/token"}
                  value={row.value}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setRow(i, { value: e.target.value })
                  }
                  className={field}
                />
                {row.target === "file" ? (
                  <Input
                    aria-label={`Secret ${i + 1} file mode`}
                    placeholder="0600"
                    value={row.mode}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                      setRow(i, { mode: e.target.value })
                    }
                    className={`${field} w-20`}
                  />
                ) : null}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-label={`Remove secret ${i + 1}`}
                  onClick={() => set({ secrets: draft.secrets.filter((_, j) => j !== i) })}
                >
                  Remove
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="settings__profile-secret-add"
              onClick={() =>
                set({
                  secrets: [...draft.secrets, { item: "", target: "env", value: "", mode: "" }],
                })
              }
            >
              <Plus className="size-3" />
              Add secret
            </Button>
          </div>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              data-testid="settings__profile-save"
              onClick={() => void save()}
            >
              Save profile
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setDraft(null);
                setEditing(null);
              }}
            >
              Cancel
            </Button>
            {error ? (
              <ErrorPopover
                label="Could not save the profile"
                testId="settings__profile-save-error"
                message={error}
              />
            ) : null}
          </div>
        </fieldset>
      ) : (
        <Button
          type="button"
          size="sm"
          data-testid="settings__profile-new"
          onClick={() => {
            setEditing(null);
            setDraft(EMPTY);
            setError(null);
          }}
        >
          <Plus className="size-3" />
          New profile
        </Button>
      )}
    </div>
  );
}
