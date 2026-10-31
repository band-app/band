import type { PluginTool, ToolContext, ToolResult } from "@band-app/plugin-api/server";
import { definePlugin } from "@band-app/plugin-api/server";
import { z } from "zod";

const json = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
});

/** Defines a tool whose handler gets arguments typed by its schema. */
function tool<S extends z.ZodRawShape>(
  name: string,
  description: string,
  shape: S,
  handler: (args: z.infer<z.ZodObject<S>>, ctx: ToolContext) => Promise<ToolResult>,
): PluginTool {
  return {
    name,
    description,
    inputSchema: z.object(shape),
    handler: handler as PluginTool["handler"],
  };
}

const POINTS =
  "Coordinates are in points, not screenshot pixels: divide pixels by the scale that simulator_status reports (3 on current iPhones).";

const POINTS_NOTE = "Coordinates are in points.";

const TOOLS: PluginTool[] = [
  tool(
    "simulator_status",
    "Show this worktree's iOS simulator: its device id, whether it is booted, and its screen size in points. Each worktree has its own device on its worker (a Mac). The device boots on the first screenshot, tap or other action.",
    {},
    async (_args, ctx) => json(await ctx.call("status")),
  ),
  tool(
    "simulator_screenshot",
    "Take a screenshot of this worktree's iOS simulator, booting it first when it is off. Returns a PNG.",
    {},
    async (_args, ctx) => {
      const shot = (await ctx.call("screenshot")) as {
        pngBase64: string;
        width: number;
        height: number;
      };
      return {
        content: [
          { type: "image", data: shot.pngBase64, mimeType: "image/png" },
          { type: "text", text: `Screenshot is ${shot.width}x${shot.height} pixels. ${POINTS}` },
        ],
      };
    },
  ),
  tool(
    "simulator_describe",
    `Read the iOS simulator screen's accessibility tree: each element's type, label, value and id, its frame and the point to tap it at. Cheaper and more exact than reading a screenshot. ${POINTS_NOTE}`,
    {},
    async (_args, ctx) => json(await ctx.call("describe")),
  ),
  tool(
    "simulator_tap",
    `Tap the iOS simulator screen. ${POINTS}`,
    {
      x: z.number().describe("Horizontal position in points"),
      y: z.number().describe("Vertical position in points"),
    },
    async (args, ctx) => json(await ctx.call("tap", args)),
  ),
  tool(
    "simulator_type",
    "Type text into the focused field of the iOS simulator.",
    { text: z.string().min(1).max(10_000) },
    async (args, ctx) => json(await ctx.call("type", args)),
  ),
  tool(
    "simulator_button",
    "Press a hardware button on the iOS simulator.",
    { button: z.enum(["HOME", "LOCK", "SIDE_BUTTON", "SIRI"]) },
    async (args, ctx) => json(await ctx.call("button", args)),
  ),
  tool(
    "simulator_open_url",
    "Open a URL in the iOS simulator. A web URL opens Safari, a custom scheme opens the app that registered it.",
    { url: z.string().min(1) },
    async (args, ctx) => json(await ctx.call("openUrl", args)),
  ),
  tool(
    "simulator_install",
    "Install an .app folder from this worktree (a simulator build) on the iOS simulator.",
    { path: z.string().min(1).describe("Absolute path of the .app inside this worktree") },
    async (args, ctx) => json(await ctx.call("install", args)),
  ),
  tool(
    "simulator_launch",
    "Launch an installed app on the iOS simulator by bundle id.",
    { bundleId: z.string().min(1) },
    async (args, ctx) => json(await ctx.call("launch", args)),
  ),
];

/**
 * The hub half of the simulator plugin: the agent tools. The device work happens in the worker
 * half (`../worker`), on the Mac that holds the worktree.
 */
export default definePlugin({
  activate(api) {
    for (const t of TOOLS) api.tools.register(t);
  },
});
