import { z } from "zod";

/** The extension API version this build of Band implements. */
export const EXTENSION_API_VERSION = 1;

const idSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);

/** A glob that matches a file name: `*.xlsx`, `*.band-test`, `Makefile`. `*` and `?` only. */
const selectorSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9._*?+@-]+$/, "A selector is a file name glob");

/** A file path inside the extension folder. No leading slash, no `..`. */
const entrySchema = z
  .string()
  .min(1)
  .max(200)
  .refine((p) => !p.startsWith("/") && !p.split("/").includes(".."), "Must stay inside the folder");

export const fileEditorSchema = z
  .object({
    id: idSchema,
    label: z.string().min(1).max(100),
    selector: z.array(selectorSchema).min(1),
    default: z.boolean().default(false),
    entry: entrySchema,
    /** The editor reads and writes bytes, not text. */
    binary: z.boolean().default(false),
    /** The editor's `tools/list` answer, a JSON file in the folder. */
    tools: entrySchema.optional(),
  })
  .strict();

/** One requirement of a worker service: a worker fact such as `os=darwin`, or a binary name. */
const requirementSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9._+@=-]+$/, "A requirement is `key=value` or a binary name");

/**
 * A variable a service may put in the environment of the agents and terminals of a worktree
 * (`worktreeEnv`). Band's own variables, search paths, git, linker and credential-looking names
 * are never allowed.
 */
export const SERVICE_ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const FORBIDDEN_ENV_NAME =
  /^(BAND_|GIT_|LD_|DYLD_|SSH_|GH_|GITHUB_|NPM_|NODE_)|^(PATH|HOME|SHELL|USER|LOGNAME|TMPDIR|PWD|IFS)$|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|API_?KEY|PRIVATE/;

/** Whether a service may set the environment variable `name` for a worktree. */
export function isAllowedServiceEnvName(name: string): boolean {
  return SERVICE_ENV_NAME.test(name) && !FORBIDDEN_ENV_NAME.test(name);
}

const serviceEnvNameSchema = z
  .string()
  .refine(
    isAllowedServiceEnvName,
    "Not a variable a service may set (no BAND_*, PATH, GIT_*, credentials)",
  );

/**
 * A process the worker runs for the extension. `entry` is a `.mjs` file in the extension folder.
 * The worker starts it on every eligible worker (standard or admin trust, `requires` met) and
 * reports `capability` once it runs.
 */
export const workerServiceSchema = z
  .object({
    id: idSchema,
    entry: entrySchema.refine((p) => p.endsWith(".mjs"), "A service entry is a .mjs file"),
    requires: z.array(requirementSchema).default([]),
    /** What the worker reports in its capabilities while the service runs. The hub's `plugin.call` names it. */
    capability: idSchema,
    /**
     * Variables the service may add to the environment of the agents and terminals of a worktree
     * on this worker, through its `worktreeEnv` handler. A variable not listed is ignored.
     */
    worktreeEnv: z.array(serviceEnvNameSchema).max(16).default([]),
  })
  .strict();

/**
 * A worktree panel: a page in the center "+" menu, not tied to a file. Band offers it when the
 * worktree's worker reports `capability` (the service must be running there).
 */
export const panelSchema = z
  .object({
    id: idSchema,
    label: z.string().min(1).max(100),
    /** A lucide icon name. Unknown names fall back to a generic icon. */
    icon: z.string().min(1).max(50).optional(),
    entry: entrySchema,
    /** The `capability` of one of this extension's worker services. */
    capability: idSchema,
    /**
     * Accepted so existing manifests keep loading. It has no effect: panel streams always accept
     * input.
     */
    defaultControl: z.boolean().default(false),
    /**
     * Binary frames from the page (1 MiB at most each) reach the service, as text frames do.
     * Without it every binary frame from the page is dropped.
     */
    binaryInput: z.boolean().default(false),
  })
  .strict();

/**
 * A language server the worker runs for the editor. The code viewer opens a file whose name
 * matches `files` (or whose language is in `languages`) against this server. The worker starts one
 * process per worktree on the first connection and shares it between editors.
 */
export const languageServerSchema = z
  .object({
    id: idSchema,
    /** LSP languageIds the server handles, such as `typescript` and `typescriptreact`. */
    languages: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,40}$/)).min(1),
    /** File name globs, matched like a file editor's `selector`. */
    files: z.array(selectorSchema).min(1),
    /**
     * A file in the extension folder that ends in `.js`, `.mjs` or `.cjs` (run with the worker's
     * node), or the name of a binary on the worker's PATH.
     */
    command: z
      .string()
      .min(1)
      .max(200)
      .refine(
        (p) => !p.startsWith("/") && !p.split("/").includes(".."),
        "Must stay inside the folder",
      ),
    args: z.array(z.string().max(500)).default([]),
    /** Files at the worktree root that mark a project. With none present the server is not offered. Empty means always. */
    rootMarkers: z.array(z.string().min(1).max(100)).default([]),
    requires: z.array(requirementSchema).default([]),
  })
  .strict();

/**
 * An agent tool of the built-in `band` MCP server, named `<extension id>_<name>`. A worker service
 * answers it: Band calls `method` on the service `service` of the worktree's worker.
 */
export const toolSchema = z
  .object({
    name: z.string().regex(/^[a-z][A-Za-z0-9_]{0,40}$/, "A tool name is letters, digits and _"),
    description: z.string().min(1).max(2000),
    inputSchema: z.record(z.unknown()).default({ type: "object", properties: {} }),
    /** The `id` of one of this extension's worker services. */
    service: idSchema,
    method: z.string().min(1).max(100),
    /** `false` leaves the tool out of the agent's list. */
    agent: z.boolean().default(true),
  })
  .strict();

/** The vibrancy materials a mod may ask the desktop app for (`none` removes the vibrancy layer). */
export const MOD_WINDOW_MATERIALS = [
  "none",
  "sidebar",
  "titlebar",
  "selection",
  "menu",
  "popover",
  "header",
  "sheet",
  "window",
  "hud",
  "fullscreen-ui",
  "tooltip",
  "content",
  "under-window",
  "under-page",
] as const;

/** Desktop window options of a mod. Missing fields keep the app's defaults. */
export const modWindowSchema = z
  .object({
    material: z.enum(MOD_WINDOW_MATERIALS).optional(),
    titleBarStyle: z.enum(["hiddenInset", "hidden", "default"]).optional(),
    /** An empty native toolbar, which gives the window the large corner radius of a toolbar window. */
    toolbar: z.enum(["none", "unified", "compact"]).optional(),
    trafficLightPosition: z
      .object({ x: z.number().int().min(0).max(200), y: z.number().int().min(0).max(200) })
      .strict()
      .optional(),
  })
  .strict();

/**
 * A client mod: trusted code that runs in the page with the device token. `css` files are added to
 * the page, `module` is an ES module whose default export is called with the `band` host object
 * (see `mod-api.ts`), and `window` sets desktop window options. Installing the extension is the
 * approval.
 */
export const modSchema = z
  .object({
    /** One file or a list. A single file is read as a list of one. */
    css: z
      .union([entrySchema.transform((file) => [file]), z.array(entrySchema).max(16)])
      .default([]),
    module: entrySchema
      .refine((p) => /\.(m?js)$/.test(p), "A mod module is a .js or .mjs file")
      .optional(),
    window: modWindowSchema.optional(),
  })
  .strict();

/**
 * `band-extension.json`. The hub validates the manifest with this schema before it serves the
 * extension's files. An unknown key is an error.
 */
export const extensionManifestSchema = z
  .object({
    id: idSchema,
    name: z.string().min(1),
    version: z
      .string()
      .regex(/^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/, "The version is letters, digits, . _ + -"),
    extensionApi: z.literal(EXTENSION_API_VERSION),
    /**
     * One standing instruction for agents. The built-in `band` MCP server sends it as part of its
     * MCP `instructions`, so it reaches the system prompt of every chat. Keep it to one line.
     */
    agentHint: z.string().max(300).optional(),
    contributes: z
      .object({
        fileEditors: z.array(fileEditorSchema).default([]),
        workerServices: z.array(workerServiceSchema).default([]),
        panels: z.array(panelSchema).default([]),
        tools: z.array(toolSchema).default([]),
        languageServers: z.array(languageServerSchema).default([]),
        mod: modSchema.optional(),
      })
      .strict()
      .default({}),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const services = manifest.contributes.workerServices;
    const capabilities = new Set(services.map((s) => s.capability));
    const serviceIds = new Set(services.map((s) => s.id));
    manifest.contributes.panels.forEach((panel, i) => {
      if (!capabilities.has(panel.capability)) {
        ctx.addIssue({
          code: "custom",
          path: ["contributes", "panels", i, "capability"],
          message: `No worker service reports the capability ${panel.capability}`,
        });
      }
    });
    manifest.contributes.tools.forEach((tool, i) => {
      if (!serviceIds.has(tool.service)) {
        ctx.addIssue({
          code: "custom",
          path: ["contributes", "tools", i, "service"],
          message: `No worker service has the id ${tool.service}`,
        });
      }
    });
    const dup = (names: string[]) => names.find((n, i) => names.indexOf(n) !== i);
    const panelDup = dup(manifest.contributes.panels.map((p) => p.id));
    if (panelDup) ctx.addIssue({ code: "custom", message: `Duplicate panel id ${panelDup}` });
    const toolDup = dup(manifest.contributes.tools.map((t) => t.name));
    if (toolDup) ctx.addIssue({ code: "custom", message: `Duplicate tool name ${toolDup}` });
  });

export type FileEditorManifest = z.infer<typeof fileEditorSchema>;
export type PanelManifest = z.infer<typeof panelSchema>;
export type LanguageServerManifest = z.infer<typeof languageServerSchema>;
export type ModManifest = z.infer<typeof modSchema>;
export type ModWindowOptions = z.infer<typeof modWindowSchema>;
export type ToolManifest = z.infer<typeof toolSchema>;
export type WorkerServiceManifest = z.infer<typeof workerServiceSchema>;
export type ExtensionManifest = z.infer<typeof extensionManifestSchema>;

/** Whether a file name matches a selector glob (`*` any run, `?` one character, case-insensitive). */
export function matchesSelector(selector: string, fileName: string): boolean {
  const pattern = selector
    .replace(/[.+@-]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${pattern}$`, "i").test(fileName);
}
