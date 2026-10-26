// SPDX-License-Identifier: AGPL-3.0-only
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  type McpSecretBundle,
  type McpServerEntry,
} from "@hapi/protocol/porter";
import { decryptPorterArchive } from "../config/porterAgeKeys";
import {
  assertMcpConfigComplete,
  buildMcpServerConfig,
  reviewedMcpCommand,
  SecretInjectionError,
  type McpMergeItem,
} from "./mcpImport";
import type {
  ImportPlan,
  McpExclusion,
  PlannedMcpServer,
} from "./importArchive";
import { decryptFailureReason, parseSecretBundle } from "./secretBundle";

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

/** #4247: the shared reason both re-authorisability refusals give. */
const OVERLAY_SCOPE =
  "an overlay only re-authorises a server whose secrets could not be restored";

/**
 * Validate a `secretOverlay` against the plan's manifest, ALL up front (ADR-0006
 * R9), BEFORE any write. Rejects, in order: an unknown server name; a server the
 * plan cannot re-authorise — unresolvable on the destination (#2640) or with its
 * secrets already restored (#4247: an overlay only re-authorises a server whose
 * secrets could not be carried); a slot name
 * not in that server's declared slots; and an INCOMPLETE overlay (the supplied
 * slot set must EQUAL the declared set — a half-filled server is a 400, resolving
 * the R6-vs-R9 fork by rejecting up front rather than silently soft-excluding
 * after other servers were written). Empty / whitespace-only values are rejected
 * earlier by the `CommitBodySchema` zod (`.trim().min(1)`). Returns `null` on
 * success, or a clear error string that NEVER contains an overlay VALUE (R9
 * hygiene) — only server names and slot NAMES. A deselected server's entry is
 * validated like any other; the rebuild then drops it (deselect wins, #3546).
 */
export function validateSecretOverlay(
  overlay: SecretOverlay,
  servers: readonly McpServerEntry[],
  planned: readonly Pick<
    PlannedMcpServer,
    "name" | "resolvable" | "secretRestorable"
  >[]
): string | null {
  const byName = new Map(servers.map(s => [s.name, s]));
  const plannedByName = new Map(planned.map(p => [p.name, p]));
  for (const [serverName, slots] of Object.entries(overlay)) {
    const entry = byName.get(serverName);
    // The plan loop records one planned server per manifest server, so a
    // manifest name missing from the plan is treated as unknown, never passed.
    const p = plannedByName.get(serverName);
    if (!entry || !p) {
      return `secretOverlay names an unknown server: "${serverName}"`;
    }
    if (!p.resolvable) {
      return `secretOverlay names "${serverName}", which is excluded as unresolvable on the destination; ${OVERLAY_SCOPE}`;
    }
    if (p.secretRestorable) {
      return `secretOverlay names "${serverName}", whose secrets were restored; ${OVERLAY_SCOPE}`;
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
 * `mcpServers` carries each server's reviewed `commandTranslation` (#5192).
 */
type PlanForRebuild = Pick<
  ImportPlan,
  | "manifest"
  | "encryptedSecretsStagedPath"
  | "settingsFile"
  | "claudeDir"
  | "mcpServers"
>;

/** {@link rebuildMcpItems} result: the servers to write + any late soft-exclusions. */
export interface McpRebuildResult {
  items: McpMergeItem[];
  /**
   * Servers excluded at commit, concatenated into the commit's `mcpExclusions`
   * by {@link rebuildMcpItemsWithOverlay}:
   *  - #3546 (R6): OVERLAID servers whose build STILL failed after merging the
   *    recipient overlay, recorded as `kind:"secret"`. Defence in depth only:
   *    R9's up-front 400 already rejects an incomplete overlay.
   *  - #5192: servers whose command at commit is not the command the review
   *    showed — a translated target that vanished after the plan — recorded as
   *    `kind:"path"` by {@link commandDriftExclusion}. (The reverse, a
   *    translation that appeared after the plan, is defence in depth only: the
   *    plan already excludes such a server as non-portable.)
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
 *
 * Every built server, overlaid or not, is written only when its command is the
 * one the review showed ({@link commandDriftExclusion}, #5192); otherwise it is
 * excluded as `kind:"path"` and nothing is written for it.
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
    // #5543: fixed reasons, never the decrypter's or the parser's text — both
    // can echo bundle content (`invalid version <first line>` for a member that
    // is not age-encrypted). The plan decrypts and parses only when a server
    // declares secret slots, so this can be the first. A plain Error keeps the
    // commit a 500: a SecretDecryptionError cause would be classified 400
    // (commitFailureOf).
    let plaintext: Uint8Array;
    try {
      plaintext = await decryptPorterArchive(plan.settingsFile, ciphertext);
    } catch (err) {
      throw new Error(decryptFailureReason(err));
    }
    const parsed = parseSecretBundle(plaintext);
    if (!parsed.ok) throw new Error(parsed.reason);
    secretBundle = parsed.bundle;
  }
  // #2640: thread the same destHome as the plan loop so a source-home command is
  // written TRANSLATED at commit. This builder is what commit ACTUALLY writes —
  // the plan-summary rewrite alone never reaches the on-disk config ([1B-1]).
  const destHome = dirname(plan.claudeDir);
  // #5192: the translation each server's review showed, from the plan.
  const reviewedTranslation = new Map(
    plan.mcpServers.map(s => [s.name, s.commandTranslation?.to])
  );
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
    let config: Record<string, unknown>;
    if (overlayForServer) {
      try {
        config = buildMcpServerConfig(server, secretsForServer, {
          destHome,
        });
        assertMcpConfigComplete(server, config);
      } catch (err) {
        if (err instanceof SecretInjectionError) {
          // Soft-exclude this ONE overlaid server (never a value — key name only).
          exclusions.push({
            name: server.name,
            kind: "secret",
            detail: err.keyName,
          });
          continue;
        }
        throw err;
      }
    } else {
      config = buildMcpServerConfig(server, secretsForServer, {
        destHome,
      });
      // #2638 (R4): final write-time completeness guard on the config actually
      // committed. A plan-approved server whose slot vanished at commit is a
      // genuine anomaly, so the throw here folds into the outer rollback.
      assertMcpConfigComplete(server, config);
    }
    const drift = commandDriftExclusion(
      server,
      config,
      reviewedTranslation.get(server.name)
    );
    if (drift) {
      exclusions.push(drift);
      continue;
    }
    items.push({ name: server.name, config });
  }
  return { items, exclusions };
}

/**
 * #5192 (SINK-1): the commit writes the command the review showed, or not at
 * all. Returns a `kind:"path"` exclusion for a server whose BUILT command
 * differs from {@link reviewedMcpCommand} for the plan's translation, else
 * `null`. The built config is compared (not a re-derived value) because it is
 * what would be written; `command` is the only field `buildMcpServerConfig`
 * reads from the filesystem. A command is never a secret slot, so naming it in
 * `detail` is safe.
 */
export function commandDriftExclusion(
  entry: McpServerEntry,
  config: Record<string, unknown>,
  translatedCommand?: string
): McpExclusion | null {
  const reviewed = reviewedMcpCommand(entry, translatedCommand);
  if (config.command === reviewed) return null;
  return {
    name: entry.name,
    kind: "path",
    detail:
      // Defensive: unreachable through buildMcpServerConfig, which sets
      // `command` only when the manifest entry has one.
      reviewed === undefined
        ? "the reviewed server had no command, so the server was not written"
        : `the reviewed command "${reviewed}" changed or is missing on this destination since the review, so the server was not written; re-run the import to review it again`,
  };
}

/** The subset of `CommitExclusions` (`./commitSelection`) the recompute reads. */
interface McpSelection {
  excludedMcpNames: ReadonlySet<string>;
  mcpExclusions: readonly McpExclusion[];
}

/**
 * Recompute the MCP commit set for a `secretOverlay` and rebuild the merge items
 * (#3546 R6). Lives here (not in `runCommit`) to keep `importArchive.ts` under the
 * #2077 `max-lines` cap. An overlay lifts ONLY a secret-restorability exclusion
 * (a `kind:"secret"` record, #2638); it never lifts an unresolvable-command
 * exclusion (#2640, #4247). An overlay entry for a user-DESELECTED server is
 * dropped — the deselect branch in `resolveCommitExclusions` runs first and WINS.
 * The surviving overlaid names are subtracted from `excludedMcpNames` so their
 * build site is reached, their eager `kind:"secret"` records are filtered out, and
 * any late soft-exclusions from the rebuild are concatenated. Only those entries
 * reach the rebuild, so a stray entry never overrides a restored server's own
 * decrypted secrets. `validateSecretOverlay` refuses entries for unresolvable or
 * restored servers up front; this filter is the defence in depth for a caller
 * that skips it.
 */
export async function rebuildMcpItemsWithOverlay(
  plan: PlanForRebuild,
  sel: McpSelection,
  excluded: ReadonlySet<string>,
  secretOverlay?: SecretOverlay
): Promise<{ items: McpMergeItem[]; mcpExclusions: McpExclusion[] }> {
  const secretExcluded = new Set(
    sel.mcpExclusions.filter(e => e.kind === "secret").map(e => e.name)
  );
  const overlaid = new Set(
    Object.keys(secretOverlay ?? {}).filter(
      n => !excluded.has(n) && secretExcluded.has(n)
    )
  );
  const effectiveExcluded = new Set(
    [...sel.excludedMcpNames].filter(n => !overlaid.has(n))
  );
  const liftingOverlay = Object.fromEntries(
    Object.entries(secretOverlay ?? {}).filter(([n]) => overlaid.has(n))
  );
  const { items, exclusions } = await rebuildMcpItems(
    plan,
    effectiveExcluded,
    overlaid.size > 0 ? liftingOverlay : undefined
  );
  const mcpExclusions = [
    ...sel.mcpExclusions.filter(
      e => !(e.kind === "secret" && overlaid.has(e.name))
    ),
    ...exclusions,
  ];
  return { items, mcpExclusions };
}
