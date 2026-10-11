// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `@hapi/protocol` graph-compile barrel — issue #2886 (Phase 1, sub-issue D).
 *
 * The deterministic compiler (`compiler.ts`), STRICT_RESUME guard
 * (`strictResume.ts`), and effect-ledger emitter (`effectLedger.ts`) that lower a
 * v0.1 `GraphIR` into a `CompiledWorkflow` artifact.
 *
 * ⚠️ This barrel transitively imports `node:crypto` (via the runtime modules) and
 * is therefore exposed ONLY through the `@hapi/protocol/graph/compile` subpath —
 * NOT the root barrel. The web-safe TYPES (`./types`) are additionally re-exported
 * from `shared/src/graph/index.ts` for browser consumers (e.g. #2887). See
 * `types.ts`'s "WEB-SAFE MODULE" note.
 */
export * from "./types";
export * from "./compiler";
export * from "./strictResume";
export * from "./effectLedger";
