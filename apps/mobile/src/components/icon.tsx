import type { LucideIcon } from "lucide-react-native";
import type { ColorValue } from "react-native";

import { colors } from "../theme";

/** The icon sizes the app uses, so one kind of mark has one size on every screen. */
export const ICON_SIZES = { sm: 14, md: 18, lg: 24 } as const;
export const ICON_STROKE = 2;

/** A lucide icon at one of the shared sizes, in a theme color (the foreground by default). */
export function Icon({
  icon: Glyph,
  size = "md",
  color = colors.foreground,
}: {
  icon: LucideIcon;
  size?: keyof typeof ICON_SIZES;
  color?: ColorValue;
}) {
  return <Glyph size={ICON_SIZES[size]} strokeWidth={ICON_STROKE} color={color as string} />;
}
