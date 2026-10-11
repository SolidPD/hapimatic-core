// SPDX-License-Identifier: AGPL-3.0-only
/**
 * USER-APPROVAL token-gate config (issue #3331, epic #3329 Sub B — R7).
 *
 * `server/src/services/` reads ZERO `process.env` by convention (the token
 * service stays pure so it is trivially unit-testable and never touches the
 * ambient environment), so the permission-allowlist feature flag is read HERE at
 * boot and INJECTED into `verifyToken`. Mirrors the sibling per-feature config
 * modules (`approvalHygieneConfig.ts`, `maxConcurrency.ts`).
 *
 *   HAPI_APPROVAL_ALLOWLIST   when truthy (`1`/`true`/`yes`/`on`), the permission
 *                             allowlist is ENFORCED — only actions on the
 *                             allowlist may mint a grant. Default OFF (R7): the
 *                             allowlist code path EXISTS but is inert (every
 *                             action resolves to "allow"), so a later enablement
 *                             needs no second PR.
 *
 *   APPROVAL_STATE_DIR        the machine-global `~/.claude/state` BASE dir
 *                             (#3538) — where bypass-scope challenges/grants live.
 *                             Read HERE (env) and injected into `verifyToken`,
 *                             with a `homedir()`-based fallback. `$APPROVAL_STATE_DIR`
 *                             parity with every rp1-home producer/consumer.
 */
import { homedir } from "node:os";
import { join } from "node:path";

export interface ApprovalTokensConfig {
  /** True iff the permission allowlist is enforced (R7 — default false). */
  allowlistEnabled: boolean;
  /**
   * The machine-global `~/.claude/state` BASE dir (#3538) — bypass-scope
   * challenge (`<base>/approval-challenges/`) + grant (`<base>/approval-grants/`)
   * resolution for hosted-session token replies. Resolved at boot from
   * `$APPROVAL_STATE_DIR` (the ONE field #3559's acceptance-ledger read reuses)
   * with a `homedir()`-based fallback, then INJECTED into `verifyToken` — the
   * service reads no env / homedir (R5). OPTIONAL so an inline test config
   * (`{ allowlistEnabled: false }`) still type-checks.
   */
  globalStateDir?: string;
}

/** Read the token-gate config from the environment once (call at boot). */
export function loadApprovalTokensConfig(): ApprovalTokensConfig {
  const raw = process.env.HAPI_APPROVAL_ALLOWLIST?.trim().toLowerCase();
  const allowlistEnabled =
    raw === "1" || raw === "true" || raw === "yes" || raw === "on";
  // $APPROVAL_STATE_DIR parity with rp1-home's `_state_base()`; homedir fallback.
  const globalStateDir =
    process.env.APPROVAL_STATE_DIR?.trim() ||
    join(homedir(), ".claude", "state");
  return { allowlistEnabled, globalStateDir };
}
