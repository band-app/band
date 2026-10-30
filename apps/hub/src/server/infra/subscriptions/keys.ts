/** The event keys a GitHub subscription matches on. The GitHub plugin builds the same strings. */
export const githubPrKey = (repo: string, number: number) => `github:pr:${repo}#${number}`;
export const githubCiKey = (repo: string, branch: string) => `github:ci:${repo}@${branch}`;
