// SPDX-License-Identifier: AGPL-3.0-only
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import type { CapabilityMeta } from "../../socket/handlers/cli/rpcHandlers";
import type { ErrorLogger } from "../../logging/errorLogger";
// Issue #3751 (Sub-Issue K): the CATALOG-side sibling gate `isEntryInvocable`
// reads the promotion allowlist and the #3749 availability evaluator. Workspace
// specifier only (`cataloged.ts` import-hygiene note — this file is typechecked by
// both typecheck:server AND typecheck:cli).
import type { CatalogEntry, AvailabilityContext } from "@hapi/protocol";
import { PROMOTED_ENTRY_IDS, evaluateAvailability } from "@hapi/protocol";

/**
 * Capability-invoke policy gate (issue #2419, epic #2416 Sub-Issue C —
 * TRUST-CRITICAL). This module is the ONLY security seam between the generic
 * `POST /api/sessions/:id/capabilities/:method` HTTP surface and the socket-RPC
 * dispatch substrate. A fail-open bug here exposes mutating/destructive RPC
 * methods to a generic HTTP invoke path — the explicit reason this sub-issue is
 * expert-review gated.
 *
 * The gate is a POSITIVE ALLOW, default-DENY (KD-1): invoke is permitted ONLY
 * when the method's registered `riskTier` is on the launch allowlist. Absent
 * meta, absent riskTier, unknown tier, and a registry miss ALL deny. Do NOT
 * rewrite `isInvocable` as `riskTier !== "readonly"` — that fails OPEN on an
 * unexpected tier value (OR-1).
 *
 * `runCapabilityInvoke` is the shared gate→validate→dispatch core: it runs
 * IDENTICALLY on the hub-local path (the request's session lives here) and the
 * owning-node federation receiver (KD-3 — the gate MUST run on the node that
 * actually holds the session; a peer's gate result is never trusted).
 */

// ── Launch allowlist ─────────────────────────────────────────────────────────
// Positive allow. Widening this is a FUTURE per-method issue requiring user
// approval (KD-5) — deliberately a code constant, NOT an env/config knob, so a
// promotion is always a reviewed edit here (the GATE_MODE audit-before-enforce
// shape from the design note).
export const INVOCABLE_TIERS: ReadonlySet<CapabilityMeta["riskTier"]> = new Set(
  ["readonly"]
);

/**
 * The fail-closed tier gate (R2, KD-1). Returns `true` ONLY when `meta` is
 * present AND its `riskTier` is on the launch allowlist. Written as a type guard
 * so a `true` result narrows `meta` to `CapabilityMeta` for the caller (the
 * input-validation step needs a non-null meta) — the compiler helps prove the
 * fail-closed ordering.
 */
export function isInvocable(
  meta: CapabilityMeta | null | undefined
): meta is CapabilityMeta {
  return meta != null && INVOCABLE_TIERS.has(meta.riskTier);
}

// ── Method-name hygiene (1B-16) ──────────────────────────────────────────────
// Validate the `:method` path param BEFORE any registry lookup so a hostile
// value cannot probe or craft a registry key. A malformed name definitionally
// cannot map to a registered readonly capability, so it is a fail-closed denial
// indistinguishable — by design, no existence oracle — from wrong-tier /
// registry-miss.
const METHOD_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export function isValidMethodName(method: string): boolean {
  return METHOD_NAME_PATTERN.test(method);
}

// ── Audit (R5, KD-4 — the observability floor) ───────────────────────────────
// The RPC path (`runCapabilityInvoke`) emits the first six outcomes. The generic
// REST invoker (#3751, `capabilityCall.ts`) adds the last four: a scope/availability
// refusal, a `trusted:false` refusal, a `federation-token` refusal, and a
// resolution refusal (uncataloged / ambiguous / normalization / prefix-deny).
export type InvokeOutcome =
  | "allowed"
  | "denied_method"
  | "denied_tier"
  | "denied_input"
  | "transport_error"
  | "proxied"
  | "denied_scope"
  | "denied_trusted"
  | "denied_auth"
  | "denied_resolution";

/**
 * The caller identity carried on the audit line. On the HUB the JWT identity is
 * known (`userId` + `namespace`, middleware/auth.ts). The owning-node federation
 * receiver sees only `X-Hapi-Caller-Namespace` (SessionService.proxyToNode) and
 * CANNOT log `userId` — so the hub's line is the authoritative caller record
 * [1B-17]. `namespace` is nullable for the federation leg where the header may
 * be absent (that request would already have been 404'd by checkCallerNamespace).
 */
export type InvokeCaller = { userId?: number; namespace: string | null };

/**
 * Emit ONE structured audit line per invoke attempt — allow AND deny (R5). A
 * generic control path without an audit trail is unacceptable (KD-4). Denials
 * and transport faults are security-relevant → `warn`; allows/proxies → `info`.
 *
 * NOTE: ErrorLogger rate-limits per `category` (issue #1141, default 10/60s), so
 * under sustained invoke load some audit lines summarize/drop. The route-level
 * rate limiter (100/60s) bounds attempts but exceeds that floor; a dedicated
 * lossless audit sink is a documented follow-up, not in scope for this MVP.
 */
export function auditInvoke(
  logger: ErrorLogger | null | undefined,
  entry: {
    // For RPC this is the method name; for the REST invoker (#3751 R3 / D11) it is
    // the REAL `METHOD path` (e.g. `POST /api/schedules`) — never a synthetic name.
    method: string;
    // Optional: the RPC path carries the target session id; the REST invoker has
    // NO session, so it is OMITTED rather than fabricated (#3751 R3 / D11).
    sessionId?: string;
    // The resolved catalog entry id for the REST invoker (#3751 R3 / D11).
    entryId?: string;
    caller: InvokeCaller;
    outcome: InvokeOutcome;
  }
): void {
  if (!logger) return;
  const message = `capability-invoke ${entry.outcome}: ${entry.method}`;
  const options = {
    category: "capability-invoke",
    sessionId: entry.sessionId,
    namespace: entry.caller.namespace,
    context: {
      method: entry.method,
      entryId: entry.entryId ?? null,
      outcome: entry.outcome,
      callerUserId: entry.caller.userId ?? null,
    },
  };
  if (entry.outcome === "allowed" || entry.outcome === "proxied") {
    logger.info(message, options);
  } else {
    logger.warn(message, options);
  }
}

// ── Input validation (R3, KD-2 — ruled Option A / D1-A) ──────────────────────
// `meta.inputSchema` is a JSON Schema (draft 2020-12, emitted by the CLI's zod
// v4 `z.toJSONSchema()`). The server has zod v4 but zod v4 cannot validate
// AGAINST a JSON Schema (`z.fromJSONSchema` unshipped — colinhacks/zod#5233), so
// D1-A rules in `ajv` via the `ajv/dist/2020` (Ajv2020) entrypoint — draft
// 2020-12 matches the emitted output (OR-3).
//
// TRUST NOTE (rider iii): ajv compiles CLIENT-DECLARED schemas via Function
// codegen. This is a BOUNDED trust surface — a schema registrant already holds
// the cliApiToken, a full-trust credential (KD-6), so namespace is not a
// boundary against it. ajv is in maintenance mode (per its README) but remains
// the standard draft-2020-12 validator.
const ajv = new Ajv2020({ strict: false, allErrors: true });

type CachedValidator = { schema: object; validate: ValidateFunction };

// Compiled-validator cache keyed by `${sessionId}:${method}` (rider ii). A
// re-registration produces a NEW `inputSchema` object reference, so reference
// inequality is the invalidation signal — a stale schema can never be reused.
const validatorCache = new Map<string, CachedValidator>();

export type InputValidation = { ok: true } | { ok: false; error: string };

/**
 * Validate `body` against the method's registered `inputSchema` BEFORE dispatch
 * (R3). A schema-less readonly method forwards its body verbatim. A
 * present-but-uncompilable schema DENIES the invoke (rider i) — a compile error
 * must NEVER fall through to forward-verbatim.
 */
export function validateCapabilityInput(
  cacheKey: string,
  meta: CapabilityMeta,
  body: unknown
): InputValidation {
  const schema = meta.inputSchema;
  // Schema-less readonly method → forward the body verbatim (R3).
  if (schema === undefined) return { ok: true };

  let cached = validatorCache.get(cacheKey);
  if (!cached || cached.schema !== schema) {
    let validate: ValidateFunction;
    try {
      validate = ajv.compile(schema);
    } catch {
      // Rider (i): a present-but-broken schema is fail-closed — DENY.
      return { ok: false, error: "Capability input schema is invalid" };
    }
    cached = { schema, validate };
    validatorCache.set(cacheKey, cached);
  }

  if (cached.validate(body)) return { ok: true };
  return {
    ok: false,
    error: ajv.errorsText(cached.validate.errors, { dataVar: "input" }),
  };
}

// ── Shared gate → validate → dispatch core (KD-3) ────────────────────────────
// The minimal engine surface the invoke core needs. SyncEngine satisfies it
// structurally; tests pass a two-method fake.
export interface CapabilityInvokeEngine {
  getCapabilityMeta(sessionId: string, method: string): CapabilityMeta | null;
  invokeCapability(
    sessionId: string,
    method: string,
    params: unknown
  ): Promise<unknown>;
}

export type InvokeResult = {
  status: 200 | 400 | 403 | 409;
  body: Record<string, unknown>;
};

const NOT_INVOCABLE: InvokeResult = {
  status: 403,
  body: {
    ok: false,
    error: "Method is not invocable",
    code: "tier_not_invocable",
  },
};

/**
 * The invoke pipeline, framework-agnostic (returns `{status, body}` so both the
 * Hono hub route and the federation receiver map it with `c.json`). Runs, in
 * strict order: method hygiene → fail-closed tier gate → input validation →
 * dispatch, auditing every terminal outcome. This is the single gate
 * implementation exercised on BOTH the hub-local and owning-node paths (KD-3).
 */
export async function runCapabilityInvoke(params: {
  engine: CapabilityInvokeEngine;
  sessionId: string;
  method: string;
  body: unknown;
  caller: InvokeCaller;
  logger: ErrorLogger | null;
}): Promise<InvokeResult> {
  const { engine, sessionId, method, body, caller, logger } = params;

  // 1. Method hygiene (1B-16) — reject before any registry lookup.
  if (!isValidMethodName(method)) {
    auditInvoke(logger, {
      method,
      sessionId,
      caller,
      outcome: "denied_method",
    });
    return NOT_INVOCABLE;
  }

  // 2. Fail-closed tier gate (R2, KD-1). Registry miss / absent meta / absent
  //    tier all resolve to `isInvocable(...) === false`.
  const meta = engine.getCapabilityMeta(sessionId, method);
  if (!isInvocable(meta)) {
    auditInvoke(logger, { method, sessionId, caller, outcome: "denied_tier" });
    return NOT_INVOCABLE;
  }

  // 3. Input validation (R3, D1-A). `meta` is narrowed to CapabilityMeta above.
  const validation = validateCapabilityInput(
    `${sessionId}:${method}`,
    meta,
    body
  );
  if (!validation.ok) {
    auditInvoke(logger, { method, sessionId, caller, outcome: "denied_input" });
    return {
      status: 400,
      body: { ok: false, error: validation.error, code: "invalid_input" },
    };
  }

  // 4. Dispatch (R1). The gateway resolves the socket and round-trips the RPC.
  try {
    const data = await engine.invokeCapability(sessionId, method, body);
    auditInvoke(logger, { method, sessionId, caller, outcome: "allowed" });
    return { status: 200, body: { ok: true, data } };
  } catch (err) {
    // [1B-14] Both gateway throws (`RPC handler not registered:` /
    // `RPC socket disconnected:`) map to `transport_failed`. A live session's
    // own `{ok:false, code}` response rides through verbatim inside `data`
    // above and is NEVER re-mapped here (e.g. `no_active_query` is a CLI-side
    // response code, not a transport error).
    auditInvoke(logger, {
      method,
      sessionId,
      caller,
      outcome: "transport_error",
    });
    return {
      status: 409,
      body: {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        code: "transport_failed",
      },
    };
  }
}

// ── Catalog-side sibling gate (issue #3751, Sub-Issue K — TRUST-CRITICAL) ─────
// `isInvocable(meta)` above gates the RPC path over a CLIENT-DECLARED riskTier and
// is FROZEN. The generic REST invoker (`capabilityCall.ts`) gates over a
// `CatalogEntry`'s TRUSTED tier PLUS the promotion allowlist, the `trusted` flag,
// the `auth` mode, and #3749 availability — a DIFFERENT data shape, so this is a
// NEW sibling symbol, never a rewrite of `isInvocable` and never wired into
// `runCapabilityInvoke` (whose signature stays frozen; the RPC path is
// byte-for-byte unchanged — R5). No adapter over `CapabilityInvokeEngine` (banned).
//
// Positive-allow, default-DENY, fail-closed ORDER (mirrors the :13-17 warning). The
// no-oracle refusals (`denied_trusted`/`denied_auth`/`denied_scope`) are checked
// BEFORE the tier gate, so `denied_tier` only ever fires for an entry the caller can
// already SEE in their catalog — an out-of-scope entry is never distinguishable from
// a nonexistent one.

/**
 * The refusal reason for a catalog entry, mapped by the route to a response + an
 * audit outcome. `denied_scope`/`denied_trusted`/`denied_auth` are the NO-ORACLE
 * class (the route collapses them to the same refusal a resolution miss returns);
 * `denied_tier` is distinct because the entry IS user-visible in the caller's
 * catalog, so `tier_not_invocable` leaks nothing new.
 */
export type EntryInvokeDecision =
  | { invocable: true }
  | {
      invocable: false;
      outcome:
        | "denied_tier"
        | "denied_scope"
        | "denied_trusted"
        | "denied_auth";
      reason: string;
    };

/**
 * Decide whether a resolved `CatalogEntry` is invocable through the generic REST
 * invoker for a caller with the given `AvailabilityContext` (R4, R5, NEW-3751-23).
 * The promotion list is consulted ONLY after the trusted/auth/availability checks,
 * ONLY for `mutating`, and is IGNORED for `destructive`.
 */
export function isEntryInvocable(
  entry: CatalogEntry,
  context: AvailabilityContext,
  // The promotion allowlist, injectable for tests (the DI seam); production callers
  // omit it and get the code-constant `PROMOTED_ENTRY_IDS` — never an env knob.
  promoted: readonly string[] = PROMOTED_ENTRY_IDS
): EntryInvokeDecision {
  // `trusted` is gate input, not display (R5): a runtime-loaded / attacker-authorable
  // entry (#3752 merges filesystem-extension entries with `trusted:false`) is never
  // dispatched — its self-declared tier must never widen the invoke surface.
  if (entry.trusted === false) {
    return {
      invocable: false,
      outcome: "denied_trusted",
      reason: "entry is not trusted (discovery-only)",
    };
  }
  // `federation-token` entries are NEVER invocable via this path (R2): that credential
  // is node-level, mesh-identical, and fronts deliberately namespace-permissive
  // receivers mounted PRE-JWT-gate — the invoker never substitutes it.
  if (entry.auth === "federation-token") {
    return {
      invocable: false,
      outcome: "denied_auth",
      reason: "federation-token entries are not invocable via the generic path",
    };
  }
  // Availability + scope hard filter (NEW-3751-23): an out-of-scope (operator) or
  // mode-unavailable entry is refused, so the generic path never reaches the
  // operator surface even though the entry resolves against the catalog structure.
  const availability = evaluateAvailability(entry.availability, context);
  if (!availability.available) {
    return {
      invocable: false,
      outcome: "denied_scope",
      reason: availability.reason ?? "not available in this scope",
    };
  }
  // Positive-allow tier gate over the CATALOG's trusted tier (R4).
  switch (entry.riskTier) {
    case "readonly":
      return { invocable: true };
    case "mutating":
      return promoted.includes(entry.id)
        ? { invocable: true }
        : {
            invocable: false,
            outcome: "denied_tier",
            reason: "mutating tier is not promoted",
          };
    default:
      // `destructive` (the promotion list is IGNORED for destructive) and any
      // unexpected tier value both fail closed.
      return {
        invocable: false,
        outcome: "denied_tier",
        reason: `riskTier "${entry.riskTier}" is not invocable`,
      };
  }
}
