// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `@hapi/protocol` graph-execute barrel — issue #3160 (Graph Runtime v1, Graph
 * Engineering Phase 3, Wave 1, Sub-Issue A).
 *
 * The production graph executor (`executor.ts`) + its public type contract and the
 * B–E extension seams (`types.ts`).
 *
 * ⚠️ This barrel transitively imports the `node:crypto` compile runtime (via
 * `recordLaunchHash`, pulled in through `executor.ts`) and is therefore exposed
 * ONLY through the `@hapi/protocol/graph/execute` subpath — NOT the web-safe root
 * barrel `shared/src/graph/index.ts` (mirroring `compile/index.ts`). The executor
 * is a runtime; it must not leak a `node:*` builtin into web's tsconfig.
 */
export * from "./types";
export * from "./executor";
export * from "./effect-ledger";
export * from "./retry-policy";
export * from "./cancellation";
