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
     * Band takes control for the person as soon as a stream connects (and after each reconnect), so
     * input reaches the service without pressing Take control. Release still works.
     */
    defaultControl: z.boolean().default(false),
    /**
     * Binary frames from the page reach the service while the person is in control and are dropped
     * otherwise. Without it every binary frame from the page is dropped. Text frames are unchanged.
     */
    binaryInput: z.boolean().default(false),
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
    contributes: z
      .object({
        fileEditors: z.array(fileEditorSchema).default([]),
        workerServices: z.array(workerServiceSchema).default([]),
        panels: z.array(panelSchema).default([]),
        tools: z.array(toolSchema).default([]),
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
