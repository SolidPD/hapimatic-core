// SPDX-License-Identifier: MIT
/**
 * Common RPC types and interfaces for both session and machine clients
 */
import type { RiskTier } from "@hapi/protocol/riskTier";

/**
 * Generic RPC handler function type
 * @template TRequest - The request data type
 * @template TResponse - The response data type
 */
export type RpcHandler<TRequest = unknown, TResponse = unknown> = (
  data: TRequest
) => TResponse | Promise<TResponse>;

/**
 * Map of method names to their handlers
 */
export type RpcHandlerMap = Map<string, RpcHandler>;

/**
 * RPC request data from server
 */
export interface RpcRequest {
  method: string;
  params: string; // JSON string
}

/**
 * RPC response callback
 */
export type RpcResponseCallback = (response: string) => void;

/**
 * Configuration for RPC handler manager
 */
export interface RpcHandlerConfig {
  scopePrefix: string;
  logger?: (message: string, data?: unknown) => void;
}

/**
 * Result of RPC handler execution
 */
export type RpcHandlerResult<T = unknown> =
  | { success: true; data: T }
  | { success: false; error: string };

/**
 * JSON Schema object (the draft `z.toJSONSchema()` emits). Structural alias —
 * kept loose on purpose: the wire form is opaque, derived mechanically from a
 * zod schema at the registration call site, never hand-authored.
 */
export type JsonSchema = Record<string, unknown>;

/**
 * Risk classification gating the generic-invoke path (epic #2416, Sub-Issue C /
 * #2419). Re-exported from the ONE canonical declaration in
 * `@hapi/protocol/riskTier` (issue #3741, ER 2026-09-16 D9) — `./types` MUST keep
 * resolving this name (`CapabilityMeta.riskTier` below, and the import in
 * `capabilityMeta.registrations.test.ts:26`). Mirrors the landed subpath-re-export
 * precedent at `cli/src/claude/launcherDispatch.ts:28`. The local `import type`
 * at the top of this file supplies the binding `CapabilityMeta` uses.
 */
export type { RiskTier } from "@hapi/protocol/riskTier";

/**
 * Self-describing metadata for a registered RPC handler (a "capability").
 *
 * Rides the existing `rpc-register` socket event as an optional field, so a
 * mixed-version fleet degrades gracefully to name-only listings (an old client
 * registers a bare `{ method }`; an old server ignores the extra `meta`).
 */
export interface CapabilityMeta {
  description: string;
  inputSchema?: JsonSchema;
  outputSchema?: JsonSchema;
  riskTier: RiskTier;
  since: string; // semver or ISO date the capability was introduced
}

/**
 * Sentinel passed to `RpcHandlerManager.registerHandler` in place of a
 * `CapabilityMeta` when a call site DECLARES it has no metadata — teardown /
 * no-op / cleanup-stub re-registrations (issue #3742). Making `meta` a required
 * `CapabilityMeta | typeof NO_META_TEARDOWN` union turns an accidental omission
 * into a compile error, while an explicit sentinel keeps the meta-less runtime
 * path (bare `{ method }` on the wire, `this.meta.delete()`) byte-identical to
 * before — the #2417 KD-5/R2 mixed-version fleet wire contract.
 *
 * `Symbol.for(...)` (registry form), NOT `Symbol()`: the Bun single-exe build
 * plus cli's tsconfig pulling in `../server/src/**` make a second module
 * instantiation plausible, and a registry symbol is the SAME value across
 * instantiations. `RpcHandlerManager` normalizes it with `typeof meta ===
 * "symbol"` (identity-independent), so a double-instantiated module can never
 * leak a symbol onto the wire even though the value is shared. The `const`
 * annotation still yields a `unique symbol` type, so the union member is
 * distinct and non-forgeable at the type level. (issue #3742, KD-1)
 */
export const NO_META_TEARDOWN: unique symbol = Symbol.for(
  "hapi.NO_META_TEARDOWN"
);
