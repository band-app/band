export function toWorktreeId(repo: string, branch: string): string {
  return `${repo}-${branch.replaceAll("/", "-")}`;
}
