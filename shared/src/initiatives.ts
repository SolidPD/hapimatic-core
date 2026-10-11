// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

// Skill-revamp 3.1 (#2156, epic rp1-home#1319) — the first-class INITIATIVE
// object: scope ref + session roster + token budget + current phase + an
// append-only event log. It is a CACHE over GitHub label truth
// (reconcile-on-read; GitHub wins on every conflict), never authoritative.
//
// Store lives in `server/src/store/initiativeStore.ts` over the
// `initiatives` / `initiative_roster` / `initiative_events` tables; the route
// factory in `server/src/web/routes/initiatives.ts`.
//
// Every object schema is `.passthrough()` per the shared/CLAUDE.md forked-
// upstream rule. API shapes are camelCase views of the snake_case DB columns;
// timestamps are epoch-ms numbers throughout (parity with fileClaims.ts and the
// pm_spawn_roster precedent).

/**
 * Coarse initiative-level lifecycle. This is NOT the workflow-checkpoint
 * vocabulary the PM's state machine speaks
 * (new → formatted → researched → [expert-reviewed] → worked → tested →
 * refactor-reflected → closed, rp1-home `.claude/ISSUE_WORKFLOW_SKILLS.md`); it
 * is a coarser PM-facing rollup inferred from it, not taken from a spec.
 * Alignment with #2157's queue design is REQUIRED before either merges.
 */
export const InitiativePhaseSchema = z.enum([
  "planning",
  "researching",
  "implementing",
  "reviewing",
  "closing",
  "done",
]);
export type InitiativePhase = z.infer<typeof InitiativePhaseSchema>;

/**
 * The append-only event kinds. EXPORTED AS A TUPLE, not just as the enum:
 * #2157's `pmEvents.ts` builds its superset enum from it —
 * `z.enum([...INITIATIVE_EVENT_KINDS, ...pmKinds])` ("extend, not fork", epic
 * #1319 O1). `session_handoff` is in the base union from day one (#2158's
 * finalize pipeline produces it during roster handover).
 *
 * What is FROZEN is the SEMANTICS of each existing kind (its name + payload
 * shape) — appending new kinds is the designed extension path; renaming or
 * repurposing an existing kind is the breaking change #2157/#2158 must not make.
 */
export const INITIATIVE_EVENT_KINDS = [
  "initiative_created",
  "session_attached",
  "session_detached",
  "phase_changed",
  "budget_updated",
  "reconciled",
  "session_handoff",
] as const;
export const InitiativeEventKindSchema = z.enum(INITIATIVE_EVENT_KINDS);
export type InitiativeEventKind = z.infer<typeof InitiativeEventKindSchema>;

/**
 * One append-only event (camelCase view of an `initiative_events` row). There is
 * deliberately NO `updatedAt` field — an event is immutable once recorded (R4).
 */
export const InitiativeEventSchema = z
  .object({
    id: z.string(),
    initiativeId: z.string(),
    kind: InitiativeEventKindSchema,
    payload: z.record(z.string(), z.unknown()).optional(),
    createdAtMs: z.number(), // epoch ms
  })
  .passthrough();
export type InitiativeEvent = z.infer<typeof InitiativeEventSchema>;

/** One roster membership (camelCase view of an `initiative_roster` row). */
export const InitiativeRosterEntrySchema = z
  .object({
    sessionId: z.string(),
    attachedAtMs: z.number(),
    detachedAtMs: z.number().nullable(),
  })
  .passthrough();
export type InitiativeRosterEntry = z.infer<typeof InitiativeRosterEntrySchema>;

/**
 * `scopeRef` — a scheme-prefixed reference to the GitHub work scope this
 * initiative caches (D1, rp1-home#1358 expert review — Matt, 2026-07-16). One of:
 *   `epic:owner/repo#N` | `milestone:owner/repo#N` | `project:owner/n`
 * Opaque beyond the scheme: switch on the prefix, never URL-parse the rest.
 * `epic:` is the only producer today; `milestone:` / `project:` arrive with
 * rp1-home#1358's Milestone / Projects-V2 PM scopes.
 */
export const ScopeRefSchema = z
  .string()
  .regex(/^(epic|milestone|project):\S+$/);
export type ScopeRef = z.infer<typeof ScopeRefSchema>;

/** The initiative entity (camelCase view of `initiatives` + its roster). */
export const InitiativeSchema = z
  .object({
    id: z.string(),
    scopeRef: ScopeRefSchema,
    phase: InitiativePhaseSchema,
    tokenBudget: z.number().nullable(),
    tokensSpent: z.number().default(0),
    roster: z.array(InitiativeRosterEntrySchema),
    createdAtMs: z.number(),
    // Nullable to match the nullable `updated_at_ms` DDL (pm_spawn_roster precedent).
    updatedAtMs: z.number().nullable(),
    reconciledAtMs: z.number().nullable(),
  })
  .passthrough();
export type Initiative = z.infer<typeof InitiativeSchema>;

/**
 * POST /initiatives — create. Roster and events are NEVER client-supplied at
 * create; the store mints the id and appends the `initiative_created` event.
 */
export const CreateInitiativeRequestSchema = z
  .object({
    scopeRef: ScopeRefSchema,
    phase: InitiativePhaseSchema.optional(), // defaults to "planning" at the store
    tokenBudget: z.number().nullable().optional(),
    tokensSpent: z.number().optional(),
  })
  .passthrough();
export type CreateInitiativeRequest = z.infer<
  typeof CreateInitiativeRequestSchema
>;

/**
 * PATCH /initiatives/:id — phase and/or budget ONLY. Events are never mutated
 * here (R4): the route maps these fields onto `setPhase` / `setBudget`, each of
 * which appends its own event.
 */
export const UpdateInitiativeRequestSchema = z
  .object({
    phase: InitiativePhaseSchema.optional(),
    tokenBudget: z.number().nullable().optional(),
    tokensSpent: z.number().optional(),
  })
  .passthrough()
  .refine(
    v =>
      v.phase !== undefined ||
      v.tokenBudget !== undefined ||
      v.tokensSpent !== undefined,
    { message: "at least one of phase, tokenBudget, tokensSpent is required" }
  );
export type UpdateInitiativeRequest = z.infer<
  typeof UpdateInitiativeRequestSchema
>;

/** POST /initiatives/:id/sessions — attach a session to the roster. */
export const AttachSessionRequestSchema = z
  .object({ sessionId: z.string().min(1) })
  .passthrough();
export type AttachSessionRequest = z.infer<typeof AttachSessionRequestSchema>;

/**
 * DETACH — modeled as a path param on DELETE /initiatives/:id/sessions/:sessionId.
 * The body schema exists for symmetry / potential future body-based callers.
 */
export const DetachSessionRequestSchema = z
  .object({ sessionId: z.string().min(1) })
  .passthrough();
export type DetachSessionRequest = z.infer<typeof DetachSessionRequestSchema>;

/** GET /initiatives — list filter (query string). */
export const InitiativeQuerySchema = z
  .object({
    scopeRef: z.string().min(1).optional(),
    phase: InitiativePhaseSchema.optional(),
    // Freshness bound for staleness — omitted ⇒ no staleness computed.
    staleAfterMs: z.coerce.number().optional(),
  })
  .passthrough();
export type InitiativeQuery = z.infer<typeof InitiativeQuerySchema>;

/**
 * GET /initiatives/:id — the one-call read (R3). roster + budget + phase live on
 * `initiative`; `events` is the N most recent; `stale` is `null` when the caller
 * omits `staleAfterMs` (no staleness computed — the field is `.nullable()`).
 */
export const InitiativeReadResponseSchema = z
  .object({
    initiative: InitiativeSchema,
    events: z.array(InitiativeEventSchema),
    stale: z.boolean().nullable(),
  })
  .passthrough();
export type InitiativeReadResponse = z.infer<
  typeof InitiativeReadResponseSchema
>;
