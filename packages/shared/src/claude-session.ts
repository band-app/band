/**
 * The folder name Claude Code keeps a working directory's sessions under, in
 * `~/.claude/projects/<slug>/<session id>.jsonl`: every character that is not a
 * letter or digit becomes `-`.
 */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}
