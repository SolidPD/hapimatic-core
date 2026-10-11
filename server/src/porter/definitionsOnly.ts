// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Import-side definitions-only tolerance (issue #3245, Task 2b — the critical
 * fix, epic #2339 expert-review D2a).
 *
 * Extracted from `importArchive.ts` per the coordinated extraction plan
 * (#3247/R20; precedents `importArchiveErrors.ts` / `importPlanSummary.ts`):
 * that module sits against the #2077 `max-lines` guardrail, so the tolerance
 * decision lands here and `importArchive.ts` carries only a one-line call site.
 *
 * THE PROBLEM. The script-driven, secrets-free export ({@link buildExportScript},
 * Task 1) produces an archive that DECLARES MCP secret SLOTS
 * (`envNames`/`headerNames`/`urlName`/`argsNames`) but ships NO encrypted
 * `secrets.age` member — it self-marks definitions-only via the well-known
 * {@link DEFINITIONS_ONLY_SECRETS_OMISSION} omission entry. Without a tolerance,
 * `importArchive.ts`'s `needsSecrets` guard sees declared slots + no encrypted
 * member and throws `SecretDecryptionError` (→ HTTP 400 in `porterImport.ts`),
 * HARD-REJECTING the whole import.
 *
 * THE TOLERANCE. When the encrypted secrets member is ABSENT **and** the manifest
 * carries the definitions-only marker, the importer proceeds WITHOUT secrets: the
 * per-server guard already in `importArchive.ts` (#2638) then soft-excludes each
 * declared-slot server (`secretRestorable: false` + `secretFailureKey`, and
 * `mcpExclusions[kind:"secret"]` at commit) — the top-level-MCP equivalent of
 * #2465's `ReAuthRecord` surfacing (server + missing fields), reusing EXISTING
 * fields rather than inventing a new one. A manifest that declares slots WITHOUT
 * the marker is STILL hard-rejected (behavior unchanged) — that is a genuine
 * missing-secrets error, not a deliberate secrets-free export.
 */
import {
  isDefinitionsOnlyManifest,
  type PorterManifest,
} from "@hapi/protocol/porter";

/**
 * Whether to TOLERATE a missing encrypted-secrets member instead of throwing
 * `SecretDecryptionError`. True iff the encrypted member is absent AND the
 * manifest is definitions-only ({@link isDefinitionsOnlyManifest}: no `secrets`
 * member + the definitions-only omission marker).
 *
 * @param manifest the parsed porter manifest
 * @param secretsEntryPresent whether the archive carries an encrypted
 *   `secrets.age` member (`Boolean(findEntry(...))` at the call site)
 */
export function tolerateMissingSecrets(
  manifest: PorterManifest,
  secretsEntryPresent: boolean
): boolean {
  return !secretsEntryPresent && isDefinitionsOnlyManifest(manifest);
}
