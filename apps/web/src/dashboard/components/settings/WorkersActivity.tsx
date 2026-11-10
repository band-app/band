import { Button } from "@band-app/ui";
import { useState } from "react";
import { type AuditEntries, formatTime, type HostList } from "./worker-format";

const PAGE_SIZE = 10;

/**
 * Cross-worker activity: what agents on admin workers did across workers or as an admin. Newest
 * first, ten to a page, with worker names where the hub knows them.
 */
export function WorkersActivity({ entries, hosts }: { entries: AuditEntries; hosts: HostList }) {
  const [page, setPage] = useState(0);
  const names = new Map(hosts.map((h) => [h.id, h.name]));
  const nameOf = (id: string) => names.get(id) ?? id;
  const pages = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
  const current = Math.min(page, pages - 1);
  const shown = entries.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE);

  if (entries.length === 0) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="settings__audit-empty">
        Nothing yet.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <ul className="divide-y divide-border rounded-md border border-border">
        {shown.map((entry) => (
          <li
            key={entry.id}
            data-testid="settings__audit-entry"
            data-procedure={entry.procedure}
            className="px-3 py-2 text-xs"
          >
            <span className="font-medium">{entry.procedure}</span>
            {" · from "}
            {nameOf(entry.callerHostId)}
            {entry.targetHostId ? ` to ${nameOf(entry.targetHostId)}` : ""}
            {entry.target ? ` (${entry.target})` : ""}
            {" · "}
            {formatTime(entry.at)}
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="settings__audit-prev"
          disabled={current === 0}
          onClick={() => setPage(current - 1)}
        >
          Newer
        </Button>
        <span data-testid="settings__audit-page">
          Page {current + 1} of {pages}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="settings__audit-next"
          disabled={current >= pages - 1}
          onClick={() => setPage(current + 1)}
        >
          Older
        </Button>
      </div>
    </div>
  );
}
