// SPDX-License-Identifier: MIT
/**
 * The session "tool group" — the set of RPC methods `registerCommonHandlers`
 * registers on BOTH the session and machine `RpcHandlerManager`s
 * (`cli/src/modules/common/registerCommonHandlers.ts`): the agent's
 * working-directory filesystem / exec / git / search tools (issue #3745, epic
 * #3740, Sub-Issue E).
 *
 * 🔒 THE SINGLE MACHINE-READABLE DEFINITION OF "TOOL GROUP" (KD-5). It is imported
 * by:
 *   - E's V4 catalog test (`capabilityCatalog.entries.test.ts`) — asserts no
 *     `rpc` entry whose method is in this set carries `riskTier: "readonly"`;
 *   - Sub-Issue K (#3751)'s R4 promotion guard — the promotion allowlist is
 *     tested AGAINST this set so a tool-group method can never be promoted onto
 *     the generic invoke path.
 *
 * 🔴 SECURITY (R4 / ER D3): `isInvocable` (server/src/web/routes/capabilityPolicy.ts)
 * reads a method's `riskTier` ALONE — the method name is never a parameter. So in
 * this codebase `readonly` is not a description, it is a PROMOTION onto the
 * generic `hapi_invoke` path. Every method in this group is therefore tiered
 * `mutating`/`destructive` in `capabilityMeta.ts` (and its catalog entry) EVEN
 * when it is a semantically pure read (readFile, ripgrep, git-*, listDirectory,
 * getDirectoryTree, listSlashCommands) — tagging any of them `readonly` would
 * model-face a fs-content-bearing or shell RPC. Do NOT "correct" a tool-group
 * read back to `readonly`.
 */
export const TOOL_GROUP_METHODS = [
  "bash", // registerBashHandlers — shell exec (destructive)
  "readFile", // registerFileHandlers — fs read (mutating, not readonly)
  "writeFile", // registerFileHandlers — fs write (destructive)
  "createDirectory", // registerFileHandlers — fs write (mutating)
  "renamePath", // registerFileHandlers — fs rename (mutating)
  "deletePath", // registerFileHandlers — fs delete (destructive)
  "listDirectory", // registerDirectoryHandlers — fs read (mutating, not readonly)
  "getDirectoryTree", // registerDirectoryHandlers — fs read (mutating, not readonly)
  "ripgrep", // registerRipgrepHandlers — fs search (mutating, not readonly)
  "difftastic", // registerDifftasticHandlers — fs diff (mutating, not readonly)
  "git-status", // registerGitHandlers — repo read (mutating, not readonly)
  "git-diff-numstat", // registerGitHandlers — repo read (mutating, not readonly)
  "git-diff-file", // registerGitHandlers — file read (mutating, not readonly)
  "git-remote-url", // registerGitHandlers — repo read (mutating, not readonly)
  "listSlashCommands", // registerSlashCommandHandlers — fs read (mutating, not readonly)
] as const;

export type ToolGroupMethod = (typeof TOOL_GROUP_METHODS)[number];

/** Membership test over the tool group (bare RPC method name). */
export function isToolGroupMethod(method: string): method is ToolGroupMethod {
  return (TOOL_GROUP_METHODS as readonly string[]).includes(method);
}
