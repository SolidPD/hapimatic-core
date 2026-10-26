// SPDX-License-Identifier: AGPL-3.0-only
import type {
  McpReviewDefinition,
  McpReviewValue,
  McpServerEntry,
} from "@hapi/protocol/porter";
import { buildMcpServerConfig, reviewedMcpCommand } from "./mcpImport";
import { declaredSlotNames } from "./mcpRebuild";
import type { ImportPlan } from "./importArchive";
import type { PlannedMcpServerReview } from "@hapi/protocol/porter";
// #5601: the wire shapes live in @hapi/protocol/porter (importWire.ts).
export type { PlannedMcpServerReview } from "@hapi/protocol/porter";

/**
 * The import review's definition of each planned MCP server (issue #5172,
 * #5165 R5/H3): what the commit writes, shown before the commit.
 *
 * The commit writes each server with `buildMcpServerConfig(entry, secrets,
 * { destHome })` (`./mcpRebuild`). The review reuses that SAME builder,
 * read-only, with each declared secret slot's NAME standing in for its value
 * and no `opts`: no `resolveMcpCommand`, no filesystem I/O (the summary is
 * rebuilt on every status poll), and no secret value read. So every field rule
 * matches the commit by construction — `url` from its slot when `urlName` is
 * set, every `argsNames` index replaced, `type` only off stdio, `disabled` on
 * any transport. The command is then the plan's own `commandTranslation.to`
 * when the plan translated it ({@link reviewedMcpCommand}), which is what the
 * commit writes, or the commit excludes the server (#5192, `./mcpRebuild`).
 *
 * Projected from `plan.manifest`, never `plan.mcpItems` (which holds decrypted
 * secret values in memory): the `Pick` below leaves `mcpItems` out of the type.
 */

/** Every config field `buildMcpServerConfig` writes that this review accounts for. */
const REVIEWED_CONFIG_FIELDS: ReadonlySet<string> = new Set([
  "command",
  "args",
  "url",
  "type",
  "disabled",
  "env",
  "headers",
]);

/**
 * Throw when the builder wrote a field the review has no row for, so a new
 * builder field fails the summary loudly instead of landing unreviewed.
 */
export function assertReviewedConfigFields(
  config: Record<string, unknown>
): void {
  for (const field of Object.keys(config)) {
    if (!REVIEWED_CONFIG_FIELDS.has(field)) {
      throw new Error(
        `[#5172] the import review has no row for MCP config field ${JSON.stringify(field)}`
      );
    }
  }
}

/**
 * The reviewed definition of one manifest MCP server. `translatedCommand` is
 * the plan's `commandTranslation.to`, when the plan translated the command.
 */
export function mcpReviewDefinition(
  entry: McpServerEntry,
  translatedCommand?: string
): McpReviewDefinition {
  const slotNames = declaredSlotNames(entry);
  const built = buildMcpServerConfig(
    entry,
    Object.fromEntries(slotNames.map(name => [name, name]))
  );
  assertReviewedConfigFields(built);

  const definition: McpReviewDefinition = { transport: entry.transport };
  if (typeof built.command === "string") {
    definition.command = reviewedMcpCommand(entry, translatedCommand);
  }
  if (Array.isArray(built.args)) {
    const slotAt = new Map(
      (entry.argsNames ?? []).map(slot => [slot.index, slot.name])
    );
    definition.args = (built.args as string[]).map(
      (value, index): McpReviewValue => {
        const slot = slotAt.get(index);
        return slot === undefined
          ? { kind: "value", value }
          : { kind: "slot", slot };
      }
    );
  }
  if (entry.urlName !== undefined) {
    definition.url = { kind: "slot", slot: entry.urlName };
  } else if (typeof built.url === "string") {
    definition.url = { kind: "value", value: built.url };
  }
  if (typeof built.disabled === "boolean") {
    definition.disabled = built.disabled;
  }
  return definition;
}

/**
 * Attach the reviewed definition to every planned server. Returns new objects;
 * the plan is not mutated. A planned server with no manifest entry cannot
 * occur (the plan loop is one row per manifest server and names are unique),
 * so it throws rather than review a server it cannot describe.
 */
export function reviewMcpServers(
  plan: Pick<ImportPlan, "manifest" | "mcpServers">
): PlannedMcpServerReview[] {
  const entries = new Map(plan.manifest.mcpServers.map(e => [e.name, e]));
  return plan.mcpServers.map(server => {
    const entry = entries.get(server.name);
    if (entry === undefined) {
      throw new Error(
        `[#5172] planned MCP server ${JSON.stringify(server.name)} has no manifest entry`
      );
    }
    return {
      ...server,
      definition: mcpReviewDefinition(entry, server.commandTranslation?.to),
    };
  });
}
