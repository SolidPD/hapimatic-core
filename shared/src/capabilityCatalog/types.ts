// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Capability-catalog TypeScript types (issue #3741, Task 2 / R1, R3, R5).
 *
 * The static contract for a catalog entry. `schema.ts` (Task 3) mirrors these in
 * zod v4; `defineCapability` consumes/returns this authored shape.
 *
 * 🔒 `RiskTier` is IMPORTED here (never re-exported from this module or the
 * `capabilityCatalog` barrel — ER 2026-09-16 D9). A second star-export of that
 * name into `shared/src/index.ts` (via `./capabilityCatalog` on top of `./graph`
 * + `./riskTier`) is a hard TS2308 ambiguous re-export.
 */
import type { RiskTier } from "../riskTier";
import type { DomainSlug } from "./domains";

/** The invocation transport a capability is reached through. */
export type Surface = "rpc" | "rest" | "mcp" | "cli" | "ui";

/**
 * The authentication a caller must present to invoke the capability.
 *
 * `hmac` (issue #3746, Sub-Issue F): a request-body HMAC signature — the fifth
 * auth mode the GitHub-webhook route uses (`server/src/web/routes/githubWebhook.ts`,
 * `X-Hub-Signature-256`). Tagging that route `none` would advertise it as
 * unauthenticated; tagging it `jwt` would teach an agent a recipe that always 401s.
 */
export type Auth = "jwt" | "cli-token" | "federation-token" | "none" | "hmac";

/**
 * How the capability is invoked — a discriminated union on `kind`, one arm per
 * surface. Each arm carries only the coordinate(s) that surface needs.
 */
export type Invocation =
  | { kind: "rest"; method: string; path: string }
  | { kind: "rpc"; method: string }
  | { kind: "mcp"; tool: string }
  | { kind: "cli"; command: string }
  | { kind: "ui"; location: string };

/**
 * Declarative (serializable) availability predicate — DATA, never a function
 * (R5 / KD-2). It must round-trip through `JSON.parse(JSON.stringify(p))`
 * unchanged so it serializes to the web client and evaluates identically
 * server-side. Sub-Issue I (#3749) supplies the evaluator.
 *
 * The key names are FROZEN as a cross-issue contract with #3746 (hand-populates
 * ~409 routes) / #3749 (filters by these names) / #3751. Reconcile verbatim with
 * #3749 R1's context keys `{launcherKind, agentId, nodeCapabilities, accountBound,
 * scope, nodeVersion}`: the `nodeCapability` (singular) vs `nodeCapabilities`
 * (plural CONTEXT set) pairing is deliberate — the evaluator tests membership;
 * `minVersion` is compared against the context key `nodeVersion`.
 */
export interface Availability {
  /** Matches #3749 context key `launcherKind`. */
  launcherKind?: string;
  /** Matches #3749 context key `agentId`. */
  agentId?: string;
  /** Singular predicate; #3749's CONTEXT key is `nodeCapabilities` (plural set) — the evaluator tests membership. */
  nodeCapability?: string;
  /** Matches #3749 context key `accountBound`. */
  accountBound?: boolean;
  /** REQUIRED — no default (R9 / ER D4). A `.default("user")` is itself fail-open and is rejected. */
  scope: "operator" | "user";
  /** #3749 R5's `minVersion` predicate, compared against context key `nodeVersion`. */
  minVersion?: string;
  /** Node-local mount fact. Stays INSIDE `availability` (where #3744 R3 and #3746 R6 read it); #3749 owns the mount-aware evaluator branch (OR-4). */
  mountedWhen?: string;
}

/**
 * A single capability catalog entry. Field list is R1's exact set. `probe`,
 * `telemetry`, and `trusted` are OPTIONAL in the authored shape (the schema
 * applies their documented defaults on parse — R9); `owner`, `example`, and
 * `since` are optional. Everything else is required, including `availability`
 * (whose `scope` is itself required).
 */
export interface CatalogEntry {
  /** `<domain>.<name>` — the prefix before the first `.` MUST equal `domain` (R2). */
  id: string;
  domain: DomainSlug;
  surface: Surface;
  description: string;
  whenToUse: string;
  invocation: Invocation;
  auth: Auth;
  riskTier: RiskTier;
  availability: Availability;
  /** Defaults to `"safe"` on parse (R9). */
  probe?: "safe" | "skip";
  /** Defaults to `"sampled"` on parse (R9). */
  telemetry?: "sampled" | "off";
  /** Defaults to `true` on parse (R9). */
  trusted?: boolean;
  owner?: string;
  example?: string;
  since?: string;
}
