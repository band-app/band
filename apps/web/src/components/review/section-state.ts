import { useCallback, useState } from "react";

export type SectionId = "reviewers" | "checks" | "comments";

// Device-local on purpose: it is a view preference, not worktree state.
const STORAGE_KEY = "band:pr-checks-sections";

function read(): Partial<Record<SectionId, boolean>> {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Whether a section is open, remembered across reloads. Every section starts open. */
export function useSectionOpen(id: SectionId): [boolean, (open: boolean) => void] {
  const [open, setOpenState] = useState(() => read()[id] !== false);
  const setOpen = useCallback(
    (next: boolean) => {
      setOpenState(next);
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...read(), [id]: next }));
      } catch {
        // Storage may be full or blocked; the section still toggles.
      }
    },
    [id],
  );
  return [open, setOpen];
}
