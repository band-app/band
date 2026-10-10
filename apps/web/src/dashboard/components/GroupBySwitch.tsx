import { GROUP_BY_OPTIONS, useGroupBy } from "../lib/sidebar-grouping";

/** The sidebar's Group by switch: Repo, Origin or Host. Remembered per device. */
export function GroupBySwitch() {
  const [groupBy, setGroupBy] = useGroupBy();
  return (
    <div
      data-testid="repos-panel__group-by"
      className="mx-3 mb-1 flex shrink-0 items-center gap-0.5 rounded-md bg-muted/60 p-0.5"
    >
      <span className="px-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        Group by
      </span>
      {GROUP_BY_OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={groupBy === option.value}
          data-testid={`repos-panel__group-by--${option.value}`}
          onClick={() => setGroupBy(option.value)}
          className={`h-5 flex-1 rounded px-1.5 text-[11px] font-medium transition-colors ${
            groupBy === option.value
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
