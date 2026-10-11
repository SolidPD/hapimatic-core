// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Shared lint-rule contract for the Graph Engineering linter — issue #2884
 * (Graph Engineering Phase 1, sub-issue B). This is the single interface that
 * BOTH this issue's `INCIDENT_DERIVED` rules AND #2885's `SEMANTIC_INVARIANT`
 * rules implement, and that the #2885 linter engine consumes.
 *
 * Ownership (coordination finding CF-1, epic #2881): `LintRule` / `LintFinding`
 * are OWNED HERE — sub-issue B lands first in dependency order, so #2885 IMPORTS
 * these symbols rather than re-declaring them. Editing the shape here edits it
 * for #2885 by construction (there is exactly one definition — no verbatim copy
 * to keep in sync).
 *
 * 🔒 `LintFinding` is a PINNED public contract (expert review 2026-08-15, finding
 * 2884-1): its readers are #2885 (engine dedup key), #2886 (compiler findings),
 * and #2887 (viz / seeded-rule assertion). Each field below carries a
 * `// consumer:` annotation — the "no field without a consumer" discipline
 * inherited from #2883's `ir.ts`. There is deliberately NO `severity` field: the
 * #2886 compile gate is `!ok` (a finding either exists or it does not), and
 * adding severity later is an additive contract change, not a v0.1 concern.
 */
import { z } from "zod";
import type { GraphIR } from "../ir";

// ── Provenance class ─────────────────────────────────────────────────────────
/**
 * How a rule's invariant was derived.
 * - `INCIDENT_DERIVED` — grounded in a real incident from the failure/guard
 *   corpus (this issue's rules; provenance is mandatory).
 * - `SEMANTIC_INVARIANT` — derived from the execution-semantics charter (#2885).
 */
export const ProvenanceClassSchema = z.enum([
  "INCIDENT_DERIVED",
  "SEMANTIC_INVARIANT",
]);
export type ProvenanceClass = z.infer<typeof ProvenanceClassSchema>;

// ── Enforcement layer ────────────────────────────────────────────────────────
/**
 * The layer at which an invariant is enforced. A single canonical invariant may
 * be enforced at MORE THAN ONE layer (synthesis III.1 — "one meaning, multiple
 * enforcement layers"): e.g. `INV-no-concurrent-exclusive-writes` is enforced
 * statically here (`lint`) and dynamically by `fleetLock.ts` at runtime
 * (`server-gate`). See `LintFinding.layers`.
 */
export const EnforcementLayerSchema = z.enum([
  "lint",
  "client-hook",
  "server-gate",
]);
export type EnforcementLayer = z.infer<typeof EnforcementLayerSchema>;

// ── LintFinding (🔒 PINNED public contract — do not add/remove/rename fields) ─
/**
 * A single linter finding. One finding == one violation of one invariant at one
 * graph location. The linter engine (#2885) dedups findings on
 * `(invariant_id, where)`, so a finding must name BOTH its invariant and its
 * location precisely.
 */
export const LintFindingSchema = z.object({
  rule_id: z.string(), // consumer: #2887 seeded-rule assertion (which rule fired)
  invariant_id: z.string(), // consumer: #2885 engine dedup key (invariant_id, where)
  provenance_class: ProvenanceClassSchema, // consumer: #2885 engine grouping; #2887 legend
  layers: z.array(EnforcementLayerSchema), // consumer: "report the invariant once, list the layers" (synthesis III.1)
  where: z.string(), // consumer: #2885 dedup key + #2887 highlight — node id(s), comma-joined for pair findings
  message: z.string(), // consumer: #2887 human-readable surface
});
export type LintFinding = z.infer<typeof LintFindingSchema>;

// ── LintRule ─────────────────────────────────────────────────────────────────
/**
 * A lint rule the engine (#2885) runs against a `GraphIR`. Modeled as an
 * `interface` (not a Zod schema) because `predicate` is a FUNCTION member — a
 * Zod schema cannot usefully validate a closure, and the engine consumes rules
 * as code, never deserializes them.
 *
 * Provenance discipline (R2/R3): an `INCIDENT_DERIVED` rule MUST cite its
 * `trigger_incident`; a rule with no cited incident is mis-classified and belongs
 * in #2885's `SEMANTIC_INVARIANT` set instead.
 */
export interface LintRule {
  /** Stable rule identifier (kebab-case), e.g. `"git-object-db-write-conflict"`. */
  id: string;
  /** How this rule's invariant was derived (this issue's rules are all INCIDENT_DERIVED). */
  provenance_class: ProvenanceClass;
  /**
   * The originating incident — REQUIRED for `INCIDENT_DERIVED` rules (optional on
   * the interface only so `SEMANTIC_INVARIANT` rules, authored by #2885, may omit it).
   */
  trigger_incident?: string;
  /** The failure mechanism the incident exposed (the "why it corrupts state"). */
  mechanism: string;
  /**
   * The canonical semantic invariant this rule enforces. Multiple rules / layers
   * may share one `invariant_id` — that is the point of the invariant framework
   * (one meaning, many enforcement points).
   */
  invariant_id: string;
  /** The layer this RULE runs at. `INCIDENT_DERIVED` lint rules are always `"lint"`. */
  enforcement_layer: EnforcementLayer;
  /** Pure predicate over the static graph — returns one `LintFinding` per violation. */
  predicate: (graph: GraphIR) => LintFinding[];
}
