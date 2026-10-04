import { posix } from "node:path";
import { z } from "zod";
import { rangeError } from "./versions.ts";

/** Where a repo keeps its environment, relative to the repo root. */
export const ENVIRONMENT_FILE = ".band/environment.json";

export const ISOLATIONS = ["worktree", "container", "vm"] as const;
export type Isolation = (typeof ISOLATIONS)[number];

const command = z.string().refine((s) => s.trim() !== "", "must not be empty");

const SIZE = /^\d+(\.\d+)?\s?(Ki|Mi|Gi|Ti|K|M|G|T|KB|MB|GB|TB)?$/;

const buildSchema = z
  .object({
    devcontainer: z.string().min(1).optional(),
    dockerfile: z.string().min(1).optional(),
    image: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((build, ctx) => {
    const set = (["devcontainer", "dockerfile", "image"] as const).filter(
      (k) => build[k] !== undefined,
    );
    if (set.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `must set exactly one of devcontainer, dockerfile or image (found ${set.length === 0 ? "none" : set.join(" and ")})`,
      });
    }
  });

const terminalSchema = z.object({ name: z.string().min(1), command }).strict();

const resourcesSchema = z
  .object({
    cpu: z.number().positive(),
    memory: z.string().regex(SIZE, 'must be a size such as "8Gi" or "512Mi"').optional(),
    disk: z.string().regex(SIZE, 'must be a size such as "50Gi"').optional(),
  })
  .strict();

export const environmentSchema = z
  .object({
    $schema: z.string().optional(),
    build: buildSchema.optional(),
    install: command.optional(),
    start: command.optional(),
    terminals: z
      .array(terminalSchema)
      .superRefine((terminals, ctx) => {
        const seen = new Set<string>();
        terminals.forEach((t, i) => {
          if (seen.has(t.name)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [i, "name"],
              message: `duplicate terminal name "${t.name}"`,
            });
          }
          seen.add(t.name);
        });
      })
      .optional(),
    teardown: command.optional(),
    secrets: z
      .array(
        z
          .string()
          .regex(
            /^[A-Za-z_][A-Za-z0-9_]*$/,
            "must be an environment variable name (secret values are never stored here)",
          ),
      )
      .optional(),
    isolation: z.enum(ISOLATIONS).optional(),
    resources: resourcesSchema.optional(),
    services: z.record(z.string().min(1), z.string().min(1)).optional(),
    requires: z
      .record(
        z.string().regex(/^[a-z][a-z0-9_.-]*$/, "must be a lower-case tool name such as node"),
        z.string().superRefine((range, ctx) => {
          const problem = rangeError(range);
          if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
        }),
      )
      .optional(),
  })
  .strict();

export type Environment = z.infer<typeof environmentSchema>;

export interface EnvironmentIssue {
  /** Where the problem is, such as `terminals[0].command`. Empty for the file as a whole. */
  path: string;
  message: string;
}

export type ParseResult =
  | { ok: true; environment: Environment }
  | { ok: false; issues: EnvironmentIssue[] };

/** `["terminals", 0, "name"]` becomes `terminals[0].name`. */
export function formatPath(path: ReadonlyArray<string | number>): string {
  let out = "";
  for (const part of path) {
    if (typeof part === "number") out += `[${part}]`;
    else out += out === "" ? part : `.${part}`;
  }
  return out;
}

function article(type: string): string {
  return /^[aeiou]/.test(type) ? `an ${type}` : `a ${type}`;
}

function zodIssues(error: z.ZodError): EnvironmentIssue[] {
  const issues: EnvironmentIssue[] = [];
  for (const issue of error.issues) {
    if (issue.code === z.ZodIssueCode.unrecognized_keys) {
      for (const key of issue.keys) {
        issues.push({ path: formatPath([...issue.path, key]), message: "unknown key" });
      }
    } else if (issue.code === z.ZodIssueCode.invalid_enum_value) {
      issues.push({
        path: formatPath(issue.path),
        message: `must be one of ${issue.options.map((o) => `"${o}"`).join(", ")} (got "${String(issue.received)}")`,
      });
    } else if (issue.code === z.ZodIssueCode.invalid_type) {
      issues.push({
        path: formatPath(issue.path),
        message:
          issue.received === "undefined" ? "is required" : `must be ${article(issue.expected)}`,
      });
    } else {
      issues.push({ path: formatPath(issue.path), message: issue.message });
    }
  }
  return issues;
}

/** Parses the text of an `environment.json`. Does not look at the file system. */
export function parseEnvironment(text: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      issues: [{ path: "", message: `not valid JSON: ${(err as Error).message}` }],
    };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, issues: [{ path: "", message: "must be a JSON object" }] };
  }
  const parsed = environmentSchema.safeParse(raw);
  if (parsed.success) return { ok: true, environment: parsed.data };
  return { ok: false, issues: zodIssues(parsed.error) };
}

/** The repo-relative form of `file`, or `null` when it points outside the repository. */
export function repoRelative(file: string): string | null {
  if (posix.isAbsolute(file) || /^[A-Za-z]:[\\/]/.test(file)) return null;
  const normal = posix.normalize(file.replaceAll("\\", "/"));
  if (normal === ".." || normal.startsWith("../")) return null;
  return normal;
}

/**
 * Checks the files `build` names. `exists` answers for a repo-relative path
 * and decides what "the repository" means (a worktree, or the project checkout).
 */
export async function checkReferences(
  environment: Environment,
  exists: (relativePath: string) => Promise<boolean>,
): Promise<EnvironmentIssue[]> {
  const issues: EnvironmentIssue[] = [];
  for (const key of ["devcontainer", "dockerfile"] as const) {
    const file = environment.build?.[key];
    if (file === undefined) continue;
    const relative = repoRelative(file);
    if (relative === null) {
      issues.push({
        path: `build.${key}`,
        message: `"${file}" must be a path inside the repository`,
      });
    } else if (!(await exists(relative))) {
      issues.push({
        path: `build.${key}`,
        message: `file "${file}" does not exist in the repository`,
      });
    }
  }
  return issues;
}

/** Parses the text and checks the files it references. */
export async function validateEnvironment(
  text: string,
  exists: (relativePath: string) => Promise<boolean>,
): Promise<ParseResult> {
  const parsed = parseEnvironment(text);
  if (!parsed.ok) return parsed;
  const issues = await checkReferences(parsed.environment, exists);
  return issues.length === 0 ? parsed : { ok: false, issues };
}
