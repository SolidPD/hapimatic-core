// SPDX-License-Identifier: AGPL-3.0-only
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  McpSecretBundleSchema,
  type McpSecretBundle,
  type McpServerEntry,
} from "@hapi/protocol/porter";
import { decryptPorterArchive } from "../config/porterAgeKeys";
import {
  assertMcpConfigComplete,
  buildMcpServerConfig,
  SecretInjectionError,
  type McpMergeItem,
} from "./mcpImport";
import type { ImportPlan, McpExclusion } from "./importArchive";

/**
 * ADR-0006 Fork A: the recipient-supplied secret overlay carried ONCE in the
 * commit body (`{ [serverName]: { [slotName]: value } }`). Inner keys are the
 * SYNTHETIC slot names (`__args_<i>__`, `__url__`, an env key, a header key) —
 * the exact keys `buildMcpServerConfig`'s flat per-server bundle uses — NEVER the
 * human display label. Memory-only; never logged (#3546 R9).
 */
export type SecretOverlay = Record<string, Record<string, string>>;

/**
 * The declared secret SLOT NAMES for a manifest MCP entry (synthetic bundle
 * keys). Order is stable but not relied on. Used by overlay validation (server)
 * and mirrored client-side by the re-auth form.
 */
export function declaredSlotNames(entry: McpServerEntry): string[] {
  return [
    ...(entry.argsNames ?? []).map(a => a.name),
    ...(entry.urlName !== undefined ? [entry.urlName] : []),
    ...(entry.envNames ?? []),
    ...(entry.headerNames ?? []),
  ];
}

/**
 * Validate a `secretOverlay` against the plan's manifest, ALL up front (ADR-0006
 * R9), BEFORE any write. Rejects, in order: an unknown server name; a slot name
 * not in that server's declared slots; and an INCOMPLETE overlay (the supplied
 * slot set must EQUAL the declared set — a half-filled server is a 400, resolving
 * the R6-vs-R9 fork by rejecting up front rather than silently soft-excluding
 * after other servers were written). Empty / whitespace-only values are rejected
 * earlier by the `CommitBodySchema` zod (`.trim().min(1)`). Returns `null` on
 * success, or a clear error string that NEVER contains an overlay VALUE (R9
 * hygiene) — only server names and slot NAMES.
 */
export function validateSecretOverlay(
  overlay: SecretOverlay,
  servers: readonly McpServerEntry[]
): string | null {
  const byName = new Map(servers.map(s => [s.name, s]));
  for (const [serverName, slots] of Object.entries(overlay)) {
    const entry = byName.get(serverName);
    if (!entry) {
      return `secretOverlay names an unknown server: "${serverName}"`;
    }
    const declared = new Set(declaredSlotNames(entry));
    const supplied = Object.keys(slots);
    for (const slot of supplied) {
      if (!declared.has(slot)) {
        return `secretOverlay for "${serverName}" names an unknown slot: "${slot}"`;
      }
    }
    // COMPLETE coverage: with no unknown slots and no duplicate keys possible on
    // an object, an equal count proves the supplied set equals the declared set.
    if (supplied.length !== declared.size) {
      return (
        `secretOverlay for "${serverName}" is incomplete: expected ` +
        `${declared.size} slot(s), got ${supplied.length}`
      );
    }
  }
  return null;
}

/**
 * The slice of {@link ImportPlan} that {@link rebuildMcpItems} reads. Kept as a
 * `Pick` (not the full plan) so this module needs only a TYPE-only import of
 * `ImportPlan` from `./importArchive`: the runtime import direction is
 * importArchive → mcpRebuild, so a value import back would be a cycle. Mirrors the
 * `PlanForSelection` pattern in `./commitSelection`. (#3546, #2077 max-lines
 * extraction — `importArchive.ts` was at 1498/1500 before this move.)
 */
type PlanForRebuild = Pick<
  ImportPlan,
  "manifest" | "encryptedSecretsStagedPath" | "settingsFile" | "claudeDir"
>;

/** {@link rebuildMcpItems} result: the servers to write + any late soft-exclusions. */
export interface McpRebuildResult {
  items: McpMergeItem[];
  /**
   * #3546 (R6): OVERLAID servers whose build STILL failed after merging the
   * recipient overlay — recorded as `kind:"secret"` and concatenated into the
   * commit's `mcpExclusions` by `runCommit`. Defence-in-depth only: R9's up-front
   * 400 already rejects an incomplete overlay, so in practice this stays empty.
   */
  exclusions: McpExclusion[];
}

/**
 * Re-decrypt secrets.age from staging (in-memory), merge the recipient
 * `secretOverlay` (ADR-0006 Fork A), and rebuild MCP merge items.
 *
 * `excludedNames` are the servers the plan already flagged for exclusion —
 * unresolvable command (#2640) or unrestorable secret (#2638 R3) — MINUS any
 * server the overlay re-authorises (subtracted by `runCommit` before this call,
 * #3546 R6). They are SKIPPED before {@link buildMcpServerConfig} runs.
 *
 * For an OVERLAID server, the overlay is merged OVER the decrypted bundle (overlay
 * wins) and the build/completeness guards are wrapped in a per-server try/catch: a
 * `SecretInjectionError` soft-excludes that ONE server (recorded, not thrown), so a
 * stray failure never aborts the whole commit after other servers were written. For
 * a NON-overlaid server the pre-#3546 HARD THROW fail-safe is preserved verbatim —
 * a plan-approved server whose slot vanished at commit folds into runCommit's
 * rollback.
 */
export async function rebuildMcpItems(
  plan: PlanForRebuild,
  excludedNames: ReadonlySet<string>,
  secretOverlay?: SecretOverlay
): Promise<McpRebuildResult> {
  if (plan.manifest.mcpServers.length === 0) {
    return { items: [], exclusions: [] };
  }
  let secretBundle: McpSecretBundle | undefined;
  if (plan.encryptedSecretsStagedPath) {
    const ciphertext = await readFile(plan.encryptedSecretsStagedPath);
    const plaintext = await decryptPorterArchive(plan.settingsFile, ciphertext);
    secretBundle = McpSecretBundleSchema.parse(
      JSON.parse(Buffer.from(plaintext).toString("utf-8"))
    );
  }
  // #2640: thread the same destHome as the plan loop so a source-home command is
  // written TRANSLATED at commit. This builder is what commit ACTUALLY writes —
  // the plan-summary rewrite alone never reaches the on-disk config ([1B-1]).
  const destHome = dirname(plan.claudeDir);
  const items: McpMergeItem[] = [];
  const exclusions: McpExclusion[] = [];
  for (const server of plan.manifest.mcpServers) {
    if (excludedNames.has(server.name)) continue;
    const overlayForServer = secretOverlay?.[server.name];
    // #3546 (R6): merge the recipient overlay OVER the decrypted bundle (overlay
    // wins). The per-server bundle is a flat slot-name→value map, so a shallow
    // spread yields the merged secrets `buildMcpServerConfig` expects — inheriting
    // the blank-guard, completeness gate, resolveMcpCommand translation,
    // containment and #3299 isolatedDest write semantics for free.
    const secretsForServer = overlayForServer
      ? { ...secretBundle?.[server.name], ...overlayForServer }
      : secretBundle?.[server.name];
    if (overlayForServer) {
      try {
        const config = buildMcpServerConfig(server, secretsForServer, {
          destHome,
        });
        assertMcpConfigComplete(server, config);
        items.push({ name: server.name, config });
      } catch (err) {
        if (err instanceof SecretInjectionError) {
          // Soft-exclude this ONE overlaid server (never a value — key name only).
          exclusions.push({
            name: server.name,
            kind: "secret",
            detail: err.keyName,
          });
        } else {
          throw err;
        }
      }
    } else {
      const config = buildMcpServerConfig(server, secretsForServer, {
        destHome,
      });
      // #2638 (R4): final write-time completeness guard on the config actually
      // committed. A plan-approved server whose slot vanished at commit is a
      // genuine anomaly, so the throw here folds into the outer rollback.
      assertMcpConfigComplete(server, config);
      items.push({ name: server.name, config });
    }
  }
  return { items, exclusions };
}

/** The subset of `CommitExclusions` (`./commitSelection`) the recompute reads. */
interface McpSelection {
  excludedMcpNames: ReadonlySet<string>;
  mcpExclusions: readonly McpExclusion[];
}

/**
 * Recompute the MCP commit set for a `secretOverlay` and rebuild the merge items
 * (#3546 R6). Lives here (not in `runCommit`) to keep `importArchive.ts` under the
 * #2077 `max-lines` cap. An overlay entry for a user-DESELECTED server is dropped —
 * the deselect branch in `resolveCommitExclusions` runs first and WINS. The
 * surviving overlaid names are subtracted from `excludedMcpNames` so their build
 * site is reached, their eager `kind:"secret"` records are filtered out, and any
 * late soft-exclusions from the rebuild are concatenated.
 */
export async function rebuildMcpItemsWithOverlay(
  plan: PlanForRebuild,
  sel: McpSelection,
  excluded: ReadonlySet<string>,
  secretOverlay?: SecretOverlay
): Promise<{ items: McpMergeItem[]; mcpExclusions: McpExclusion[] }> {
  const overlaid = new Set(
    Object.keys(secretOverlay ?? {}).filter(n => !excluded.has(n))
  );
  const effectiveExcluded = new Set(
    [...sel.excludedMcpNames].filter(n => !overlaid.has(n))
  );
  const { items, exclusions } = await rebuildMcpItems(
    plan,
    effectiveExcluded,
    secretOverlay
  );
  const mcpExclusions = [
    ...sel.mcpExclusions.filter(
      e => !(e.kind === "secret" && overlaid.has(e.name))
    ),
    ...exclusions,
  ];
  return { items, mcpExclusions };
}
