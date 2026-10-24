// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Session-aware availability CONTEXT derivation (issue #3749, Sub-Issue I / R2,
 * R2a). The SERVER is the sole context producer (R4 / KD-2): only the server can
 * read `HAPI_VM_ADMIN` (a different process from the cli), the OCI-creds host
 * proof, the caller's JWT identity, and the node registry. It builds the
 * `AvailabilityContext` the pure evaluator (`@hapi/protocol` `availability.ts`)
 * consumes, and owns the shared catalog annotate-and-hard-filter used by BOTH the
 * catalog route (Task 3) and the federation receiver (Task 4).
 *
 * `scope` is the security-load-bearing axis (KD-1a): it keys on the CALLER, never
 * the node or the process. `operator` demands a positive host proof AND a
 * caller-identity match; unset binding ⇒ every caller is `user`. Fail closed.
 */
import { VERSION } from "../version.generated";
import { evaluateCapability } from "../provisioner/capability";
import { readVmTier } from "../web/desktopProxy";
import {
  evaluateAvailability,
  isVisibleToScope,
  resolveLauncherKind,
  type AvailabilityContext,
  type CatalogEntry,
} from "@hapi/protocol";
import type { LiveCatalog } from "./catalogCollector";

/** The authenticated caller identity (JWT `{uid, ns}`, WebAppEnv). */
export interface Caller {
  readonly userId: number;
  readonly namespace: string;
}

/**
 * The single configured operator identity on the operator host (R2a caller
 * proof). Read from `HAPI_OPERATOR_NAMESPACE` / `HAPI_OPERATOR_USER_ID`. Unset ⇒
 * NO operator caller exists → every caller resolves to `user` (fail closed).
 */
export interface OperatorBinding {
  readonly namespace?: string;
  readonly userId?: number;
}

/** Read the operator-identity binding from env (call-time, injectable). */
export function readOperatorBinding(
  env: Record<string, string | undefined> = process.env
): OperatorBinding {
  const namespace = env.HAPI_OPERATOR_NAMESPACE?.trim() || undefined;
  const rawUserId = env.HAPI_OPERATOR_USER_ID?.trim();
  const parsed = rawUserId ? Number.parseInt(rawUserId, 10) : Number.NaN;
  const userId = Number.isFinite(parsed) ? parsed : undefined;
  return { namespace, userId };
}

/** Injectable dependencies for {@link deriveScope} (defaults hit the real host). */
export interface ScopeDeps {
  readonly operatorBinding?: OperatorBinding;
  /** The host proof — `evaluateCapability(...).enabled`. */
  readonly hostProofEnabled?: () => boolean;
  /** The VM-tier marker — customer VMs carry it, operator hosts do not. */
  readonly vmTier?: () => string | undefined;
}

/** Default host proof: the fail-closed provisioner verdict on this box (R2a). */
function defaultHostProofEnabled(): boolean {
  return evaluateCapability({
    repoRoot: process.env.HAPI_VM_REPO_ROOT ?? process.cwd(),
  }).enabled;
}

/**
 * Derive the caller's scope (R2a). `operator` requires BOTH:
 *   (a) host proof: `evaluateCapability(...).enabled` AND `readVmTier()===undefined`
 *       (a customer can delete its own tier marker but cannot manufacture ~/.oci
 *       creds + the provisioning scripts), AND
 *   (b) caller proof: the request's `{userId, namespace}` matches the configured
 *       operator binding.
 * Any doubt ⇒ `user`. An UNSET binding ⇒ `user` for everyone (fail closed) — do
 * NOT ship (a) alone. `hub`/`peer`/`node` topology carries NO privilege here.
 */
export function deriveScope(
  caller: Caller,
  deps: ScopeDeps = {}
): "operator" | "user" {
  const binding = deps.operatorBinding ?? readOperatorBinding();

  // (b) caller proof — binding must be configured AND match. Unset ⇒ fail closed.
  const hasNamespace = binding.namespace !== undefined;
  const hasUserId = binding.userId !== undefined;
  if (!hasNamespace && !hasUserId) return "user";
  if (hasNamespace && caller.namespace !== binding.namespace) return "user";
  if (hasUserId && caller.userId !== binding.userId) return "user";

  // (a) host proof — positive proof this is an operator host.
  const hostProofEnabled = deps.hostProofEnabled ?? defaultHostProofEnabled;
  const vmTier = deps.vmTier ?? readVmTier;
  if (!hostProofEnabled()) return "user";
  if (vmTier() !== undefined) return "user"; // customer VM marker present

  return "operator";
}

/** The two JWT context keys {@link isOperatorCaller} reads (structural, so a
 *  Hono `Context<WebAppEnv>` and a test double both fit). */
export interface CallerContext {
  get(key: "userId" | "namespace"): unknown;
}

/**
 * The route-level operator check (#4450 R1): true only when the request's own
 * JWT identity derives `operator` scope at THIS moment. A missing or wrong-typed
 * `userId` / `namespace` is never operator (fail closed). The catalog hard filter
 * hides an operator entry; a route that acts must still check the caller itself.
 */
export function isOperatorCaller(
  c: CallerContext,
  deps: ScopeDeps = {}
): boolean {
  const userId = c.get("userId");
  const namespace = c.get("namespace");
  if (typeof userId !== "number" || typeof namespace !== "string") {
    return false;
  }
  return deriveScope({ userId, namespace }, deps) === "operator";
}

/** The subset of a session record this builder reads (structural, decoupled). */
export interface SessionLike {
  readonly metadata?: {
    readonly launcherKind?: string;
    readonly flavor?: string | null;
    readonly claudeAccount?: unknown;
  } | null;
}

export interface BuildContextInput {
  /** The looked-up session (undefined ⇒ minimal context, e.g. no `sessionId`). */
  readonly session?: SessionLike;
  readonly caller: Caller;
  /** This node's capability set (server `capabilityDetector`). */
  readonly nodeCapabilities: readonly string[];
  /** KD-3: when {@link nodeCapabilities} was detected (staleness marker). */
  readonly nodeCapabilitiesDetectedAt?: string;
  /** This node's version (defaults to the local VERSION constant). */
  readonly nodeVersion?: string;
  readonly scopeDeps?: ScopeDeps;
  /** Launcher-resolver fallback env (default: process.env.HAPI_CLAUDE_LAUNCHER). */
  readonly launcherEnvValue?: string;
}

/**
 * Build the per-session availability context (R2). Every axis derives from the
 * SAME signal the launcher/registry consults (KD-2): the frozen
 * `metadata.launcherKind` (resolver as FALLBACK only), `metadata.flavor ??
 * "claude"`, the session's `claudeAccount`, the server capability detector, the
 * node version, and the caller-keyed `scope`.
 */
export function buildAvailabilityContext(
  input: BuildContextInput
): AvailabilityContext {
  const meta = input.session?.metadata ?? undefined;
  const launcherKind =
    meta?.launcherKind ??
    resolveLauncherKind(
      input.launcherEnvValue ?? process.env.HAPI_CLAUDE_LAUNCHER,
      undefined
    ).kind;
  return {
    scope: deriveScope(input.caller, input.scopeDeps),
    launcherKind,
    agentId: meta?.flavor ?? "claude",
    accountBound: meta?.claudeAccount != null,
    nodeCapabilities: input.nodeCapabilities,
    nodeVersion: input.nodeVersion ?? VERSION,
    nodeCapabilitiesDetectedAt: input.nodeCapabilitiesDetectedAt,
  };
}

/** A catalog entry annotated with its per-session availability verdict (KD-3). */
export interface AnnotatedCatalogEntry extends CatalogEntry {
  /** Whether this in-scope entry is usable for the session right now. */
  available: boolean;
  /** Human "why not" (present only when `available` is false). */
  reason?: string;
  /** KD-3 staleness marker: when the node-capability set was detected. */
  detectedAt?: string;
}

/**
 * A LiveCatalog whose `CatalogEntry`-bearing sections carry availability
 * annotations. `rpc` (live per-session registrations) and `uncatalogedRest` (bare
 * method+path) carry no `availability` predicate and pass through unchanged — the
 * hard filter operates only on the sections that declare a scope.
 */
export interface AnnotatedLiveCatalog {
  rest: AnnotatedCatalogEntry[];
  uncatalogedRest: LiveCatalog["uncatalogedRest"];
  rpc: LiveCatalog["rpc"];
  mcp: AnnotatedCatalogEntry[];
  cli: AnnotatedCatalogEntry[];
  ui: AnnotatedCatalogEntry[];
}

/** Hard-filter out-of-scope entries (absence), annotate the in-scope ones. */
function annotateSection(
  entries: readonly CatalogEntry[],
  context: AvailabilityContext
): AnnotatedCatalogEntry[] {
  const out: AnnotatedCatalogEntry[] = [];
  for (const entry of entries) {
    // KD-1 HARD FILTER: out-of-scope (and no-scope) entries are OMITTED — never
    // `available:false` — so a caller never learns the surface exists.
    if (!isVisibleToScope(entry.availability, context)) continue;
    const { available, reason } = evaluateAvailability(
      entry.availability,
      context
    );
    const annotated: AnnotatedCatalogEntry = { ...entry, available };
    if (reason !== undefined) annotated.reason = reason;
    // KD-3: surface the detection time on EVERY verdict, so a consumer can judge
    // staleness of a `capabilityDetector`-cached answer.
    if (context.nodeCapabilitiesDetectedAt !== undefined) {
      annotated.detectedAt = context.nodeCapabilitiesDetectedAt;
    }
    out.push(annotated);
  }
  return out;
}

/**
 * Annotate + HARD-FILTER a live catalog by scope for one session (R3). The
 * single shared path used by the catalog route AND the federation receiver, so
 * the security-critical omit-vs-annotate rule cannot drift between them.
 */
export function annotateAndFilterCatalog(
  catalog: LiveCatalog,
  context: AvailabilityContext
): AnnotatedLiveCatalog {
  return {
    rest: annotateSection(catalog.rest, context),
    uncatalogedRest: catalog.uncatalogedRest,
    rpc: catalog.rpc,
    mcp: annotateSection(catalog.mcp, context),
    cli: annotateSection(catalog.cli, context),
    ui: annotateSection(catalog.ui, context),
  };
}
