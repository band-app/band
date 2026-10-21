import { Label } from "@band-app/ui";

export interface RepoHostOption {
  id: string;
  name: string;
}

/** What the fields edit: the hosts a repo may run on (null for all) and the primary host ("" for automatic). */
export interface RepoHostsValue {
  allowedHostIds: string[] | null;
  primaryHostId: string;
}

interface Props {
  hosts: RepoHostOption[];
  value: RepoHostsValue;
  onChange: (value: RepoHostsValue) => void;
  /** Prefix for element ids, so two copies on a page keep distinct labels. */
  idPrefix: string;
  disabled?: boolean;
}

/**
 * "Available on: All hosts | Only: [hosts]" and "Primary host", in the Add repo dialog. A repo's
 * page in Settings > Repos has its own controls (`settings/RepoWorkers.tsx`). Narrowing the hosts
 * moves the primary host onto one that is still allowed.
 */
export function RepoHostsFields({ hosts, value, onChange, idPrefix, disabled }: Props) {
  const only = value.allowedHostIds !== null;
  const primaryChoices = only ? hosts.filter((h) => value.allowedHostIds?.includes(h.id)) : hosts;
  const toggle = (id: string) => {
    const current = value.allowedHostIds ?? [];
    const next = current.includes(id) ? current.filter((h) => h !== id) : [...current, id];
    onChange({
      allowedHostIds: next,
      primaryHostId: next.includes(value.primaryHostId) ? value.primaryHostId : "",
    });
  };
  return (
    <fieldset
      className="space-y-2 rounded-lg border p-3"
      disabled={disabled}
      data-testid="repo-hosts"
    >
      <legend className="px-1 text-sm font-medium">Available on</legend>
      <div className="flex gap-4 text-sm">
        <label className="flex items-center gap-1.5">
          <input
            type="radio"
            name={`${idPrefix}-available`}
            data-testid="repo-hosts__all"
            checked={!only}
            onChange={() => onChange({ ...value, allowedHostIds: null })}
          />
          All workers
        </label>
        <label className="flex items-center gap-1.5">
          <input
            type="radio"
            name={`${idPrefix}-available`}
            data-testid="repo-hosts__only"
            checked={only}
            onChange={() =>
              onChange({
                ...value,
                allowedHostIds: value.primaryHostId
                  ? [value.primaryHostId]
                  : hosts[0]
                    ? [hosts[0].id]
                    : [],
              })
            }
          />
          Only
        </label>
      </div>
      {only ? (
        <ul className="space-y-1" aria-label="Allowed workers">
          {hosts.map((h) => (
            <li key={h.id}>
              <label className="flex items-center gap-1.5 text-sm">
                <input
                  type="checkbox"
                  data-testid="repo-hosts__host"
                  data-host={h.id}
                  checked={value.allowedHostIds?.includes(h.id) ?? false}
                  onChange={() => toggle(h.id)}
                />
                {h.name}
              </label>
            </li>
          ))}
        </ul>
      ) : null}
      {only && value.allowedHostIds?.length === 0 ? (
        <p className="text-xs text-destructive" data-testid="repo-hosts__empty">
          Choose at least one worker.
        </p>
      ) : null}
      <div className="space-y-1">
        <Label htmlFor={`${idPrefix}-primary`}>Primary worker</Label>
        <select
          id={`${idPrefix}-primary`}
          data-testid="repo-hosts__primary"
          value={value.primaryHostId}
          onChange={(e) => onChange({ ...value, primaryHostId: e.target.value })}
          className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
        >
          <option value="">Automatic (the first worker that clones it)</option>
          {primaryChoices.map((h) => (
            <option key={h.id} value={h.id}>
              {h.name}
            </option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground">
          Only the primary worker lists the repo's default-branch worktree. Other workers keep a
          hidden clone that new worktrees are made from.
        </p>
      </div>
    </fieldset>
  );
}

/** True when the value can be saved: at least one host when the repo is limited. */
export function repoHostsValid(value: RepoHostsValue): boolean {
  return value.allowedHostIds === null || value.allowedHostIds.length > 0;
}
