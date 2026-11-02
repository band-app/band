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
      })
      .strict()
      .default({}),
  })
  .strict();

export type FileEditorManifest = z.infer<typeof fileEditorSchema>;
export type ExtensionManifest = z.infer<typeof extensionManifestSchema>;

/** Whether a file name matches a selector glob (`*` any run, `?` one character, case-insensitive). */
export function matchesSelector(selector: string, fileName: string): boolean {
  const pattern = selector
    .replace(/[.+@-]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${pattern}$`, "i").test(fileName);
}
