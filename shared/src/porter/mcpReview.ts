// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Configuration Porter — the import review's view of an MCP server definition
 * (issue #5172, #5165 R5/H3).
 *
 * The commit writes each imported MCP server into `~/.claude.json` and every
 * account config, and Claude Code starts it at the next session. The review
 * therefore shows, before commit, the definition the commit writes: its
 * transport, command, args, url, and `disabled` flag. A credential-bearing
 * `args` element or `url` is shown by its secret slot name, never by value.
 * The server builds this view (`server/src/porter/mcpReviewDefinition.ts`) and
 * the web renders it, so the shape lives here once.
 *
 * NODE-FREE (R7): like every non-test module under `shared/src/porter`, this
 * file imports nothing from `node:*`.
 */
import type { McpServerEntry } from "./manifest";

/**
 * One `args` element, or the `url`, as the review shows it: the literal value
 * the commit writes, or the secret slot whose value the commit writes there.
 * A slot is identified only from the manifest's `argsNames` / `urlName`, never
 * from the text of a value, so no literal can render as a slot.
 */
export type McpReviewValue =
  | { kind: "value"; value: string }
  | { kind: "slot"; slot: string };

/** The reviewed definition of one planned MCP server. Absent keys are omitted. */
export interface McpReviewDefinition {
  transport: string;
  /** As the commit writes it: after the source-home `commandTranslation`. */
  command?: string;
  args?: McpReviewValue[];
  url?: McpReviewValue;
  disabled?: boolean;
}

/**
 * Every manifest MCP field, classified for the review (#5172). `shown` fields
 * appear in {@link McpReviewDefinition}; `slot-names` fields are shown by name
 * only; `metadata` fields are not part of what the commit writes. A field added
 * to the manifest fails typecheck here until someone classifies it.
 */
export const MCP_REVIEW_FIELD_ROLES = {
  name: "metadata",
  transport: "shown",
  command: "shown",
  args: "shown",
  url: "shown",
  urlName: "slot-names",
  argsNames: "slot-names",
  headerNames: "slot-names",
  envNames: "slot-names",
  disabled: "shown",
  source: "metadata",
} as const satisfies Record<
  keyof McpServerEntry,
  "shown" | "slot-names" | "metadata"
>;
