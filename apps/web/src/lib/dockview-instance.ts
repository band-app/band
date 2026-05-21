import type { DockviewApi } from "dockview";

let api: DockviewApi | null = null;

export function setDockviewApi(next: DockviewApi | null): void {
  api = next;
}

export function getDockviewApi(): DockviewApi | null {
  return api;
}
