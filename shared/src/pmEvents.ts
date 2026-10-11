// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

import { INITIATIVE_EVENT_KINDS } from "./initiatives";

// Skill-revamp 3.2 (#2157, epic rp1-home#1319) — the EVENT-DRIVEN PM contract:
// the webhook-payload subset the receiver consumes, the superset event-kind
// taxonomy that rides #2156's ONE append-only log, and the queue-drain
// request/response the PM tick reads in a single call.
//
// Every object schema is `.passthrough()` per the shared/CLAUDE.md forked-
// upstream rule — GitHub adds payload fields constantly and a webhook must not
// 400 because a new field appeared. Timestamps are epoch-ms numbers throughout
// (parity with initiatives.ts / fileClaims.ts).

// ── GitHub webhook payload subset ────────────────────────────────────
//
// Deliberately NARROW: only the fields the receiver actually reads. Parse
// permissively and ignore everything else. Do NOT model GitHub's full payload —
// `.passthrough()` keeps the unknown remainder without validating it, and every
// consumed sub-object is `.optional()` so a `ping` (or any event we don't map)
// parses cleanly and is answered `202 ignored` rather than `400`.

const WebhookRepositorySchema = z
  .object({ full_name: z.string() })
  .passthrough();

const WebhookLabelSchema = z.object({ name: z.string() }).passthrough();

const WebhookIssueSchema = z
  .object({
    number: z.number(),
    labels: z.array(WebhookLabelSchema).optional(),
  })
  .passthrough();

const WebhookPullRequestSchema = z
  .object({
    number: z.number(),
    merged: z.boolean().optional(),
  })
  .passthrough();

const WebhookSenderSchema = z.object({ login: z.string() }).passthrough();

/**
 * The narrow subset of a GitHub `issues` / `pull_request` webhook payload the
 * receiver consumes. `action` + every nested object is optional so a webhook
 * `ping` (no `action`, no `issue`) still parses — the handler maps
 * `x-github-event` + `action` and answers `202 ignored` for anything unmapped.
 */
export const GitHubWebhookEventSchema = z
  .object({
    action: z.string().optional(),
    repository: WebhookRepositorySchema.optional(),
    issue: WebhookIssueSchema.optional(),
    label: WebhookLabelSchema.optional(),
    pull_request: WebhookPullRequestSchema.optional(),
    sender: WebhookSenderSchema.optional(),
  })
  .passthrough();
export type GitHubWebhookEvent = z.infer<typeof GitHubWebhookEventSchema>;

// ── Queue event-kind taxonomy (superset — extend, not fork) ──────────
//
// One taxonomy riding ONE log (epic #1319 O1 ruling, expert-review D1-B). The
// nine push kinds this issue adds are composed ON TOP of #2156's exported base
// tuple — `z.enum([...INITIATIVE_EVENT_KINDS, ...PM_QUEUE_EXTRA_KINDS])`. #2156's
// store `appendEvent` accepts `kind: string` (house rule K1: the DB column is
// unconstrained; the canonical set is a TS union gated by zod at the API edge),
// so NO edit to `shared/src/initiatives.ts` or `server/src/store/types.ts` is
// needed. If #2156 ever lands without the `INITIATIVE_EVENT_KINDS` export this
// file fails compile-loud at the import above — the intended failure mode, not a
// silent fork.

/** The nine event kinds #2157 adds: GitHub webhook events + peer-session events. */
export const PM_QUEUE_EXTRA_KINDS = [
  "github_issue_labeled",
  "github_issue_unlabeled",
  "github_issue_closed",
  "github_pr_opened",
  "github_pr_merged",
  "session_spawned",
  "session_idle",
  "session_completed",
  "session_errored",
] as const;
export type PmQueueExtraKind = (typeof PM_QUEUE_EXTRA_KINDS)[number];

/** The full queue taxonomy: #2156's base kinds ∪ this issue's nine push kinds. */
export const PmQueueEventKindSchema = z.enum([
  ...INITIATIVE_EVENT_KINDS,
  ...PM_QUEUE_EXTRA_KINDS,
]);
export type PmQueueEventKind = z.infer<typeof PmQueueEventKindSchema>;

/**
 * One drained event (camelCase view of an `initiative_events` row). Mirrors
 * #2156's `InitiativeEventSchema` but widens `kind` to the queue superset — the
 * drain returns rows whose kind may be a #2157 push kind. `.passthrough()` per
 * the forked-upstream rule.
 */
export const PmQueueEventSchema = z
  .object({
    id: z.string(),
    initiativeId: z.string(),
    kind: PmQueueEventKindSchema,
    payload: z.record(z.string(), z.unknown()).optional(),
    createdAtMs: z.number(),
  })
  .passthrough();
export type PmQueueEvent = z.infer<typeof PmQueueEventSchema>;

// ── Queue drain contract (the PM tick's ONE call) ────────────────────

/**
 * GET /api/initiatives/:id/drain query. `sinceEventId` is the client-held drain
 * cursor (a UUIDv7 event id); omitted ⇒ drain from the beginning. `limit`
 * defaults to 100, capped at 500.
 */
export const QueueDrainQuerySchema = z
  .object({
    sinceEventId: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
  })
  .passthrough();
export type QueueDrainQuery = z.infer<typeof QueueDrainQuerySchema>;

/**
 * Which ingestion path the queue currently trusts for freshness.
 * - `"push"` — webhooks are healthy; the queue is authoritative for freshness.
 * - `"poll-fallback"` — webhooks are broken (config-verified heartbeat stale);
 *   the reconcile poll is the trusted freshness path.
 *
 * 🔴 This is a FRESHNESS verdict, NEVER a gate verdict (R8). A gate decision
 * still reads the primary source — the queue accelerates verification, never
 * replaces it.
 */
export const QueueModeSchema = z.enum(["push", "poll-fallback"]);
export type QueueMode = z.infer<typeof QueueModeSchema>;

/**
 * The queue-health verdict returned alongside every drain — so the PM tick
 * learns "you are in poll-fallback mode" in the SAME call it drains (R5 + R6 in
 * one round-trip). `webhooksHealthy` is the config-verified heartbeat verdict;
 * `gapDetected` is `detectGap`'s output; `mode` is the trusted ingestion path.
 */
export const QueueHealthSchema = z
  .object({
    webhooksHealthy: z.boolean(),
    lastDeliveryAtMs: z.number().nullable(),
    gapDetected: z.boolean(),
    mode: QueueModeSchema,
  })
  .passthrough();
export type QueueHealth = z.infer<typeof QueueHealthSchema>;

/**
 * GET /api/initiatives/:id/drain response. R5's cheap no-op tick is
 * `events: []` PLUS a `queueHealth` verdict — the tick never has to poll or read
 * a transcript to learn it is caught up. `nextCursor` is the id to pass as
 * `sinceEventId` next time (unchanged from the request when the drain was empty).
 */
export const QueueDrainResponseSchema = z
  .object({
    events: z.array(PmQueueEventSchema),
    nextCursor: z.string().nullable(),
    queueHealth: QueueHealthSchema,
  })
  .passthrough();
export type QueueDrainResponse = z.infer<typeof QueueDrainResponseSchema>;
