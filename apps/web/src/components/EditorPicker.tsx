import { useSettingsQuery, useUpdateSettings } from "@band-app/dashboard-core";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@band-app/ui";
import { Check, ChevronDown, Copy } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
// ---------------------------------------------------------------------------
// App icon imports
// ---------------------------------------------------------------------------
import androidStudioIcon from "../assets/icons/app/android-studio.svg";
import antigravityIcon from "../assets/icons/app/antigravity.svg";
import cursorIcon from "../assets/icons/app/cursor.svg";
import finderIcon from "../assets/icons/app/finder.png";
import ghosttyIcon from "../assets/icons/app/ghostty.svg";
import intellijIcon from "../assets/icons/app/intellij.svg";
import iterm2Icon from "../assets/icons/app/iterm2.svg";
import kiroIcon from "../assets/icons/app/kiro.svg";
import rustroverIcon from "../assets/icons/app/rustrover.svg";
import sublimetextIcon from "../assets/icons/app/sublimetext.svg";
import terminalIcon from "../assets/icons/app/terminal.png";
import textmateIcon from "../assets/icons/app/textmate.png";
import vscodeIcon from "../assets/icons/app/vscode.svg";
import warpIcon from "../assets/icons/app/warp.png";
import webstormIcon from "../assets/icons/app/webstorm.svg";
import windSurfIcon from "../assets/icons/app/windsurf.svg";
import xcodeIcon from "../assets/icons/app/xcode.png";
import zedIcon from "../assets/icons/app/zed.svg";
import zedDarkIcon from "../assets/icons/app/zed-dark.svg";
import { invoke as desktopInvoke } from "../lib/desktop-ipc";
import { isDesktop } from "../lib/is-desktop";

// ---------------------------------------------------------------------------
// Icon registry
// ---------------------------------------------------------------------------
const APP_ICONS: Record<string, string> = {
  vscode: vscodeIcon,
  cursor: cursorIcon,
  zed: zedIcon,
  "zed-dark": zedDarkIcon,
  finder: finderIcon,
  terminal: terminalIcon,
  iterm2: iterm2Icon,
  ghostty: ghosttyIcon,
  warp: warpIcon,
  xcode: xcodeIcon,
  "android-studio": androidStudioIcon,
  antigravity: antigravityIcon,
  textmate: textmateIcon,
  "sublime-text": sublimetextIcon,
  intellij: intellijIcon,
  webstorm: webstormIcon,
  rustrover: rustroverIcon,
  windsurf: windSurfIcon,
  kiro: kiroIcon,
};

function isDark() {
  return document.documentElement.classList.contains("dark");
}

function AppIcon({ id, className }: { id: string; className?: string }) {
  const [dark, setDark] = useState(isDark);

  useEffect(() => {
    const observer = new MutationObserver(() => setDark(isDark()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  }, []);

  // Theme-aware: zed has a dark variant
  let src = APP_ICONS[id];
  if (id === "zed" && dark) {
    src = APP_ICONS["zed-dark"] ?? src;
  }

  if (!src) return null;
  return <img src={src} alt="" draggable={false} className={className ?? "size-5"} />;
}

// ---------------------------------------------------------------------------
// App definitions — subset of Band's app-presets.json that make sense for
// "Open in" (editors, terminals, Finder). Browsers/chrome/safari excluded.
// ---------------------------------------------------------------------------
interface AppDef {
  id: string;
  label: string;
  icon: string;
  /** The macOS app name passed to `open -a` / `check_app_exists`. */
  openWith: string;
}

const MAC_APPS: AppDef[] = [
  { id: "vscode", label: "VS Code", icon: "vscode", openWith: "Visual Studio Code" },
  { id: "cursor", label: "Cursor", icon: "cursor", openWith: "Cursor" },
  { id: "zed", label: "Zed", icon: "zed", openWith: "Zed" },
  { id: "windsurf", label: "Windsurf", icon: "windsurf", openWith: "Windsurf" },
  { id: "kiro", label: "Kiro", icon: "kiro", openWith: "Kiro" },
  { id: "xcode", label: "Xcode", icon: "xcode", openWith: "Xcode" },
  { id: "antigravity", label: "Antigravity", icon: "antigravity", openWith: "Antigravity" },
  { id: "textmate", label: "TextMate", icon: "textmate", openWith: "TextMate" },
  { id: "sublime-text", label: "Sublime Text", icon: "sublime-text", openWith: "Sublime Text" },
  { id: "intellij", label: "IntelliJ IDEA", icon: "intellij", openWith: "IntelliJ IDEA" },
  { id: "webstorm", label: "WebStorm", icon: "webstorm", openWith: "WebStorm" },
  { id: "rustrover", label: "RustRover", icon: "rustrover", openWith: "RustRover" },
  { id: "iterm2", label: "iTerm2", icon: "iterm2", openWith: "iTerm" },
  { id: "terminal", label: "Terminal", icon: "terminal", openWith: "Terminal" },
  { id: "ghostty", label: "Ghostty", icon: "ghostty", openWith: "Ghostty" },
  { id: "warp", label: "Warp", icon: "warp", openWith: "Warp" },
  {
    id: "android-studio",
    label: "Android Studio",
    icon: "android-studio",
    openWith: "Android Studio",
  },
];

// ---------------------------------------------------------------------------
// EditorPicker
// ---------------------------------------------------------------------------
interface EditorPickerProps {
  /** The workspace path to open. */
  workspacePath: string;
  /** Optional callback to copy the path. */
  onCopyPath?: () => void;
}

export function EditorPicker({ workspacePath, onCopyPath }: EditorPickerProps) {
  const { settings } = useSettingsQuery();
  const updateSettings = useUpdateSettings();

  // Installed apps detection
  const [installed, setInstalled] = useState<Record<string, boolean>>({ finder: true });

  useEffect(() => {
    if (!isDesktop) return;

    let cancelled = false;
    Promise.all(
      MAC_APPS.map((app) =>
        desktopInvoke<boolean>("check_app_exists", { appName: app.openWith })
          .then((ok) => [app.id, ok] as const)
          .catch(() => [app.id, false] as const),
      ),
    ).then((entries) => {
      if (cancelled) return;
      const map: Record<string, boolean> = { finder: true };
      for (const [id, ok] of entries) {
        map[id] = ok;
      }
      setInstalled(map);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  // Build visible options: Finder always first, then installed apps
  const options = useMemo(() => {
    const finderItem: AppDef = {
      id: "finder",
      label: "Finder",
      icon: "finder",
      openWith: "Finder",
    };
    const apps = MAC_APPS.filter((app) => installed[app.id]);
    return [finderItem, ...apps];
  }, [installed]);

  // Current selection from settings (falls back to "finder")
  const selectedId = (settings as unknown as Record<string, unknown>).defaultOpenApp as
    | string
    | undefined;
  const current = useMemo(
    () => options.find((o) => o.id === selectedId) ?? options[0],
    [options, selectedId],
  );

  // Persist selection
  const selectApp = useCallback(
    (appId: string) => {
      updateSettings.mutate({
        ...settings,
        defaultOpenApp: appId,
      } as typeof settings);
    },
    [settings, updateSettings],
  );

  // Open action
  const openWith = useCallback(
    async (app: AppDef) => {
      if (!isDesktop) return;
      if (app.id === "finder") {
        desktopInvoke("reveal_in_finder", { path: workspacePath }).catch(() => {});
        return;
      }
      desktopInvoke("open_with_app", {
        path: workspacePath,
        appName: app.openWith,
      }).catch(() => {});
    },
    [workspacePath],
  );

  // Click the main button → open with current app
  const handleMainClick = useCallback(() => {
    openWith(current);
  }, [current, openWith]);

  return (
    <div className="flex items-center rounded-md overflow-hidden border border-border/40">
      {/* Main button: icon of current app */}
      <button
        type="button"
        onClick={handleMainClick}
        onMouseDown={(e) => e.stopPropagation()}
        className="flex items-center justify-center px-1 py-0.5 hover:bg-accent/50 transition-colors"
        title={`Open in ${current.label}`}
      >
        <AppIcon id={current.icon} className="size-5" />
      </button>

      {/* Dropdown trigger */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            onMouseDown={(e) => e.stopPropagation()}
            className="flex items-center justify-center px-0.5 py-0.5 hover:bg-accent/50 transition-colors border-l border-border/40"
          >
            <ChevronDown className="size-3.5 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[180px]">
          <DropdownMenuLabel>Open in</DropdownMenuLabel>
          {options.map((app) => (
            <DropdownMenuItem
              key={app.id}
              onClick={() => {
                selectApp(app.id);
                openWith(app);
              }}
              className="gap-2"
            >
              <AppIcon id={app.icon} className="size-5 shrink-0" />
              <span className="flex-1">{app.label}</span>
              {current.id === app.id && <Check className="size-3.5 text-muted-foreground" />}
            </DropdownMenuItem>
          ))}
          {onCopyPath && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={onCopyPath} className="gap-2">
                <Copy className="size-4 shrink-0 ml-0.5" />
                <span className="flex-1">Copy path</span>
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
