import {
  Button,
  cn,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from "@band-app/ui";
import { useEffect, useState } from "react";
import { resetAppearance, setAppearance, setMode } from "../../../lib/theme/apply";
import { normalizeHex } from "../../../lib/theme/color";
import {
  type Appearance,
  CODE_FONT_SIZE_RANGE,
  CODE_FONTS,
  COLOR_KEYS,
  type ColorKey,
  DEFAULT_CODE_FONT_SIZE,
  DEFAULT_UI_FONT_SIZE,
  effectiveColors,
  isCustomized,
  isDefaultAppearance,
  type ThemeMode,
  UI_FONT_SIZE_RANGE,
  UI_FONTS,
} from "../../../lib/theme/model";
import { PRESETS } from "../../../lib/theme/presets";
import { useAppearance } from "../../../lib/theme/use-appearance";
import { ModePreview } from "./ModePreview";
import { SettingsRow } from "./SettingsRow";
import { SettingsSection } from "./SettingsSection";

const MODES: { id: ThemeMode; label: string }[] = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

const COLOR_LABELS: Record<ColorKey, string> = {
  accent: "Accent",
  background: "Background",
  foreground: "Foreground",
};

const CUSTOM = "custom";

/** A swatch that opens the native color picker, next to a hex field. */
function ColorField({
  id,
  value,
  onCommit,
}: {
  id: ColorKey;
  value: string;
  onCommit: (hex: string) => void;
}) {
  const [text, setText] = useState(value.toUpperCase());
  useEffect(() => setText(value.toUpperCase()), [value]);

  const commit = (raw: string) => {
    const hex = normalizeHex(raw);
    if (hex) onCommit(hex);
    else setText(value.toUpperCase());
  };

  return (
    <div className="flex items-center gap-2 rounded-full border border-border px-2 py-1">
      <label
        className="relative size-5 shrink-0 cursor-pointer overflow-hidden rounded-full border border-border"
        style={{ backgroundColor: value }}
      >
        <input
          type="color"
          aria-label={`${COLOR_LABELS[id]} color picker`}
          data-testid={`appearance__${id}-picker`}
          value={value}
          onChange={(e) => onCommit(e.target.value)}
          className="absolute inset-0 size-full cursor-pointer opacity-0"
        />
      </label>
      <input
        aria-label={`${COLOR_LABELS[id]} hex`}
        data-testid={`appearance__${id}-hex`}
        value={text}
        maxLength={7}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit(e.currentTarget.value);
        }}
        className="w-[4.5rem] bg-transparent font-mono text-sm uppercase outline-none"
      />
    </div>
  );
}

/** A px field that commits on blur or Enter and snaps to its range. */
function SizeField({
  id,
  value,
  fallback,
  range,
  onCommit,
}: {
  id: string;
  value: number | null;
  fallback: number;
  range: { min: number; max: number };
  onCommit: (value: number | null) => void;
}) {
  const shown = value ?? fallback;
  const [text, setText] = useState(String(shown));
  useEffect(() => setText(String(shown)), [shown]);

  const commit = () => {
    const n = Number.parseInt(text, 10);
    if (!Number.isFinite(n)) {
      setText(String(shown));
      return;
    }
    const clamped = Math.min(range.max, Math.max(range.min, n));
    setText(String(clamped));
    if (clamped !== value) onCommit(clamped);
  };

  return (
    <div className="flex items-center gap-2">
      <Input
        id={id}
        data-testid={id}
        inputMode="numeric"
        value={text}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
          if (e.key === "Enter") commit();
        }}
        className="h-8 w-16 text-center text-sm"
      />
      <span className="text-sm text-muted-foreground">px</span>
    </div>
  );
}

interface AppearanceSettingsProps {
  /** Whether this build can show the desktop through the sidebar. */
  translucentSidebarAvailable: boolean;
  translucentSidebar: boolean;
  onTranslucentSidebarChange: (value: boolean) => void;
}

export function AppearanceSettings({
  translucentSidebarAvailable,
  translucentSidebar,
  onTranslucentSidebarChange,
}: AppearanceSettingsProps) {
  const { appearance, mode, resolvedMode } = useAppearance();
  const colors = effectiveColors(appearance, resolvedMode);
  const custom = isCustomized(appearance);
  const update = (patch: Partial<Appearance>) => setAppearance({ ...appearance, ...patch });

  const setColor = (key: ColorKey, hex: string) => {
    update({
      overrides: {
        ...appearance.overrides,
        [resolvedMode]: { ...(appearance.overrides[resolvedMode] ?? {}), [key]: hex },
      },
    });
  };

  const choosePreset = (id: string) => {
    if (id === CUSTOM) return;
    update({ preset: id, overrides: {} });
  };

  const presetLabel = PRESETS.find((p) => p.id === appearance.preset)?.label ?? "Band";

  return (
    <div className="flex flex-col gap-6" data-testid="appearance">
      <SettingsSection title="Visual style">
        <SettingsRow variant="responsive" label="Mode">
          <div className="flex gap-3" role="radiogroup" aria-label="Mode">
            {MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                role="radio"
                aria-checked={mode === m.id}
                aria-label={m.label}
                data-testid={`appearance__mode-${m.id}`}
                onClick={() => setMode(m.id)}
                className="flex flex-col items-center gap-1 rounded-lg focus-visible:outline-2 focus-visible:outline-focus-ring"
              >
                <ModePreview mode={m.id} selected={mode === m.id} />
                <span
                  className={cn(
                    "text-xs",
                    mode === m.id ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  {m.label}
                </span>
              </button>
            ))}
          </div>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection>
        <SettingsRow
          variant="responsive"
          label="Theme"
          description={`The colors below are for ${resolvedMode} mode. Switch the mode to edit the other.`}
        >
          <Select value={custom ? CUSTOM : appearance.preset} onValueChange={choosePreset}>
            <SelectTrigger
              className="h-8 w-full text-sm sm:w-44"
              aria-label="Theme"
              data-testid="appearance__preset"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {custom ? (
                <SelectItem value={CUSTOM} disabled>
                  Custom ({presetLabel})
                </SelectItem>
              ) : null}
              {PRESETS.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>
        {COLOR_KEYS.map((key) => (
          <SettingsRow key={key} label={COLOR_LABELS[key]}>
            <ColorField id={key} value={colors[key]} onCommit={(hex) => setColor(key, hex)} />
          </SettingsRow>
        ))}
        <SettingsRow variant="responsive" label="UI font">
          <Select value={appearance.uiFont} onValueChange={(v: string) => update({ uiFont: v })}>
            <SelectTrigger
              className="h-8 w-full text-sm sm:w-44"
              aria-label="UI font"
              data-testid="appearance__ui-font"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {UI_FONTS.map((f) => (
                <SelectItem key={f.id} value={f.id}>
                  {f.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>
        <SettingsRow variant="responsive" label="Code font">
          <Select
            value={appearance.codeFont}
            onValueChange={(v: string) => update({ codeFont: v })}
          >
            <SelectTrigger
              className="h-8 w-full text-sm sm:w-44"
              aria-label="Code font"
              data-testid="appearance__code-font"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CODE_FONTS.map((f) => (
                <SelectItem key={f.id} value={f.id}>
                  {f.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>
      </SettingsSection>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-end px-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="appearance__reset"
            disabled={isDefaultAppearance(appearance)}
            onClick={resetAppearance}
          >
            Reset to default
          </Button>
        </div>
        <SettingsSection>
          <SettingsRow
            htmlFor="appearance__ui-size"
            label="UI font size"
            description="The base size for the interface."
          >
            <SizeField
              id="appearance__ui-size"
              value={appearance.uiFontSize}
              fallback={DEFAULT_UI_FONT_SIZE}
              range={UI_FONT_SIZE_RANGE}
              onCommit={(v) => update({ uiFontSize: v })}
            />
          </SettingsRow>
          <SettingsRow
            htmlFor="appearance__code-size"
            label="Code font size"
            description="The size for code in chats, the editor, diffs and the terminal."
          >
            <SizeField
              id="appearance__code-size"
              value={appearance.codeFontSize}
              fallback={DEFAULT_CODE_FONT_SIZE}
              range={CODE_FONT_SIZE_RANGE}
              onCommit={(v) => update({ codeFontSize: v })}
            />
          </SettingsRow>
          {translucentSidebarAvailable && (
            <SettingsRow
              htmlFor="translucent-sidebar"
              label="Translucent sidebar"
              description="Show the desktop through the repo list, blurred and tinted."
            >
              <Switch
                id="translucent-sidebar"
                checked={translucentSidebar}
                onCheckedChange={onTranslucentSidebarChange}
              />
            </SettingsRow>
          )}
        </SettingsSection>
      </div>
    </div>
  );
}
