import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "@band-app/logger";
import type { SkillInfo } from "./types.js";

const log = createLogger("coding-agent:skills");

/**
 * Parse YAML frontmatter from a SKILL.md file.
 *
 * Frontmatter is delimited by `---` lines at the top of the file.
 * We only need simple key-value pairs (string values), so a full
 * YAML parser is not required.
 */
function parseFrontmatter(content: string): Record<string, string> {
  const lines = content.split("\n");
  if (lines[0]?.trim() !== "---") return {};

  const result: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "---") break;

    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;

    const key = line.slice(0, colonIndex).trim();
    let value = line.slice(colonIndex + 1).trim();
    // Strip surrounding YAML quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && value) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Read skills from a single directory.
 *
 * Each skill is a subdirectory containing a `SKILL.md` file with
 * YAML frontmatter that includes `name`, `description`, and
 * optionally `argument-hint`.
 */
export function readSkillsFromDir(skillsDir: string): SkillInfo[] {
  let entries: string[];
  try {
    entries = readdirSync(skillsDir);
  } catch {
    return [];
  }

  const skills: SkillInfo[] = [];

  for (const entry of entries) {
    try {
      const entryPath = join(skillsDir, entry);
      const entryStat = statSync(entryPath);
      if (!entryStat.isDirectory()) continue;

      const skillMdPath = join(entryPath, "SKILL.md");
      const content = readFileSync(skillMdPath, "utf-8");
      const frontmatter = parseFrontmatter(content);

      const name = frontmatter.name;
      const description = frontmatter.description;
      if (!name || !description) {
        log.debug({ entry }, "skipping skill without name or description");
        continue;
      }

      skills.push({
        name,
        description,
        argumentHint: frontmatter["argument-hint"] || undefined,
      });
    } catch {
      log.debug({ entry }, "failed to read skill");
    }
  }

  return skills;
}
