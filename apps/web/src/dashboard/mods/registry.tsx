/**
 * The client mod registry. A mod (the `contributes.mod` of an extension) registers overrides for
 * named regions and a sidebar data transform. `Overridable` renders a region: the stock component
 * when no mod overrides it, else the mod's render function called with `(props, Default)`. An
 * override that throws renders the stock component and records the error for Settings >
 * Extensions. Later overrides wrap earlier ones, in install order.
 */
import type {
  ModRegion,
  ModRegionProps,
  SidebarItem,
  SidebarItemsTransform,
} from "@band-app/plugin-api";
import {
  Component,
  createContext,
  type ErrorInfo,
  type ReactNode,
  useContext,
  useSyncExternalStore,
} from "react";

type RenderFn = (props: unknown, Default: () => ReactNode) => ReactNode;

interface OverrideEntry {
  extensionId: string;
  region: ModRegion;
  render: RenderFn;
}

export interface ModError {
  extensionId: string;
  /** The region, or `sidebar.items` / `load` for the other failures. */
  region: string;
  message: string;
}

let overrides: OverrideEntry[] = [];
let transforms: { extensionId: string; fn: SidebarItemsTransform }[] = [];
let errors: ModError[] = [];
let version = 0;
const listeners = new Set<() => void>();

function bump(): void {
  version++;
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useModVersion(): number {
  return useSyncExternalStore(
    subscribe,
    () => version,
    () => 0,
  );
}

export function registerOverride(extensionId: string, region: ModRegion, render: RenderFn): void {
  overrides = [...overrides, { extensionId, region, render }];
  bump();
}

export function registerSidebarTransform(extensionId: string, fn: SidebarItemsTransform): void {
  transforms = [...transforms, { extensionId, fn }];
  bump();
}

export function recordModError(error: ModError): void {
  if (errors.some((e) => e.extensionId === error.extensionId && e.region === error.region)) return;
  errors = [...errors, error];
  bump();
}

export function clearMods(): void {
  overrides = [];
  transforms = [];
  errors = [];
  bump();
}

export function getModErrors(): ModError[] {
  return errors;
}

export function useModErrors(): ModError[] {
  useModVersion();
  return errors;
}

/** Runs every registered transform in order. A transform that throws is skipped and recorded. */
export function applySidebarTransforms<T extends SidebarItem>(items: T[], repoName: string): T[] {
  let out: SidebarItem[] = items;
  for (const t of transforms) {
    try {
      const next = t.fn(out, { repoName });
      if (Array.isArray(next)) out = next;
    } catch (err) {
      recordModError({
        extensionId: t.extensionId,
        region: "sidebar.items",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out as T[];
}

export function hasSidebarTransforms(): boolean {
  return transforms.length > 0;
}

class OverrideBoundary extends Component<
  { entry: OverrideEntry; fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error, _info: ErrorInfo) {
    recordModError({
      extensionId: this.props.entry.extensionId,
      region: this.props.entry.region,
      message: error.message,
    });
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** What `Default` renders for the layer around it: the next layer in, or the stock element. */
const SlotContext = createContext<() => ReactNode>(() => null);

/** The `Default` a mod receives. Its identity is fixed, so a re-render never remounts the stock UI. */
function Slot() {
  return <>{useContext(SlotContext)()}</>;
}

function Layer({
  entry,
  props,
  inner,
}: {
  entry: OverrideEntry;
  props: unknown;
  inner: () => ReactNode;
}) {
  return (
    <SlotContext.Provider value={inner}>
      <OverrideBoundary entry={entry} fallback={inner()}>
        <Called entry={entry} props={props} />
      </OverrideBoundary>
    </SlotContext.Provider>
  );
}

/** Calls the mod's function as a component, so it may use hooks. */
function Called({ entry, props }: { entry: OverrideEntry; props: unknown }) {
  return <>{entry.render(props, Slot)}</>;
}

/** Renders `name`: the mod override chain around the stock element from `render`, or `render()` alone. */
export function Overridable<R extends ModRegion>({
  name,
  props,
  render,
}: {
  name: R;
  props: ModRegionProps[R];
  render: () => ReactNode;
}) {
  useModVersion();
  const chain = overrides.filter((o) => o.region === name);
  let inner = render;
  for (const entry of chain) {
    const prev = inner;
    inner = () => <Layer entry={entry} props={props} inner={prev} />;
  }
  return <>{inner()}</>;
}
