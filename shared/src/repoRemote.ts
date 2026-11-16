// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Issue #6646: the ONE parser of a git remote URL into a repository identity
 * (`owner/repo`). The CLI stamps `metadata.repoIdentity` with it when a session
 * registers (`cli/src/agent/sessionFactory.ts`), and the server resolves the
 * same identity for the Create page (`server/src/utils/repoIdentity.ts`). They
 * were two identical copies; one module keeps the key the Create page shows and
 * the key a session is inserted under from drifting apart, which matters now
 * that a project's billable switch is matched across nodes by that key.
 */

/**
 * How long `git remote get-url origin` may take, in both resolvers. The CLI
 * gave it 3 s and the server 10 s, so on a slow mount a session registered
 * under its path while the Create page showed its repository. 10 s is the
 * server's budget (a cold round-trip on a CIFS mount can take 6 s and more).
 */
export const GIT_REMOTE_TIMEOUT_MS = 10_000;

/**
 * Parse a git remote URL (SSH `git@host:owner/repo(.git)` or HTTP(S)
 * `https://host/owner/repo(.git)`) into its `owner/repo` name and a browsable
 * URL. Returns null for any other shape (an `ssh://` URL, a local path).
 * The host is dropped from `name`.
 */
export function parseGitRemoteUrl(
  remoteUrl: string
): { name: string; url?: string } | null {
  const trimmed = remoteUrl.trim();

  // SSH format: git@github.com:owner/repo.git
  const sshMatch = trimmed.match(/^git@([^:]+):([^/]+)\/(.+?)(?:\.git)?$/);
  if (sshMatch) {
    const [, host, owner, repo] = sshMatch;
    const name = `${owner}/${repo}`;
    const isGitHub = host === "github.com";
    return {
      name,
      url: isGitHub ? `https://github.com/${name}` : `https://${host}/${name}`,
    };
  }

  // HTTPS format: https://github.com/owner/repo.git
  const httpsMatch = trimmed.match(
    /^https?:\/\/([^/]+)\/([^/]+)\/(.+?)(?:\.git)?$/
  );
  if (httpsMatch) {
    const [, host, owner, repo] = httpsMatch;
    const name = `${owner}/${repo}`;
    return { name, url: `https://${host}/${name}` };
  }

  return null;
}
