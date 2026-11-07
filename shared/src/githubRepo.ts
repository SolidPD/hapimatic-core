// SPDX-License-Identifier: AGPL-3.0-only
/**
 * A repository accessible to a host GitHub account, as the Create page's repository picker
 * receives it (issue #6326).
 *
 * One definition for the server's repo listing (`server/src/utils/githubCli.ts` re-exports it as
 * `GitHubRepoResult`), the federation proxy, the web API client and the web query hook, so the
 * four can no longer drift (two hand copies had already lost `defaultBranch`). The gateway keeps
 * its own copy in `gateway/src/lib/githubRest.ts` because it deploys standalone, without
 * `shared/`; `scripts/github-rest-replica-parity-v1.test.ts` pins its mapping to the server's.
 *
 * The optional fields are ABSENT when the transport that served the list does not report them:
 * an older federation peer or gateway, or a GitHub row that lacks the field. Absent is not the
 * same as `false`: the picker hides a filter whose field no loaded repository carries instead of
 * offering a toggle that does nothing.
 */
export interface GitHubRepo {
  nameWithOwner: string;
  name: string;
  description: string | null;
  isPrivate: boolean;
  pushedAt: string | null;
  /** hapimatic-private#4481: the branch a clone lands on, when the transport reports it. */
  defaultBranch?: string | null;
  /** #6326: ISO-8601 creation time; absent when the serving transport predates it. */
  createdAt?: string;
  /** #6326: GitHub refuses pushes to an archived repository; absent when not reported. */
  isArchived?: boolean;
  /** #6326: the repository is a fork; absent when not reported. */
  isFork?: boolean;
}
