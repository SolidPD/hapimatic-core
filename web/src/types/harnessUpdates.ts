// SPDX-License-Identifier: AGPL-3.0-only
import type {
  RedactedHarnessDescriptor,
  HarnessDetectionState,
  ImpactArtifact,
} from "@hapi/protocol";

/**
 * Web view types for the harness self-update admin panel (issue #1773, Sub-Issue D
 * of epic #1769 "Claude Code self-update from the admin drawer").
 *
 * ── Contract ownership (the "Mode 2" build — all three backends have merged) ──
 * The panel's DATA leaf types are owned by the sibling sub-issues and imported RAW
 * from `@hapi/protocol` — this file declares NO parallel copy of them:
 *   - #1770 owns the descriptor/detection-state (`shared/src/harness.ts`):
 *     `RedactedHarnessDescriptor`, `HarnessDetectionState`.
 *   - #1771 owns the changelog span (`shared/src/harnessChangelog.ts`): `ChangelogSpan`.
 *   - #1772 owns the analysis artifact (`shared/src/selfUpdateImpact.ts`): `ImpactArtifact`,
 *     `ImpactItem`, `Headline`, `ImpactedIssue`, `VerdictColor`.
 *
 * What this file DOES own is the three server-side RESPONSE ENVELOPES, which live in
 * server files (`HarnessStatusResponse` in `harnessPollService.ts`,
 * `AnalysisStatusEnvelope` in `impactService.ts`) and therefore cannot be imported by
 * the browser bundle (`@hapi/protocol` is shared-only; server is not). We mirror those
 * envelope shapes here, composing the shared leaf types above.
 *
 * ── Wire convention (locked epic contract) ──
 * snake_case on the wire, epoch-ms number timestamps, NO camelizing mapper anywhere —
 * the artifact + state reach the panel raw. Verified against the merged routes
 * (`server/src/web/routes/harness{,Changelog,Analysis}.ts`).
 */

// Re-export the shared leaf types the panel's components consume, so a component
// has ONE import site (`@/types/harnessUpdates`) rather than reaching into
// `@hapi/protocol` and this file separately.
export type {
  RedactedHarnessDescriptor,
  HarnessDetectionState,
  ChangelogSpan,
  ChangelogVersionEntry,
  ImpactArtifact,
  ImpactItem,
  Headline,
  ImpactedIssue,
  VerdictColor,
} from "@hapi/protocol";

/**
 * `GET /api/harness/status` (#1770) — one entry per registry descriptor, each pairing
 * the REDACTED descriptor (no privileged commands) with its persisted detection state
 * (or null before the first poll). Mirror of the server's `HarnessStatusResponse`
 * (`server/src/harness/harnessPollService.ts`). `POST /api/harness/check` returns the
 * same shape.
 */
export type HarnessStatusResponse = {
  node_id: string;
  harnesses: Array<{
    descriptor: RedactedHarnessDescriptor;
    state: HarnessDetectionState | null;
  }>;
};

/**
 * `GET /api/harness/:harnessId/analysis?range=<from>..<to>` (#1772) — the discriminated
 * status envelope. Mirror of the server's `AnalysisStatusEnvelope`
 * (`server/src/selfUpdate/impactService.ts`). The panel switches on `status`; the
 * `ready` case carries the artifact plus `companion_session_id` (backs "Ask Claude
 * about this" after a reload) and `analyzed_at`.
 */
export type HarnessAnalysisResponse =
  | { status: "none" }
  | { status: "analyzing" }
  | {
      status: "ready";
      artifact: ImpactArtifact;
      companion_session_id: string | null;
      analyzed_at: number;
    }
  | { status: "failed" }
  | { status: "at_capacity" };

/**
 * `POST /api/harness/:harnessId/analyze` (#1772) — the trigger outcome. A duplicate
 * in-flight trigger returns the EXISTING `session_id` under `status: "analyzing"`
 * (the orchestrator's guard), never a second spawn.
 */
export type TriggerAnalysisResponse =
  | { status: "analyzing"; session_id?: string }
  | { status: "at_capacity" }
  | { status: "failed" };

/**
 * `POST /api/harness/:harnessId/update` + `POST /api/harness/:harnessId/rollback`
 * (#1774, Sub-Issue E) — the SUCCESS envelope. The privileged command is NEVER
 * echoed to the client (R11). On failure `ApiClient.request` throws `ApiError`
 * carrying the server's `{ code, error }` (`update_in_flight` / `version_mismatch`
 * / `no_prior_version` / `binary_not_found` / `exec_failed` / `not_supported_remote`).
 * Mirror of the server success response in `server/src/web/routes/harnessUpdate.ts`.
 */
export type HarnessApplyResponse = { ok: true; new_version: string | null };

/**
 * Poll-cadence config surfaced by `GET`/`PUT /api/harness/poll-config` (#1775,
 * Sub-Issue F). Mirror of the server's `HarnessPollConfig`
 * (`server/src/config/harnessPollConfig.ts`). Co-located here (the canonical
 * harness-web-types home) rather than a separate file, per #1775's directive.
 */
export type HarnessPollConfig = {
  enabled: boolean;
  pollIntervalMs: number;
};

/** `GET`/`PUT /api/harness/poll-config` response envelope (#1775). */
export type HarnessPollConfigResponse = { config: HarnessPollConfig };

/**
 * `POST /api/harness/check` (#1775 "Check now") — the refreshed status plus a
 * `coalesced` flag: true when the manual check joined an already-in-flight
 * detection (the service's inFlight guard) instead of running a fresh one, so the
 * panel can surface "a check is already running" rather than implying a fresh
 * result with an unchanged last-checked timestamp (R4).
 */
export type HarnessCheckResponse = HarnessStatusResponse & {
  coalesced: boolean;
};

/**
 * The "unavailable" sentinel a query hook resolves to when the whole `/api/harness`
 * namespace is unreachable (404 before the backend mounts, 503 while the poll service
 * is booting). Distinct from a genuine fetch error, so the panel renders a graceful
 * "not available" state rather than an indefinite spinner or an error banner (R8).
 * Now that #1770–#1772 have merged this is a boot-window / misconfiguration guard, not
 * the steady state — but it is retained per the Fallback Preservation Rule.
 */
export const HARNESS_UNAVAILABLE = "unavailable" as const;
export type HarnessUnavailable = typeof HARNESS_UNAVAILABLE;
