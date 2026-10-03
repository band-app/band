/**
 * Converts arbitrary text to a valid git branch name slug.
 * Preserves "/" for namespace prefixes (e.g. feature/my-branch).
 */
export function slugifyBranchName(input: string): string {
  return input
    .toLowerCase()
    .replace(/\s+/g, "-") // spaces → hyphens
    .replace(/[^a-z0-9\-/]/g, "") // strip anything not alphanumeric, hyphen, or slash
    .replace(/-{2,}/g, "-") // collapse runs of hyphens
    .replace(/\/+/g, "/") // collapse duplicate slashes
    .replace(/^[-/]+|[-/]+$/g, ""); // trim leading/trailing hyphens and slashes
}
