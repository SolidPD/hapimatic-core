// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Finalize-time PM spawn-roster reconciliation step (issue #2010).
 *
 * A fail-open sibling of `parseStep` / `enrichStep` / `costStep` in
 * `turnLifecycle`'s finalize chain. On finalize of a session whose node holds a
 * non-`complete` `pm_spawn_roster` row, it greps the just-finalized transcript
 * for that row's `completion_token` and, on a hit, flips the row to `complete`
 * server-side — so the `/project-manager-role` PM no longer needs a per-monitor-
 * tick transcript grep (the producer half of rp1-home#1069).
 *
 * **Token-scan lookup (Design B) + identity guard (#2074).** Rather than keying
 * the row lookup on a session id (`cc_session_id` / `hapi_session_id`), this step
 * checks EACH non-`complete` row's `completion_token` against the transcript text.
 * The session-id keys are unreliable AS A LOOKUP KEY cross-node: the PM's
 * enrichment PATCH is node-blind (it targets the PM's own hub, keyed on
 * `completion_token`), so a cross-node spawn's row — which the federation-aware
 * WRITE (the spawn-roster POST proxy) places on the spawned session's OWN node —
 * never receives `cc_session_id` there, and `hapi_session_id` is not set at POST.
 * The `completion_token` (`PMDONE-<24hex>`, 96-bit, UNIQUE) IS the natural
 * collision-free key, so the scan works identically same-node and cross-node with
 * no enrichment dependency.
 *
 * A unique token is NOT, however, a token that appears ONLY in its own session's
 * transcript — the distinction #2074 turned on. Design B originally assumed the
 * closer's terminal step was the sole emitter; in practice a spawning PM echoed a
 * peer's token into the PM's OWN status output, and the PM's turn-finalize then
 * flipped the peer's still-active row to `complete`. So the token remains the
 * LOOKUP key, and the session id is now used as a GUARD when present: a row
 * enriched with its peer's id may be completed only by that peer's own finalize.
 * An unenriched row (the cross-node case) keeps the token-only match — safe
 * because a hub-side PM finalize never sees the peer's node-B row at all.
 *
 * **Echo-proof wrapped emission (#2173).** A row can also be id-less for a
 * NON-cross-node reason: a same-node peer that errors on its first turn (a 529
 * Overloaded) BEFORE the PM's first enrichment poll leaves its row id-less, so the
 * #2074 guard's id-less carve-out no longer implies "cross-node, hub never sees it".
 * A spawning PM that echoes the bare token then false-completes that co-located row.
 * The fix: the closer emits the token behind the fixed `PM_COMPLETION_TOKEN_PREFIX`
 * wire prefix and this step matches ONLY that wrapped form — a bare mention in prose
 * is no longer a completion signal.
 *
 * **Cross-node mechanism.** The producer's federation-aware spawn-roster WRITE
 * lands a cross-node spawn's row on the spawned session's node; finalize runs on
 * that same node (its transcript is local there), so this step reconciles the row
 * node-locally and the hub reads completion via the existing
 * `/api/federation/.../spawn-roster` aggregate.
 *
 * **Universal parser untouched (R2).** The PM-specific high-entropy token is read
 * FROM the roster row, never baked into the universal Sub-C `parseStep` grammar.
 *
 * **Fail-open (R3).** Any failure (missing/unreadable transcript, store throw)
 * degrades to a no-op and NEVER aborts finalize. `runFinalizeSteps` already wraps
 * every step in its own try/catch; this module adds a localized guard for
 * defense-in-depth (mirrors `safeOpenEnrich`).
 *
 * **Cost (R-perf).** The transcript is read ONLY when ≥1 non-`complete` row
 * exists on this node, so a non-PM finalize pays a single indexed SELECT
 * (`idx_pm_roster_status`) and nothing else.
 */

import { readFileSync } from "node:fs";

import type { PmSpawnRosterRecord } from "@hapi/protocol";

import type { ErrorLogger } from "../logging/errorLogger";
import type { PmRosterStore } from "../store/turns/pmRosterStore";
import type { FinalizeStep, FinalizeStepContext } from "./turnLifecycle";

/**
 * The echo-proof wire prefix the closer's terminal step emits immediately before a
 * spawn-roster completion token. The reconciler matches the token ONLY in this
 * wrapped form ("PM-COMPLETION-TOKEN: <token>"), so a spawning PM merely mentioning
 * a peer's bare token in prose (the #2074 / #2173 echo vector) can no longer be
 * mistaken for a genuine emission.
 *
 * 🔴 CROSS-REPO WIRE CONTRACT (issue #2173, Path B). This exact byte string MUST
 * equal the prefix the rp1-home issue-closer emits at its terminal step
 * (~/.claude/skills/issue-closer/SKILL.md, Step 16e). Changing it requires a
 * lockstep change to that closer, deployed to every machine BEFORE this matcher
 * tightens: the closer-emits-wrapped change is backward-compatible with the old
 * bare-substring matcher (the wrapped line still contains the bare token as a
 * substring), but this matcher is NOT backward-compatible with a bare emission.
 */
export const PM_COMPLETION_TOKEN_PREFIX = "PM-COMPLETION-TOKEN: ";

/**
 * Build the issue #2010 `pmReconcileStep` for the finalize seam. Closes over the
 * `PmRosterStore` (and an optional logger), mirroring the `createParseStep` /
 * `createEnrichStep` factory shape. The returned step is a pure side-effecting
 * `FinalizeStep` — it sets roster status and returns no column enrichment (`{}`).
 */
export function createPmReconcileStep(
  pmRoster: PmRosterStore,
  errorLogger?: ErrorLogger | null
): FinalizeStep {
  return (ctx: FinalizeStepContext) => {
    try {
      const rows = pmRoster.getReconcilable();
      // Common case for non-PM sessions: nothing to reconcile — skip the read.
      if (rows.length === 0) return {};

      const transcript = readTranscriptText(ctx);
      if (transcript === null) return {}; // no readable transcript — fail-open no-op

      for (const row of rows) {
        // Echo-proof match (#2173): require the token in its wrapped emission
        // form (PM_COMPLETION_TOKEN_PREFIX + token), NOT a bare substring — a bare
        // token mention (a PM echoing a peer's token into its own status output)
        // must NOT count as a genuine emission. The prefix + token is JSON-safe, so
        // a raw substring match still needs no escaping.
        if (
          !transcript.includes(PM_COMPLETION_TOKEN_PREFIX + row.completionToken)
        ) {
          continue;
        }
        // A token hit is necessary but NOT sufficient (#2074).
        if (!finalizingSessionMayComplete(row, ctx)) continue;

        pmRoster.setStatus({
          completionToken: row.completionToken,
          status: "complete",
        });
      }
    } catch (error) {
      // Fail-open (defense-in-depth; runFinalizeSteps also guards each step).
      errorLogger?.error("pmReconcileStep failed (degraded)", {
        category: "spawn-roster",
        sessionId: ctx.hapiSessionId,
        context: {
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
    // Pure side-effecting step — contributes NO finalize-column enrichment.
    return {};
  };
}

/**
 * Whether the just-finalized session is allowed to complete `row` (#2074).
 *
 * A token hit alone does NOT prove the finalizing session is the peer that
 * earned the token: a spawning PM that echoed a peer's token into its OWN status
 * output produces a hit on the PM's finalize while the peer is still working.
 *
 * When the row carries its peer's id — the same-node case, where the PM's
 * node-blind enrichment PATCH lands on the shared node — that id must match the
 * finalizing session. When the row carries NO peer id — the cross-node case,
 * where the peer's node-B row never received the node-blind PATCH — the
 * token-only match stands: the false-match cannot occur there (a hub-side PM
 * finalize never sees the peer's node-B row), and gating on a never-populated id
 * would strand every cross-node row `spawned` forever.
 *
 * `hapi_session_id` is the load-bearing key — it shares the UUID space with
 * `ctx.hapiSessionId`. (`pm_session_id` does NOT: it holds a session TAG, so a
 * guard keyed on it would compile, typecheck, and be silently inert.)
 */
function finalizingSessionMayComplete(
  row: PmSpawnRosterRecord,
  ctx: FinalizeStepContext
): boolean {
  // An id-less row is the cross-node case — nothing to match against, so the
  // pre-#2074 token-only behavior stands.
  if (!row.hapiSessionId && !row.ccSessionId) return true;
  return (
    (row.hapiSessionId != null && row.hapiSessionId === ctx.hapiSessionId) ||
    (row.ccSessionId != null && row.ccSessionId === ctx.event.ccSessionId)
  );
}

/**
 * Read the just-finalized session's transcript as raw text (mirrors V1's
 * `grep -F` over the whole file — the closer's token may be emitted in any turn).
 * Trusts the finalize event's `transcriptPath`, which the CLI turn reporter
 * already resolved against the correct (account-isolation-aware) config dir at
 * turn-open. Returns `null` on a missing path or read failure (fail-open).
 */
function readTranscriptText(ctx: FinalizeStepContext): string | null {
  const main = ctx.event.transcriptPath;
  if (!main) return null;
  try {
    return readFileSync(main, "utf-8");
  } catch {
    return null;
  }
}
