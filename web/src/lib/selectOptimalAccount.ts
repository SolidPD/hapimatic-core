// SPDX-License-Identifier: AGPL-3.0-only
import type { RedactedAccount } from "@/types/api";
import type { AccountUsage } from "@hapi/protocol";
import { selectOptimalAccountUuid as selectOptimalAccountUuidShared } from "@hapi/protocol";

/**
 * Pick the most-underutilized HEALTHY account for create-page auto-selection
 * (#2042, epic #2038 A4).
 *
 * Thin `RedactedAccount`-typed wrapper over the shared `@hapi/protocol` core
 * (#3611, epic #3609 Sub-Issue B) — no divergent copy remains. Beyond the original
 * "lowest `ok` score" behavior, the shared core now also EXCLUDES hard-locked
 * accounts (R8 — `score >= 100`, either window at cap, or `unrefreshable`; the
 * pre-#3611 body admitted `score === 100`) and applies the deterministic
 * other-window tie-break (R9). Excluding a hard-locked account from the create-page
 * pre-selection is a deliberate, user-visible behavior change and is in scope.
 *
 * `unrefreshable` is derived from the `RedactedAccount` list (its HARD-gate field,
 * `web/src/types/api.ts`) and passed as the shared core's injected predicate, so
 * the shared module stays I/O-free and package-agnostic. Ties resolve
 * deterministically (weekly headroom, then 5-hour, then stable first-seen); returns
 * `null` when no eligible account exists, and the caller falls back to its existing
 * default selection.
 */
export function selectOptimalAccountUuid(
  accounts: RedactedAccount[],
  usage: AccountUsage[]
): string | null {
  // #3808 (R7): create-page auto-selection is Anthropic-only — the shared core picks
  // the lowest-utilization Claude account against the Anthropic usage snapshot. Restrict
  // to Anthropic records so a codex/gemini account is never auto-selected for a Claude
  // spawn. (absent provider ⇒ anthropic.)
  const anthropicAccounts = accounts.filter(
    a => (a.provider ?? "anthropic") === "anthropic"
  );
  const unrefreshable = new Set<string>();
  for (const a of anthropicAccounts) {
    if (a.unrefreshable === true) unrefreshable.add(a.accountUuid);
  }
  return selectOptimalAccountUuidShared(anthropicAccounts, usage, uuid =>
    unrefreshable.has(uuid)
  );
}
