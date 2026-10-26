// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Daemon identity / git / account turn enrichment (issue #1666, epic #1662 — Sub D).
 *
 * Sub D populates the per-turn columns that only Hapimatic knows — the in-memory
 * `session.metadata` identity/account/repo fields plus the live git working-tree
 * state. Two seams, deliberately split by what is synchronously knowable:
 *
 *   - **`createOpenEnrichStep(getSession)`** — the OPEN-enrich step. The real A+B
 *     build writes the identity columns ONLY via `turnStore.insertOpenTurn`
 *     (the finalize UPDATE ignores them), so the enrichment happens at turn-OPEN,
 *     reading the live `getSession(sid)` object. This also means even an orphaned
 *     (never-finalized) turn carries full identity. Synchronous — every field is
 *     an in-memory read.
 *
 *   - **`createEnrichStep()`** — Sub B's finalize `enrichStep` seam. The git
 *     working-tree SHA/dirty cannot be read synchronously on the server (the
 *     git-status RPC is async), so the CLI `TurnReporter` computes git locally and
 *     sends it on the wire; this step maps the CLI-provided finalize git
 *     (`ctx.event.gitShaEnd`/`gitDirty`) into the finalize input. `git_sha_end`
 *     is NULL-on-dead-session for free: a force-killed session sends no finalize
 *     event, so the orphan sweep finalizes the row with `git_sha_end` NULL.
 *
 * Both steps are FAIL-OPEN (R9): an undefined session, a missing field, or any
 * throw degrades to NULL columns and NEVER disturbs the session path (the
 * open-enrich runs inside `openTurn`'s try/catch; the finalize step inside B's
 * `runFinalizeSteps` try/catch).
 */

import { apiKeyRefVaultId } from "@hapi/protocol/apiKeyRef";
import type { Session } from "@hapi/protocol/types";

import type {
  FinalizeStepContext,
  FinalizeStepResult,
  OpenEnrichStep,
} from "./turnLifecycle";

/**
 * Map `metadata.source` → `session_mode` (R4). The scheduler stamps `source`
 * AFTER spawn (`taskExecutor.updateSessionSource`), so the FIRST turn of a
 * scheduler-spawned session may still read `undefined` here and record
 * `"standard"` — an accepted, documented limitation (directive OR-1); turns 2+
 * are always correct.
 */
export function deriveSessionMode(source: string | undefined): string {
  return source === "scheduler" || source === "heartbeat"
    ? "scheduled"
    : "standard";
}

/**
 * Build the Sub D OPEN-enrich step, closing over `getSession`
 * (= `syncEngine.getSession`) to read the live in-memory session at turn-open.
 */
export function createOpenEnrichStep(
  getSession: (sid: string) => Session | undefined
): OpenEnrichStep {
  return ctx => {
    try {
      const session = getSession(ctx.hapiSessionId);
      if (!session) return {};
      const m = session.metadata;

      // `orchestration_id` is not a declared `MetadataSchema` field yet (its
      // source wiring is unbuilt in this repo — #993's value lands later). Read
      // it through the `.passthrough()` escape hatch so the column lights up
      // automatically when a future sub-issue stamps `metadata.orchestrationId`;
      // until then it is NULL on every live session (R7).
      const orchestrationId = (m as Record<string, unknown> | null | undefined)
        ?.orchestrationId;
      // Issue #4824: the binding this turn runs under, read from the session
      // record as the turn OPENS. Identity columns are never touched by the
      // finalize UPDATE, so a later switch cannot re-attribute this turn. Every
      // mid-session switch — account or API key, including the legacy
      // account-only `switchAccount` — runs through
      // `AccountRestart.switchPaymentMethod`, which writes the new binding to the
      // record after killing the old process and BEFORE the respawn (#4823), so
      // the first post-switch turn opens under the new binding; a failed switch
      // restores the original binding before its rollback respawn. The key id
      // is the vault id (#4568), recorded only for an `api-key` binding.
      const bindingKind = m?.authBinding?.kind ?? null;

      return {
        // Issue #2187: the session's namespace — the ONE identity field Sub D
        // omitted, which pinned every turn row to NULL and made the Sub G parity
        // harness compare disjoint bucket keys ("" from NULL turns vs "default"
        // from the legacy/client sides), so every metric was permanently red.
        // `session.namespace` is a required top-level field (schemas.ts:263); the
        // `?? null` is a defensive guard matching the sibling `?? null` house style.
        namespace: session.namespace ?? null,
        // R5: structurally NULL for host-credential sessions (no accountUuid).
        accountId: m?.accountUuid ?? null,
        planTier: m?.claudeAccount?.rateLimitTier ?? null,
        authBindingKind: bindingKind,
        // Issue #5127: a key stored on another node is bound by its qualified
        // ref (`<uuid>@<home>`); the ledger keeps its vault id, so one key has
        // one id in the turn ledger on every node.
        apiKeyId:
          bindingKind === "api-key" && m?.apiKeyId != null
            ? apiKeyRefVaultId(m.apiKeyId)
            : null,
        safeMode: m?.safeMode ?? null,
        sessionMode: deriveSessionMode(m?.source), // R4
        permissionMode: session.permissionMode ?? null,
        sessionName: m?.name ?? null,
        // KD-2: `turns.linked_issue` is TEXT; serialize the issue number as `#N`
        // (the `repo` column carries owner/repo, so the bare `#N` is unambiguous).
        linkedIssue: session.linkedIssue
          ? `#${session.linkedIssue.number}`
          : null,
        orchestrationId:
          typeof orchestrationId === "string" ? orchestrationId : null,
        repo: m?.repoIdentity?.name ?? null,
        // R6: true iff the worktree metadata block is present.
        isWorktree: m ? m.worktree != null : null,
        // Server fallback (worktree sessions); the CLI's live `# branch.head`
        // overrides this when present (CLI-wire git, R2).
        gitBranch: m?.worktree?.branch ?? null,
      };
    } catch {
      // R9: fail-open — an enrichment failure must never disturb a session.
      return {};
    }
  };
}

/**
 * Build the Sub D finalize enrich step (Sub B's `enrichStep` seam). Maps the
 * CLI-provided finalize git (`TurnFinalizeEvent.gitShaEnd`/`gitDirty`, added by
 * Sub D) into the finalize input (R3). Synchronous and trivially fail-open;
 * B's `runFinalizeSteps` also wraps it in its own try/catch.
 */
export function createEnrichStep(): (
  ctx: FinalizeStepContext
) => FinalizeStepResult {
  return ctx => ({
    gitShaEnd: ctx.event.gitShaEnd ?? null,
    gitDirty: ctx.event.gitDirty ?? null,
  });
}

/**
 * Build the issue #3352 CLI-usage finalize step. Maps the OPTIONAL CLI-supplied
 * usage block (`TurnFinalizeEvent.usage`), carried by non-claude runners
 * (gemini / codex / opencode) that have no claude transcript, into the finalize
 * token/model columns.
 *
 * Byte-identical-claude contract (R7): the block is ABSENT on a claude finalize,
 * so this returns `{}` and the transcript `parseStep` result (which ran just
 * before it in the seam) is preserved untouched. It MUST be wired to run AFTER
 * `parseStep`, because on a non-claude turn the parse yields explicit
 * `undefined` token keys (empty transcript) that would otherwise clobber values
 * set earlier — running last lets the real CLI numbers win.
 *
 * No fabrication (R4): only the fields the CLI actually provided are mapped; an
 * absent cache split is simply not set (→ the column stays NULL), never a
 * fabricated 0 that would read as a measured zero.
 *
 * Attribution (R8): `modelId` + `modelProvider` are written so #3353's
 * provider-keyed rate cards resolve (a NULL provider would default to
 * `anthropic` and misprice a non-claude row).
 *
 * Synchronous and trivially fail-open; B's `runFinalizeSteps` also wraps it.
 */
export function createCliUsageStep(): (
  ctx: FinalizeStepContext
) => FinalizeStepResult {
  return ctx => {
    const usage = ctx.event.usage;
    if (!usage) return {};
    const out: FinalizeStepResult = {};
    if (usage.modelId != null) out.modelId = usage.modelId;
    if (usage.modelProvider != null) out.modelProvider = usage.modelProvider;
    if (usage.tokIn != null) out.tokIn = usage.tokIn;
    if (usage.tokOut != null) out.tokOut = usage.tokOut;
    // R4: cache splits are only mapped when the CLI exposes them — an absent
    // split stays NULL (never a measured 0).
    if (usage.tokCacheRead != null) out.tokCacheRead = usage.tokCacheRead;
    if (usage.tokCacheWrite != null) out.tokCacheWrite = usage.tokCacheWrite;
    // R6: per-turn context occupancy where the CLI exposes a window. `contextWindow`
    // is written at OPEN; at finalize we record used + (window − used) remaining.
    if (usage.contextUsedTokens != null) {
      out.contextUsedTokens = usage.contextUsedTokens;
      if (usage.contextWindowTokens != null) {
        out.contextRemainingTokens = Math.max(
          0,
          usage.contextWindowTokens - usage.contextUsedTokens
        );
      }
    }
    return out;
  };
}
