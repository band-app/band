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
    version: z.string().min(1),
    extensionApi: z.literal(EXTENSION_API_VERSION),
    contributes: z
      .object({
        fileEditors: z.array(fileEditorSchema).default([]),
        workerServices: z.array(workerServiceSchema).default([]),
      })
      .strict()
      .default({}),
  })
  .strict();

export type FileEditorManifest = z.infer<typeof fileEditorSchema>;
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
