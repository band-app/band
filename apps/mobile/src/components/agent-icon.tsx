import { agentIconFor } from "@band-app/shared/agent-icons";
import { Bot } from "lucide-react-native";
import type { ColorValue } from "react-native";
import Svg, { Path } from "react-native-svg";
import { colors } from "../theme";

/**
 * The mark of a coding agent, drawn in the foreground color. A custom agent passes its type
 * (`codingAgents[].type`), so it gets its type's mark; a type with no mark gets a generic bot.
 */
export function AgentIcon({
  type,
  size = 20,
  color = colors.foreground,
}: {
  type: string | undefined;
  size?: number;
  color?: ColorValue;
}) {
  const data = agentIconFor(type);
  if (!data) return <Bot size={size} color={color as string} strokeWidth={1.75} />;
  return (
    <Svg width={size} height={size} viewBox={data.viewBox} accessibilityLabel={data.label}>
      {data.paths.map((p) => (
        <Path key={p.d} d={p.d} fill={color} fillOpacity={p.fillOpacity} fillRule={p.fillRule} />
      ))}
    </Svg>
  );
}
