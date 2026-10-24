// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Configuration Porter — tokenized one-liner export contract (issue #3446,
 * epic #3445 Sub A). The LOCKED contract (K1) that the whole epic single-sources
 * here: B (#3447 — OS tabs + PowerShell), C (#3448 — per-source review), and
 * D (#3449 — Claude-Code paste path) all consume these shapes, so they live in
 * `shared/` (`@hapi/protocol/porter`) rather than in `server/` or `web/`.
 *
 * PLACEMENT — these are pure TYPE contracts (no runtime, no `node:*`), genuinely
 * shared across server (mint/status route responses) and web (client + UI), so
 * `shared/` is the only placement that avoids a server↔web mirror drift.
 */

/**
 * The page-visible lifecycle of a porter token, surfaced by the status endpoint
 * (K4). `waiting` = minted, not yet uploaded; `received` = the source machine
 * uploaded its archive and a plan was staged; `expired` = past the TTL before an
 * upload landed. `received` is terminal-happy: once the upload is consumed a
 * later status read stays `received` even past the token TTL (the staged plan has
 * its own 30-min staging TTL, independent of the token).
 */
export type PorterTokenState = "waiting" | "received" | "expired";

/**
 * K1 — the mint response. Returned by `POST /api/porter/token`.
 *
 * - `token` — base64url (`randomBytes(24)`), so its alphabet never contains `.`
 *   and the `.ps1` suffix split in `GET /p/:token` is unambiguous (D1).
 * - `fetchUrl` — `<origin>/p/<token>`; the copyable `curl -fsSL <fetchUrl> | bash`
 *   one-liner is built from this. Re-fetchable ≤ 5 times within the TTL (K3).
 * - `uploadUrl` — `<origin>/p/<token>/archive`; the served script self-uploads
 *   here. Single-use (K3).
 * - `fetchUrlPowerShell` — the `.ps1` variant of `fetchUrl`. A (#3446) leaves it
 *   UNDEFINED and ships only the bash variant + the selection seam; B (#3447)
 *   fills this slot and the PowerShell branch of `GET /p/:token` (K2).
 */
export interface PorterTokenResponse {
  token: string;
  /** Epoch ms at which the token's fetch leg expires (~15 min after mint). */
  expiresAt: number;
  fetchUrl: string;
  uploadUrl: string;
  fetchUrlPowerShell?: string;
}

/**
 * K4 — the status response. Returned by `GET /api/porter/token/:token/status`.
 * The plan summary flows to the browser HERE (not over the `curl` channel), so
 * the page reads `plan` from this endpoint to hydrate the import review UI.
 *
 * Generic over the plan-summary payload because that type differs by package:
 * the server responds with `ImportPlanSummary` (server-only,
 * `porter/importArchive.ts`); the web narrows to its field-for-field mirror
 * (`web/src/types/porter.ts`). `shared/` cannot reference either, so the plan
 * payload is a type parameter (defaults to `unknown`).
 */
export interface PorterTokenStatus<Plan = unknown> {
  state: PorterTokenState;
  /** Epoch ms fetch-leg expiry — the page renders a TTL countdown from this. */
  expiresAt: number;
  /** How many times the fetch leg has been served (0–5); page-visible over-fetch signal. */
  fetchCount: number;
  /** Present once `state === "received"`: the staged import plan for review. */
  plan?: Plan;
  /**
   * #5202 (U14): present instead of `plan` when the archive was staged but its
   * review could not be built. The detail is in the server log only.
   */
  planError?: string;
}
