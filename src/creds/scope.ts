export class ScopeDeniedError extends Error {}

const connectHint = (repo: string) =>
  `Ask the user to run on the hatchery host: hatchery repo connect <drone-repo> ${repo}` +
  ` (add --github if this drone lives on Forgejo). Do not work around this.`;

function orgOf(repo: string): string {
  return repo.split("/")[0].toLowerCase();
}

/**
 * Repos a drone may get a token for. One installation token covers a single
 * org, so the result never spans orgs.
 */
export function resolveScope(
  allowed: string[],
  repo: string | null,
  org: string | null,
): string[] {
  if (repo) {
    const match = allowed.find((r) => r.toLowerCase() === repo.toLowerCase());
    if (!match) {
      throw new ScopeDeniedError(
        `This drone is not connected to ${repo}. ${connectHint(repo)}`,
      );
    }
    return [match];
  }

  if (org) {
    const matches = allowed.filter((r) => orgOf(r) === org.toLowerCase());
    if (matches.length === 0) {
      throw new ScopeDeniedError(
        `This drone is not connected to any repo in ${org}. ${connectHint(`${org}/<repo>`)}`,
      );
    }
    return matches;
  }

  if (allowed.length === 0) {
    throw new ScopeDeniedError("This drone is not connected to any GitHub repo.");
  }
  const first = orgOf(allowed[0]);
  return allowed.filter((r) => orgOf(r) === first);
}
