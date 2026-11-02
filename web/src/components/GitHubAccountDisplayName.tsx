// SPDX-License-Identifier: AGPL-3.0-only
import { githubDisplayName } from "@/lib/githubConnections";

/**
 * The "· Name" that follows a linked account's @login (issue #5973), shared by Settings →
 * Connectors and the Create page picker so the two never lay it out differently. Renders nothing
 * when the account has no name to show ({@link githubDisplayName}: absent, blank, or the login).
 *
 * Put it in the same flex row as the login, which must be `min-w-0 truncate`. The name gives up
 * all its room first, through an extreme shrink weight (a small one still takes a fraction of a
 * pixel from the login, enough to show "…"), down to `min-w-12`; only then does a long login
 * truncate, so the row never ends on a lone "·". The name sits in `<bdi>` so a right-to-left name
 * cannot reorder the login and the dot around it.
 */
export function GitHubAccountDisplayName(props: {
  account: { login: string; name: string | null };
}) {
  const name = githubDisplayName(props.account);
  if (!name) return null;
  return (
    <span className="flex min-w-12 shrink-[1000000] items-center gap-2 text-[length:var(--text-caption)] text-[var(--app-hint)]">
      <span aria-hidden="true">·</span>
      <bdi className="min-w-0 truncate">{name}</bdi>
    </span>
  );
}
