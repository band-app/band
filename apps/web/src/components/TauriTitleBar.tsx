import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { type RefObject, useEffect, useRef, useState } from "react";

/** Attaches a native mousedown → startDragging listener to a ref. */
function useTauriDrag(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let appWindow: { startDragging: () => Promise<void> } | null = null;
    import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
      appWindow = getCurrentWindow();
    });

    const onMouseDown = (e: MouseEvent) => {
      if (e.buttons === 1 && appWindow) {
        appWindow.startDragging();
      }
    };
    el.addEventListener("mousedown", onMouseDown);
    return () => el.removeEventListener("mousedown", onMouseDown);
  }, [ref]);
}

interface TauriTitleBarProps {
  /** Static title. If omitted, fetches the app title from Tauri. */
  title?: string;
  /** Callback to toggle the sidebar. When provided, a toggle button is shown. */
  onToggleSidebar?: () => void;
  /** Whether the sidebar is currently collapsed. */
  sidebarCollapsed?: boolean;
}

/** Draggable Tauri title bar that works with external-URL webviews. */
export function TauriTitleBar({ title, onToggleSidebar, sidebarCollapsed }: TauriTitleBarProps) {
  const [appTitle, setAppTitle] = useState(title ?? "Band");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (title) return;
    import("@tauri-apps/api/core").then(({ invoke }) => {
      invoke<string>("get_app_title").then(setAppTitle);
    });
  }, [title]);

  useTauriDrag(ref);

  return (
    <div
      ref={ref}
      data-tauri-drag-region
      className="h-[28px] shrink-0 flex items-center justify-center relative"
    >
      {onToggleSidebar && (
        <button
          type="button"
          onClick={onToggleSidebar}
          className="absolute left-[70px] top-1/2 -translate-y-1/2 flex items-center justify-center rounded p-0.5 text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
          title={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
        >
          {sidebarCollapsed ? (
            <PanelLeftOpen className="size-3.5" />
          ) : (
            <PanelLeftClose className="size-3.5" />
          )}
        </button>
      )}
      <span className="text-xs font-medium text-muted-foreground select-none pointer-events-none">
        {appTitle}
      </span>
    </div>
  );
}

/** Invisible draggable region for Tauri windows (no title text). */
export function TauriDragRegion() {
  const ref = useRef<HTMLDivElement>(null);
  useTauriDrag(ref);

  return <div ref={ref} data-tauri-drag-region className="h-[28px] shrink-0" />;
}
