// SPDX-License-Identifier: AGPL-3.0-only
/**
 * KD6 dedup-key helper for the message-layer hook stage (issue #3124).
 *
 * ⚠️ WEB-SAFETY: this module imports `node:crypto`, so — like
 * `shared/src/deterministicJson.ts` and the `graph/compile` runtime — it is
 * exposed ONLY via the `@hapi/protocol/messageHookDedup` package.json subpath and
 * is NEVER re-exported from the root `@hapi/protocol` barrel. The root barrel is
 * web-reachable and web's tsconfig has no `node:*` types (`run-record.ts`
 * documents the same convention). The crypto-FREE config/coverage schemas live
 * in the barrel-reachable `messageHookConfig.ts`.
 */
import { createHash } from "node:crypto";

/**
 * KD6 dedup key — `sha256(event + "\n" + matcher + "\n" + canonicalGuardId)`,
 * lowercase hex. `matcher = ""` is NORMATIVE (part of the key, never omitted).
 *
 * REPRODUCES `cli/src/agent/projection/hooks/transpiler.ts` `computeHookDedupKey`
 * byte-for-byte — that file names itself "the one normative implementation;
 * #3124 reproduces it byte-for-byte". The two live in different packages because
 * `shared/` cannot import from `cli/` (the same cross-package boundary
 * `shared/src/capabilityGate.ts` documents for `manifestCapabilityState`, #3132).
 * Drift is caught mechanically: `messageHookConfig.test.ts` and the CLI's
 * `transpiler.test.ts` pin the SAME (input → hash) vector, so a change to either
 * formula fails a test on both sides. Converging behind one shared source once
 * #3130 unifies the projection provenance type into `@hapi/protocol` is a tracked
 * follow-up.
 */
export function computeHookDedupKey(
  event: string,
  matcher: string,
  canonicalGuardId: string
): string {
  return createHash("sha256")
    .update(`${event}\n${matcher}\n${canonicalGuardId}`)
    .digest("hex");
}
