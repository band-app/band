import { type PluginInfo, pluginHost } from "../../services/plugin-host-service";
import { publicProcedure, t } from "../trpc";

export const pluginsRouter = t.router({
  /** The bundled plugins and their state. The dashboard hides the UI of disabled ones. */
  list: publicProcedure.query((): PluginInfo[] => pluginHost.list()),
});
