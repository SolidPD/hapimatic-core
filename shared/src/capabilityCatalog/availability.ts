// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Session-aware availability evaluator (issue #3749, Sub-Issue I / R1, R1a, R1b,
 * R2b). The PURE half: given a declarative `availability` predicate (#3741) and a
 * per-session `AvailabilityContext`, decide whether a capability is visible to
 * the caller's scope and available for the session's mode.
 *
 * `shared/` is the zod-only, browser-safe contract layer — this module imports
 * ONLY from within `shared/src` and reads no `node:fs` / `process.env` (R1). The
 * SERVER builds the context (`server/src/capabilities/availabilityContext.ts`);
 * the web only CONSUMES the resulting `{available, reason}` annotation and never
 * evaluates (#3752 KD-3 / R1). D (#3744) owns `mountedWhen` — this evaluator has
 * NO `mountedWhen` branch by design (R1b / KD-5).
 *
 * Predicate/context key pairing (R1a — reconciled verbatim with #3741's landed
 * `Availability`): `nodeCapability` (SINGULAR predicate) is tested for membership
 * in `nodeCapabilities` (PLURAL context set); `minVersion` (predicate) is
 * compared against `nodeVersion` (context) — two halves of a predicate/context
 * pair, never two spellings of one field.
 */
import type { Availability } from "./types";

/**
 * The six session axes the SERVER derives per request and this evaluator reads.
 * `scope` is REQUIRED and fail-closed to `"user"` at the derivation site — an
 * operator verdict demands a positive host proof AND a caller-identity match
 * (R2a). Every OTHER axis is optional: an absent axis imposes NO constraint (so
 * the neutral context yields the full eligible set — the "subset" invariant of
 * R4a). `nodeCapabilitiesDetectedAt` is the KD-3 staleness marker surfaced on the
 * annotation; it is NOT part of the evaluation.
 */
export interface AvailabilityContext {
  /** Matches predicate `launcherKind`. Frozen `metadata.launcherKind` (R2). */
  readonly launcherKind?: string;
  /** Matches predicate `agentId`. `metadata.flavor ?? "claude"` (R2). */
  readonly agentId?: string;
  /** The node's capability SET; predicate `nodeCapability` tests membership. */
  readonly nodeCapabilities?: readonly string[];
  /** Whether the session is bound to an Anthropic account (R2). */
  readonly accountBound?: boolean;
  /** REQUIRED. Fail-closed to `"user"` unless the caller proves operator (R2a). */
  readonly scope: "operator" | "user";
  /** The node's version; predicate `minVersion` compares against this (R5). */
  readonly nodeVersion?: string;
  /** KD-3: when the node-capability set was detected (staleness marker). */
  readonly nodeCapabilitiesDetectedAt?: string;
}

/** The evaluator's verdict for one entry. `reason` is a human "why not". */
export interface AvailabilityResult {
  readonly available: boolean;
  readonly reason?: string;
}

/**
 * The HARD-FILTER decision (KD-1 / KD-1a): is this entry visible to the caller's
 * scope AT ALL? Callers that must OMIT out-of-scope entries (the catalog route,
 * the federation receiver, Tier-0) use this to decide absence — distinct from
 * `evaluateAvailability`, whose `{available:false}` means "listed, but not
 * usable right now" (within-scope mode-dependence).
 *
 * - `scope` absent (a runtime-loaded entry that bypassed #3741's parse — R2b): NOT
 *   visible to anyone. Read defensively because the field is TYPED required but
 *   can be runtime-missing.
 * - `scope: "user"`: visible to every caller.
 * - `scope: "operator"`: visible ONLY to an operator caller (operator ⊇ user).
 */
export function isVisibleToScope(
  predicate: Availability | undefined,
  context: AvailabilityContext
): boolean {
  const scope = predicate?.scope;
  // Fail closed on an absent / unexpected scope (R2b). Typed as the enum, but a
  // runtime extension entry can arrive with it missing, so guard at runtime.
  if (scope !== "user" && scope !== "operator") return false;
  if (scope === "user") return true;
  return context.scope === "operator";
}

/**
 * Compare two dotted numeric version strings. Returns <0 / 0 / >0 for a<b / a=b /
 * a>b. Non-numeric or absent segments compare as 0, so `"1.0.1208"` vs `"1.0"`
 * treats the missing patch as 0. Pure, dependency-free.
 */
function compareVersions(a: string, b: string): number {
  const as = a.split(".");
  const bs = b.split(".");
  const len = Math.max(as.length, bs.length);
  for (let i = 0; i < len; i++) {
    const an = Number.parseInt(as[i] ?? "0", 10) || 0;
    const bn = Number.parseInt(bs[i] ?? "0", 10) || 0;
    if (an !== bn) return an < bn ? -1 : 1;
  }
  return 0;
}

/**
 * Evaluate one predicate against a session context → `{available, reason}`. One
 * branch per SESSION axis, scope first. A predicate axis with no context value
 * imposes NO constraint (a partial/neutral context never excludes on that axis —
 * the R4a subset invariant). `mountedWhen` is NOT evaluated here (R1b — D owns it).
 */
export function evaluateAvailability(
  predicate: Availability | undefined,
  context: AvailabilityContext
): AvailabilityResult {
  // Scope (security). Out-of-scope is surfaced here for the truth table (V1); the
  // catalog/Tier-0 callers OMIT such entries via isVisibleToScope before ever
  // reaching an annotation, so this branch is the belt to that suspenders (R2b).
  if (!isVisibleToScope(predicate, context)) {
    const declared = predicate?.scope;
    return {
      available: false,
      reason:
        declared === "operator"
          ? "requires operator scope"
          : "not user-visible (no scope declared)",
    };
  }

  // Mode-dependence axes (within scope). `predicate.X && context.X && mismatch`:
  // an absent context axis never fails the entry (subset invariant).
  if (
    predicate?.launcherKind &&
    context.launcherKind &&
    predicate.launcherKind !== context.launcherKind
  ) {
    return {
      available: false,
      reason: `requires the ${predicate.launcherKind} launcher (session is ${context.launcherKind})`,
    };
  }

  if (
    predicate?.agentId &&
    context.agentId &&
    predicate.agentId !== context.agentId
  ) {
    return {
      available: false,
      reason: `requires the ${predicate.agentId} agent (session is ${context.agentId})`,
    };
  }

  if (
    predicate?.nodeCapability &&
    context.nodeCapabilities &&
    !context.nodeCapabilities.includes(predicate.nodeCapability)
  ) {
    return {
      available: false,
      reason: `requires node capability ${predicate.nodeCapability}`,
    };
  }

  if (predicate?.accountBound === true && context.accountBound === false) {
    return { available: false, reason: "requires a bound account" };
  }

  if (
    predicate?.minVersion &&
    context.nodeVersion &&
    compareVersions(context.nodeVersion, predicate.minVersion) < 0
  ) {
    return {
      available: false,
      reason: `requires version ${predicate.minVersion} (node is ${context.nodeVersion})`,
    };
  }

  return { available: true };
}
