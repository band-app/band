export function toWorkspaceId(project: string, branch: string): string {
  return `${project}-${branch.replaceAll("/", "-")}`;
}
