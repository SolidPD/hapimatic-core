// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Message-layer hook config, handler binding, coverage records, and the KD6
 * dedup-key helper (issue #3124, epic #3117 Sub I — message-layer hooks / tier 2
 * of the enforcement ladder).
 *
 * This is the SHARED (`@hapi/protocol`) home for the config + coverage-record
 * SCHEMAS the server-side message-hook stage (`server/src/sync/messageHooks.ts`)
 * needs but that the server cannot reach in the CLI. It is intentionally
 * `node:*`-FREE so it can be re-exported from the root `@hapi/protocol` barrel
 * (which `shared/src/schemas.ts` imports and web bundles). The crypto-using KD6
 * dedup-key helper lives in the sibling `messageHookDedup.ts`, exposed only via
 * the `@hapi/protocol/messageHookDedup` subpath (web-safety convention — see that
 * file and `graph/run-record.ts`).
 */
import { z } from "zod";

/**
 * Per-hook native-coverage record (#3123 R7 / CG-2). Mirrors the CLI's
 * `HookCoverageRecord` (`cli/src/agent/projection/types.ts`) field-for-field —
 * #3123's projection stage EMITS one per projected/degraded hook; #3124 CONSUMES
 * them (via `session.metadata.hookCoverage`, Task 6) for the R5 dedup decision.
 * `.passthrough()` so a future #3130 provenance field does not fail validation
 * on an older consumer.
 */
export const hookCoverageRecordSchema = z
  .object({
    event: z.string(),
    matcher: z.string(),
    /** KD6: `sha256(event + "\n" + matcher + "\n" + canonicalGuardId)`, lower hex. */
    dedupKey: z.string(),
    /** `true` when the hook registered in the harness's OWN native taxonomy; a
     *  natively-covered hook must NOT double-fire at the message layer (R5). */
    native: z.boolean(),
    /** Set when the event could not be projected and degraded to script-step tier. */
    degraded: z.boolean().optional(),
    /** Human/machine annotation for a degraded record (#3123 R3, never silent). */
    reason: z.string().optional(),
  })
  .passthrough();

export type HookCoverageRecord = z.infer<typeof hookCoverageRecordSchema>;

/**
 * The execution binding for a message hook (KD7). `builtin` resolves against an
 * in-process handler registry; `command` wraps a subprocess speaking the
 * UserPromptSubmit stdin/stdout JSON contract (the `.claude/hooks/*` detector
 * protocol). This is the axis that lets a hookless catalog CLI (e.g. Pi) run the
 * SAME detector script the native Claude harness runs, at the message layer.
 */
export const messageHookHandlerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("builtin"), id: z.string() }),
  z.object({
    kind: z.literal("command"),
    command: z.string(),
    args: z.array(z.string()).optional(),
  }),
]);

export type MessageHookHandlerBinding = z.infer<
  typeof messageHookHandlerSchema
>;

/** Harness scope (R3): always run, vs run only when the harness has no native
 *  projection of this hook (the dedup-driven scope KD4 resolves per session). */
export const messageHookHarnessScopeSchema = z.enum([
  "all",
  "no-native-equivalent",
]);
export type MessageHookHarnessScope = z.infer<
  typeof messageHookHarnessScopeSchema
>;

/** Fail policy for a NON-gate hook that errors/times out (R4): `open` skips the
 *  hook (delivery proceeds), `closed` denies delivery. A gate-class hook always
 *  denies on timeout regardless of this field. */
export const messageHookFailPolicySchema = z.enum(["open", "closed"]);
export type MessageHookFailPolicy = z.infer<typeof messageHookFailPolicySchema>;

/**
 * A message-layer hook (Task 1). Registered via `registerMessageHook` (Task 2);
 * consumed by `runMessageHooks` (Task 3). `.passthrough()` for forward-compat.
 */
export const messageHookConfigSchema = z
  .object({
    /** Stable hook id (surfaced in a denial `{delivered:false, hookId}`). */
    id: z.string().min(1),
    /** The UserPromptSubmit-class event this hook models (e.g. "UserPromptSubmit"). */
    event: z.string().min(1),
    harnessScope: messageHookHarnessScopeSchema,
    /** Per-hook execution bound (ms) — every hook is `Promise.race`d against it. */
    timeoutMs: z.number().int().positive(),
    failPolicy: messageHookFailPolicySchema,
    /** Gate-class hooks may DENY delivery and MUST deny on timeout (R4). */
    gateClass: z.boolean(),
    /** KD6 dedup key — matched against a session's coverage records (R5). */
    dedupKey: z.string().min(1),
    handler: messageHookHandlerSchema,
    /** R9 opt-in: programmatic `sentFrom` values this hook ADDITIONALLY runs for.
     *  Absent/empty → the hook runs only for genuine user origins
     *  (`USER_SENT_FROM_VALUES`). */
    origins: z.array(z.string()).optional(),
  })
  .passthrough();

export type MessageHookConfig = z.infer<typeof messageHookConfigSchema>;
